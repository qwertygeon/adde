/**
 * envelope·이벤트 페이로드 타입·이벤트 타입 분류(FR-015) — the workflow contract "Event type catalog"
 * 그대로. 카탈로그 밖 이벤트 타입이나 상태 이름은 무시하지 않고 실패로 드러낸다(fold.ts).
 */
import { type Result, ok, err } from "./result.js";
import { EVENT_CATALOG, TASK_TRANSITION_ROWS } from "./contract/index.js";
import type { EventProducer } from "./contract/index.js";
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
  WorkDefinitionId,
  ProjectId,
} from "./ids.js";
import type { UtcInstant, ActorSource, ActorRef, CancelOrigin } from "./values.js";
import type { PendingDecision } from "./pending-decision.js";
import type { TriggerSpec } from "./trigger.js";
import type { TaskPolicy } from "./task-policy.js";
import type { TaskBlockReason, AttemptOutcome } from "./commands.js";
import type { SignalDedupKey, ContentHash } from "./derivation/dedup-key.js";
import type { InputRequest } from "./registry/descriptors.js";
import type { ValidationIssue } from "./validation/task-validation.js";
import type { ReactionSpec } from "./validation/reaction-spec.js";
import type { ApprovalSurfaceRefusalReason } from "./policy/approval-surface.js";
import type { StaleReason, NonStaleReason } from "./engine.js";
import type { PlanProposal } from "./plan/proposal.js";
import type { PlanValidationIssue } from "./plan-graph.js";
import type { InputBinding, BoundInput } from "./task-result/binding.js";
import type { RecordedTaskResult } from "./task-result/outputs.js";
import type {
  DefinitionPauseOrigin,
  DefinitionStopOrigin,
  HeldOccurrence,
  HoldCause,
  ResolvedScheduleRef,
  ScheduleRow,
  SkipReason,
} from "./definition/model.js";
import type { ProposedTaskDraft } from "./plan/proposal.js";

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

/** 도메인이 생산하는 이벤트 — 카탈로그 `producedBy` 가 `DOMAIN_EVENT_PRODUCERS` 인 행. */
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
  | "confirmation_rejected_forged_provenance"
  | "approval_surface_refused"
  | "agent_result_unmatched"
  | "work_definition_created"
  | "work_definition_revised"
  | "work_definition_paused"
  | "work_definition_resumed"
  | "work_definition_stopped"
  | "work_definition_occurrence_held"
  | "work_definition_occurrences_skipped"
  | "trigger_fired"
  | "trigger_canceled";

export const DOMAIN_EVENT_PRODUCERS: readonly EventProducer[] = [
  "phase1-core",
  "phase1-registries",
  "phase1-plans-definitions",
];

export type SignalTypeName =
  | "confirmation_decision"
  | "human_decision"
  | "cancel_requested"
  | "replan_requested"
  | "delegation_response"
  | "definition_control"
  | "external_signal";

export type SignalSubjectRef =
  | { readonly taskId: TaskId }
  | { readonly workId: WorkId }
  | { readonly definitionId: WorkDefinitionId };

/** 외부 신호가 관측·일치시킨 Trigger 정체(출처·신호 이름). */
export interface SignalTriggerRef {
  readonly sourceId: string;
  readonly signalName: string;
}

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
    /** 승인 대기 동안 Work 가 보유하는 제안 내용 전체. */
    readonly proposal: PlanProposal;
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
    /** 재검증 무효로 철회할 때 그 이슈. */
    readonly issues?: readonly PlanValidationIssue[];
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
    /** 정의 템플릿에서 만든 회차 Work 의 첫 계획에만. */
    readonly source?: "definition_template";
  };
  work_replanning_started: { readonly signalId: SignalId };
  work_ready: Record<string, never>;
  work_activated: Record<string, never>;
  work_blocked: { readonly unsatisfiedRequiredTaskIds: readonly TaskId[] };
  work_unblocked: Record<string, never>;
  work_completed: {
    readonly completionPolicyVersion: 1;
    /** 관리 Work 의 완료에만 — 정의의 중지 출처. */
    readonly stopOrigin?: DefinitionStopOrigin;
  };
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
    readonly reactions: readonly ReactionSpec[];
    /** `{taskId}` 로 해석된 결합. 비면 생략. */
    readonly inputBindings?: Readonly<Record<string, InputBinding>>;
  };
  task_validation_started: Record<string, never>;
  task_validated: Record<string, never>;
  task_validation_failed: { readonly issues: readonly ValidationIssue[] };
  task_input_requested: { readonly requests: readonly InputRequest[] };
  task_input_received: Record<string, never>;
  task_scheduled: {
    readonly occurrenceId: OccurrenceId;
    readonly cause: "schedule" | "external_signal" | "retry" | "dependency_satisfaction";
    readonly causingEventId?: string;
  };
  task_unscheduled: { readonly invalidatedOccurrenceId: OccurrenceId };
  task_started: {
    readonly attemptId: AttemptId;
    readonly attemptNo: number;
    readonly deadline: UtcInstant;
    readonly firedOccurrenceId?: OccurrenceId;
    /** 첫 효과에서만 — 결합 해석 기록(결합이 없으면 []). */
    readonly boundInputs?: readonly BoundInput[];
  };
  task_waiting_confirmation: {
    readonly confirmationId: ConfirmationId;
    /** 첫 효과에서만 — 결합 해석 기록(결합이 없으면 []). */
    readonly boundInputs?: readonly BoundInput[];
  };
  task_retry_wait: {
    readonly attemptId: AttemptId;
    readonly attemptNo: number;
    readonly retryDelayMs: number;
    readonly jitterDrawMs?: number;
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
  task_completed: {
    readonly attemptId?: AttemptId;
    readonly evidence?: unknown;
    readonly result: RecordedTaskResult;
  };
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
  reminder_occurrence_emitted: {
    readonly occurrenceId: OccurrenceId;
    readonly decisionId?: DecisionId;
  };
  signal_accepted: {
    readonly signalId: SignalId;
    readonly signalType: SignalTypeName;
    readonly dedupKey: SignalDedupKey;
    readonly subject: SignalSubjectRef;
    /** 외부 신호에만 — 일치한 출처·신호 이름. */
    readonly trigger?: SignalTriggerRef;
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
    /** 기대 revision 을 싣는 신호만(외부 신호는 생략). */
    readonly comparedRevision?: number;
    readonly currentRevision: number;
    readonly token?: string;
    /** 외부 신호에만 — 관측한 출처·신호 이름. */
    readonly trigger?: SignalTriggerRef;
  };
  signal_rejected: {
    readonly signalId: SignalId;
    readonly signalType: SignalTypeName;
    readonly candidateKey: SignalDedupKey;
    readonly subject: SignalSubjectRef;
    readonly reason: NonStaleReason;
    readonly observedState: string;
    /** 외부 신호에만 — 관측한 출처·신호 이름. */
    readonly trigger?: SignalTriggerRef;
  };
  confirmation_accepted: {
    readonly confirmationId: ConfirmationId;
    readonly signalId: SignalId;
    readonly result: RecordedTaskResult;
  };
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
  approval_surface_refused: {
    readonly declaredSurface: "out_of_band";
    readonly reason: ApprovalSurfaceRefusalReason;
  };
  agent_result_unmatched: {
    readonly attemptId: AttemptId;
    readonly reason: "unknown_dispatch" | "task_terminal" | "superseded_attempt" | "attempt_ended";
    readonly resultContentHash: ContentHash;
    readonly presentedInDecisionId?: DecisionId;
  };
  work_definition_created: {
    readonly definition: {
      readonly id: WorkDefinitionId;
      readonly projectId: ProjectId;
      readonly sourceWorkId: WorkId;
      readonly title: string;
      readonly activation: TriggerSpec;
      readonly template: readonly ProposedTaskDraft[];
      readonly maxOpenOccurrences: number;
      readonly maxOccurrences?: number;
      readonly correlationId: string;
    };
    readonly proposalId: PlanProposalId;
    /** 일정 활성화의 첫 회차. */
    readonly nextSchedule?: ScheduleRow;
  };
  work_definition_revised: {
    readonly definitionId: WorkDefinitionId;
    readonly proposalId: PlanProposalId;
    readonly title: string;
    readonly activation: TriggerSpec;
    readonly template: readonly ProposedTaskDraft[];
    readonly maxOpenOccurrences: number;
    readonly maxOccurrences?: number;
    /** 새 활성화의 첫 대기 행. 없으면 null. */
    readonly nextSchedule: ScheduleRow | null;
  };
  work_definition_paused: {
    readonly definitionId: WorkDefinitionId;
    readonly pauseOrigin: DefinitionPauseOrigin;
    /** 템플릿 무효 일시정지의 검증 이슈. */
    readonly templateIssues?: readonly PlanValidationIssue[];
  };
  work_definition_resumed: {
    readonly definitionId: WorkDefinitionId;
    readonly signalId: SignalId;
    /** 재개 시점에 대기 행이 이미 도래해 있었다. */
    readonly pendingScheduleOverdue: boolean;
  };
  work_definition_stopped: {
    readonly definitionId: WorkDefinitionId;
    readonly stopOrigin: DefinitionStopOrigin;
  };
  work_definition_occurrence_held: {
    readonly definitionId: WorkDefinitionId;
    readonly occurrenceId: OccurrenceId;
    readonly cause: HoldCause;
    readonly occurrence: HeldOccurrence;
    /** 필드 없음 = 대기 행 불변, null = 대기 행 없음, 값 = 새 대기 행. */
    readonly nextSchedule?: ScheduleRow | null;
  };
  work_definition_occurrences_skipped: {
    readonly definitionId: WorkDefinitionId;
    readonly count: number;
    readonly firstOriginalInstant: UtcInstant;
    readonly lastOriginalInstant: UtcInstant;
    readonly reason: SkipReason;
    /** 건너뛴 보류 회차(보류 순). */
    readonly heldOccurrenceIds: readonly OccurrenceId[];
    readonly lastResolvedSchedule?: ResolvedScheduleRef;
    readonly nextSchedule?: ScheduleRow | null;
  };
  trigger_fired: {
    readonly definitionId: WorkDefinitionId;
    readonly triggerId: string;
    readonly occurrenceId: OccurrenceId;
    readonly workId: WorkId;
    readonly definitionRevision: number;
    readonly originalInstant: UtcInstant;
    readonly recurrenceIndex?: number;
    /** 보류 회차의 해제. */
    readonly released: boolean;
    readonly nextSchedule?: ScheduleRow | null;
  };
  trigger_canceled: {
    readonly definitionId: WorkDefinitionId;
    readonly triggerId: string;
    readonly occurrenceId: OccurrenceId;
    readonly scheduledForUtc: UtcInstant;
    readonly recurrenceIndex: number;
    readonly reason: "definition_revised" | "definition_stopped";
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

/** 정의 전이 표의 이벤트 — 커밋에 하나라도 있으면 정의 revision 이 1 오른다. */
export const DEFINITION_TRANSITION_EVENT_TYPES: readonly DomainEventType[] = [
  "work_definition_created",
  "work_definition_revised",
  "work_definition_paused",
  "work_definition_resumed",
  "work_definition_stopped",
];

/** ADR-004 의 5종 — 기록 전용(비변이) 이벤트. */
export const RECORD_ONLY_EVENT_TYPES: readonly DomainEventType[] = [
  "stale_transition_rejected",
  "signal_ignored_duplicate",
  "signal_rejected_stale",
  "signal_rejected",
  "confirmation_rejected_forged_provenance",
];

/** 결정 만료·확인 대기 리마인더 — 상태와 revision 을 바꾸지 않는다. */
export const TASK_REMINDER_EVENT_TYPES: readonly DomainEventType[] = [
  "reminder_occurrence_emitted",
];

const DOMAIN_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  EVENT_CATALOG.filter((row) => DOMAIN_EVENT_PRODUCERS.includes(row.producedBy)).map(
    (row) => row.name,
  ),
);

const TASK_ROW_EVENT_NAMES: readonly string[] = [
  ...new Set(TASK_TRANSITION_ROWS.flatMap((row) => [row.event, ...row.companions])),
];

/** Task revision 을 올리는 이벤트 — 전이 표 행·동반 이벤트 중 도메인 생산분, 리마인더 제외. */
export const TASK_REVISION_EVENT_TYPES: readonly DomainEventType[] = TASK_ROW_EVENT_NAMES.filter(
  (name) =>
    DOMAIN_EVENT_TYPE_SET.has(name) &&
    !(TASK_REMINDER_EVENT_TYPES as readonly string[]).includes(name),
) as DomainEventType[];

const CATALOG_NAME_SET: ReadonlySet<string> = new Set(EVENT_CATALOG.map((row) => row.name));

export function parseEventType(raw: string): Result<CatalogEventType, UnknownNameError> {
  if (!CATALOG_NAME_SET.has(raw)) {
    return err({ kind: "unknown_name", domain: "event_type", raw });
  }
  return ok(raw as CatalogEventType);
}
