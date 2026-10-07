/**
 * 재계획 열림·대기 판정, 재계획 중 거절하는 Task 명령, 닫힐 때의 대기 발화 판정. 열림은 저장 필드 없이
 * 커밋된 계획이 있는 Work 가 계획 단계 세 상태 중 하나인 것으로 파생한다.
 */
import { type Result, ok, err } from "../result.js";
import type { TaskId } from "../ids.js";
import type { UtcInstant } from "../values.js";
import type { TaskRecord, WorkAggregate, WorkRecord } from "../aggregate.js";
import type { TaskCommand } from "../commands.js";
import type { DomainRegistries } from "../registry/registries.js";
import type { MisfireDecision, MisfireError, TaskTriggerOccurrence } from "../policy/misfire.js";
import { decideTaskTriggerMisfire } from "../policy/misfire.js";
import { requiresPreExecutionApproval } from "../policy/pre-execution-approval.js";
import { scheduleCauseDeclared } from "../policy/trigger-cause.js";
import { validateTaskRecord } from "../validation/task-validation.js";

export function isReplanOpen(work: WorkRecord): boolean {
  return (
    work.planRevision >= 1 &&
    (work.state === "PLANNING" ||
      work.state === "WAITING_INPUT" ||
      work.state === "WAITING_APPROVAL")
  );
}

/**
 * 재계획 대기 — 열려 있거나, 재계획 중 실패로 끝났다. 실패 종결은 구간을 끝내지만 재계획을 닫지
 * 않으므로(커밋·거부가 없음) 기다리던 발화는 풀리지 않는다. 계획 실패 원인은 계획 단계에서만,
 * planRevision ≥ 1 인 계획 단계는 재계획으로만 도달하므로 이 조합이 재계획 중 실패와 같다.
 */
export function isReplanWaitHeld(work: WorkRecord): boolean {
  return (
    isReplanOpen(work) ||
    (work.state === "FAILED" && work.failureCause === "planning_failed" && work.planRevision >= 1)
  );
}

/** 새 attempt·첫 효과·Trigger 발화·occurrence 해석 — 재계획 대기 동안 거절한다. */
export const REPLAN_GATED_TASK_COMMANDS: readonly TaskCommand["kind"][] = Object.freeze([
  "start_attempt",
  "begin_confirmation_wait",
  "park_awaiting_human",
  "schedule_task",
  "retry_ready",
  "skip_task",
]);

/**
 * 재계획 대기 동안 거절하는 명령인가. 신호 원인 예약은 occurrence 를 원인 이벤트와 같은 커밋에
 * 영속하는 명령이라 받아들이고, 그 occurrence 의 발화만 막는다. 예약·재시도 원인 예약은 원인 이벤트가
 * 없어 닫힌 뒤 스케줄러가 다시 낸다. 신호 원인이라도 Trigger 가 외부 신호 발화로 선언되지 않았으면
 * 계약상 생기지 않는 occurrence 라 거절하고, 실행 전 승인이 필요한 Task 는 예약 대신 승인 주차(사람
 * 요청)가 일어나는데 같은 주차를 일으키는 명령이 모두 막히므로 거절한다(미적용 — 원천이 다시 낼 수 있다).
 * 실행 전 승인이 필요한 Task 의 검증 통과는 같은 커밋에 실행 전 승인 주차를 붙이므로 재계획 대기 중에는
 * 적용하지 않는다. 검증 실패·입력 요청·차단 출구는 주차가 없어 그대로 처리한다.
 */
export function isReplanGatedTaskCommand(
  registries: DomainRegistries,
  task: TaskRecord,
  command: TaskCommand,
): boolean {
  if (command.kind === "complete_validation") {
    return (
      task.state === "VALIDATING" &&
      requiresPreExecutionApproval(task) &&
      validateTaskRecord(registries, task).exit === "valid"
    );
  }
  if (!REPLAN_GATED_TASK_COMMANDS.includes(command.kind)) return false;
  if (command.kind !== "schedule_task" || command.cause !== "external_signal") return true;
  const descriptor = registries.triggers.get(task.trigger.kind, task.trigger.version);
  return (
    descriptor === undefined ||
    !scheduleCauseDeclared(descriptor, command.cause) ||
    requiresPreExecutionApproval(task)
  );
}

export type ReplanCloseFiring =
  | { readonly taskId: TaskId; readonly kind: "decided"; readonly decision: MisfireDecision }
  | { readonly taskId: TaskId; readonly kind: "undecidable"; readonly error: MisfireError };

/**
 * 현재 member 순. READY·SCHEDULED 의 예약형 Trigger → schedule 판정, SCHEDULED 사건 원인 → event_caused
 * 판정. 그 밖 member 는 항목 없음. 재계획 대기(열림 또는 재계획 중 실패)면 err.
 */
export function decideReplanCloseFirings(
  registries: DomainRegistries,
  aggregate: WorkAggregate,
  now: UtcInstant,
): Result<readonly ReplanCloseFiring[], { readonly kind: "replan_still_open" }> {
  if (isReplanWaitHeld(aggregate.work)) return err({ kind: "replan_still_open" });
  const out: ReplanCloseFiring[] = [];
  for (const taskId of aggregate.work.memberTaskIds) {
    const task = aggregate.tasks[taskId];
    if (task === undefined || (task.state !== "READY" && task.state !== "SCHEDULED")) continue;
    const descriptor = registries.triggers.get(task.trigger.kind, task.trigger.version);
    let occurrence: TaskTriggerOccurrence | undefined;
    if (descriptor === undefined || descriptor.occurrenceDerivation.kind === "schedule") {
      occurrence = { kind: "schedule" };
    } else if (task.state === "SCHEDULED" && task.scheduledOccurrenceId !== undefined) {
      occurrence = { kind: "event_caused", occurrenceId: task.scheduledOccurrenceId };
    }
    if (occurrence === undefined) continue;
    const decided = decideTaskTriggerMisfire(registries.triggers, {
      taskId,
      trigger: task.trigger,
      occurrence,
      now,
    });
    out.push(
      decided.ok
        ? { taskId, kind: "decided", decision: decided.value }
        : { taskId, kind: "undecidable", error: decided.error },
    );
  }
  return ok(out);
}
