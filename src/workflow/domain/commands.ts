/**
 * 명령·신호·적용 입력 타입, 명령↔전이 행 매핑 표(FR-004, FR-010) — design.md §인터페이스 계약
 * `commands.ts` 그대로. 표에 없는 조합 판정(SC-005·SC-018)과 테스트 케이스 생성의 SoT.
 */
import type { TaskId, WorkId, ConfirmationId, DecisionId, AttemptId, SignalId } from "./ids.js";
import type { UtcInstant, ActorSource, ActorRef, CancelOrigin } from "./values.js";
import type { PendingDecision } from "./pending-decision.js";
import type { TriggerSpec } from "./trigger.js";
import type { TaskPolicy } from "./task-policy.js";
import type { OccurrenceId } from "./ids.js";
import type { WorkSource } from "./aggregate.js";
import type { ContentHash } from "./derivation/dedup-key.js";
import type { RegistryAxis } from "./registry/registries.js";
import type { ApprovalSurfaceRefusalReason } from "./policy/approval-surface.js";
import type { ReactionSpec } from "./validation/reaction-spec.js";
import type { InputBinding } from "./task-result/binding.js";
import type { OutputIssue } from "./task-result/outputs.js";
import type { PlanProposalInput } from "./plan/proposal.js";

export interface CommandMeta {
  readonly now: UtcInstant;
  readonly actorSource: ActorSource;
  readonly actor?: ActorRef;
  readonly causationId?: string;
}

interface TaskCommandBase {
  readonly taskId: TaskId;
  readonly expectedRevision: number;
  readonly meta: CommandMeta;
}

/** 미등록 descriptor 하나 — 축·식별자·버전. */
export interface UnknownDescriptorRef {
  readonly axis: RegistryAxis;
  readonly id: string;
  readonly version: number;
}

export type DescriptorUnknownBlockReason = {
  readonly kind: "descriptor_unknown";
  readonly descriptors: readonly UnknownDescriptorRef[];
};

export type ApprovalSurfaceRefusedBlockReason = {
  readonly kind: "approval_surface_refused";
  readonly reason: ApprovalSurfaceRefusalReason;
  readonly declaredSurface: "out_of_band";
};

export type TaskBlockReason =
  | DescriptorUnknownBlockReason
  | { readonly kind: "dependency_unsatisfied"; readonly dependencyTaskIds: readonly TaskId[] }
  | ApprovalSurfaceRefusedBlockReason;

/** 재시도 여부·지연은 도메인이 정책으로 계산한다 — 호출자는 시도별 지터 값만 주입한다. */
export type AttemptOutcome =
  | {
      readonly kind: "completed";
      readonly evidence: unknown;
      /** 보고 출력. 부재 = `{}`. */
      readonly outputs?: unknown;
      readonly jitterDrawMs?: number;
    }
  | {
      readonly kind: "failed";
      readonly code: string;
      readonly jitterDrawMs?: number;
      /** 출력 위반으로 바뀐 실패일 때만. */
      readonly outputIssues?: readonly OutputIssue[];
    }
  | { readonly kind: "attempt_timeout"; readonly jitterDrawMs?: number }
  | {
      readonly kind: "dispatch_orphaned";
      readonly deadLetterDecision: PendingDecision;
      readonly jitterDrawMs?: number;
    }
  | {
      readonly kind: "dispatch_withdrawn";
      readonly deadLetterDecision: PendingDecision;
      readonly jitterDrawMs?: number;
    }
  | {
      readonly kind: "blocked";
      readonly cause: "gate_denied" | "executor_blocked" | "dispatcher_refused";
      readonly decision: PendingDecision;
    }
  | { readonly kind: "effect_dead_lettered"; readonly decision: PendingDecision }
  | { readonly kind: "abandoned_for_validity" };

export type TaskCommand =
  | (TaskCommandBase & { readonly kind: "begin_validation" })
  | (TaskCommandBase & { readonly kind: "complete_validation" })
  | (TaskCommandBase & { readonly kind: "receive_input" })
  | (TaskCommandBase & {
      readonly kind: "schedule_task";
      readonly occurrenceId: OccurrenceId;
      readonly cause: "schedule" | "external_signal" | "retry";
    })
  | (TaskCommandBase & { readonly kind: "unschedule_task" })
  | (TaskCommandBase & {
      readonly kind: "start_attempt";
      readonly firedOccurrenceId?: OccurrenceId;
    })
  | (TaskCommandBase & {
      readonly kind: "begin_confirmation_wait";
      readonly confirmationId: ConfirmationId;
    })
  | (TaskCommandBase & {
      readonly kind: "park_awaiting_human";
      readonly cause: "unattended_eligibility_refused";
      readonly decision: PendingDecision;
    })
  | (TaskCommandBase & {
      readonly kind: "record_attempt_outcome";
      readonly attemptId: AttemptId;
      readonly outcome: AttemptOutcome;
    })
  | (TaskCommandBase & { readonly kind: "retry_ready" })
  | (TaskCommandBase & {
      readonly kind: "abandon_retries";
      readonly cause: "retry_budget_exhausted" | "retries_abandoned";
    })
  | (TaskCommandBase & { readonly kind: "expire" })
  | (TaskCommandBase & { readonly kind: "emit_reminder"; readonly occurrenceId: OccurrenceId })
  | (TaskCommandBase & { readonly kind: "unblock" })
  | (TaskCommandBase & { readonly kind: "cancel_task"; readonly origin: CancelOrigin })
  | (TaskCommandBase & {
      readonly kind: "skip_task";
      readonly reason: { readonly kind: "misfire_skip"; readonly occurrenceId?: OccurrenceId };
    })
  | (TaskCommandBase & {
      readonly kind: "present_late_result";
      readonly attemptId: AttemptId;
      readonly resultContentHash: ContentHash;
    });

export type TaskRef = { readonly draftRef: string } | { readonly taskId: TaskId };

export interface PlanTaskDraft {
  readonly draftRef: string;
  readonly type: { readonly id: string; readonly version: number };
  readonly title: string;
  readonly input: unknown;
  readonly dependsOn: readonly TaskRef[];
  readonly trigger: TriggerSpec;
  readonly policy: TaskPolicy;
  /** 계약 TaskDraft 에 없는 도메인 확장 — 부모 간선(활성화·의존 순환 검출에 참여하지 않음). */
  readonly parent?: TaskRef;
  /** 선언 전이 반응. 부재 = []. */
  readonly reactions?: readonly ReactionSpec[];
  /** 입력 필드 → 결합. 결합이 채울 필드는 누락 입력이 아니다. */
  readonly inputBindings?: Readonly<Record<string, InputBinding>>;
}

/** source.kind "definition_occurrence" 는 unsupported_in_this_phase 로 거절(셋째 차수). */
export interface CreateWorkCommand {
  readonly kind: "create_work";
  readonly meta: CommandMeta;
  readonly projectId: import("./ids.js").ProjectId;
  readonly title: string;
  readonly objective: string;
  readonly source: WorkSource;
  readonly correlationId?: string;
}

interface WorkCommandBase {
  readonly expectedRevision: number;
  readonly meta: CommandMeta;
}

export type WorkCommand =
  | (WorkCommandBase & { readonly kind: "start_planning" })
  | (WorkCommandBase & {
      readonly kind: "request_work_input";
      readonly requests: readonly unknown[];
    })
  | (WorkCommandBase & { readonly kind: "receive_work_input" })
  | (WorkCommandBase & {
      readonly kind: "propose_plan";
      readonly plan: PlanProposalInput;
      /** 계획 승인 결정의 요약. */
      readonly summary: string;
      readonly onInvalid?: "stay_planning" | "fail_work";
    })
  | (WorkCommandBase & {
      readonly kind: "commit_plan";
      readonly plan: PlanProposalInput;
      readonly onInvalid?: "stay_planning" | "fail_work";
    })
  | (WorkCommandBase & {
      readonly kind: "fail_planning";
      readonly invalidPlan?: { readonly issues: readonly unknown[] };
    })
  | (WorkCommandBase & {
      readonly kind: "withdraw_plan_proposal";
      /** 명령 경로 원인은 원문 변경 하나 — 재검증 실패 원인은 도메인 재검증만 낸다. */
      readonly cause: "source_changed";
    })
  | (WorkCommandBase & { readonly kind: "fail_work" })
  | (WorkCommandBase & { readonly kind: "cancel_work"; readonly origin: CancelOrigin });

export type WorkflowCommand = TaskCommand | WorkCommand;

interface SignalBase {
  readonly signalId: SignalId;
  readonly expectedRevision: number;
  readonly actorSource: ActorSource;
  readonly actor?: ActorRef;
  readonly provenance?: import("./values.js").ProvenanceEvidence;
  readonly receivedAt: UtcInstant;
}

export type DecisionSignal =
  | (SignalBase & {
      readonly type: "confirmation_decision";
      readonly taskId: TaskId;
      readonly confirmationId: ConfirmationId;
      readonly decision: "accept" | "reject" | "cancel";
    })
  | (SignalBase & {
      readonly type: "human_decision";
      readonly decisionId: DecisionId;
      readonly choice: "grant" | "deny";
    })
  | (SignalBase & {
      readonly type: "cancel_requested";
      readonly subject: { readonly taskId: TaskId } | { readonly workId: WorkId };
      readonly reason?: string;
    })
  | (SignalBase & { readonly type: "replan_requested"; readonly workId: WorkId });

export interface DelegationResponseSignal extends SignalBase {
  readonly type: "delegation_response";
  readonly taskId: TaskId;
  readonly occurrenceId: OccurrenceId;
  readonly responseContentHash: ContentHash;
}

export type GrantResume =
  | { readonly to: "READY" }
  | {
      readonly to: "SCHEDULED";
      readonly occurrence:
        | { readonly kind: "given"; readonly occurrenceId: OccurrenceId }
        | { readonly kind: "dead_letter_retry" };
    };

export type DecisionApplication =
  | { readonly kind: "none" }
  | { readonly kind: "task_grant"; readonly resume: GrantResume }
  | { readonly kind: "task_deny"; readonly resolution: "declined" | "discarded_only_effect" }
  /** 커밋되는 내용은 Work 가 보유한 대기 제안뿐이다. */
  | { readonly kind: "plan_grant" }
  | { readonly kind: "plan_deny" };

// ---------------------------------------------------------------------------
// 명령 kind → 도달 가능한 전이 행 ID (SC-005·SC-018 SoT). 행 ID 는 contract/task-transitions.ts·
// contract/work-transitions.ts 의 `id` 규칙과 일치해야 한다(design.md §DAG 요약 T010 완료 기준).
// ---------------------------------------------------------------------------

export const TASK_COMMAND_ROWS: Readonly<Record<TaskCommand["kind"], readonly string[]>> = {
  begin_validation: ["DRAFT>VALIDATING:task_validation_started"],
  complete_validation: [
    "VALIDATING>WAITING_INPUT:task_input_requested",
    "VALIDATING>READY:task_validated",
    "VALIDATING>BLOCKED:task_blocked",
    "VALIDATING>FAILED:task_validation_failed",
    "READY>BLOCKED_AWAITING_HUMAN:task_awaiting_human",
  ],
  receive_input: ["WAITING_INPUT>VALIDATING:task_input_received"],
  schedule_task: [
    "READY>SCHEDULED:task_scheduled",
    "RETRY_WAIT>SCHEDULED:task_scheduled",
    "READY>BLOCKED_AWAITING_HUMAN:task_awaiting_human",
  ],
  unschedule_task: ["SCHEDULED>READY:task_unscheduled"],
  start_attempt: [
    "READY>RUNNING:task_started",
    "SCHEDULED>RUNNING:task_started",
    "READY>BLOCKED_AWAITING_HUMAN:task_awaiting_human",
  ],
  begin_confirmation_wait: [
    "READY>WAITING_CONFIRMATION:task_waiting_confirmation",
    "SCHEDULED>WAITING_CONFIRMATION:task_waiting_confirmation",
    "READY>BLOCKED_AWAITING_HUMAN:task_awaiting_human",
  ],
  park_awaiting_human: [
    "READY>BLOCKED_AWAITING_HUMAN:task_awaiting_human",
    "SCHEDULED>BLOCKED_AWAITING_HUMAN:task_awaiting_human",
  ],
  record_attempt_outcome: [
    "RUNNING>COMPLETED:task_completed",
    "RUNNING>RETRY_WAIT:task_retry_wait",
    "RUNNING>BLOCKED_AWAITING_HUMAN:task_awaiting_human",
    "RUNNING>FAILED:task_failed",
    "RUNNING>EXPIRED:task_expired",
  ],
  retry_ready: ["RETRY_WAIT>READY:task_retry_ready"],
  abandon_retries: ["RETRY_WAIT>FAILED:task_failed"],
  expire: [
    "WAITING_INPUT>EXPIRED:task_expired",
    "READY>EXPIRED:task_expired",
    "SCHEDULED>EXPIRED:task_expired",
    "RETRY_WAIT>EXPIRED:task_expired",
    "WAITING_CONFIRMATION>EXPIRED:confirmation_expired",
    "BLOCKED>EXPIRED:task_expired",
    "BLOCKED_AWAITING_HUMAN>EXPIRED:task_expired",
  ],
  emit_reminder: ["WAITING_CONFIRMATION>WAITING_CONFIRMATION:reminder_occurrence_emitted"],
  unblock: ["BLOCKED>VALIDATING:task_unblocked"],
  cancel_task: [
    "WAITING_CONFIRMATION>CANCELED:confirmation_cancelled",
    "BLOCKED>CANCELED:task_canceled",
    "BLOCKED_AWAITING_HUMAN>CANCELED:task_canceled",
    "ANY_NONTERMINAL_EXCEPT_WAITING_CONFIRMATION>CANCELED:task_canceled",
  ],
  skip_task: ["ANY_NONTERMINAL>SKIPPED:task_skipped"],
  present_late_result: [],
} as const;

/** 전이 행 없이 판정하는 명령 — 엔진 사전 검사가 빈 행 목록을 허용한다. */
export const TASK_NON_ROW_COMMANDS: readonly TaskCommand["kind"][] = ["present_late_result"];

export const WORK_COMMAND_ROWS: Readonly<
  Record<WorkCommand["kind"] | "create_work", readonly string[]>
> = {
  create_work: ["NONE>DRAFT:work_created"],
  start_planning: ["DRAFT>PLANNING:work_planning_started"],
  request_work_input: ["PLANNING>WAITING_INPUT:work_input_requested"],
  receive_work_input: ["WAITING_INPUT>PLANNING:work_input_received"],
  propose_plan: ["PLANNING>WAITING_APPROVAL:work_plan_proposed", "PLANNING>FAILED:work_failed"],
  commit_plan: ["PLANNING>READY:work_plan_committed", "PLANNING>FAILED:work_failed"],
  fail_planning: ["PLANNING>FAILED:work_failed"],
  withdraw_plan_proposal: ["WAITING_APPROVAL>PLANNING:work_plan_withdrawn"],
  fail_work: ["ACTIVE>FAILED:work_failed"],
  cancel_work: [
    "WAITING_APPROVAL>CANCELED:work_canceled",
    "ANY_NONTERMINAL>CANCELED:work_canceled",
  ],
} as const;

/** 명령이 아닌 경로로만 생산되는 행: 연쇄. */
export const TASK_CASCADE_ROWS: readonly string[] = [
  "VALIDATING>BLOCKED:task_blocked",
  "READY>BLOCKED:task_blocked",
  "ANY_NONTERMINAL>SKIPPED:task_skipped",
  "VALIDATING|WAITING_INPUT|READY|SCHEDULED|BLOCKED>FAILED:task_failed",
  "READY>SCHEDULED:task_scheduled",
] as const;

/** 명령이 아닌 경로로만 생산되는 행: 신호. */
export const TASK_SIGNAL_ROWS: readonly string[] = [
  "WAITING_CONFIRMATION>COMPLETED:confirmation_accepted",
  "WAITING_CONFIRMATION>REJECTED:confirmation_rejected",
  "WAITING_CONFIRMATION>CANCELED:confirmation_cancelled",
  "BLOCKED_AWAITING_HUMAN>READY:human_decision_granted",
  "BLOCKED_AWAITING_HUMAN>SCHEDULED:human_decision_granted",
  "BLOCKED_AWAITING_HUMAN>REJECTED:human_decision_denied",
  "BLOCKED_AWAITING_HUMAN>FAILED:task_failed",
  "BLOCKED>CANCELED:task_canceled",
  "BLOCKED_AWAITING_HUMAN>CANCELED:task_canceled",
  "ANY_NONTERMINAL_EXCEPT_WAITING_CONFIRMATION>CANCELED:task_canceled",
] as const;

/** 명령이 아닌 경로로만 생산되는 행: Work 파생. */
export const WORK_DERIVED_ROWS: readonly string[] = [
  "READY>ACTIVE:work_activated",
  "READY>COMPLETED:work_completed",
  "READY>BLOCKED:work_blocked",
  "ACTIVE>BLOCKED:work_blocked",
  "BLOCKED>ACTIVE:work_unblocked",
  "BLOCKED>COMPLETED:work_completed",
  "ACTIVE>COMPLETED:work_completed",
] as const;

/** 명령이 아닌 경로로만 생산되는 행: Work 신호. */
export const WORK_SIGNAL_ROWS: readonly string[] = [
  "WAITING_APPROVAL>READY:work_plan_committed",
  "WAITING_APPROVAL>PLANNING:work_plan_rejected",
  "WAITING_APPROVAL>READY:work_plan_rejected",
  "ACTIVE>PLANNING:work_replanning_started",
  "BLOCKED>PLANNING:work_replanning_started",
  "WAITING_APPROVAL>CANCELED:work_canceled",
  "ANY_NONTERMINAL>CANCELED:work_canceled",
] as const;
