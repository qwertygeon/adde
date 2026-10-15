/**
 * 이벤트 → 상태 적용(단일 적용 경로)·커밋 단위 revision 규칙. 이벤트별 적용은 페이로드가 담은 값만
 * 쓴다(판정 로직 금지 — 이벤트가 곧 결정). Task revision 은 그 Task 의 전이 행·동반 이벤트(리마인더
 * 제외)나 열린 결정의 표시를 바꾸는 이벤트가 커밋에 하나라도 있으면 1 오른다 — 거절·중복 기록·신호
 * 수용 기록·승인 채널 거절 기록은 단독으로 올리지 않는다. 정의 이벤트는 관리 Work 의 정의 값을 바꾸고
 * Work revision 을 올리지 않는다 — 정의 revision 은 커밋에 정의 전이 이벤트가 하나라도 있을 때 1 오른다.
 */
import type { TaskId, EventId, WorkDefinitionId } from "./ids.js";
import type {
  WorkAggregate,
  TaskRecord,
  WorkRecord,
  DecisionSubjectRef,
  TerminalEventRef,
} from "./aggregate.js";
import type { DomainEvent } from "./events.js";
import {
  DEFINITION_TRANSITION_EVENT_TYPES,
  RECORD_ONLY_EVENT_TYPES,
  TASK_REVISION_EVENT_TYPES,
  WORK_EVENT_TYPES,
} from "./events.js";
import type { SignalDedupKey } from "./derivation/dedup-key.js";
import type {
  DefinitionRecord,
  PendingScheduleRow,
  ResolvedScheduleRef,
  ScheduleRow,
} from "./definition/model.js";
import { instantMs } from "./values.js";

const RECORD_ONLY_SET: ReadonlySet<string> = new Set(RECORD_ONLY_EVENT_TYPES);
const WORK_EVENT_SET: ReadonlySet<string> = new Set(WORK_EVENT_TYPES);
const TASK_REVISION_EVENT_SET: ReadonlySet<string> = new Set(TASK_REVISION_EVENT_TYPES);
const DEFINITION_TRANSITION_EVENT_SET: ReadonlySet<string> = new Set(
  DEFINITION_TRANSITION_EVENT_TYPES,
);

function bumpsTaskRevision(event: DomainEvent): boolean {
  if (TASK_REVISION_EVENT_SET.has(event.type)) return true;
  return (
    event.type === "agent_result_unmatched" && event.payload.presentedInDecisionId !== undefined
  );
}

function requireTaskId(event: DomainEvent): TaskId {
  if (event.taskId === undefined) {
    throw new Error(`evolve: 이벤트 ${event.type} 에 taskId 가 없다`);
  }
  return event.taskId;
}

/** 필드를 지운 레코드를 그대로 둔다 — 부분 패치 병합은 생략한 optional 필드를 지우지 못한다. */
function replaceTask(
  tasks: Record<string, TaskRecord>,
  taskId: TaskId,
  next: TaskRecord,
): Record<string, TaskRecord> {
  if (tasks[taskId] === undefined) {
    throw new Error(`evolve: 알 수 없는 Task 대상 ${taskId}`);
  }
  return { ...tasks, [taskId]: next };
}

function patchTask(
  tasks: Record<string, TaskRecord>,
  taskId: TaskId,
  patch: Partial<TaskRecord>,
): Record<string, TaskRecord> {
  const current = tasks[taskId];
  if (current === undefined) {
    throw new Error(`evolve: 알 수 없는 Task 대상 ${taskId}`);
  }
  return { ...tasks, [taskId]: { ...current, ...patch } };
}

/** `exactOptionalPropertyTypes` 아래 optional 필드를 완전히 제거한다(=undefined 대입 금지). */
function omitFields<T extends object>(value: T, keys: readonly (keyof T)[]): T {
  const copy: Partial<T> = { ...value };
  for (const key of keys) delete copy[key];
  return copy as T;
}

/** 정의 이벤트의 대상 — 페이로드 정의 ID 가 관리 중인 정의와 다르면 프로그램 오류다. */
function requireDefinition(
  definition: DefinitionRecord | undefined,
  definitionId: WorkDefinitionId,
  type: string,
): DefinitionRecord {
  if (definition === undefined || definition.id !== definitionId) {
    throw new Error(`evolve: 이벤트 ${type} 의 정의 ${definitionId} 를 이 Work 가 관리하지 않는다`);
  }
  return definition;
}

/** `nextSchedule` 규칙 — 필드 없음 = 대기 행 불변, null = 대기 행 없음, 값 = 새 대기 행(지연 표식 없음). */
function withNextSchedule(
  definition: DefinitionRecord,
  next: ScheduleRow | null | undefined,
): DefinitionRecord {
  if (next === undefined) return definition;
  if (next === null) return omitFields(definition, ["pendingSchedule"]);
  const row: PendingScheduleRow = {
    occurrenceId: next.occurrenceId,
    triggerId: next.triggerId,
    scheduledForUtc: next.scheduledForUtc,
    recurrenceIndex: next.recurrenceIndex,
    overdue: false,
  };
  return { ...definition, pendingSchedule: row };
}

/**
 * 마지막 해소 장부에 페이로드 값을 합친다 — 현재 장부보다 늦을 때만 받는다. 장부는 줄지 않는다: 해소가
 * 미도래 취소 ID 회차를 잃는 회차로 기록해 장부가 앞서 오른 뒤, 같은 해소가 보류한 더 이른 회차의 해제나
 * 개정 건너뜀이 장부를 내리면 다음 개정 탐색이 같은 잃는 회차를 다시 만나 두 번 기록한다.
 */
function laterResolved(
  current: DefinitionRecord,
  candidate: ResolvedScheduleRef | undefined,
): { readonly lastResolvedSchedule?: ResolvedScheduleRef } {
  if (candidate === undefined) return {};
  const ledger = current.lastResolvedSchedule;
  if (
    ledger !== undefined &&
    instantMs(candidate.scheduledForUtc) <= instantMs(ledger.scheduledForUtc)
  ) {
    return {};
  }
  return { lastResolvedSchedule: candidate };
}

function withoutOpenAttempt(current: TaskRecord): TaskRecord {
  return omitFields(current, ["openAttempt"]);
}

function withoutPendingDecision(current: TaskRecord): TaskRecord {
  return omitFields(current, ["pendingDecision", "parkedAttemptId"]);
}

/** 종결 이벤트 — 열린 attempt·주차 attempt 를 함께 닫는다. */
function withoutOpenAttemptOrPark(current: TaskRecord): TaskRecord {
  return omitFields(current, ["openAttempt", "parkedAttemptId"]);
}

/**
 * 한 커밋(같은 `commit.id`)의 이벤트를 순서대로 적용한다. 첫 커밋은 `work_created` 여야 한다.
 * 입력 이벤트 열을 신뢰한다 — 엔진 커밋이나 그 저장 로그를 재생한다는 전제이고, 페이로드의 의미·출처를 다시 판정하지 않는다.
 */
export function evolveCommit(
  aggregate: WorkAggregate | undefined,
  events: readonly DomainEvent[],
): WorkAggregate {
  if (events.length === 0) {
    if (aggregate === undefined) throw new Error("evolve: 빈 커밋으로 애그리거트를 만들 수 없다");
    return aggregate;
  }

  const hasMutation = events.some((e) => !RECORD_ONLY_SET.has(e.type));
  const baseCommitSeq = aggregate?.commitSeq ?? 0;
  const commitSeq = hasMutation ? baseCommitSeq + 1 : baseCommitSeq;
  const lastEvent = events[events.length - 1] as DomainEvent;

  function terminalRefOf(event: DomainEvent): TerminalEventRef {
    return {
      eventId: event.id as EventId,
      occurredAt: event.occurredAt,
      position: { commitSeq, index: event.commit.index },
    };
  }

  let work: WorkRecord | undefined = aggregate?.work;
  let tasks: Record<string, TaskRecord> = aggregate?.tasks ?? {};
  let decisionSubjects: Record<string, DecisionSubjectRef> = aggregate
    ? { ...aggregate.decisionSubjects }
    : {};
  let acceptedSignalKeys: SignalDedupKey[] = aggregate ? [...aggregate.acceptedSignalKeys] : [];
  let definition: DefinitionRecord | undefined = aggregate?.definition;

  const mutatedTaskIds = new Set<TaskId>();
  let workMutated = false;
  let definitionTransitioned = false;

  for (const event of events) {
    const recordOnly = RECORD_ONLY_SET.has(event.type);
    if (!recordOnly && WORK_EVENT_SET.has(event.type)) workMutated = true;
    if (event.taskId !== undefined && bumpsTaskRevision(event)) mutatedTaskIds.add(event.taskId);
    if (DEFINITION_TRANSITION_EVENT_SET.has(event.type)) definitionTransitioned = true;

    switch (event.type) {
      case "work_created": {
        const p = event.payload;
        work = {
          id: p.workId,
          projectId: event.projectId as unknown as WorkRecord["projectId"],
          title: p.title,
          objective: p.objective,
          state: "DRAFT",
          revision: 0,
          taskIds: [],
          planRevision: 0,
          memberTaskIds: [],
          source: p.source as WorkRecord["source"],
          completionPolicyVersion: 1,
          startedUnderCurrentRevision: false,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
          correlationId: p.correlationId,
        };
        break;
      }
      case "work_planning_started":
        work = { ...(work as WorkRecord), state: "PLANNING" };
        break;
      case "work_input_requested":
        work = { ...(work as WorkRecord), state: "WAITING_INPUT" };
        break;
      case "work_input_received":
        work = { ...(work as WorkRecord), state: "PLANNING" };
        break;
      case "work_plan_proposed": {
        const p = event.payload;
        const w = work as WorkRecord;
        work = {
          ...w,
          state: "WAITING_APPROVAL",
          pendingProposalId: p.proposalId,
          pendingProposalDigest: p.digest,
          pendingProposal: p.proposal,
          pendingDecision: p.decision,
        };
        decisionSubjects = { ...decisionSubjects, [p.decision.id]: { workId: w.id } };
        break;
      }
      case "work_plan_rejected": {
        const w = work as WorkRecord;
        work = {
          ...omitFields(w, [
            "pendingDecision",
            "pendingProposalId",
            "pendingProposalDigest",
            "pendingProposal",
          ]),
          state: w.planRevision === 0 ? "PLANNING" : "READY",
        };
        break;
      }
      case "work_plan_withdrawn": {
        const w = work as WorkRecord;
        work = {
          ...omitFields(w, [
            "pendingDecision",
            "pendingProposalId",
            "pendingProposalDigest",
            "pendingProposal",
          ]),
          state: "PLANNING",
        };
        break;
      }
      case "work_plan_invalid":
        // 상태 불변 — Work 이벤트라 커밋 단위 Work revision 은 오른다(계약 Work revision 규칙).
        break;
      case "work_plan_committed": {
        const p = event.payload;
        const w = work as WorkRecord;
        const newTaskIds = p.draftRefMap.map((m) => m.taskId);
        work = {
          ...omitFields(w, [
            "pendingDecision",
            "pendingProposalId",
            "pendingProposalDigest",
            "pendingProposal",
          ]),
          state: "READY",
          planRevision: p.planRevision,
          taskIds: [...w.taskIds, ...newTaskIds],
          memberTaskIds: [...p.retained, ...newTaskIds],
          startedUnderCurrentRevision: false,
        };
        break;
      }
      case "work_replanning_started":
        work = { ...(work as WorkRecord), state: "PLANNING" };
        break;
      case "work_ready":
        // 상태는 계획 커밋·재계획 닫힘 이벤트가 이미 READY 로 설정 — work_ready 는 동반 이벤트일 뿐 필드 변경 없음.
        break;
      case "work_activated":
        work = { ...(work as WorkRecord), state: "ACTIVE", startedUnderCurrentRevision: true };
        break;
      case "work_blocked":
        // 계약 파생 상태 3항("ACTIVE 이거나 BLOCKED 이었던 이래 현재 계획 revision 아래")·
        // design.md §6 — ACTIVE 뿐 아니라 BLOCKED 진입도 true 로 둔다.
        work = { ...(work as WorkRecord), state: "BLOCKED", startedUnderCurrentRevision: true };
        break;
      case "work_unblocked":
        work = { ...(work as WorkRecord), state: "ACTIVE", startedUnderCurrentRevision: true };
        break;
      case "work_completed":
        work = { ...(work as WorkRecord), state: "COMPLETED" };
        break;
      case "work_failed":
        work = { ...(work as WorkRecord), state: "FAILED", failureCause: event.payload.cause };
        break;
      case "work_canceled":
        work = { ...(work as WorkRecord), state: "CANCELED" };
        break;

      case "task_created": {
        const p = event.payload;
        const w = work as WorkRecord;
        const task: TaskRecord = {
          id: p.taskId,
          workId: w.id,
          projectId: w.projectId,
          draftRef: p.draftRef,
          type: p.type,
          title: p.title,
          input: p.input,
          state: "DRAFT",
          revision: 0,
          dependsOn: p.dependsOn,
          ...(p.parentTaskId !== undefined ? { parentTaskId: p.parentTaskId } : {}),
          trigger: p.trigger,
          policy: p.policy,
          reactions: p.reactions,
          inputBindings: p.inputBindings ?? {},
          preExecutionApproved: false,
          lateResults: [],
          lastAttemptNo: 0,
          dependencyActivated: false,
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
          correlationId: w.correlationId,
        };
        tasks = { ...tasks, [task.id]: task };
        break;
      }
      case "task_validation_started":
        tasks = patchTask(tasks, requireTaskId(event), { state: "VALIDATING" });
        break;
      case "task_validated":
        tasks = patchTask(tasks, requireTaskId(event), { state: "READY" });
        break;
      case "task_validation_failed":
        tasks = patchTask(tasks, requireTaskId(event), {
          state: "FAILED",
          terminalRef: terminalRefOf(event),
        });
        break;
      case "task_input_requested":
        tasks = patchTask(tasks, requireTaskId(event), { state: "WAITING_INPUT" });
        break;
      case "task_input_received":
        tasks = patchTask(tasks, requireTaskId(event), { state: "VALIDATING" });
        break;
      case "task_scheduled": {
        const p = event.payload;
        const taskId = requireTaskId(event);
        // 수용 참조는 예약 하나에만 쓰인다 — 원인과 무관하게 예약이 소비한다.
        const current = omitFields(tasks[taskId] as TaskRecord, ["pendingSignalAcceptance"]);
        tasks = replaceTask(tasks, taskId, {
          ...current,
          state: "SCHEDULED",
          scheduledOccurrenceId: p.occurrenceId,
          ...(p.cause === "dependency_satisfaction" ? { dependencyActivated: true } : {}),
        });
        break;
      }
      case "task_unscheduled": {
        const taskId = requireTaskId(event);
        const current = omitFields(tasks[taskId] as TaskRecord, ["scheduledOccurrenceId"]);
        tasks = { ...tasks, [taskId]: { ...current, state: "READY" } };
        break;
      }
      case "task_started": {
        const p = event.payload;
        const taskId = requireTaskId(event);
        const current = tasks[taskId] as TaskRecord;
        tasks = patchTask(tasks, taskId, {
          state: "RUNNING",
          openAttempt: {
            attemptId: p.attemptId,
            attemptNo: p.attemptNo,
            startedAt: event.occurredAt,
            deadline: p.deadline,
          },
          lastAttemptNo: Math.max(current.lastAttemptNo, p.attemptNo),
          ...(p.boundInputs !== undefined ? { boundInputs: p.boundInputs } : {}),
        });
        break;
      }
      case "task_waiting_confirmation": {
        const p = event.payload;
        tasks = patchTask(tasks, requireTaskId(event), {
          state: "WAITING_CONFIRMATION",
          confirmationId: p.confirmationId,
          ...(p.boundInputs !== undefined ? { boundInputs: p.boundInputs } : {}),
        });
        break;
      }
      case "task_retry_wait": {
        const taskId = requireTaskId(event);
        tasks = replaceTask(tasks, taskId, {
          ...withoutOpenAttempt(tasks[taskId] as TaskRecord),
          state: "RETRY_WAIT",
          lastRetryWait: { occurredAt: event.occurredAt, attemptNo: event.payload.attemptNo },
        });
        break;
      }
      case "task_retry_ready":
        tasks = patchTask(tasks, requireTaskId(event), { state: "READY" });
        break;
      case "task_awaiting_human": {
        const p = event.payload;
        const taskId = requireTaskId(event);
        tasks = replaceTask(tasks, taskId, {
          ...omitFields(tasks[taskId] as TaskRecord, ["openAttempt", "parkedAttemptId"]),
          state: "BLOCKED_AWAITING_HUMAN",
          pendingDecision: p.pendingDecision,
          ...(p.attemptId !== undefined ? { parkedAttemptId: p.attemptId } : {}),
        });
        decisionSubjects = { ...decisionSubjects, [p.pendingDecision.id]: { taskId } };
        break;
      }
      case "human_decision_granted": {
        const p = event.payload;
        const taskId = requireTaskId(event);
        const current = tasks[taskId] as TaskRecord;
        const approvedNow = current.pendingDecision?.kind === "pre_execution_approval";
        const base = {
          ...withoutPendingDecision(current),
          ...(approvedNow ? { preExecutionApproved: true } : {}),
        };
        tasks = replaceTask(
          tasks,
          taskId,
          p.resumedTo === "SCHEDULED"
            ? {
                ...base,
                state: "SCHEDULED",
                ...(p.occurrenceId !== undefined ? { scheduledOccurrenceId: p.occurrenceId } : {}),
              }
            : { ...base, state: "READY" },
        );
        break;
      }
      case "human_decision_denied": {
        const p = event.payload;
        if (p.role === "transition") {
          const taskId = requireTaskId(event);
          const base = withoutPendingDecision(tasks[taskId] as TaskRecord);
          tasks = replaceTask(tasks, taskId, {
            ...base,
            state: "REJECTED",
            terminalRef: terminalRefOf(event),
          });
        }
        break;
      }
      case "task_blocked":
        tasks = patchTask(tasks, requireTaskId(event), {
          state: "BLOCKED",
          blockReason: event.payload.blockReason,
        });
        break;
      case "task_unblocked": {
        const taskId = requireTaskId(event);
        const current = omitFields(tasks[taskId] as TaskRecord, ["blockReason"]);
        tasks = { ...tasks, [taskId]: { ...current, state: "VALIDATING" } };
        break;
      }
      case "task_completed": {
        const taskId = requireTaskId(event);
        tasks = replaceTask(tasks, taskId, {
          ...withoutOpenAttemptOrPark(tasks[taskId] as TaskRecord),
          state: "COMPLETED",
          result: { ...event.payload.result, taskId, eventId: event.id as EventId },
          terminalRef: terminalRefOf(event),
        });
        break;
      }
      case "task_failed": {
        const taskId = requireTaskId(event);
        tasks = replaceTask(tasks, taskId, {
          ...withoutOpenAttemptOrPark(tasks[taskId] as TaskRecord),
          state: "FAILED",
          terminalRef: terminalRefOf(event),
        });
        break;
      }
      case "task_expired": {
        const taskId = requireTaskId(event);
        tasks = replaceTask(tasks, taskId, {
          ...withoutOpenAttemptOrPark(tasks[taskId] as TaskRecord),
          state: "EXPIRED",
          terminalRef: terminalRefOf(event),
        });
        break;
      }
      case "task_canceled": {
        const p = event.payload;
        const taskId = requireTaskId(event);
        tasks = replaceTask(tasks, taskId, {
          ...withoutOpenAttemptOrPark(tasks[taskId] as TaskRecord),
          state: "CANCELED",
          cancelOrigin: p.origin,
          terminalRef: terminalRefOf(event),
        });
        break;
      }
      case "task_skipped": {
        const taskId = requireTaskId(event);
        tasks = replaceTask(tasks, taskId, {
          ...withoutOpenAttemptOrPark(tasks[taskId] as TaskRecord),
          state: "SKIPPED",
          terminalRef: terminalRefOf(event),
        });
        break;
      }
      case "stale_transition_rejected":
        // 기록 전용 — 상태·revision 불변.
        break;

      case "reminder_occurrence_emitted":
        // 확인 대기·결정 만료 리마인더 — 상태·revision 불변.
        break;
      case "approval_surface_refused":
        // 거절 기록 — 같은 커밋의 task_blocked 가 상태를 바꾼다. 정책 값은 내려 쓰지 않는다.
        break;
      case "agent_result_unmatched": {
        const p = event.payload;
        const taskId = requireTaskId(event);
        const current = tasks[taskId] as TaskRecord;
        tasks = patchTask(tasks, taskId, {
          lateResults: [
            ...current.lateResults,
            {
              attemptId: p.attemptId,
              resultContentHash: p.resultContentHash,
              ...(p.presentedInDecisionId !== undefined
                ? { presentedInDecisionId: p.presentedInDecisionId }
                : {}),
            },
          ],
        });
        break;
      }
      case "confirmation_accepted": {
        const taskId = requireTaskId(event);
        tasks = patchTask(tasks, taskId, {
          state: "COMPLETED",
          result: { ...event.payload.result, taskId, eventId: event.id as EventId },
          terminalRef: terminalRefOf(event),
        });
        break;
      }
      case "confirmation_rejected":
        tasks = patchTask(tasks, requireTaskId(event), {
          state: "REJECTED",
          terminalRef: terminalRefOf(event),
        });
        break;
      case "confirmation_cancelled": {
        const p = event.payload;
        tasks = patchTask(tasks, requireTaskId(event), {
          state: "CANCELED",
          cancelOrigin: p.origin,
          terminalRef: terminalRefOf(event),
        });
        break;
      }
      case "confirmation_expired":
        tasks = patchTask(tasks, requireTaskId(event), {
          state: "EXPIRED",
          terminalRef: terminalRefOf(event),
        });
        break;

      case "signal_accepted": {
        const p = event.payload;
        acceptedSignalKeys = [...acceptedSignalKeys, p.dedupKey];
        if (p.signalType === "external_signal" && "taskId" in p.subject) {
          if (p.trigger === undefined) {
            throw new Error(`evolve: 외부 신호 수용 ${event.id} 에 trigger 가 없다`);
          }
          tasks = patchTask(tasks, p.subject.taskId, {
            pendingSignalAcceptance: {
              eventId: event.id as EventId,
              occurredAt: event.occurredAt,
              sourceId: p.trigger.sourceId,
              signalName: p.trigger.signalName,
            },
          });
        }
        break;
      }
      case "signal_ignored_duplicate":
      case "signal_rejected_stale":
      case "signal_rejected":
      case "confirmation_rejected_forged_provenance":
        // 기록 전용 — 상태·revision·acceptedSignalKeys 불변.
        break;

      case "work_definition_created": {
        const p = event.payload;
        if (definition !== undefined) {
          throw new Error(`evolve: Work 가 이미 정의 ${definition.id} 를 관리한다`);
        }
        const d = p.definition;
        definition = withNextSchedule(
          {
            id: d.id,
            projectId: d.projectId,
            sourceWorkId: d.sourceWorkId,
            state: "ACTIVE",
            revision: 0,
            title: d.title,
            activation: d.activation,
            template: d.template,
            maxOpenOccurrences: d.maxOpenOccurrences,
            ...(d.maxOccurrences !== undefined ? { maxOccurrences: d.maxOccurrences } : {}),
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
            correlationId: d.correlationId,
            held: [],
            materialized: [],
            retiredOccurrenceIds: [],
          },
          p.nextSchedule,
        );
        break;
      }
      case "work_definition_revised": {
        const p = event.payload;
        const current = omitFields(requireDefinition(definition, p.definitionId, event.type), [
          "maxOccurrences",
        ]);
        definition = withNextSchedule(
          {
            ...current,
            title: p.title,
            activation: p.activation,
            template: p.template,
            maxOpenOccurrences: p.maxOpenOccurrences,
            ...(p.maxOccurrences !== undefined ? { maxOccurrences: p.maxOccurrences } : {}),
          },
          p.nextSchedule,
        );
        break;
      }
      case "work_definition_paused": {
        const p = event.payload;
        const current = requireDefinition(definition, p.definitionId, event.type);
        definition = { ...current, state: "PAUSED", pauseOrigin: p.pauseOrigin };
        break;
      }
      case "work_definition_resumed": {
        const p = event.payload;
        const current = omitFields(requireDefinition(definition, p.definitionId, event.type), [
          "pauseOrigin",
        ]);
        const row = current.pendingSchedule;
        definition = {
          ...current,
          state: "ACTIVE",
          ...(row !== undefined
            ? { pendingSchedule: { ...row, overdue: p.pendingScheduleOverdue } }
            : {}),
        };
        break;
      }
      case "work_definition_stopped": {
        const p = event.payload;
        const current = omitFields(requireDefinition(definition, p.definitionId, event.type), [
          "pendingSchedule",
        ]);
        definition = { ...current, state: "STOPPED", stopOrigin: p.stopOrigin };
        break;
      }
      case "work_definition_occurrence_held": {
        const p = event.payload;
        const current = requireDefinition(definition, p.definitionId, event.type);
        definition = withNextSchedule(
          { ...current, held: [...current.held, p.occurrence] },
          p.nextSchedule,
        );
        break;
      }
      case "work_definition_occurrences_skipped": {
        const p = event.payload;
        const current = requireDefinition(definition, p.definitionId, event.type);
        const skippedHeld = new Set<string>(p.heldOccurrenceIds);
        definition = withNextSchedule(
          {
            ...current,
            held: current.held.filter((h) => !skippedHeld.has(h.occurrenceId)),
            ...laterResolved(current, p.lastResolvedSchedule),
          },
          p.nextSchedule,
        );
        break;
      }
      case "trigger_fired": {
        const p = event.payload;
        const current = requireDefinition(definition, p.definitionId, event.type);
        definition = withNextSchedule(
          {
            ...current,
            materialized: [
              ...current.materialized,
              {
                occurrenceId: p.occurrenceId,
                workId: p.workId,
                definitionRevision: p.definitionRevision,
              },
            ],
            held: p.released
              ? current.held.filter((h) => h.occurrenceId !== p.occurrenceId)
              : current.held,
            ...laterResolved(
              current,
              p.recurrenceIndex !== undefined
                ? { scheduledForUtc: p.originalInstant, recurrenceIndex: p.recurrenceIndex }
                : undefined,
            ),
          },
          p.nextSchedule,
        );
        break;
      }
      case "trigger_canceled": {
        const p = event.payload;
        const current = requireDefinition(definition, p.definitionId, event.type);
        const base =
          current.pendingSchedule?.occurrenceId === p.occurrenceId
            ? omitFields(current, ["pendingSchedule"])
            : current;
        definition = {
          ...base,
          retiredOccurrenceIds: [...base.retiredOccurrenceIds, p.occurrenceId],
        };
        break;
      }

      default: {
        const exhaustive: never = event;
        throw new Error(
          `evolve: 알 수 없는 이벤트 타입 ${String((exhaustive as DomainEvent).type)}`,
        );
      }
    }
  }

  if (work === undefined) {
    throw new Error("evolve: 첫 커밋은 work_created 여야 한다");
  }

  const finalTasks: Record<string, TaskRecord> = { ...tasks };
  for (const taskId of mutatedTaskIds) {
    const current = finalTasks[taskId];
    if (current === undefined) continue;
    finalTasks[taskId] = {
      ...current,
      revision: current.revision + 1,
      updatedAt: lastEvent.occurredAt,
    };
  }

  let finalWork = work;
  if (workMutated) {
    finalWork = { ...finalWork, revision: finalWork.revision + 1, updatedAt: lastEvent.occurredAt };
  }

  let finalDefinition = definition;
  if (definitionTransitioned && finalDefinition !== undefined) {
    finalDefinition = {
      ...finalDefinition,
      revision: finalDefinition.revision + 1,
      updatedAt: lastEvent.occurredAt,
    };
  }

  return {
    work: finalWork,
    tasks: finalTasks,
    acceptedSignalKeys,
    decisionSubjects,
    commitSeq,
    ...(finalDefinition !== undefined ? { definition: finalDefinition } : {}),
  };
}
