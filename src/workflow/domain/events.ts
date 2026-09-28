/**
 * envelope·이벤트 페이로드 타입·이벤트 타입 분류(FR-015) — the workflow contract "Event type catalog"
 * 그대로. 카탈로그 밖 이벤트 타입이나 상태 이름은 무시하지 않고 실패로 드러낸다(fold.ts).
 */
import { type Result, ok, err } from "./result.js";
import { EVENT_CATALOG } from "./contract/index.js";
import type { UnknownNameError } from "./task-state.js";
import type {
  TaskId,
  WorkId,
  CommitId,
  PlanProposalId,
  ConfirmationId,
  DecisionId,
  AttemptId,
  SignalId,
  OccurrenceId,
} from "./ids.js";
import type { UtcInstant, ActorSource, ActorRef, CancelOrigin } from "./values.js";
import type { PendingDecision } from "./pending-decision.js";
import type { TriggerSpec } from "./trigger.js";
import type { TaskPolicy } from "./task-policy.js";
import type { TaskBlockReason, AttemptOutcome } from "./commands.js";
import type { SignalDedupKey } from "./derivation/dedup-key.js";
import type { StaleReason, NonStaleReason } from "./engine.js";

export const WORKFLOW_EVENT_SCHEMA_VERSION = 1;

export interface WorkflowEventEnvelope<T = unknown> {
  readonly schemaVersion: number;
  readonly id: string;
  readonly type: string;
  readonly occurredAt: UtcInstant;
  readonly projectId: string;
  readonly workId?: WorkId;
  readonly taskId?: TaskId;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly actor?: ActorRef;
  readonly actorSource: ActorSource;
  readonly commit: { readonly id: CommitId; readonly index: number; readonly count: number };
  readonly payload: T;
}

export type CatalogEventType = (typeof EVENT_CATALOG)[number]["name"];

/** `producedBy = "phase1-core"` 파생 50종. */
export type DomainEventType =
  | "work_created"
  | "work_planning_started"
  | "work_plan_proposed"
  | "work_plan_rejected"
  | "work_plan_withdrawn"
  | "work_plan_invalid"
  | "work_input_requested"
  | "work_input_received"
  | "work_plan_committed"
  | "work_replanning_started"
  | "work_ready"
  | "work_activated"
  | "work_blocked"
  | "work_unblocked"
  | "work_completed"
  | "work_failed"
  | "work_canceled"
  | "task_created"
  | "task_validation_started"
  | "task_validated"
  | "task_validation_failed"
  | "task_input_requested"
  | "task_input_received"
  | "task_scheduled"
  | "task_unscheduled"
  | "task_started"
  | "task_waiting_confirmation"
  | "task_retry_wait"
  | "task_retry_ready"
  | "task_awaiting_human"
  | "human_decision_granted"
  | "human_decision_denied"
  | "task_blocked"
  | "task_unblocked"
  | "task_completed"
  | "task_failed"
  | "task_expired"
  | "task_canceled"
  | "task_skipped"
  | "stale_transition_rejected"
  | "reminder_occurrence_emitted"
  | "signal_accepted"
  | "signal_ignored_duplicate"
  | "signal_rejected_stale"
  | "signal_rejected"
  | "confirmation_accepted"
  | "confirmation_rejected"
  | "confirmation_cancelled"
  | "confirmation_expired"
  | "confirmation_rejected_forged_provenance";

export type SignalTypeName =
  | "confirmation_decision"
  | "human_decision"
  | "cancel_requested"
  | "replan_requested"
  | "delegation_response";

export type SignalSubjectRef = { readonly taskId: TaskId } | { readonly workId: WorkId };

export interface DraftRefMapping {
  readonly draftRef: string;
  readonly taskId: TaskId;
}

export type TaskFailedReason =
  | {
      readonly kind: "attempt_failed";
      readonly attemptId: AttemptId;
      readonly attemptNo: number;
      readonly outcome: AttemptOutcome;
    }
  | { readonly kind: "retry_budget_exhausted" }
  | { readonly kind: "retries_abandoned" }
  | { readonly kind: "dependency_unsatisfied"; readonly dependencyTaskIds: readonly TaskId[] }
  | { readonly kind: "decision_discarded"; readonly decisionId: DecisionId };

export type TaskSkippedReason =
  | { readonly kind: "dependency_unsatisfied"; readonly dependencyTaskIds: readonly TaskId[] }
  | { readonly kind: "misfire_skip"; readonly occurrenceId?: OccurrenceId };

/** design.md §데이터 모델 "이벤트 envelope 와 페이로드" 표 그대로. */
export interface EventPayloadMap {
  work_created: {
    readonly workId: WorkId;
    readonly projectId: string;
    readonly title: string;
    readonly objective: string;
    readonly source: unknown;
    readonly completionPolicyVersion: 1;
    readonly correlationId: string;
  };
  work_planning_started: Record<string, never>;
  work_plan_proposed: {
    readonly proposalId: PlanProposalId;
    readonly digest: string;
    readonly decision: PendingDecision;
  };
  work_plan_rejected: {
    readonly proposalId: PlanProposalId;
    readonly decisionId?: DecisionId;
    readonly closesReplan: boolean;
  };
  work_plan_withdrawn: {
    readonly proposalId: PlanProposalId;
    readonly decisionId?: DecisionId;
    readonly cause: "no_longer_validates" | "source_changed";
  };
  work_plan_invalid: { readonly proposalId?: PlanProposalId; readonly issues: readonly unknown[] };
  work_input_requested: { readonly requests: readonly unknown[] };
  work_input_received: Record<string, never>;
  work_plan_committed: {
    readonly proposalId: PlanProposalId;
    readonly digest: string;
    readonly planRevision: number;
    readonly decisionId?: DecisionId;
    readonly draftRefMap: readonly DraftRefMapping[];
    readonly retained: readonly TaskId[];
    readonly superseded: readonly TaskId[];
    readonly dropped: readonly TaskId[];
  };
  work_replanning_started: { readonly signalId: SignalId };
  work_ready: Record<string, never>;
  work_activated: Record<string, never>;
  work_blocked: { readonly unsatisfiedRequiredTaskIds: readonly TaskId[] };
  work_unblocked: Record<string, never>;
  work_completed: { readonly completionPolicyVersion: 1 };
  work_failed: { readonly cause: "planning_failed" | "declared_failure_policy" };
  work_canceled: { readonly origin: CancelOrigin };
  task_created: {
    readonly taskId: TaskId;
    readonly draftRef: string;
    readonly type: { readonly id: string; readonly version: number };
    readonly title: string;
    readonly input: unknown;
    readonly dependsOn: readonly TaskId[];
    readonly parentTaskId?: TaskId;
    readonly trigger: TriggerSpec;
    readonly policy: TaskPolicy;
  };
  task_validation_started: Record<string, never>;
  task_validated: Record<string, never>;
  task_validation_failed: { readonly issues: readonly unknown[] };
  task_input_requested: { readonly requests: readonly unknown[] };
  task_input_received: Record<string, never>;
  task_scheduled: {
    readonly occurrenceId: OccurrenceId;
    readonly cause: "schedule" | "signal" | "retry" | "dependencies_complete";
    readonly causingEventId?: string;
  };
  task_unscheduled: { readonly invalidatedOccurrenceId: OccurrenceId };
  task_started: {
    readonly attemptId: AttemptId;
    readonly attemptNo: number;
    readonly deadline: UtcInstant;
    readonly firedOccurrenceId?: OccurrenceId;
  };
  task_waiting_confirmation: { readonly confirmationId: ConfirmationId };
  task_retry_wait: {
    readonly attemptId: AttemptId;
    readonly attemptNo: number;
    readonly retryDelayMs: number;
    readonly outcome: AttemptOutcome;
  };
  task_retry_ready: Record<string, never>;
  task_awaiting_human: {
    readonly pendingDecision: PendingDecision;
    readonly cause:
      | "approval_required_before_execute"
      | "unattended_eligibility_refused"
      | "gate_denied"
      | "executor_blocked"
      | "dispatcher_refused"
      | "effect_dead_lettered";
    readonly attemptId?: AttemptId;
    readonly outcome?: AttemptOutcome;
  };
  human_decision_granted: {
    readonly decisionId: DecisionId;
    readonly resumedTo: "READY" | "SCHEDULED";
    readonly occurrenceId?: OccurrenceId;
  };
  human_decision_denied: {
    readonly decisionId: DecisionId;
    readonly role: "transition" | "companion";
  };
  task_blocked: { readonly blockReason: TaskBlockReason };
  task_unblocked: Record<string, never>;
  task_completed: { readonly attemptId?: AttemptId; readonly evidence?: unknown };
  task_failed: { readonly reason: TaskFailedReason };
  task_expired: {
    readonly basis: "task_validity" | "decision_expiry";
    readonly closedAttemptId?: AttemptId;
    readonly attemptOutcome?: AttemptOutcome;
  };
  task_canceled: { readonly origin: CancelOrigin; readonly closedAttemptId?: AttemptId };
  task_skipped: { readonly reason: TaskSkippedReason; readonly closedAttemptId?: AttemptId };
  stale_transition_rejected: {
    readonly commandKind: string;
    readonly reason: "terminal_subject" | "revision_mismatch";
    readonly observedState: string;
    readonly currentRevision: number;
    readonly expectedRevision: number;
  };
  reminder_occurrence_emitted: { readonly occurrenceId: OccurrenceId };
  signal_accepted: {
    readonly signalId: SignalId;
    readonly signalType: SignalTypeName;
    readonly dedupKey: SignalDedupKey;
    readonly subject: SignalSubjectRef;
  };
  signal_ignored_duplicate: {
    readonly signalId: SignalId;
    readonly signalType: SignalTypeName;
    readonly dedupKey: SignalDedupKey;
    readonly subject: SignalSubjectRef;
  };
  signal_rejected_stale: {
    readonly signalId: SignalId;
    readonly signalType: SignalTypeName;
    readonly candidateKey: SignalDedupKey;
    readonly subject: SignalSubjectRef;
    readonly reason: StaleReason;
    readonly observedState: string;
    readonly comparedRevision: number;
    readonly currentRevision: number;
    readonly token?: string;
  };
  signal_rejected: {
    readonly signalId: SignalId;
    readonly signalType: SignalTypeName;
    readonly candidateKey: SignalDedupKey;
    readonly subject: SignalSubjectRef;
    readonly reason: NonStaleReason;
    readonly observedState: string;
  };
  confirmation_accepted: { readonly confirmationId: ConfirmationId; readonly signalId: SignalId };
  confirmation_rejected: { readonly confirmationId: ConfirmationId; readonly signalId: SignalId };
  confirmation_cancelled: {
    readonly confirmationId: ConfirmationId;
    readonly origin: CancelOrigin;
  };
  confirmation_expired: { readonly confirmationId: ConfirmationId };
  confirmation_rejected_forged_provenance: {
    readonly signalId: SignalId;
    readonly signalType: SignalTypeName;
    readonly candidateKey: SignalDedupKey;
    readonly subject: SignalSubjectRef;
    readonly determinedActorSource: ActorSource;
    readonly provenance?: import("./values.js").ProvenanceEvidence;
  };
}

/** 컴파일 검사 — 페이로드 맵의 키가 `DomainEventType` 과 정확히 같음(양방향 `extends`). */
type AssertExactKeys<Keys extends PropertyKey, Expected extends PropertyKey> = [Keys] extends [
  Expected,
]
  ? [Expected] extends [Keys]
    ? true
    : never
  : never;
const _payloadKeysMatchDomainEventType: AssertExactKeys<keyof EventPayloadMap, DomainEventType> =
  true;
void _payloadKeysMatchDomainEventType;

export type DomainEvent = {
  [K in DomainEventType]: WorkflowEventEnvelope<EventPayloadMap[K]> & { readonly type: K };
}[DomainEventType];

/**
 * decide 단계가 만드는 "주 이벤트" — envelope 이전의 판정 결과(engine.ts 가 envelope 을 부여한다,
 * §3 커밋 파이프라인 단계 6). `type`·`payload` 는 `DomainEvent` 와 같은 판별 유니온이다.
 */
export type DecidedEvent = {
  [K in DomainEventType]: {
    readonly type: K;
    readonly payload: EventPayloadMap[K];
    readonly taskId?: TaskId;
    readonly workId?: WorkId;
  };
}[DomainEventType];

export function mkEvent<K extends DomainEventType>(
  type: K,
  payload: EventPayloadMap[K],
  target: { readonly taskId?: TaskId; readonly workId?: WorkId } = {},
): DecidedEvent {
  return { type, payload, ...target } as DecidedEvent;
}

/** 카탈로그 "Work events" 절 파생. */
export const WORK_EVENT_TYPES: readonly DomainEventType[] = [
  "work_created",
  "work_planning_started",
  "work_plan_proposed",
  "work_plan_rejected",
  "work_plan_withdrawn",
  "work_plan_invalid",
  "work_input_requested",
  "work_input_received",
  "work_plan_committed",
  "work_replanning_started",
  "work_ready",
  "work_activated",
  "work_blocked",
  "work_unblocked",
  "work_completed",
  "work_failed",
  "work_canceled",
];

/** ADR-004 의 5종 — 기록 전용(비변이) 이벤트. */
export const RECORD_ONLY_EVENT_TYPES: readonly DomainEventType[] = [
  "stale_transition_rejected",
  "signal_ignored_duplicate",
  "signal_rejected_stale",
  "signal_rejected",
  "confirmation_rejected_forged_provenance",
];

const CATALOG_NAME_SET: ReadonlySet<string> = new Set(EVENT_CATALOG.map((row) => row.name));

export function parseEventType(raw: string): Result<CatalogEventType, UnknownNameError> {
  if (!CATALOG_NAME_SET.has(raw)) {
    return err({ kind: "unknown_name", domain: "event_type", raw });
  }
  return ok(raw as CatalogEventType);
}
