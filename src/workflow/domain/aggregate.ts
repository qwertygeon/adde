/**
 * 애그리거트 데이터 모델(design.md §데이터 모델) — WorkAggregate·TaskRecord·WorkRecord 와 조회 함수.
 */
import type {
  TaskId,
  WorkId,
  ProjectId,
  AttemptId,
  OccurrenceId,
  ConfirmationId,
  PlanProposalId,
  WorkDefinitionId,
  EventId,
} from "./ids.js";
import type { UtcInstant, CancelOrigin } from "./values.js";
import type { TaskStateName } from "./task-state.js";
import type { WorkStateName } from "./work-state.js";
import type { TriggerSpec } from "./trigger.js";
import type { TaskPolicy } from "./task-policy.js";
import type { PendingDecision } from "./pending-decision.js";
import type { SignalDedupKey } from "./derivation/dedup-key.js";
import type { LogPosition } from "./derivation/occurrence-id.js";
import type { MemberSnapshot } from "./completion.js";
import type { TaskBlockReason } from "./commands.js";
import type { ReactionSpec } from "./validation/reaction-spec.js";
import type { DecisionId } from "./ids.js";
import type { ContentHash } from "./derivation/dedup-key.js";

export interface OpenAttempt {
  readonly attemptId: AttemptId;
  readonly attemptNo: number;
  readonly startedAt: UtcInstant;
  readonly deadline: UtcInstant;
}

export interface TerminalEventRef {
  readonly eventId: EventId;
  readonly occurredAt: UtcInstant;
  readonly position: LogPosition;
}

/** 계약 "Work definition and occurrence contract" 의 `OccurrenceInput` 형태 그대로. */
export interface OccurrenceInput {
  readonly occurrenceId: string;
  readonly definitionId: WorkDefinitionId;
  readonly definitionRevision: number;
  readonly scheduledForUtc?: UtcInstant;
  readonly localDate?: string;
  readonly timezone?: string;
  readonly signal?: {
    readonly sourceId: string;
    readonly signalName: string;
    readonly sourceOccurrenceId: string;
    readonly payload: unknown;
  };
}

/** 계약 "Work definition and occurrence contract" 의 `WorkSource` 형태 그대로. */
export type WorkSource =
  | { readonly kind: "markdown"; readonly documentId: string }
  | { readonly kind: "cli" }
  | { readonly kind: "spawn"; readonly causingTaskId: TaskId }
  | {
      readonly kind: "definition_occurrence";
      readonly definitionId: WorkDefinitionId;
      readonly definitionRevision: number;
      readonly occurrenceId: string;
      readonly input: OccurrenceInput;
    };

/** 열린 attempt 가 끝난 뒤 도착한 결과 — 증거로 보존하고 상태는 바꾸지 않는다. */
export interface LateResult {
  readonly attemptId: AttemptId;
  readonly resultContentHash: ContentHash;
  /** 열린 결정의 표시에 반영됐으면 그 결정. */
  readonly presentedInDecisionId?: DecisionId;
}

export interface TaskRecord {
  readonly id: TaskId;
  readonly workId: WorkId;
  readonly projectId: ProjectId;
  readonly draftRef: string;
  readonly type: { readonly id: string; readonly version: number };
  readonly title: string;
  readonly input: unknown;
  readonly state: TaskStateName;
  readonly revision: number;
  readonly dependsOn: readonly TaskId[];
  readonly parentTaskId?: TaskId;
  readonly trigger: TriggerSpec;
  readonly policy: TaskPolicy;
  /** 선언 전이 반응(부재 = []). */
  readonly reactions: readonly ReactionSpec[];
  /** BLOCKED 동안의 차단 사유. */
  readonly blockReason?: TaskBlockReason;
  /** 실행 전 승인 결정이 grant 로 닫혔음 — Task 당 한 번. */
  readonly preExecutionApproved: boolean;
  /** attempt 결과로 BLOCKED_AWAITING_HUMAN 에 들어왔을 때 그 attempt. */
  readonly parkedAttemptId?: AttemptId;
  readonly lateResults: readonly LateResult[];
  /** 계약 `Task.currentAttemptId = openAttempt.attemptId`. */
  readonly openAttempt?: OpenAttempt;
  /** 시작한 attempt 수(0 부터). */
  readonly lastAttemptNo: number;
  /** SCHEDULED 동안. */
  readonly scheduledOccurrenceId?: OccurrenceId;
  /** WAITING_CONFIRMATION 진입 시 설정, 종결 후 보존. */
  readonly confirmationId?: ConfirmationId;
  /** BLOCKED_AWAITING_HUMAN 동안. */
  readonly pendingDecision?: PendingDecision;
  /** CANCELED 일 때. */
  readonly cancelOrigin?: CancelOrigin;
  /** 의존 활성화 task_scheduled 를 받은 적 있음. */
  readonly dependencyActivated: boolean;
  /** 종결 이벤트의 위치. */
  readonly terminalRef?: TerminalEventRef;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly correlationId: string;
}

export interface WorkRecord {
  readonly id: WorkId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly objective: string;
  readonly state: WorkStateName;
  readonly revision: number;
  readonly taskIds: readonly TaskId[];
  readonly planRevision: number;
  readonly memberTaskIds: readonly TaskId[];
  readonly pendingProposalId?: PlanProposalId;
  readonly pendingProposalDigest?: string;
  /** plan_approval_required, WAITING_APPROVAL 동안. */
  readonly pendingDecision?: PendingDecision;
  readonly source: WorkSource;
  readonly completionPolicyVersion: 1;
  readonly startedUnderCurrentRevision: boolean;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly causationId?: string;
  readonly correlationId: string;
}

export type DecisionSubjectRef = { readonly taskId: TaskId } | { readonly workId: WorkId };

export interface WorkAggregate {
  readonly work: WorkRecord;
  /** 키: TaskId. */
  readonly tasks: Readonly<Record<string, TaskRecord>>;
  /** 수용 순. */
  readonly acceptedSignalKeys: readonly SignalDedupKey[];
  /** 키: DecisionId, 닫힌 결정 포함. */
  readonly decisionSubjects: Readonly<Record<string, DecisionSubjectRef>>;
  /** 상태 변이 커밋 수. */
  readonly commitSeq: number;
}

export function taskOf(aggregate: WorkAggregate, taskId: TaskId): TaskRecord | undefined {
  return aggregate.tasks[taskId];
}

/** 소유 Task 전부(member 여부 무관). */
export function memberSnapshots(aggregate: WorkAggregate): readonly MemberSnapshot[] {
  return aggregate.work.taskIds.map((taskId) => {
    const record = aggregate.tasks[taskId];
    if (record === undefined) {
      throw new Error(
        `애그리거트 불변식 위반 — Work.taskIds 에 있으나 tasks 에 없는 Task: ${taskId}`,
      );
    }
    return {
      taskId: record.id,
      state: record.state,
      terminalRequired: record.policy.terminalRequired,
      ...(record.cancelOrigin !== undefined ? { cancelOrigin: record.cancelOrigin } : {}),
    };
  });
}
