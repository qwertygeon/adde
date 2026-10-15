/**
 * 계획 제안 — 사전 거절, 제안 검증(그래프 → 초안 → 보존 집합 → 보존 member 참조 → 새 초안 참조 →
 * 결합 → 정의 초안 → 필수 member → 정규 JSON), digest, membership 변화, 필수 승인 판정, 커밋 이벤트 조립.
 * 제안 ID·digest·결정은 도메인이 만들고, 승인 grant 가 커밋하는 내용은 Work 가 보유한 제안뿐이다.
 * 검증 핵심은 기준 애그리거트와 제공 회차 필드 위에서 돈다 — 정의 템플릿도 "그 활성화로 materialize 될
 * 회차 Work 의 첫 계획" 기준으로 같은 핵심을 거친다.
 */
import { type Result, DomainInvariantError } from "../result.js";
import type { TaskId, WorkId, PlanProposalId, DecisionId } from "../ids.js";
import { nextEntityId } from "../ids.js";
import type { ContentHash } from "../derivation/dedup-key.js";
import type { CanonicalJsonError } from "../derivation/canonical-json.js";
import { canonicalJsonDigest, canonicalJsonFrozenCopy } from "../derivation/canonical-json.js";
import type { WorkAggregate, WorkRecord } from "../aggregate.js";
import type { TaskRef, PlanTaskDraft } from "../commands.js";
import type { DecidedEvent, DraftRefMapping } from "../events.js";
import { mkEvent } from "../events.js";
import type { CommandRejection, DomainDeps } from "../engine.js";
import type { PlanValidationIssue } from "../plan-graph.js";
import { validatePlanDrafts } from "../plan-graph.js";
import type { TriggerSpec } from "../trigger.js";
import type { TaskPolicy } from "../task-policy.js";
import type { ReactionSpec } from "../validation/reaction-spec.js";
import { validateTask } from "../validation/task-validation.js";
import type { NormalizedTaskDeclaration } from "../validation/task-validation.js";
import { isSatisfyingTerminal, isTerminalTaskState } from "../task-state.js";
import type { InputBinding } from "../task-result/binding.js";
import type { OccurrenceBindingField } from "../task-result/binding.js";
import {
  checkDraftBindings,
  producerWithoutOutputReason,
  providedOccurrenceFields,
} from "../task-result/binding.js";
import { validateDefinitionDraft } from "../definition/draft.js";
import { wellFormedPath } from "../derivation/value-text.js";
import { isPlanDraftFrame } from "../entry/shape.js";

export type PlanProposalSource = "planner" | "definition_template";

const PLAN_PROPOSAL_SOURCES: readonly string[] = ["planner", "definition_template"];

export interface PlanProposalInput {
  readonly basePlanRevision: number;
  readonly source: PlanProposalSource;
  readonly tasks: readonly PlanTaskDraft[];
  readonly retain: readonly TaskId[];
  /** WorkDefinitionDraft — 검증을 통과하면 정규화한 정의 초안으로 바뀐다. */
  readonly definition?: unknown;
}

/** 검증 정규화 초안 — digest·커밋의 원천. */
export interface ProposedTaskDraft {
  readonly draftRef: string;
  readonly type: { readonly id: string; readonly version: number };
  readonly title: string;
  readonly input: unknown;
  /** 비면 생략 */
  readonly inputBindings?: Readonly<Record<string, InputBinding>>;
  readonly dependsOn: readonly TaskRef[];
  readonly parent?: TaskRef;
  readonly trigger: TriggerSpec;
  readonly policy: TaskPolicy;
  readonly reactions: readonly ReactionSpec[];
}

export interface PlanProposal {
  readonly id: PlanProposalId;
  readonly workId: WorkId;
  readonly basePlanRevision: number;
  readonly source: PlanProposalSource;
  readonly tasks: readonly ProposedTaskDraft[];
  readonly retain: readonly TaskId[];
  readonly definition?: unknown;
  readonly digest: ContentHash;
}

export interface PlanMembershipChange {
  /** retain 중 B 안(작성 순) */
  readonly retained: readonly TaskId[];
  /** B\R 종결(B 순) */
  readonly superseded: readonly TaskId[];
  /** B\R 비종결(B 순) */
  readonly dropped: readonly TaskId[];
}

export type MandatoryApprovalReason = "removes_terminal_required_member" | "carries_definition";

export interface MandatoryApprovalJudgement {
  readonly required: boolean;
  /** removes_terminal_required_member → carries_definition 순 */
  readonly reasons: readonly MandatoryApprovalReason[];
  /** B 순 */
  readonly removedTerminalRequiredTaskIds: readonly TaskId[];
}

/** digest 원천 — 정규 JSON 왕복 깊은 동결 사본. */
export type PlanProposalContent = Pick<
  PlanProposal,
  "basePlanRevision" | "source" | "tasks" | "retain" | "definition"
>;

export type PlanProposalCheck =
  | {
      readonly valid: true;
      /** digest 를 계산한 동결 사본. 커밋은 이 값에서 만든다. */
      readonly content: PlanProposalContent;
      /** = content.tasks */
      readonly tasks: readonly ProposedTaskDraft[];
      readonly membership: PlanMembershipChange;
      readonly mandatoryApproval: MandatoryApprovalJudgement;
      readonly digest: ContentHash;
    }
  | { readonly valid: false; readonly issues: readonly PlanValidationIssue[] };

/** 보유 제안 재검증 결과 — 유효하면 커밋할 제안(보유 내용의 동결 사본·보유 id·digest). */
export type HeldProposalCheck =
  | {
      readonly valid: true;
      readonly proposal: PlanProposal;
      readonly membership: PlanMembershipChange;
      readonly mandatoryApproval: MandatoryApprovalJudgement;
    }
  | { readonly valid: false; readonly issues: readonly PlanValidationIssue[] };

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

const PLAN_INPUT_KEYS = ["basePlanRevision", "source", "tasks", "retain", "definition"] as const;

/**
 * raw 가 객체(비배열·비null)면 다섯 키를 한 번씩 읽어 새 동결 객체로(값 undefined 키 생략), 아니면 raw
 * 그대로. 호출자 값을 진입에서 한 번만 읽어 사전 거절과 검증이 같은 값을 보게 한다 — getter·Proxy 가
 * 읽을 때마다 다른 값을 내도 판정·digest·커밋이 갈리지 않는다.
 */
export function planInputEnvelope(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const envelope: Record<string, unknown> = {};
  for (const key of PLAN_INPUT_KEYS) {
    const value = raw[key];
    if (value !== undefined) envelope[key] = value;
  }
  return Object.freeze(envelope);
}

/** digest 입력 객체 = { workId, basePlanRevision, source, tasks, retain, definition? }. */
export function planProposalDigest(
  workId: WorkId,
  content: Pick<PlanProposal, "basePlanRevision" | "source" | "tasks" | "retain" | "definition">,
): Result<ContentHash, CanonicalJsonError> {
  return canonicalJsonDigest({
    workId,
    basePlanRevision: content.basePlanRevision,
    source: content.source,
    tasks: content.tasks,
    retain: content.retain,
    ...(content.definition !== undefined ? { definition: content.definition } : {}),
  });
}

export function planMembershipChange(
  aggregate: WorkAggregate,
  retain: readonly TaskId[],
): PlanMembershipChange {
  const base = aggregate.work.memberTaskIds;
  const baseSet = new Set<string>(base);
  const retained: TaskId[] = [];
  for (const taskId of retain) {
    if (baseSet.has(taskId) && !retained.includes(taskId)) retained.push(taskId);
  }
  const retainedSet = new Set<string>(retained);
  const superseded: TaskId[] = [];
  const dropped: TaskId[] = [];
  for (const taskId of base) {
    if (retainedSet.has(taskId)) continue;
    const task = aggregate.tasks[taskId];
    if (task !== undefined && isTerminalTaskState(task.state)) superseded.push(taskId);
    else dropped.push(taskId);
  }
  return { retained, superseded, dropped };
}

export function judgeMandatoryPlanApproval(
  aggregate: WorkAggregate,
  proposal: Pick<PlanProposalInput, "retain" | "definition">,
): MandatoryApprovalJudgement {
  const retainSet = new Set<string>(proposal.retain);
  const removedTerminalRequiredTaskIds = aggregate.work.memberTaskIds.filter(
    (taskId) => !retainSet.has(taskId) && aggregate.tasks[taskId]?.policy.terminalRequired === true,
  );
  const reasons: MandatoryApprovalReason[] = [];
  if (removedTerminalRequiredTaskIds.length > 0) reasons.push("removes_terminal_required_member");
  if (proposal.definition !== undefined) reasons.push("carries_definition");
  return { required: reasons.length > 0, reasons, removedTerminalRequiredTaskIds };
}

/** 계획 사전 거절 사유 — 검사 순서대로. */
export type PlanPreconditionCode =
  | "plan_not_object"
  | "source_reserved"
  | "source_unknown"
  | "tasks_retain_not_arrays"
  | "base_revision_mismatch"
  | "draft_frame_invalid";

function preconditionCodeOf(
  work: WorkRecord,
  plan: PlanProposalInput,
  checkRevision: boolean,
): PlanPreconditionCode | undefined {
  const input = planInputEnvelope(plan);
  if (!isPlainObject(input)) return "plan_not_object";
  if (input.source === "definition_template") return "source_reserved";
  if (typeof input.source !== "string" || !PLAN_PROPOSAL_SOURCES.includes(input.source)) {
    return "source_unknown";
  }
  const tasks = input.tasks;
  if (!Array.isArray(tasks) || !Array.isArray(input.retain)) return "tasks_retain_not_arrays";
  if (checkRevision && input.basePlanRevision !== work.planRevision) {
    return "base_revision_mismatch";
  }
  for (const draft of tasks) {
    if (!isPlanDraftFrame(draft)) return "draft_frame_invalid";
  }
  return undefined;
}

/**
 * 계획 사전 거절의 첫 사유 — 객체 아님 → 정의 템플릿 출처(materialize 만 만든다) → 출처 밖 값 → tasks·retain
 * 비배열 → 기준 revision 불일치 → 초안 틀 위반. 없으면 undefined. 입력은 planInputEnvelope 로 한 번 읽는다.
 */
export function planPreconditionCode(
  work: WorkRecord,
  plan: PlanProposalInput,
): PlanPreconditionCode | undefined {
  return preconditionCodeOf(work, plan, true);
}

const PRECONDITION_REJECTIONS: Readonly<Record<PlanPreconditionCode, CommandRejection>> =
  Object.freeze({
    plan_not_object: { reason: "invalid_input", detail: "plan 이 객체가 아님" },
    source_reserved: { reason: "invalid_input", detail: "definition_template_source_reserved" },
    source_unknown: { reason: "invalid_input", detail: "제안 출처가 정의된 값이 아님" },
    tasks_retain_not_arrays: { reason: "invalid_input", detail: "tasks·retain 은 배열이어야 한다" },
    base_revision_mismatch: {
      reason: "condition_not_met",
      detail: "basePlanRevision 이 Work.planRevision 과 다름",
    },
    draft_frame_invalid: { reason: "invalid_input", detail: "계획 초안 틀이 아님" },
  });

/** 명령 경로의 사전 거절 — planPreconditionCode 의 사유를 호출마다 새 거절 값으로. 없으면 undefined. */
export function planPreconditionRejection(
  work: WorkRecord,
  plan: PlanProposalInput,
): CommandRejection | undefined {
  const code = planPreconditionCode(work, plan);
  return code === undefined ? undefined : { ...PRECONDITION_REJECTIONS[code] };
}

interface DraftCheck {
  readonly issues: readonly PlanValidationIssue[];
  /** 초안 순서. 검증이 정규화하지 못한 초안은 undefined. */
  readonly normalized: readonly (NormalizedTaskDeclaration | undefined)[];
}

/**
 * 초안별 검증 — 의존 충족으로 발화하는 Trigger 인데 의존이 없음, 그리고 Task 검증의 차단·구조 실패.
 * 누락 입력은 계획을 무효로 만들지 않는다(Task 가 커밋된 뒤 검증에서 입력을 묻는다). 결합이 채울
 * 필드는 누락이 아니다.
 */
function checkDrafts(deps: DomainDeps, drafts: readonly PlanTaskDraft[]): DraftCheck {
  const issues: PlanValidationIssue[] = [];
  const normalized: (NormalizedTaskDeclaration | undefined)[] = [];
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
      ...(draft.inputBindings !== undefined ? { inputBindings: draft.inputBindings } : {}),
    });
    switch (result.exit) {
      case "valid":
      case "input_requested":
        normalized.push(result.normalized);
        break;
      case "blocked":
        normalized.push(undefined);
        issues.push({
          kind: "draft_invalid",
          draftRef: draft.draftRef,
          reason: result.blockReason,
        });
        break;
      case "validation_failed":
        normalized.push(undefined);
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

function normalizeDraft(
  draft: PlanTaskDraft,
  normalized: NormalizedTaskDeclaration,
): ProposedTaskDraft {
  const bindings = draft.inputBindings;
  return {
    draftRef: draft.draftRef,
    type: { id: draft.type.id, version: draft.type.version },
    title: draft.title,
    input: draft.input,
    ...(bindings !== undefined && Object.keys(bindings).length > 0
      ? { inputBindings: bindings }
      : {}),
    dependsOn: draft.dependsOn,
    ...(draft.parent !== undefined ? { parent: draft.parent } : {}),
    trigger: normalized.trigger,
    policy: normalized.policy,
    reactions: normalized.reactions,
  };
}

/** digest 를 뺀 검증 결과 — 기준 애그리거트 위에서 돈 검증 핵심의 출력. */
export type PlanContentCheck =
  | {
      readonly valid: true;
      /** 정규 JSON 왕복 깊은 동결 사본. */
      readonly content: PlanProposalContent;
      readonly membership: PlanMembershipChange;
      readonly mandatoryApproval: MandatoryApprovalJudgement;
    }
  | { readonly valid: false; readonly issues: readonly PlanValidationIssue[] };

/**
 * 등록부는 deps.registries(판정 시점 주입). 전제: 사전 거절을 통과한 입력. 진입에서 입력 전체를 정규 JSON
 * 왕복 깊은 동결 사본으로 바꾸고 이후 그 사본만 읽는다 — 검증한 값·digest 원천·커밋 내용이 같고, 이슈가
 * 가리키는 참조도 호출자 객체가 아니다. 사본을 만들 수 없는 내용은 판정할 내용이 없으므로 그 이슈 하나다.
 */
export function validatePlanProposal(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  plan: PlanProposalInput,
): PlanProposalCheck {
  const check = checkPlanContentOn(
    deps,
    aggregate,
    plan,
    providedOccurrenceFields(aggregate.work.source),
  );
  if (!check.valid) return check;
  const digest = planProposalDigest(aggregate.work.id, check.content);
  if (!digest.ok) {
    throw new DomainInvariantError("계획 검증: 정규 JSON 사본이 성공한 제안 내용의 digest 실패");
  }
  return {
    valid: true,
    content: check.content,
    tasks: check.content.tasks,
    membership: check.membership,
    mandatoryApproval: check.mandatoryApproval,
    digest: digest.value,
  };
}

/**
 * 검증 핵심 — 기준 애그리거트(계획 revision·기준 member·Task·Work 출처·관리 정의)와 제공 회차 필드
 * 위에서 판정한다. 정의 초안은 결합 뒤·필수 member 앞에서 검증하고, 정의 초안을 싣거나 정의를 관리(했던)
 * Work 의 계획은 필수 member 부재를 무효로 보지 않는다.
 */
export function checkPlanContentOn(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  plan: PlanProposalInput,
  occurrenceFields: ReadonlySet<OccurrenceBindingField>,
): PlanContentCheck {
  const work = aggregate.work;
  // 0. 입력 포착
  const captured = canonicalJsonFrozenCopy(planInputEnvelope(plan));
  if (!captured.ok) {
    return {
      valid: false,
      issues: [{ kind: "proposal_not_canonical_json", path: wellFormedPath(captured.error.path) }],
    };
  }
  const input = captured.value as PlanProposalInput;
  // 1. 기준 revision — grant·재검증 경로 전용(명령 경로는 사전 거절이 먼저 잡는다).
  if (input.basePlanRevision !== work.planRevision) {
    return {
      valid: false,
      issues: [
        {
          kind: "base_revision_mismatch",
          basePlanRevision: input.basePlanRevision,
          planRevision: work.planRevision,
        },
      ],
    };
  }
  const base = work.memberTaskIds;
  const baseSet = new Set<string>(base);

  // 2. 그래프 — 부모 {taskId} 는 기준 member 로 해석된다.
  const issues: PlanValidationIssue[] = [...validatePlanDrafts(input.tasks, base)];

  // 3. 초안
  const draftCheck = checkDrafts(deps, input.tasks);
  for (const issue of draftCheck.issues) issues.push(issue);

  // 4. 보존 집합(retain 순)
  const seen = new Set<string>();
  for (const taskId of input.retain) {
    if (seen.has(taskId)) {
      issues.push({ kind: "retained_duplicate", taskId });
      continue;
    }
    seen.add(taskId);
    if (!baseSet.has(taskId)) {
      issues.push({ kind: "retained_not_member", taskId });
      continue;
    }
    const task = aggregate.tasks[taskId];
    if (task === undefined) {
      issues.push({ kind: "retained_record_missing", taskId });
      continue;
    }
    if (isTerminalTaskState(task.state) && !isSatisfyingTerminal(task.state)) {
      issues.push({ kind: "retained_terminal_unsatisfying", taskId, state: task.state });
    }
  }
  const retained = new Set<TaskId>(input.retain.filter((taskId) => baseSet.has(taskId)));

  // 5. 보존 member 의 기존 참조(B 순, 의존 → 결합, 참조당 첫 실패 하나). 비종결 소비자의 결합은
  //    보존 생산자가 출력 없이 종결됐으면 다시는 충족될 수 없다.
  for (const taskId of base) {
    if (!retained.has(taskId)) continue;
    const task = aggregate.tasks[taskId];
    if (task === undefined) continue;
    for (const ref of task.dependsOn) {
      if (!retained.has(ref)) {
        issues.push({ kind: "member_reference_outside_revision", taskId, edge: "dependency", ref });
      }
    }
    for (const field of Object.keys(task.inputBindings).sort()) {
      const binding = task.inputBindings[field];
      if (binding === undefined || binding.from !== "task" || !("taskId" in binding.task)) continue;
      const ref = binding.task.taskId;
      if (!retained.has(ref)) {
        issues.push({ kind: "member_reference_outside_revision", taskId, edge: "binding", ref });
      } else if (!isTerminalTaskState(task.state)) {
        const producer = aggregate.tasks[ref];
        const reason =
          producer === undefined
            ? undefined
            : producerWithoutOutputReason(producer, binding.output);
        if (reason !== undefined) {
          issues.push({ kind: "member_binding_without_output", taskId, field, ref, reason });
        }
      }
    }
  }

  // 6. 새 초안의 Task 참조(초안 순) — 기준 member 중 보존하지 않는 것.
  for (const draft of input.tasks) {
    for (const ref of draft.dependsOn) {
      if ("taskId" in ref && baseSet.has(ref.taskId) && !retained.has(ref.taskId)) {
        issues.push({
          kind: "dependency_outside_revision",
          draftRef: draft.draftRef,
          taskId: ref.taskId,
        });
      }
    }
  }

  // 7. 결합(초안 순)
  const draftsByRef = new Map<string, PlanTaskDraft>();
  for (const draft of input.tasks) {
    if (!draftsByRef.has(draft.draftRef)) draftsByRef.set(draft.draftRef, draft);
  }
  const bindingContext = {
    registries: deps.registries,
    aggregate,
    drafts: draftsByRef,
    retained,
    workSource: work.source,
    occurrenceFields,
  };
  for (const draft of input.tasks) {
    for (const issue of checkDraftBindings(bindingContext, draft)) issues.push(issue);
  }

  // 7b. 정의 초안 — 초안 무효는 제안 전체를 무효로 만든다.
  const definitionCheck =
    input.definition === undefined
      ? undefined
      : validateDefinitionDraft(deps, aggregate, input.definition);
  if (definitionCheck !== undefined) {
    for (const issue of definitionCheck.issues) issues.push(issue);
  }

  // 8. 결과 membership 에 terminal-required member 가 있어야 한다 — 정의 초안을 싣거나 정의를 관리(했던)
  //    Work 는 정의가 그 Work 를 붙들므로 예외다.
  const retainedRequired = [...retained].some(
    (taskId) => aggregate.tasks[taskId]?.policy.terminalRequired === true,
  );
  const draftRequired = input.tasks.some((draft, index) => {
    const normalized = draftCheck.normalized[index];
    if (normalized !== undefined) return normalized.policy.terminalRequired;
    const rawPolicy = draft.policy as unknown;
    return isPlainObject(rawPolicy) && rawPolicy["terminalRequired"] === true;
  });
  const requiredMemberExempt = input.definition !== undefined || aggregate.definition !== undefined;
  if (!retainedRequired && !draftRequired && !requiredMemberExempt) {
    issues.push({ kind: "no_terminal_required_member" });
  }

  // 9. 정규화 제안 내용의 정규 JSON — 모든 초안이 정규화됐을 때만 판정할 수 있다.
  const normalizedAll = draftCheck.normalized.every((n) => n !== undefined);
  if (!normalizedAll) return { valid: false, issues };
  const tasks = input.tasks.map((draft, index) =>
    normalizeDraft(draft, draftCheck.normalized[index] as NormalizedTaskDeclaration),
  );
  // digest 와 커밋이 같은 값을 쓰도록 정규화 내용의 동결 사본을 먼저 만들고 digest 는 그 사본에서 계산한다.
  const contentCopy = canonicalJsonFrozenCopy({
    basePlanRevision: input.basePlanRevision,
    source: input.source,
    tasks,
    retain: input.retain,
    ...(input.definition !== undefined
      ? { definition: definitionCheck?.normalized ?? input.definition }
      : {}),
  });
  if (!contentCopy.ok) {
    issues.push({
      kind: "proposal_not_canonical_json",
      path: wellFormedPath(contentCopy.error.path),
    });
  }
  if (issues.length > 0 || !contentCopy.ok) return { valid: false, issues };
  const content = contentCopy.value as PlanProposalContent;

  return {
    valid: true,
    content,
    membership: planMembershipChange(aggregate, input.retain),
    mandatoryApproval: judgeMandatoryPlanApproval(aggregate, input),
  };
}

/** 보유 제안 → 재검증 입력. */
export function planProposalInputOf(proposal: PlanProposal): PlanProposalInput {
  return {
    basePlanRevision: proposal.basePlanRevision,
    source: proposal.source,
    tasks: proposal.tasks,
    retain: proposal.retain,
    ...(proposal.definition !== undefined ? { definition: proposal.definition } : {}),
  };
}

/**
 * 보유 제안 재검증(grant·대기 제안 재검증 공통). 보유 내용을 사본으로 한 번 읽어 무결성·검증·커밋에 같은
 * 사본을 쓴다. 사본의 digest 가 보유 digest 와 다르면 승인 대상과 다른 내용이라 무효다. 내용과 digest 가
 * 맞아도 Work 가 보유한 제안(ID·digest)이 아니면 무효이고, 새 제안과 같은 사전 거절 조건(기준 revision 은
 * 검증의 base_revision_mismatch 가 다룬다)에 걸려도 무효다. 유효하면 커밋할 제안은 재정규화한 내용이 아니라
 * 승인된 digest 의 내용(사본)이다.
 */
export function revalidateHeldProposal(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  held: PlanProposal,
): HeldProposalCheck {
  const heldId = held.id;
  const heldDigest = held.digest;
  const captured = canonicalJsonFrozenCopy(planProposalInputOf(held));
  if (!captured.ok) {
    return {
      valid: false,
      issues: [{ kind: "proposal_not_canonical_json", path: wellFormedPath(captured.error.path) }],
    };
  }
  const content = captured.value as PlanProposalContent;
  const digest = planProposalDigest(aggregate.work.id, content);
  if (!digest.ok) {
    throw new DomainInvariantError("보유 제안 재검증: 정규 JSON 사본이 성공한 내용의 digest 실패");
  }
  if (digest.value !== heldDigest) {
    return { valid: false, issues: [{ kind: "proposal_digest_mismatch" }] };
  }
  const work = aggregate.work;
  if (heldId !== work.pendingProposalId || heldDigest !== work.pendingProposalDigest) {
    return { valid: false, issues: [{ kind: "proposal_not_held" }] };
  }
  const precondition = preconditionCodeOf(work, content as PlanProposalInput, false);
  if (precondition !== undefined) {
    return {
      valid: false,
      issues: [{ kind: "proposal_precondition_unmet", reason: precondition }],
    };
  }
  const check = validatePlanProposal(deps, aggregate, content);
  if (!check.valid) return check;
  return {
    valid: true,
    proposal: Object.freeze({
      id: heldId,
      workId: aggregate.work.id,
      ...content,
      digest: heldDigest,
    }),
    membership: check.membership,
    mandatoryApproval: check.mandatoryApproval,
  };
}

/**
 * task_created…(초안 순, tsk_ 생성) → work_plan_committed → work_ready. inputBindings·dependsOn·parent 는
 * TaskId 로 해석. 검증하지 않으므로 공개 배럴에 두지 않는다 — 검증을 마친 직접 커밋·grant 경로만 부른다.
 */
export function buildPlanCommitEvents(
  deps: DomainDeps,
  proposal: PlanProposal,
  membership: PlanMembershipChange,
  options: {
    readonly decisionId?: DecisionId;
    /** `work_plan_committed` 와 `work_ready` 사이에 넣는 정의 이벤트(생성·개정과 그 해소). */
    readonly definitionEvents?: readonly DecidedEvent[];
    /** 정의 템플릿에서 만든 회차 Work 의 첫 계획. */
    readonly templateSource?: boolean;
  },
): readonly DecidedEvent[] {
  const workId = proposal.workId;
  const draftRefMap: DraftRefMapping[] = proposal.tasks.map((draft) => ({
    draftRef: draft.draftRef,
    taskId: nextEntityId(deps.ids, "task"),
  }));
  const taskIdOf = new Map(draftRefMap.map((m) => [m.draftRef, m.taskId]));
  function resolveRef(ref: TaskRef): TaskId {
    if ("draftRef" in ref) {
      const id = taskIdOf.get(ref.draftRef);
      if (id === undefined) {
        throw new Error(`계획 커밋: draftRef 를 TaskId 로 해석할 수 없음 ${ref.draftRef}`);
      }
      return id;
    }
    return ref.taskId;
  }
  function resolveBinding(binding: InputBinding): InputBinding {
    if (binding.from === "occurrence") return { from: "occurrence", field: binding.field };
    return { from: "task", task: { taskId: resolveRef(binding.task) }, output: binding.output };
  }
  const taskCreatedEvents = proposal.tasks.map((draft) => {
    const taskId = taskIdOf.get(draft.draftRef) as TaskId;
    const bindings = draft.inputBindings;
    const resolvedBindings =
      bindings !== undefined && Object.keys(bindings).length > 0
        ? Object.fromEntries(
            Object.keys(bindings).map((field) => [
              field,
              resolveBinding(bindings[field] as InputBinding),
            ]),
          )
        : undefined;
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
        trigger: draft.trigger,
        policy: draft.policy,
        reactions: draft.reactions,
        ...(resolvedBindings !== undefined ? { inputBindings: resolvedBindings } : {}),
      },
      { taskId, workId },
    );
  });
  return [
    ...taskCreatedEvents,
    mkEvent(
      "work_plan_committed",
      {
        proposalId: proposal.id,
        digest: proposal.digest,
        planRevision: proposal.basePlanRevision + 1,
        ...(options.decisionId !== undefined ? { decisionId: options.decisionId } : {}),
        draftRefMap,
        retained: membership.retained,
        superseded: membership.superseded,
        dropped: membership.dropped,
        ...(options.templateSource === true ? { source: "definition_template" as const } : {}),
      },
      { workId },
    ),
    ...(options.definitionEvents ?? []),
    mkEvent("work_ready", {}, { workId }),
  ];
}
