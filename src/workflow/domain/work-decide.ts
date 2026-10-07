/**
 * Work 명령 판정 — 계획 제안·직접 커밋은 `plan/proposal.ts` 의 사전 거절·검증·커밋 조립을 쓴다.
 * 파생 Work 상태 이벤트는 여기서 만들지 않는다(엔진이 커밋 파이프라인에서 붙인다).
 */
import type { WorkAggregate } from "./aggregate.js";
import { nextEntityId } from "./ids.js";
import type { CreateWorkCommand, WorkCommand } from "./commands.js";
import type { DecidedEvent } from "./events.js";
import { mkEvent } from "./events.js";
import type { CommandRejection, DomainDeps } from "./engine.js";
import type { PendingDecision } from "./pending-decision.js";
import type { PlanValidationIssue } from "./plan-graph.js";
import type { PlanProposal, PlanProposalContent, PlanProposalInput } from "./plan/proposal.js";
import {
  buildPlanCommitEvents,
  planInputEnvelope,
  planPreconditionRejection,
  validatePlanProposal,
} from "./plan/proposal.js";

export type WorkDecideOutcome =
  | { readonly kind: "events"; readonly events: readonly DecidedEvent[] }
  | { readonly kind: "rejected"; readonly rejection: CommandRejection };

function events(...list: readonly DecidedEvent[]): WorkDecideOutcome {
  return { kind: "events", events: list };
}
function rejected(rejection: CommandRejection): WorkDecideOutcome {
  return { kind: "rejected", rejection };
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
function rejectUnsupported(detail?: string): CommandRejection {
  return { reason: "unsupported_in_this_phase", ...(detail !== undefined ? { detail } : {}) };
}

/** `definition_occurrence` 는 unsupported_in_this_phase 로 거절(셋째 차수). */
export function decideCreateWork(deps: DomainDeps, command: CreateWorkCommand): WorkDecideOutcome {
  if (command.source.kind === "definition_occurrence") {
    return rejected(rejectUnsupported("definition_occurrence Work 생성은 셋째 차수"));
  }
  const workId = nextEntityId(deps.ids, "work");
  const correlationId = command.correlationId ?? workId;
  return events(
    mkEvent(
      "work_created",
      {
        workId,
        projectId: command.projectId,
        title: command.title,
        objective: command.objective,
        source: command.source,
        completionPolicyVersion: 1,
        correlationId,
      },
      { workId },
    ),
  );
}

/**
 * 무효 계획 출력 — 제안이 아니므로 제안 ID 를 받지 않는다. `fail_work` 면 Work 를 실패시킨다(그 밖의
 * 값은 계획 단계에 머문다).
 */
function invalidPlan(
  workId: WorkAggregate["work"]["id"],
  issues: readonly PlanValidationIssue[],
  onInvalid: unknown,
): WorkDecideOutcome {
  const invalidEvent = mkEvent("work_plan_invalid", { issues }, { workId });
  if (onInvalid === "fail_work") {
    return events(invalidEvent, mkEvent("work_failed", { cause: "planning_failed" }, { workId }));
  }
  return events(invalidEvent);
}

/**
 * 유효 제안 — 제안 ID 는 판정 시점에 생성한다. 내용은 검증이 digest 를 계산한 동결 사본이라 호출자 입력을
 * 다시 읽지 않는다.
 */
function proposalOf(
  deps: DomainDeps,
  workId: WorkAggregate["work"]["id"],
  content: PlanProposalContent,
  digest: PlanProposal["digest"],
): PlanProposal {
  return Object.freeze({
    id: nextEntityId(deps.ids, "planProposal"),
    workId,
    ...content,
    digest,
  });
}

export function decideWorkCommand(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  command: WorkCommand,
): WorkDecideOutcome {
  const work = aggregate.work;
  const workId = work.id;
  switch (command.kind) {
    case "start_planning": {
      if (work.state !== "DRAFT") return rejected(rejectNotInTable());
      return events(mkEvent("work_planning_started", {}, { workId }));
    }
    case "request_work_input": {
      if (work.state !== "PLANNING") return rejected(rejectNotInTable());
      return events(mkEvent("work_input_requested", { requests: command.requests }, { workId }));
    }
    case "receive_work_input": {
      if (work.state !== "WAITING_INPUT") return rejected(rejectNotInTable());
      return events(mkEvent("work_input_received", {}, { workId }));
    }
    case "propose_plan": {
      if (work.state !== "PLANNING") return rejected(rejectNotInTable());
      // 호출자 값은 여기서 한 번씩만 읽는다.
      const plan = planInputEnvelope(command.plan) as PlanProposalInput;
      const summary: unknown = command.summary;
      const onInvalid: unknown = command.onInvalid;
      const precondition = planPreconditionRejection(work, plan);
      if (precondition !== undefined) return rejected(precondition);
      if (typeof summary !== "string") {
        return rejected(rejectInvalidInput("summary 는 문자열이어야 한다"));
      }
      const check = validatePlanProposal(deps, aggregate, plan);
      if (!check.valid) return invalidPlan(work.id, check.issues, onInvalid);
      const proposal = proposalOf(deps, work.id, check.content, check.digest);
      const decision: PendingDecision = {
        id: nextEntityId(deps.ids, "decision"),
        kind: "plan_approval_required",
        workId,
        planProposalId: proposal.id,
        requestedAt: command.meta.now,
        summary,
        surfaceDeliveries: [],
      };
      return events(
        mkEvent(
          "work_plan_proposed",
          { proposalId: proposal.id, digest: proposal.digest, proposal, decision },
          { workId },
        ),
      );
    }
    case "commit_plan": {
      if (work.state !== "PLANNING") return rejected(rejectNotInTable());
      // 호출자 값은 여기서 한 번씩만 읽는다.
      const plan = planInputEnvelope(command.plan) as PlanProposalInput;
      const onInvalid: unknown = command.onInvalid;
      const precondition = planPreconditionRejection(work, plan);
      if (precondition !== undefined) return rejected(precondition);
      const check = validatePlanProposal(deps, aggregate, plan);
      if (!check.valid) return invalidPlan(work.id, check.issues, onInvalid);
      if (check.mandatoryApproval.required) {
        return rejected(rejectCondition("mandatory_plan_approval_required"));
      }
      // 계획 단계에는 계획 승인 결정이 없으므로 직접 커밋은 결정 ID 를 싣지 않는다.
      const proposal = proposalOf(deps, work.id, check.content, check.digest);
      return events(...buildPlanCommitEvents(deps, proposal, check.membership, {}));
    }
    case "fail_planning": {
      if (work.state !== "PLANNING") return rejected(rejectNotInTable());
      if (command.invalidPlan !== undefined) {
        return events(
          mkEvent("work_plan_invalid", { issues: command.invalidPlan.issues }, { workId }),
          mkEvent("work_failed", { cause: "planning_failed" }, { workId }),
        );
      }
      return events(mkEvent("work_failed", { cause: "planning_failed" }, { workId }));
    }
    case "withdraw_plan_proposal": {
      if (work.state !== "WAITING_APPROVAL") return rejected(rejectNotInTable());
      // 명령 경로의 철회 원인은 원문 변경 하나다 — 재검증 실패 원인은 도메인 재검증만 낸다.
      // 타입을 우회해 들어온 값을 거절한다.
      const cause: string = command.cause;
      if (cause !== "source_changed") {
        return rejected(rejectInvalidInput("withdraw_cause_not_allowed"));
      }
      const proposalId = work.pendingProposalId;
      if (proposalId === undefined) return rejected(rejectInvalidInput("대기 중인 제안 없음"));
      const decisionId = work.pendingDecision?.id;
      return events(
        mkEvent(
          "work_plan_withdrawn",
          { proposalId, ...(decisionId !== undefined ? { decisionId } : {}), cause: command.cause },
          { workId },
        ),
      );
    }
    case "fail_work": {
      if (work.state !== "ACTIVE") return rejected(rejectNotInTable());
      return events(mkEvent("work_failed", { cause: "declared_failure_policy" }, { workId }));
    }
    case "cancel_work": {
      if (work.state === "COMPLETED" || work.state === "FAILED" || work.state === "CANCELED") {
        return rejected(rejectNotInTable());
      }
      if (command.origin.kind === "vault_signal" && command.origin.actorSource !== "human_local") {
        return rejected(rejectInvalidInput("vault_signal 취소는 human_local 필수"));
      }
      return events(mkEvent("work_canceled", { origin: command.origin }, { workId }));
    }
    default: {
      const exhaustive: never = command;
      throw new Error(`decideWorkCommand: 알 수 없는 명령 ${String(exhaustive)}`);
    }
  }
}
