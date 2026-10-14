/**
 * 정의 초안 검증·정규화와 템플릿 출처 제안. 초안은 순서대로 형태 → 제안 Work 출처 → 관리 관계(개정 대상·
 * 중지 여부·기대 revision·신규 등록 자격) → 활성화 → 열린 회차 상한 → 신호 회차 상한 → 템플릿을 보고
 * 이슈를 모두 모은다. 템플릿은 "그 활성화로 materialize 될 회차 Work 의 첫 계획" — 기준 member 없음·계획
 * revision 0·회차 Work 출처·발화 선언이 제공하는 회차 필드 — 으로 계획 검증 핵심을 거친다.
 *
 * materialize 는 정의 스냅숏의 템플릿을 그대로 커밋한다. 검증은 유효·무효 판정에만 쓰고, digest 의 원천도
 * 같은 스냅숏이다(생성될 Work ID 를 넣지 않아 같은 회차의 digest 가 결정적이다).
 */
import { DomainInvariantError } from "../result.js";
import type { WorkDefinitionId, WorkId, ProjectId, OccurrenceId } from "../ids.js";
import { parseEntityId } from "../ids.js";
import type { UtcInstant } from "../values.js";
import type { ContentHash } from "../derivation/dedup-key.js";
import { canonicalJsonDigest, canonicalJsonFrozenCopy } from "../derivation/canonical-json.js";
import type { OccurrenceInput, WorkAggregate, WorkRecord, WorkSource } from "../aggregate.js";
import type { TriggerSpec } from "../trigger.js";
import type { DomainDeps } from "../engine.js";
import type { PlanValidationIssue } from "../plan-graph.js";
import type { PlanProposalContent, ProposedTaskDraft } from "../plan/proposal.js";
import { checkPlanContentOn } from "../plan/proposal.js";
import type { OccurrenceBindingField } from "../task-result/binding.js";
import { providedOccurrenceFields } from "../task-result/binding.js";
import { OCCURRENCE_FIELDS_BY_FIRING } from "../contract/occurrence-input.js";
import type { DefinitionDraftInvalidReason, DefinitionRecord } from "./model.js";
import { isScheduleActivation, isSignalActivation } from "./model.js";

/** 검증을 통과한 정의 초안 — 제안 내용의 `definition` 자리에 정규 JSON 동결 사본으로 들어간다. */
export interface DefinitionDraftContent {
  readonly amends?: {
    readonly definitionId: WorkDefinitionId;
    readonly expectedRevision: number;
  };
  readonly title: string;
  /** descriptor 스키마로 파싱한 활성화. */
  readonly activation: TriggerSpec;
  /** 정규화한 템플릿 초안. */
  readonly template: readonly ProposedTaskDraft[];
  readonly maxOpenOccurrences: number;
  readonly maxOccurrences?: number;
}

export interface DefinitionDraftCheck {
  readonly issues: readonly PlanValidationIssue[];
  /** 이슈가 없을 때만. */
  readonly normalized?: DefinitionDraftContent;
}

export type TemplateProposalCheck =
  | {
      readonly valid: true;
      readonly content: PlanProposalContent;
      readonly digest: ContentHash;
    }
  | { readonly valid: false; readonly issues: readonly PlanValidationIssue[] };

const DRAFT_KEYS: readonly string[] = [
  "amends",
  "title",
  "activation",
  "template",
  "maxOpenOccurrences",
  "maxOccurrences",
];
const REQUIRED_DRAFT_KEYS: readonly string[] = [
  "title",
  "activation",
  "template",
  "maxOpenOccurrences",
];

/** 템플릿 검증 문맥의 회차 Work 기준 — 판정 문맥일 뿐 커밋되지 않는다. */
const VIEW_INSTANT = "1970-01-01T00:00:00.000Z" as UtcInstant;

function isPlainObject(raw: unknown): raw is Readonly<Record<string, unknown>> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isPositiveSafeInteger(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1;
}

function invalid(reason: DefinitionDraftInvalidReason): PlanValidationIssue {
  return { kind: "definition_invalid", reason };
}

function parseAmends(raw: unknown): DefinitionDraftContent["amends"] | "malformed" | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) return "malformed";
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !Object.hasOwn(raw, "definitionId")) return "malformed";
  if (!Object.hasOwn(raw, "expectedRevision")) return "malformed";
  const definitionId = raw["definitionId"];
  const expectedRevision = raw["expectedRevision"];
  if (typeof definitionId !== "string") return "malformed";
  const parsedId = parseEntityId("workDefinition", definitionId);
  if (!parsedId.ok) return "malformed";
  if (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return "malformed";
  }
  return { definitionId: parsedId.value, expectedRevision };
}

interface ShapedDraft {
  readonly amends: DefinitionDraftContent["amends"];
  readonly title: string;
  readonly activation: unknown;
  readonly template: readonly unknown[];
  readonly maxOpenOccurrences: unknown;
  readonly maxOccurrences: unknown;
}

function shapeOf(raw: unknown): ShapedDraft | undefined {
  if (!isPlainObject(raw)) return undefined;
  const keys = Object.keys(raw);
  if (keys.some((key) => !DRAFT_KEYS.includes(key))) return undefined;
  if (REQUIRED_DRAFT_KEYS.some((key) => !Object.hasOwn(raw, key))) return undefined;
  const title = raw["title"];
  const template = raw["template"];
  if (typeof title !== "string" || !Array.isArray(template)) return undefined;
  const amends = parseAmends(raw["amends"]);
  if (amends === "malformed") return undefined;
  return {
    amends,
    title,
    activation: raw["activation"],
    template,
    maxOpenOccurrences: raw["maxOpenOccurrences"],
    maxOccurrences: raw["maxOccurrences"],
  };
}

type ActivationCheck =
  | {
      readonly ok: true;
      readonly activation: TriggerSpec;
      readonly activationKind: "schedule_activation" | "signal_activation";
      readonly occurrenceFields: ReadonlySet<OccurrenceBindingField>;
    }
  | { readonly ok: false; readonly reason: DefinitionDraftInvalidReason };

function checkActivation(deps: DomainDeps, raw: unknown): ActivationCheck {
  const view = (isPlainObject(raw) ? raw : {}) as {
    readonly kind?: unknown;
    readonly version?: unknown;
  };
  const descriptor =
    typeof view.kind === "string" && typeof view.version === "number"
      ? deps.registries.triggers.get(view.kind, view.version)
      : undefined;
  if (descriptor === undefined) return { ok: false, reason: "activation_descriptor_unknown" };
  const parsed = descriptor.schema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "activation_schema_invalid" };
  const activation = parsed.data as unknown as TriggerSpec;
  const activationKind = isScheduleActivation(deps.registries, activation)
    ? "schedule_activation"
    : isSignalActivation(deps.registries, activation)
      ? "signal_activation"
      : undefined;
  if (activationKind === undefined) return { ok: false, reason: "activation_kind_not_allowed" };
  return {
    ok: true,
    activation,
    activationKind,
    occurrenceFields: new Set(OCCURRENCE_FIELDS_BY_FIRING[descriptor.firing] ?? []),
  };
}

/** 회차 Work 의 첫 계획 기준 — 기준 member 없음·계획 revision 0·회차 Work 출처·관리 정의 없음. */
function occurrenceWorkView(
  projectId: ProjectId,
  source: WorkSource,
  correlationId: string,
): WorkAggregate {
  const work: WorkRecord = {
    id: "wrk_occurrenceview" as WorkId,
    projectId,
    title: "",
    objective: "",
    state: "PLANNING",
    revision: 0,
    taskIds: [],
    planRevision: 0,
    memberTaskIds: [],
    source,
    completionPolicyVersion: 1,
    startedUnderCurrentRevision: false,
    createdAt: VIEW_INSTANT,
    updatedAt: VIEW_INSTANT,
    correlationId,
  };
  return { work, tasks: {}, acceptedSignalKeys: [], decisionSubjects: {}, commitSeq: 0 };
}

function validateTemplate(
  deps: DomainDeps,
  view: WorkAggregate,
  template: readonly unknown[],
  occurrenceFields: ReadonlySet<OccurrenceBindingField>,
) {
  return checkPlanContentOn(
    deps,
    view,
    {
      basePlanRevision: 0,
      source: "definition_template",
      tasks: template as PlanProposalContent["tasks"],
      retain: [],
    },
    occurrenceFields,
  );
}

/**
 * 정의 초안 검증. `aggregate` 는 제안을 받은 Work. 이슈가 하나라도 있으면 제안은 무효다. 형태가 어긋나면
 * 그 이슈 하나로 끝난다.
 */
export function validateDefinitionDraft(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  raw: unknown,
): DefinitionDraftCheck {
  const draft = shapeOf(raw);
  if (draft === undefined) return { issues: [invalid("draft_malformed")] };
  const issues: PlanValidationIssue[] = [];

  if (aggregate.work.source.kind !== "markdown") issues.push(invalid("work_source_not_markdown"));

  const stewarded = aggregate.definition;
  if (draft.amends !== undefined) {
    if (stewarded === undefined || stewarded.id !== draft.amends.definitionId) {
      issues.push(invalid("amends_not_steward"));
    } else {
      if (stewarded.state === "STOPPED") issues.push(invalid("amends_definition_stopped"));
      if (draft.amends.expectedRevision !== stewarded.revision) {
        issues.push(invalid("amends_revision_mismatch"));
      }
    }
  } else if (stewarded !== undefined) {
    issues.push(invalid("already_stewards_definition"));
  }

  const activation = checkActivation(deps, draft.activation);
  if (!activation.ok) issues.push(invalid(activation.reason));

  if (!isPositiveSafeInteger(draft.maxOpenOccurrences)) {
    issues.push(invalid("max_open_occurrences_invalid"));
  }

  if (draft.maxOccurrences !== undefined) {
    if (activation.ok && activation.activationKind === "schedule_activation") {
      issues.push(invalid("max_occurrences_not_allowed"));
    } else if (!isPositiveSafeInteger(draft.maxOccurrences)) {
      issues.push(invalid("max_occurrences_invalid"));
    }
  }

  const templateView = occurrenceWorkView(
    aggregate.work.projectId,
    {
      kind: "definition_occurrence",
      definitionId: (draft.amends?.definitionId ?? "wdf_draftview") as WorkDefinitionId,
      definitionRevision: 0,
      occurrenceId: "",
      input: {
        occurrenceId: "",
        definitionId: (draft.amends?.definitionId ?? "wdf_draftview") as WorkDefinitionId,
        definitionRevision: 0,
      },
    },
    aggregate.work.correlationId,
  );
  const templateCheck = validateTemplate(
    deps,
    templateView,
    draft.template,
    activation.ok ? activation.occurrenceFields : new Set(),
  );
  if (!templateCheck.valid) {
    for (const issue of templateCheck.issues) {
      issues.push({ kind: "definition_template_issue", issue });
    }
  }

  if (issues.length > 0 || !activation.ok || !templateCheck.valid) return { issues };
  const maxOpenOccurrences = draft.maxOpenOccurrences as number;
  const maxOccurrences = draft.maxOccurrences as number | undefined;
  return {
    issues: [],
    normalized: {
      ...(draft.amends !== undefined ? { amends: draft.amends } : {}),
      title: draft.title,
      activation: activation.activation,
      template: templateCheck.content.tasks,
      maxOpenOccurrences,
      ...(maxOccurrences !== undefined ? { maxOccurrences } : {}),
    },
  };
}

/** 템플릿 출처 제안 digest — 정의·revision·회차와 템플릿 스냅숏. 생성될 Work ID 를 넣지 않는다. */
export function templateProposalDigest(input: {
  readonly definitionId: WorkDefinitionId;
  readonly definitionRevision: number;
  readonly occurrenceId: OccurrenceId;
  readonly tasks: readonly ProposedTaskDraft[];
}): ContentHash {
  const digest = canonicalJsonDigest({
    source: "definition_template",
    definitionId: input.definitionId,
    definitionRevision: input.definitionRevision,
    occurrenceId: input.occurrenceId,
    basePlanRevision: 0,
    tasks: input.tasks,
    retain: [],
  });
  if (!digest.ok) {
    throw new DomainInvariantError("템플릿 제안 digest: 정의 템플릿이 정규 JSON 이 아니다");
  }
  return digest.value;
}

/**
 * 회차의 템플릿 출처 제안. 템플릿을 회차 입력의 실제 필드 기준으로 검증하고, 유효하면 정의 스냅숏의
 * 템플릿을 그대로 담은 제안 내용과 digest 를 돌려준다.
 */
export function buildTemplateProposal(
  deps: DomainDeps,
  definition: DefinitionRecord,
  occurrence: { readonly occurrenceId: OccurrenceId; readonly input: OccurrenceInput },
): TemplateProposalCheck {
  const source: WorkSource = {
    kind: "definition_occurrence",
    definitionId: definition.id,
    definitionRevision: occurrence.input.definitionRevision,
    occurrenceId: occurrence.occurrenceId,
    input: occurrence.input,
  };
  const view = occurrenceWorkView(definition.projectId, source, definition.correlationId);
  const check = validateTemplate(deps, view, definition.template, providedOccurrenceFields(source));
  if (!check.valid) return { valid: false, issues: check.issues };
  const contentCopy = canonicalJsonFrozenCopy({
    basePlanRevision: 0,
    source: "definition_template",
    tasks: definition.template,
    retain: [],
  });
  if (!contentCopy.ok) {
    throw new DomainInvariantError("템플릿 제안: 정의 템플릿이 정규 JSON 이 아니다");
  }
  return {
    valid: true,
    content: contentCopy.value as PlanProposalContent,
    digest: templateProposalDigest({
      definitionId: definition.id,
      definitionRevision: occurrence.input.definitionRevision,
      occurrenceId: occurrence.occurrenceId,
      tasks: definition.template,
    }),
  };
}
