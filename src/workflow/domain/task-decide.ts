/**
 * Task 명령 판정·attempt 결과 라우팅·시간 판정(FR-004~FR-007) — design.md §4·§5 표 그대로.
 * 판정은 이벤트 목록(주 이벤트)만 반환하고 상태를 바꾸지 않는다.
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
import type { TaskCommand, AttemptOutcome } from "./commands.js";
import type { DecidedEvent } from "./events.js";
import { mkEvent } from "./events.js";
import type { CommandRejection, DomainDeps } from "./engine.js";

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

/** RUNNING Task 의 결과가 지목하는 전이 행 ID(§5 표, 위에서부터 첫 규칙). */
export function routeAttemptOutcome(
  task: TaskRecord,
  outcome: AttemptOutcome,
  now: UtcInstant,
): Result<string, CommandRejection> {
  const time = evaluateTime(task, now);
  if (outcome.kind === "completed") {
    return ok("RUNNING>COMPLETED:task_completed");
  }
  if (outcome.kind === "abandoned_for_validity") {
    if (!time.validityPassed)
      return err(rejectInvalidInput("abandoned_for_validity requires validity passed"));
    return ok("RUNNING>EXPIRED:task_expired");
  }
  if (time.validityPassed) {
    return ok("RUNNING>EXPIRED:task_expired");
  }
  if (outcome.kind === "blocked" || outcome.kind === "effect_dead_lettered") {
    return ok("RUNNING>BLOCKED_AWAITING_HUMAN:task_awaiting_human");
  }
  const maxAttempts = task.policy.retry.maxAttempts;
  const attemptNo = task.openAttempt?.attemptNo ?? task.lastAttemptNo;
  if (outcome.kind === "dispatch_orphaned" || outcome.kind === "dispatch_withdrawn") {
    if (attemptNo < maxAttempts) return ok("RUNNING>RETRY_WAIT:task_retry_wait");
    return ok("RUNNING>BLOCKED_AWAITING_HUMAN:task_awaiting_human");
  }
  if (outcome.kind === "attempt_timeout") {
    if (attemptNo < maxAttempts) return ok("RUNNING>RETRY_WAIT:task_retry_wait");
    return ok("RUNNING>FAILED:task_failed");
  }
  if (outcome.kind === "failed") {
    if (outcome.retryable && attemptNo < maxAttempts)
      return ok("RUNNING>RETRY_WAIT:task_retry_wait");
    return ok("RUNNING>FAILED:task_failed");
  }
  const exhaustive: never = outcome;
  throw new Error(`routeAttemptOutcome: 알 수 없는 결과 종류 ${String(exhaustive)}`);
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
      const outcome = command.outcome;
      switch (outcome.result) {
        case "valid":
          return events(mkEvent("task_validated", {}, { taskId }));
        case "input_missing":
          return events(
            mkEvent("task_input_requested", { requests: outcome.requests }, { taskId }),
          );
        case "blocked":
          if (outcome.blockReason.kind === "dependency_unsatisfied") {
            return rejected(rejectInvalidInput("dependency_unsatisfied 는 연쇄 전용 blockReason"));
          }
          return events(mkEvent("task_blocked", { blockReason: outcome.blockReason }, { taskId }));
        case "structurally_invalid":
          return events(mkEvent("task_validation_failed", { issues: outcome.issues }, { taskId }));
        default: {
          const exhaustive: never = outcome;
          throw new Error(`complete_validation: 알 수 없는 결과 ${String(exhaustive)}`);
        }
      }
    }
    case "receive_input": {
      if (task.state !== "WAITING_INPUT") return rejected(rejectNotInTable());
      return events(mkEvent("task_input_received", {}, { taskId }));
    }
    case "schedule_task": {
      if (task.state === "READY") {
        if (command.cause !== "schedule" && command.cause !== "signal")
          return rejected(rejectCondition());
      } else if (task.state === "RETRY_WAIT") {
        if (command.cause !== "retry") return rejected(rejectCondition());
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
        if (task.trigger.kind !== "immediate")
          return rejected(rejectCondition("READY 시작은 immediate@1 만"));
      } else if (task.state === "SCHEDULED") {
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
    case "request_confirmation": {
      if (task.state !== "READY" && task.state !== "SCHEDULED") return rejected(rejectNotInTable());
      return events(
        mkEvent(
          "task_waiting_confirmation",
          { confirmationId: command.confirmationId },
          { taskId },
        ),
      );
    }
    case "park_awaiting_human": {
      if (task.state === "READY") {
        if (
          command.cause === "approval_required_before_execute" &&
          !task.policy.approvalRequiredBeforeExecute
        ) {
          return rejected(rejectCondition("approvalRequiredBeforeExecute 가 아님"));
        }
      } else if (task.state === "SCHEDULED") {
        if (command.cause !== "unattended_eligibility_refused") return rejected(rejectCondition());
      } else {
        return rejected(rejectNotInTable());
      }
      if (!isTaskSubjectDecision(command.decision) || command.decision.taskId !== taskId) {
        return rejected(rejectInvalidInput("decision 이 이 Task 주체가 아님"));
      }
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
      switch (routed.value) {
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
          const retryDelayMs = "retryDelayMs" in command.outcome ? command.outcome.retryDelayMs : 0;
          return events(
            mkEvent(
              "task_retry_wait",
              { attemptId, attemptNo, retryDelayMs, outcome: command.outcome },
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
          throw new Error(`record_attempt_outcome: 알 수 없는 라우팅 결과 ${routed.value}`);
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
      if (task.state !== "WAITING_CONFIRMATION") return rejected(rejectNotInTable());
      return events(
        mkEvent("reminder_occurrence_emitted", { occurrenceId: command.occurrenceId }, { taskId }),
      );
    }
    case "unblock": {
      if (task.state !== "BLOCKED") return rejected(rejectNotInTable());
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
    default: {
      const exhaustive: never = command;
      throw new Error(`decideTaskCommand: 알 수 없는 명령 ${String(exhaustive)}`);
    }
  }
}
