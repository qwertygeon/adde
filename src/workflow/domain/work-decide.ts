/**
 * Work 명령 판정과 계획 커밋(FR-010, FR-013) — design.md §6 표와 "계획 커밋 규칙" 그대로.
 * 파생 Work 상태 이벤트는 여기서 만들지 않는다(엔진이 §3 단계 5 에서 붙인다).
 */
import type { WorkRecord } from "./aggregate.js";
import type { TaskId, DecisionId } from "./ids.js";
import { nextEntityId } from "./ids.js";
import type { CreateWorkCommand, WorkCommand, PlanCommitInput } from "./commands.js";
import type { DecidedEvent, DraftRefMapping } from "./events.js";
import { mkEvent } from "./events.js";
import type { CommandRejection, DomainDeps } from "./engine.js";
import { validatePlanDrafts } from "./plan-graph.js";
import type { PlanValidationIssue } from "./plan-graph.js";
import type { PlanTaskDraft } from "./commands.js";
import { validateTask } from "./validation/task-validation.js";
import type { NormalizedTaskDeclaration } from "./validation/task-validation.js";

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

export type PlanCommitDecision =
  | { readonly kind: "events"; readonly events: readonly DecidedEvent[] }
  | { readonly kind: "rejected"; readonly rejection: CommandRejection };

export interface PlanCommitOptions {
  /** "reject" 는 신호 grant 경로 전용 — 무효면 이벤트 없이 거절한다(키 선점·Work 변화 없음). */
  readonly onInvalid?: "stay_planning" | "fail_work" | "reject";
  readonly decisionId?: DecisionId;
}

interface DraftCheck {
  readonly issues: readonly PlanValidationIssue[];
  /** 이슈가 없으면 초안마다 정규화한 Trigger·정책·반응(초안 순서). */
  readonly normalized: readonly NormalizedTaskDeclaration[];
}

/**
 * 초안별 검증 — 의존 충족으로 발화하는 Trigger 인데 의존이 없음, 그리고 Task 검증의 차단·구조 실패.
 * 누락 입력은 계획을 무효로 만들지 않는다(Task 가 커밋된 뒤 검증에서 입력을 묻는다).
 */
function checkDrafts(deps: DomainDeps, drafts: readonly PlanTaskDraft[]): DraftCheck {
  const issues: PlanValidationIssue[] = [];
  const normalized: NormalizedTaskDeclaration[] = [];
  for (const draft of drafts) {
    const trigger = draft.trigger as unknown as {
      readonly kind?: unknown;
      readonly version?: unknown;
    };
    if (typeof trigger.kind === "string" && typeof trigger.version === "number") {
      const descriptor = deps.registries.triggers.get(trigger.kind, trigger.version);
      if (descriptor?.firing === "dependencies_satisfied" && draft.dependsOn.length === 0) {
        issues.push({
          kind: "trigger_requires_dependencies",
          draftRef: draft.draftRef,
          trigger: { kind: trigger.kind, version: trigger.version },
        });
      }
    }
    const result = validateTask(deps.registries, {
      type: draft.type,
      input: draft.input,
      trigger: draft.trigger,
      policy: draft.policy,
      reactions: draft.reactions,
    });
    switch (result.exit) {
      case "valid":
      case "input_requested":
        normalized.push(result.normalized);
        break;
      case "blocked":
        issues.push({
          kind: "draft_invalid",
          draftRef: draft.draftRef,
          reason: result.blockReason,
        });
        break;
      case "validation_failed":
        issues.push({
          kind: "draft_invalid",
          draftRef: draft.draftRef,
          reason: { kind: "structurally_invalid", issues: result.issues },
        });
        break;
      default: {
        const exhaustive: never = result;
        throw new Error(`checkDrafts: 알 수 없는 검증 출구 ${String(exhaustive)}`);
      }
    }
  }
  return { issues, normalized };
}

/**
 * 계획 커밋 규칙의 공용 구현 — 직접 명령(`commit_plan`)과 신호 `human_decision` grant(plan 주체)
 * 양쪽이 재사용한다. 주체가 `PLANNING`(명령)이든 `WAITING_APPROVAL`(신호)이든 커밋 규칙 자체는 같다 —
 * 상태 검사는 호출자 책임. 그래프 이슈 뒤 초안 이슈를 붙이고, 이슈가 하나라도 있으면 Task 를 하나도
 * 만들지 않는다.
 */
export function decidePlanCommit(
  deps: DomainDeps,
  work: WorkRecord,
  proposal: PlanCommitInput,
  options: PlanCommitOptions = {},
): PlanCommitDecision {
  const workId = work.id;
  if (proposal.basePlanRevision !== work.planRevision) {
    return {
      kind: "rejected",
      rejection: rejectCondition("basePlanRevision 이 Work.planRevision 과 다름"),
    };
  }
  if (proposal.basePlanRevision !== 0 || proposal.retain.length > 0) {
    return {
      kind: "rejected",
      rejection: rejectUnsupported("재계획 커밋(보존·supersede)은 셋째 차수"),
    };
  }
  const draftCheck = checkDrafts(deps, proposal.drafts);
  const issues = [...validatePlanDrafts(proposal.drafts, []), ...draftCheck.issues];
  if (issues.length > 0) {
    if (options.onInvalid === "reject") {
      return {
        kind: "rejected",
        rejection: {
          reason: "condition_not_met",
          detail: "plan_revalidation_invalid",
          planIssues: issues,
        },
      };
    }
    const invalidEvent = mkEvent(
      "work_plan_invalid",
      { proposalId: proposal.proposalId, issues },
      { workId },
    );
    if (options.onInvalid === "fail_work") {
      return {
        kind: "events",
        events: [invalidEvent, mkEvent("work_failed", { cause: "planning_failed" }, { workId })],
      };
    }
    return { kind: "events", events: [invalidEvent] };
  }
  const draftRefMap: DraftRefMapping[] = proposal.drafts.map((d) => ({
    draftRef: d.draftRef,
    taskId: nextEntityId(deps.ids, "task"),
  }));
  const taskIdOf = new Map(draftRefMap.map((m) => [m.draftRef, m.taskId]));
  function resolveRef(ref: { readonly draftRef?: string; readonly taskId?: TaskId }): TaskId {
    if (ref.draftRef !== undefined) {
      const id = taskIdOf.get(ref.draftRef);
      if (id === undefined)
        throw new Error(`commit_plan: draftRef 를 TaskId 로 해석할 수 없음 ${ref.draftRef}`);
      return id;
    }
    if (ref.taskId !== undefined) return ref.taskId;
    throw new Error("commit_plan: TaskRef 가 draftRef·taskId 어느 것도 갖지 않음");
  }
  const taskCreatedEvents = proposal.drafts.map((draft, index) => {
    const taskId = taskIdOf.get(draft.draftRef) as TaskId;
    const normalized = draftCheck.normalized[index] as NormalizedTaskDeclaration;
    return mkEvent(
      "task_created",
      {
        taskId,
        draftRef: draft.draftRef,
        type: draft.type,
        title: draft.title,
        input: draft.input,
        dependsOn: draft.dependsOn.map(resolveRef),
        ...(draft.parent !== undefined ? { parentTaskId: resolveRef(draft.parent) } : {}),
        trigger: normalized.trigger,
        policy: normalized.policy,
        reactions: normalized.reactions,
      },
      { taskId, workId },
    );
  });
  const planRevision = proposal.basePlanRevision + 1;
  return {
    kind: "events",
    events: [
      ...taskCreatedEvents,
      mkEvent(
        "work_plan_committed",
        {
          proposalId: proposal.proposalId,
          digest: proposal.digest,
          planRevision,
          ...(options.decisionId !== undefined ? { decisionId: options.decisionId } : {}),
          draftRefMap,
          retained: [],
          superseded: [],
          dropped: [],
        },
        { workId },
      ),
      mkEvent("work_ready", {}, { workId }),
    ],
  };
}

export function decideWorkCommand(
  deps: DomainDeps,
  work: WorkRecord,
  command: WorkCommand,
): WorkDecideOutcome {
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
      const decision = command.decision;
      if (
        decision.kind !== "plan_approval_required" ||
        decision.workId !== workId ||
        decision.planProposalId !== command.proposalId
      ) {
        return rejected(rejectInvalidInput("decision 이 이 Work·제안 주체가 아님"));
      }
      return events(
        mkEvent(
          "work_plan_proposed",
          { proposalId: command.proposalId, digest: command.digest, decision },
          { workId },
        ),
      );
    }
    case "commit_plan": {
      if (work.state !== "PLANNING") return rejected(rejectNotInTable());
      const decisionId =
        work.pendingDecision !== undefined && work.pendingDecision.kind === "plan_approval_required"
          ? work.pendingDecision.id
          : undefined;
      // 직접 커밋은 무효면 항상 work_plan_invalid 를 커밋한다 — 이벤트 없는 거절은 신호 grant 경로
      // 전용이라, 타입 밖 값이 와도 넘기지 않고 fail_work 만 그대로 따른다.
      const decision = decidePlanCommit(deps, work, command.proposal, {
        onInvalid: command.onInvalid === "fail_work" ? "fail_work" : "stay_planning",
        ...(decisionId !== undefined ? { decisionId } : {}),
      });
      return decision.kind === "events" ? events(...decision.events) : rejected(decision.rejection);
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
