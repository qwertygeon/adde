/**
 * 커밋 내 연쇄 — Work 취소 연쇄, 의존 불충족 라우팅, 의존 활성화, 파생 Work 상태. 순수 함수 — ID
 * 생성·envelope 부여는 engine.ts.
 */
import type { WorkAggregate, TaskRecord } from "./aggregate.js";
import { memberSnapshots } from "./aggregate.js";
import type { TaskId, EventId } from "./ids.js";
import type { ActorSource, CancelOrigin } from "./values.js";
import { isTerminalTaskState } from "./task-state.js";
import { isTerminalWorkState } from "./work-state.js";
import type { DecidedEvent } from "./events.js";
import { mkEvent } from "./events.js";
import { isActivationSatisfied } from "./task-decide.js";
import { deriveOccurrenceId, selectDependencyCausingEvent } from "./derivation/occurrence-id.js";
import type { DerivedStateInput } from "./completion.js";
import { deriveWorkState, evaluateCompletion } from "./completion.js";
import { DomainInvariantError } from "./result.js";
import type { DomainRegistries } from "./registry/registries.js";
import { requiresPreExecutionApproval } from "./policy/pre-execution-approval.js";

export interface CascadeDecided {
  readonly event: DecidedEvent;
  readonly causationEventId?: string;
}

/** `work_canceled` 와 같은 커밋에서 비종결 소유 Task 를 `Work.taskIds` 순서로 취소(ADR-016). */
export function decideWorkCancellationCascade(
  aggregate: WorkAggregate,
  workCanceledEventId: string,
  actorSource: ActorSource,
): readonly CascadeDecided[] {
  const out: CascadeDecided[] = [];
  for (const taskId of aggregate.work.taskIds) {
    const task = aggregate.tasks[taskId];
    if (task === undefined || isTerminalTaskState(task.state)) continue;
    const origin: CancelOrigin = {
      kind: "work_cascade",
      actorSource,
      workEventId: workCanceledEventId as EventId,
    };
    if (task.state === "WAITING_CONFIRMATION") {
      out.push({
        event: mkEvent(
          "confirmation_cancelled",
          { confirmationId: task.confirmationId as import("./ids.js").ConfirmationId, origin },
          { taskId },
        ),
        causationEventId: workCanceledEventId,
      });
    } else {
      out.push({
        event: mkEvent("task_canceled", { origin }, { taskId }),
        causationEventId: workCanceledEventId,
      });
    }
  }
  return out;
}

const UNSATISFYING_TERMINAL_OR_CANCELED = new Set(["REJECTED", "EXPIRED", "FAILED", "CANCELED"]);

function unsatisfiedDependencyIds(aggregate: WorkAggregate, task: TaskRecord): readonly TaskId[] {
  return task.dependsOn.filter((depId) => {
    const dep = aggregate.tasks[depId];
    return dep !== undefined && UNSATISFYING_TERMINAL_OR_CANCELED.has(dep.state);
  });
}

function latestCausingEventId(
  aggregate: WorkAggregate,
  dependencyTaskIds: readonly TaskId[],
): string | undefined {
  const refs = dependencyTaskIds
    .map((id) => aggregate.tasks[id]?.terminalRef)
    .filter((ref): ref is NonNullable<typeof ref> => ref !== undefined)
    .map((ref) => ({ eventId: ref.eventId, occurredAt: ref.occurredAt, position: ref.position }));
  const selected = selectDependencyCausingEvent(refs);
  return selected?.id;
}

const FAIL_ELIGIBLE_STATES = new Set([
  "VALIDATING",
  "WAITING_INPUT",
  "READY",
  "SCHEDULED",
  "BLOCKED",
]);

/** 의존 충족으로 발화하는 Trigger 인지 등록부 선언으로 판정한다(미등록이면 활성화하지 않는다). */
function firesOnDependencies(registries: DomainRegistries, task: TaskRecord): boolean {
  const descriptor = registries.triggers.get(task.trigger.kind, task.trigger.version);
  return descriptor !== undefined && descriptor.firing === "dependencies_satisfied";
}

/**
 * 의존 불충족 라우팅·의존 활성화 한 라운드. 변화가 없으면 빈 배열. 실행 전 승인을 기다리는 Task 는
 * 활성화하지 않는다 — grant 로 READY 에 돌아온 커밋에서 다시 판정된다.
 */
export function decideDependencyCascadeRound(
  registries: DomainRegistries,
  aggregate: WorkAggregate,
): readonly CascadeDecided[] {
  const out: CascadeDecided[] = [];
  for (const taskId of aggregate.work.taskIds) {
    const task = aggregate.tasks[taskId];
    if (task === undefined || isTerminalTaskState(task.state)) continue;

    const unsatisfied = unsatisfiedDependencyIds(aggregate, task);
    if (unsatisfied.length > 0) {
      const causing = latestCausingEventId(aggregate, unsatisfied);
      const policy = task.policy.onDependencyUnsatisfied;
      if (policy === "block" && (task.state === "VALIDATING" || task.state === "READY")) {
        out.push({
          event: mkEvent(
            "task_blocked",
            { blockReason: { kind: "dependency_unsatisfied", dependencyTaskIds: unsatisfied } },
            { taskId },
          ),
          ...(causing !== undefined ? { causationEventId: causing } : {}),
        });
        continue;
      }
      if (policy === "skip") {
        out.push({
          event: mkEvent(
            "task_skipped",
            { reason: { kind: "dependency_unsatisfied", dependencyTaskIds: unsatisfied } },
            { taskId },
          ),
          ...(causing !== undefined ? { causationEventId: causing } : {}),
        });
        continue;
      }
      if (policy === "fail" && FAIL_ELIGIBLE_STATES.has(task.state)) {
        out.push({
          event: mkEvent(
            "task_failed",
            { reason: { kind: "dependency_unsatisfied", dependencyTaskIds: unsatisfied } },
            { taskId },
          ),
          ...(causing !== undefined ? { causationEventId: causing } : {}),
        });
        continue;
      }
      // 행 없는 상태면 그대로 둔다 — 행 있는 상태로 들어오는 커밋에서 같은 규칙 재적용(research.md §10).
    }

    if (
      task.state === "READY" &&
      !task.dependencyActivated &&
      !requiresPreExecutionApproval(task) &&
      firesOnDependencies(registries, task)
    ) {
      if (isActivationSatisfied(aggregate, taskId)) {
        const refs = task.dependsOn
          .map((depId) => aggregate.tasks[depId]?.terminalRef)
          .filter((ref): ref is NonNullable<typeof ref> => ref !== undefined)
          .map((ref) => ({
            eventId: ref.eventId,
            occurredAt: ref.occurredAt,
            position: ref.position,
          }));
        const causing = selectDependencyCausingEvent(refs);
        if (causing !== undefined) {
          const occ = deriveOccurrenceId({
            kind: "event_caused",
            ownerId: taskId,
            triggerId: task.trigger.triggerId,
            causingEvent: causing,
          });
          if (occ.ok) {
            out.push({
              event: mkEvent(
                "task_scheduled",
                {
                  occurrenceId: occ.value,
                  cause: "dependency_satisfaction",
                  causingEventId: causing.id,
                },
                { taskId },
              ),
              causationEventId: causing.id,
            });
          }
        }
      }
    }
  }
  return out;
}

/** 파생 Work 상태 평가(design.md §6). 상태가 바뀔 때만 이벤트를 돌려준다. */
export function decideDerivedWorkStateEvent(
  aggregate: WorkAggregate,
  causationEventId: string | undefined,
): CascadeDecided | undefined {
  const state = aggregate.work.state;
  if (isTerminalWorkState(state)) return undefined;
  if (state !== "READY" && state !== "ACTIVE" && state !== "BLOCKED") return undefined;

  const input: DerivedStateInput = {
    ownedTasks: memberSnapshots(aggregate),
    memberTaskIds: aggregate.work.memberTaskIds,
    startedUnderCurrentRevision: aggregate.work.startedUnderCurrentRevision,
  };
  const derived = deriveWorkState(input);
  if (derived === state) return undefined;

  const causation = causationEventId !== undefined ? { causationEventId } : {};
  if (derived === "COMPLETED") {
    return {
      event: mkEvent(
        "work_completed",
        { completionPolicyVersion: 1 },
        { workId: aggregate.work.id },
      ),
      ...causation,
    };
  }
  if (derived === "BLOCKED") {
    const evaluation = evaluateCompletion(input);
    return {
      event: mkEvent(
        "work_blocked",
        { unsatisfiedRequiredTaskIds: evaluation.unsatisfiedRequiredTaskIds },
        { workId: aggregate.work.id },
      ),
      ...causation,
    };
  }
  if (derived === "ACTIVE") {
    const type = state === "BLOCKED" ? "work_unblocked" : "work_activated";
    return { event: mkEvent(type, {}, { workId: aggregate.work.id }), ...causation };
  }
  // derived === "READY" 인데 state 는 ACTIVE·BLOCKED — ACTIVE·BLOCKED 진입은 항상
  // startedUnderCurrentRevision 을 true 로 두므로(ADR-004 계열 §6), deriveWorkState 가 다시
  // READY 를 내는 것은 그 불변식이 깨졌다는 뜻이다(ADR-005 프로그램 오류, 입력 거절 아님).
  throw new DomainInvariantError(
    `decideDerivedWorkStateEvent: ${state} 에서 파생 상태가 READY 로 되돌아갔다(startedUnderCurrentRevision 불변식 위반) — workId=${aggregate.work.id}`,
  );
}
