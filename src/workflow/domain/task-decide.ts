/**
 * Task 명령 판정·attempt 결과 라우팅·시간 판정. 판정은 이벤트 목록(주 이벤트)만 반환하고 상태를
 * 바꾸지 않는다. 유형·종류별 차이는 등록부의 descriptor 선언으로만 읽는다.
 */
import { type Result, ok, err, DomainInvariantError } from "./result.js";
import type { TaskRecord, WorkAggregate } from "./aggregate.js";
import { taskOf } from "./aggregate.js";
import type { TaskId } from "./ids.js";
import { nextEntityId } from "./ids.js";
import { addMs, hasPassed } from "./values.js";
import type { UtcInstant } from "./values.js";
import { isSatisfyingTerminal, isTerminalTaskState } from "./task-state.js";
import { isTaskSubjectDecision } from "./pending-decision.js";
import type { PendingDecisionKind } from "./pending-decision.js";
import type { TaskCommand, AttemptOutcome } from "./commands.js";
import type { DecidedEvent } from "./events.js";
import { mkEvent } from "./events.js";
import type { CommandRejection, DomainDeps } from "./engine.js";
import { validateTask } from "./validation/task-validation.js";
import { decideRetry } from "./policy/retry.js";
import type { RetryFailure } from "./policy/retry.js";
import {
  preExecutionApprovalPark,
  requiresPreExecutionApproval,
} from "./policy/pre-execution-approval.js";

export interface TimeEvaluation {
  readonly validityPassed: boolean;
  readonly decisionExpired: boolean;
  readonly late: boolean;
  readonly attemptDeadlinePassed: boolean;
}

export function evaluateTime(task: TaskRecord, now: UtcInstant): TimeEvaluation {
  const validityPassed =
    task.policy.expiresAt !== undefined && hasPassed(task.policy.expiresAt, now);
  const pendingExpiresAt =
    task.pendingDecision !== undefined && "expiresAt" in task.pendingDecision
      ? task.pendingDecision.expiresAt
      : undefined;
  const decisionExpired = pendingExpiresAt !== undefined && hasPassed(pendingExpiresAt, now);
  const late =
    task.policy.targetDueAt !== undefined &&
    hasPassed(task.policy.targetDueAt, now) &&
    !isTerminalTaskState(task.state);
  const attemptDeadlinePassed =
    task.openAttempt !== undefined && hasPassed(task.openAttempt.deadline, now);
  return { validityPassed, decisionExpired, late, attemptDeadlinePassed };
}

/** dependsOn 전부 충족 종결(COMPLETED·SKIPPED). */
export function isActivationSatisfied(aggregate: WorkAggregate, taskId: TaskId): boolean {
  const task = taskOf(aggregate, taskId);
  if (task === undefined) return false;
  return task.dependsOn.every((depId) => {
    const dep = taskOf(aggregate, depId);
    return dep !== undefined && isSatisfyingTerminal(dep.state);
  });
}

function rejectCondition(detail?: string): CommandRejection {
  return { reason: "condition_not_met", ...(detail !== undefined ? { detail } : {}) };
}
function rejectInvalidInput(detail?: string): CommandRejection {
  return { reason: "invalid_input", ...(detail !== undefined ? { detail } : {}) };
}
function rejectNotInTable(): CommandRejection {
  return { reason: "transition_not_in_table" };
}
function rejectAwaitingApproval(): CommandRejection {
  return rejectCondition("실행 전 승인 대기");
}

export interface AttemptRouting {
  readonly rowId: string;
  readonly retryDelayMs?: number;
  readonly jitterDrawMs?: number;
}

/** 시도 결과로 주차할 때 원인별로 허용하는 결정 종류. */
const PARK_DECISION_KIND: Readonly<
  Record<
    | "gate_denied"
    | "executor_blocked"
    | "dispatcher_refused"
    | "effect_dead_lettered"
    | "dispatch_orphaned"
    | "dispatch_withdrawn",
    PendingDecisionKind
  >
> = {
  gate_denied: "tool_permission_denied_unattended",
  executor_blocked: "tool_permission_denied_unattended",
  dispatcher_refused: "tool_permission_denied_unattended",
  effect_dead_lettered: "dead_letter_resolution_required",
  dispatch_orphaned: "dead_letter_resolution_required",
  dispatch_withdrawn: "dead_letter_resolution_required",
};

const ROW_COMPLETED = "RUNNING>COMPLETED:task_completed";
const ROW_RETRY_WAIT = "RUNNING>RETRY_WAIT:task_retry_wait";
const ROW_AWAITING_HUMAN = "RUNNING>BLOCKED_AWAITING_HUMAN:task_awaiting_human";
const ROW_FAILED = "RUNNING>FAILED:task_failed";
const ROW_EXPIRED = "RUNNING>EXPIRED:task_expired";

/**
 * RUNNING Task 의 결과가 지목하는 전이 행과 재시도 지연(위에서부터 첫 규칙). 재시도 여부·지연은
 * `decideRetry` 가 정책으로 정한다 — 재시도 불가면 실패 결과는 FAILED, dispatch 고아·철회는 사람 결정.
 */
export function routeAttemptOutcome(
  task: TaskRecord,
  outcome: AttemptOutcome,
  now: UtcInstant,
): Result<AttemptRouting, CommandRejection> {
  const time = evaluateTime(task, now);
  if (outcome.kind === "completed") return ok({ rowId: ROW_COMPLETED });
  if (outcome.kind === "abandoned_for_validity") {
    if (!time.validityPassed)
      return err(rejectInvalidInput("abandoned_for_validity requires validity passed"));
    return ok({ rowId: ROW_EXPIRED });
  }
  if (time.validityPassed) return ok({ rowId: ROW_EXPIRED });
  if (outcome.kind === "blocked" || outcome.kind === "effect_dead_lettered") {
    return ok({ rowId: ROW_AWAITING_HUMAN });
  }
  const failure: RetryFailure =
    outcome.kind === "failed"
      ? { kind: "error_code", code: outcome.code }
      : { kind: "retryable_by_definition" };
  const decision = decideRetry({
    policy: task.policy.retry,
    attemptNo: task.openAttempt?.attemptNo ?? task.lastAttemptNo,
    failure,
    ...(outcome.jitterDrawMs !== undefined ? { jitterDrawMs: outcome.jitterDrawMs } : {}),
  });
  if (!decision.ok) {
    return err(rejectInvalidInput(`${decision.error.field}: ${decision.error.reason}`));
  }
  if (decision.value.kind === "retry") {
    return ok({
      rowId: ROW_RETRY_WAIT,
      retryDelayMs: decision.value.delayMs,
      ...(outcome.jitterDrawMs !== undefined ? { jitterDrawMs: decision.value.jitterDrawMs } : {}),
    });
  }
  if (outcome.kind === "dispatch_orphaned" || outcome.kind === "dispatch_withdrawn") {
    return ok({ rowId: ROW_AWAITING_HUMAN });
  }
  return ok({ rowId: ROW_FAILED });
}

export type TaskDecideOutcome =
  | { readonly kind: "events"; readonly events: readonly DecidedEvent[] }
  | { readonly kind: "rejected"; readonly rejection: CommandRejection };

function events(...list: readonly DecidedEvent[]): TaskDecideOutcome {
  return { kind: "events", events: list };
}
function rejected(rejection: CommandRejection): TaskDecideOutcome {
  return { kind: "rejected", rejection };
}

/** 명령 kind 가 현재 상태에서 가질 수 있는 행 존재 → 행 조건 판정(사전 검사의 나머지 단계는 engine.ts). */
export function decideTaskCommand(
  deps: DomainDeps,
  task: TaskRecord,
  command: TaskCommand,
): TaskDecideOutcome {
  const taskId = task.id;
  switch (command.kind) {
    case "begin_validation": {
      if (task.state !== "DRAFT") return rejected(rejectNotInTable());
      return events(mkEvent("task_validation_started", {}, { taskId }));
    }
    case "complete_validation": {
      if (task.state !== "VALIDATING") return rejected(rejectNotInTable());
      const result = validateTask(deps.registries, {
        type: task.type,
        input: task.input,
        trigger: task.trigger,
        policy: task.policy,
        reactions: task.reactions,
      });
      switch (result.exit) {
        case "valid": {
          const validated = mkEvent("task_validated", {}, { taskId });
          if (!requiresPreExecutionApproval(task)) return events(validated);
          return events(validated, preExecutionApprovalPark(deps, task, command.meta.now));
        }
        case "input_requested":
          return events(mkEvent("task_input_requested", { requests: result.requests }, { taskId }));
        case "validation_failed":
          return events(mkEvent("task_validation_failed", { issues: result.issues }, { taskId }));
        case "blocked": {
          const blocked = mkEvent("task_blocked", { blockReason: result.blockReason }, { taskId });
          if (result.blockReason.kind !== "approval_surface_refused") return events(blocked);
          return events(
            mkEvent(
              "approval_surface_refused",
              {
                declaredSurface: result.blockReason.declaredSurface,
                reason: result.blockReason.reason,
              },
              { taskId },
            ),
            blocked,
          );
        }
        default: {
          const exhaustive: never = result;
          throw new Error(`complete_validation: 알 수 없는 검증 출구 ${String(exhaustive)}`);
        }
      }
    }
    case "receive_input": {
      if (task.state !== "WAITING_INPUT") return rejected(rejectNotInTable());
      return events(mkEvent("task_input_received", {}, { taskId }));
    }
    case "schedule_task": {
      if (task.state === "READY") {
        if (command.cause !== "schedule" && command.cause !== "external_signal")
          return rejected(rejectCondition());
        if (requiresPreExecutionApproval(task)) {
          return events(preExecutionApprovalPark(deps, task, command.meta.now));
        }
      } else if (task.state === "RETRY_WAIT") {
        if (command.cause !== "retry") return rejected(rejectCondition());
        if (requiresPreExecutionApproval(task)) return rejected(rejectAwaitingApproval());
      } else {
        return rejected(rejectNotInTable());
      }
      return events(
        mkEvent(
          "task_scheduled",
          { occurrenceId: command.occurrenceId, cause: command.cause },
          { taskId },
        ),
      );
    }
    case "unschedule_task": {
      if (task.state !== "SCHEDULED") return rejected(rejectNotInTable());
      const invalidated = task.scheduledOccurrenceId;
      if (invalidated === undefined)
        return rejected(rejectInvalidInput("scheduledOccurrenceId 없음"));
      return events(
        mkEvent("task_unscheduled", { invalidatedOccurrenceId: invalidated }, { taskId }),
      );
    }
    case "start_attempt": {
      if (task.state === "READY") {
        if (requiresPreExecutionApproval(task)) {
          return events(preExecutionApprovalPark(deps, task, command.meta.now));
        }
        const trigger = deps.registries.triggers.get(task.trigger.kind, task.trigger.version);
        if (trigger === undefined) return rejected(rejectCondition("descriptor_unknown"));
        if (trigger.firing !== "on_ready") {
          return rejected(rejectCondition("READY 시작은 준비 즉시 발화하는 Trigger 만"));
        }
      } else if (task.state === "SCHEDULED") {
        if (requiresPreExecutionApproval(task)) return rejected(rejectAwaitingApproval());
        if (
          command.firedOccurrenceId === undefined ||
          command.firedOccurrenceId !== task.scheduledOccurrenceId
        ) {
          return rejected(rejectCondition("firedOccurrenceId 가 예약 occurrence 와 다름"));
        }
      } else {
        return rejected(rejectNotInTable());
      }
      const defaultDeadlineMs = deps.operationalDefaults.agentDispatchDeadlineMs;
      if (!Number.isInteger(defaultDeadlineMs) || defaultDeadlineMs <= 0) {
        throw new DomainInvariantError(
          "operationalDefaults.agentDispatchDeadlineMs 는 양의 정수여야 한다",
        );
      }
      const attemptId = nextEntityId(deps.ids, "attempt");
      const attemptNo = task.lastAttemptNo + 1;
      const deadline = addMs(command.meta.now, task.policy.attemptTimeoutMs ?? defaultDeadlineMs);
      return events(
        mkEvent(
          "task_started",
          {
            attemptId,
            attemptNo,
            deadline,
            ...(command.firedOccurrenceId !== undefined
              ? { firedOccurrenceId: command.firedOccurrenceId }
              : {}),
          },
          { taskId },
        ),
      );
    }
    case "begin_confirmation_wait": {
      if (task.state !== "READY" && task.state !== "SCHEDULED") return rejected(rejectNotInTable());
      if (requiresPreExecutionApproval(task)) {
        if (task.state === "SCHEDULED") return rejected(rejectAwaitingApproval());
        return events(preExecutionApprovalPark(deps, task, command.meta.now));
      }
      return events(
        mkEvent(
          "task_waiting_confirmation",
          { confirmationId: command.confirmationId },
          { taskId },
        ),
      );
    }
    case "park_awaiting_human": {
      if (task.state !== "READY" && task.state !== "SCHEDULED") return rejected(rejectNotInTable());
      if (!isTaskSubjectDecision(command.decision) || command.decision.taskId !== taskId) {
        return rejected(rejectInvalidInput("decision 이 이 Task 주체가 아님"));
      }
      if (command.decision.kind !== "tool_permission_denied_unattended") {
        return rejected(rejectInvalidInput("무인 적격 거절 결정이 아님"));
      }
      if (requiresPreExecutionApproval(task)) return rejected(rejectAwaitingApproval());
      return events(
        mkEvent(
          "task_awaiting_human",
          { pendingDecision: command.decision, cause: command.cause },
          { taskId },
        ),
      );
    }
    case "record_attempt_outcome": {
      if (task.state !== "RUNNING") return rejected(rejectNotInTable());
      if (task.openAttempt === undefined || task.openAttempt.attemptId !== command.attemptId) {
        return rejected(rejectCondition("attemptId 가 열린 attempt 와 다름"));
      }
      const routed = routeAttemptOutcome(task, command.outcome, command.meta.now);
      if (!routed.ok) return rejected(routed.error);
      const attemptId = task.openAttempt.attemptId;
      const attemptNo = task.openAttempt.attemptNo;
      switch (routed.value.rowId) {
        case "RUNNING>COMPLETED:task_completed": {
          const evidence =
            command.outcome.kind === "completed" ? command.outcome.evidence : undefined;
          return events(
            mkEvent(
              "task_completed",
              { attemptId, ...(evidence !== undefined ? { evidence } : {}) },
              { taskId },
            ),
          );
        }
        case "RUNNING>RETRY_WAIT:task_retry_wait": {
          const { retryDelayMs, jitterDrawMs } = routed.value;
          return events(
            mkEvent(
              "task_retry_wait",
              {
                attemptId,
                attemptNo,
                retryDelayMs: retryDelayMs ?? 0,
                ...(jitterDrawMs !== undefined ? { jitterDrawMs } : {}),
                outcome: command.outcome,
              },
              { taskId },
            ),
          );
        }
        case "RUNNING>BLOCKED_AWAITING_HUMAN:task_awaiting_human": {
          const decision =
            "decision" in command.outcome
              ? command.outcome.decision
              : "deadLetterDecision" in command.outcome
                ? command.outcome.deadLetterDecision
                : undefined;
          if (decision === undefined)
            return rejected(rejectInvalidInput("blocked 결과에 decision 없음"));
          if (!isTaskSubjectDecision(decision) || decision.taskId !== taskId) {
            return rejected(rejectInvalidInput("decision 이 이 Task 주체가 아님"));
          }
          const parkReason =
            command.outcome.kind === "blocked" ? command.outcome.cause : command.outcome.kind;
          const expectedKind = (
            PARK_DECISION_KIND as Readonly<Record<string, PendingDecisionKind | undefined>>
          )[parkReason];
          if (expectedKind === undefined || decision.kind !== expectedKind) {
            return rejected(rejectInvalidInput("주차 원인과 결정 종류가 맞지 않음"));
          }
          const cause:
            "gate_denied" | "executor_blocked" | "dispatcher_refused" | "effect_dead_lettered" =
            command.outcome.kind === "blocked" ? command.outcome.cause : "effect_dead_lettered";
          return events(
            mkEvent(
              "task_awaiting_human",
              { pendingDecision: decision, cause, attemptId, outcome: command.outcome },
              { taskId },
            ),
          );
        }
        case "RUNNING>FAILED:task_failed":
          return events(
            mkEvent(
              "task_failed",
              {
                reason: { kind: "attempt_failed", attemptId, attemptNo, outcome: command.outcome },
              },
              { taskId },
            ),
          );
        case "RUNNING>EXPIRED:task_expired":
          return events(
            mkEvent(
              "task_expired",
              {
                basis: "task_validity",
                closedAttemptId: attemptId,
                attemptOutcome: command.outcome,
              },
              { taskId },
            ),
          );
        default:
          throw new Error(`record_attempt_outcome: 알 수 없는 라우팅 결과 ${routed.value.rowId}`);
      }
    }
    case "retry_ready": {
      if (task.state !== "RETRY_WAIT") return rejected(rejectNotInTable());
      return events(mkEvent("task_retry_ready", {}, { taskId }));
    }
    case "abandon_retries": {
      if (task.state !== "RETRY_WAIT") return rejected(rejectNotInTable());
      const kind =
        command.cause === "retry_budget_exhausted" ? "retry_budget_exhausted" : "retries_abandoned";
      return events(mkEvent("task_failed", { reason: { kind } }, { taskId }));
    }
    case "expire": {
      const time = evaluateTime(task, command.meta.now);
      switch (task.state) {
        case "WAITING_INPUT":
        case "READY":
        case "SCHEDULED":
        case "RETRY_WAIT":
        case "BLOCKED": {
          if (!time.validityPassed) return rejected(rejectCondition("유효기한 미경과"));
          return events(mkEvent("task_expired", { basis: "task_validity" }, { taskId }));
        }
        case "WAITING_CONFIRMATION": {
          if (!time.validityPassed) return rejected(rejectCondition("유효기한 미경과"));
          return events(
            mkEvent(
              "confirmation_expired",
              { confirmationId: task.confirmationId as import("./ids.js").ConfirmationId },
              { taskId },
            ),
          );
        }
        case "BLOCKED_AWAITING_HUMAN": {
          if (!time.validityPassed && !time.decisionExpired)
            return rejected(rejectCondition("유효기한·결정만료 미경과"));
          return events(
            mkEvent(
              "task_expired",
              { basis: time.decisionExpired ? "decision_expiry" : "task_validity" },
              { taskId },
            ),
          );
        }
        default:
          return rejected(rejectNotInTable());
      }
    }
    case "emit_reminder": {
      if (task.state === "WAITING_CONFIRMATION") {
        return events(
          mkEvent(
            "reminder_occurrence_emitted",
            { occurrenceId: command.occurrenceId },
            { taskId },
          ),
        );
      }
      if (task.state !== "BLOCKED_AWAITING_HUMAN") return rejected(rejectNotInTable());
      const decision = task.pendingDecision;
      if (
        decision === undefined ||
        !isTaskSubjectDecision(decision) ||
        !("expiresAt" in decision) ||
        decision.expiresAt === undefined
      ) {
        return rejected(rejectCondition("만료가 있는 Task 주체 결정이 열려 있지 않음"));
      }
      return events(
        mkEvent(
          "reminder_occurrence_emitted",
          { occurrenceId: command.occurrenceId, decisionId: decision.id },
          { taskId },
        ),
      );
    }
    case "unblock": {
      if (task.state !== "BLOCKED") return rejected(rejectNotInTable());
      if (task.blockReason?.kind === "approval_surface_refused") {
        return rejected(rejectCondition("승인 채널 거절 차단은 수리로 풀리지 않음"));
      }
      return events(mkEvent("task_unblocked", {}, { taskId }));
    }
    case "cancel_task": {
      if (isTerminalTaskState(task.state)) return rejected(rejectNotInTable());
      if (command.origin.kind === "vault_signal" && command.origin.actorSource !== "human_local") {
        return rejected(rejectInvalidInput("vault_signal 취소는 human_local 필수"));
      }
      if (task.state === "WAITING_CONFIRMATION") {
        return events(
          mkEvent(
            "confirmation_cancelled",
            {
              confirmationId: task.confirmationId as import("./ids.js").ConfirmationId,
              origin: command.origin,
            },
            { taskId },
          ),
        );
      }
      return events(mkEvent("task_canceled", { origin: command.origin }, { taskId }));
    }
    case "skip_task": {
      if (isTerminalTaskState(task.state)) return rejected(rejectNotInTable());
      return events(
        mkEvent(
          "task_skipped",
          {
            reason: {
              kind: "misfire_skip",
              ...(command.reason.occurrenceId !== undefined
                ? { occurrenceId: command.reason.occurrenceId }
                : {}),
            },
          },
          { taskId },
        ),
      );
    }
    case "present_late_result": {
      if (isTerminalTaskState(task.state)) return rejected(rejectNotInTable());
      if (task.state !== "BLOCKED_AWAITING_HUMAN") return rejected(rejectNotInTable());
      const decision = task.pendingDecision;
      if (
        decision === undefined ||
        decision.kind !== "dead_letter_resolution_required" ||
        task.parkedAttemptId === undefined ||
        command.attemptId !== task.parkedAttemptId
      ) {
        return rejected(rejectCondition("dead-letter 결정에 걸린 attempt 의 결과가 아님"));
      }
      return events(
        mkEvent(
          "agent_result_unmatched",
          {
            attemptId: command.attemptId,
            reason: "attempt_ended",
            resultContentHash: command.resultContentHash,
            presentedInDecisionId: decision.id,
          },
          { taskId },
        ),
      );
    }
    default: {
      const exhaustive: never = command;
      throw new Error(`decideTaskCommand: 알 수 없는 명령 ${String(exhaustive)}`);
    }
  }
}
