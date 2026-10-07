/**
 * Task 검증 — VALIDATING 의 출구를 처음 성립하는 하나로 정한다: 식별 형태 → 미등록 descriptor →
 * 구조 → 승인 채널 → 누락 입력 → 성공. 고칠 수 없는 오류가 사람에게 묻는 것보다 먼저 온다. 입력은
 * 판정만 하고 채우지 않는다(스키마 출력을 쓰지 않음). Trigger·정책·반응은 정규화한 값을 돌려준다.
 */
import { DomainInvariantError } from "../result.js";
import type { DomainRegistries } from "../registry/registries.js";
import type { TaskRecord } from "../aggregate.js";
import type {
  InputRequest,
  MissingInputIssue,
  ReactionDescriptor,
  TaskTypeDescriptor,
  TriggerDescriptor,
} from "../registry/descriptors.js";
import { taskTypeFieldProfile } from "../registry/field-profile.js";
import type { TriggerSpec } from "../trigger.js";
import type { TaskPolicy } from "../task-policy.js";
import { parseTaskPolicy } from "../task-policy.js";
import { judgeApprovalSurface } from "../policy/approval-surface.js";
import type {
  UnknownDescriptorRef,
  DescriptorUnknownBlockReason,
  ApprovalSurfaceRefusedBlockReason,
} from "../commands.js";
import type { ReactionSpec } from "./reaction-spec.js";
import { checkReactionSpecs } from "./reaction-spec.js";

export type ValidationIssueArea = "identity" | "input" | "trigger" | "policy" | "reactions";

export interface ValidationIssue {
  readonly area: ValidationIssueArea;
  readonly path: readonly (string | number)[];
  readonly code:
    | "type_identity_malformed"
    | "trigger_identity_malformed"
    | "reactions_not_array"
    | "reaction_identity_malformed"
    | "input_not_object"
    | "input_field_invalid"
    | "input_unknown_field"
    | "trigger_invalid"
    | "recurrence_not_allowed_on_task_trigger"
    | "policy_invalid"
    | "reaction_params_invalid"
    | "reaction_logical_id_invalid"
    | "reaction_logical_id_duplicate"
    | "reaction_on_invalid"
    | "reaction_not_transition";
  /** 스키마 issue code 또는 정책 형식 오류 사유. */
  readonly detail?: string;
}

export interface TaskDeclaration {
  readonly type: { readonly id: string; readonly version: number };
  readonly input: unknown;
  readonly trigger: unknown;
  readonly policy: unknown;
  /** 부재 = [] */
  readonly reactions?: unknown;
  /** 결합 선언 — 키만 읽는다(결합이 채울 필드는 누락 입력이 아니다). */
  readonly inputBindings?: Readonly<Record<string, unknown>>;
}

export interface NormalizedTaskDeclaration {
  readonly trigger: TriggerSpec;
  readonly policy: TaskPolicy;
  readonly reactions: readonly ReactionSpec[];
}

export type TaskValidationResult =
  | { readonly exit: "valid"; readonly normalized: NormalizedTaskDeclaration }
  | {
      readonly exit: "input_requested";
      readonly requests: readonly InputRequest[];
      readonly normalized: NormalizedTaskDeclaration;
    }
  | { readonly exit: "validation_failed"; readonly issues: readonly ValidationIssue[] }
  | { readonly exit: "blocked"; readonly blockReason: DescriptorUnknownBlockReason }
  | {
      readonly exit: "blocked";
      readonly blockReason: ApprovalSurfaceRefusedBlockReason;
      readonly normalized: NormalizedTaskDeclaration;
    };

interface Identity {
  readonly id: string;
  readonly version: number;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** 자기 속성이 없거나 값이 `undefined` 면 부재다(스키마 issue code 는 부재와 잘못된 값을 가르지 않는다). */
function isPresent(input: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(input, field) && input[field] !== undefined;
}

function identityFrom(raw: unknown, idKey: "id" | "kind", positive: boolean): Identity | undefined {
  if (!isPlainObject(raw)) return undefined;
  const id = raw[idKey];
  const version = raw["version"];
  if (typeof id !== "string" || typeof version !== "number" || !Number.isInteger(version)) {
    return undefined;
  }
  if (positive && version < 1) return undefined;
  return { id, version };
}

function pathSegment(segment: PropertyKey): string | number {
  return typeof segment === "number" ? segment : String(segment);
}

function inputIssues(
  taskType: TaskTypeDescriptor,
  input: Record<string, unknown>,
  schemaKeys: readonly string[],
): ValidationIssue[] {
  const parsed = taskType.schema.safeParse(input);
  if (parsed.success) return [];
  const fieldIssues: { readonly order: number; readonly issue: ValidationIssue }[] = [];
  const unknownIssues: ValidationIssue[] = [];
  for (const issue of parsed.error.issues) {
    if (issue.path.length === 0 && issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        unknownIssues.push({ area: "input", path: [key], code: "input_unknown_field" });
      }
      continue;
    }
    const head = issue.path[0];
    if (typeof head === "string" && !isPresent(input, head)) continue;
    const order = typeof head === "string" ? schemaKeys.indexOf(head) : -1;
    fieldIssues.push({
      order,
      issue: {
        area: "input",
        path: issue.path.map(pathSegment),
        code: "input_field_invalid",
        detail: issue.code,
      },
    });
  }
  const sortedFieldIssues = fieldIssues
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((entry) => entry.issue);
  return [...sortedFieldIssues, ...unknownIssues];
}

function missingInputRequests(
  taskType: TaskTypeDescriptor,
  input: Record<string, unknown>,
  policy: TaskPolicy,
  boundFields: ReadonlySet<string>,
): readonly InputRequest[] {
  const profile = taskTypeFieldProfile(taskType);
  const missing: MissingInputIssue[] = [];
  for (const field of profile.schemaKeys) {
    if (boundFields.has(field)) continue;
    const required =
      profile.requiredFields.has(field) ||
      (profile.unattendedRequiredFields.has(field) && policy.unattended.eligible);
    if (!required || isPresent(input, field)) continue;
    const metadata = taskType.inputFields[field];
    if (metadata === undefined) {
      throw new DomainInvariantError(`필수 입력 필드 ${field} 에 메타데이터가 없다`);
    }
    missing.push({ field, metadata });
  }
  if (missing.length === 0) return [];
  const defaults = missing.map((issue): InputRequest => ({
    questionId: issue.field,
    field: issue.field,
    prompt: issue.metadata.question,
    safetyRelevant: issue.metadata.safetyRelevant,
  }));
  if (taskType.describeMissingInput === undefined) return defaults;
  const overridden = taskType.describeMissingInput(missing);
  const promptByField = new Map<string, string>();
  for (const request of overridden) {
    if (
      promptByField.has(request.field) ||
      typeof request.prompt !== "string" ||
      request.prompt.trim().length === 0
    ) {
      throw new DomainInvariantError(
        `describeMissingInput 결과가 계약을 어겼다(필드 중복 또는 빈 문구): ${request.field}`,
      );
    }
    promptByField.set(request.field, request.prompt);
  }
  const sameFields =
    promptByField.size === missing.length && missing.every((m) => promptByField.has(m.field));
  if (!sameFields) {
    throw new DomainInvariantError("describeMissingInput 결과의 필드 집합이 누락 필드와 다르다");
  }
  return defaults.map((request) => ({
    ...request,
    prompt: promptByField.get(request.field) as string,
  }));
}

export function validateTask(
  registries: DomainRegistries,
  declaration: TaskDeclaration,
): TaskValidationResult {
  // 1. 식별 형태
  const identityIssues: ValidationIssue[] = [];
  const typeIdentity = identityFrom(declaration.type, "id", true);
  if (typeIdentity === undefined) {
    identityIssues.push({ area: "identity", path: ["type"], code: "type_identity_malformed" });
  }
  const triggerIdentity = identityFrom(declaration.trigger, "kind", false);
  if (triggerIdentity === undefined) {
    identityIssues.push({
      area: "identity",
      path: ["trigger"],
      code: "trigger_identity_malformed",
    });
  }
  const rawReactions = declaration.reactions === undefined ? [] : declaration.reactions;
  const reactionIdentities: Identity[] = [];
  if (!Array.isArray(rawReactions)) {
    identityIssues.push({ area: "identity", path: ["reactions"], code: "reactions_not_array" });
  } else {
    rawReactions.forEach((raw: unknown, index) => {
      const identity = identityFrom(raw, "kind", false);
      if (identity === undefined) {
        identityIssues.push({
          area: "identity",
          path: ["reactions", index],
          code: "reaction_identity_malformed",
        });
      } else {
        reactionIdentities.push(identity);
      }
    });
  }
  if (identityIssues.length > 0 || typeIdentity === undefined || triggerIdentity === undefined) {
    return { exit: "validation_failed", issues: identityIssues };
  }
  const declaredReactions = rawReactions as readonly unknown[];

  // 2. 등록부 조회 — 다른 버전으로 대체하지 않는다.
  const unknown: UnknownDescriptorRef[] = [];
  const taskType = registries.taskTypes.get(typeIdentity.id, typeIdentity.version);
  if (taskType === undefined) unknown.push({ axis: "task_type", ...typeIdentity });
  const triggerDescriptor = registries.triggers.get(triggerIdentity.id, triggerIdentity.version);
  if (triggerDescriptor === undefined) unknown.push({ axis: "trigger", ...triggerIdentity });
  const reactionDescriptors: ReactionDescriptor[] = [];
  for (const identity of reactionIdentities) {
    const descriptor = registries.reactions.get(identity.id, identity.version);
    if (descriptor === undefined) unknown.push({ axis: "reaction", ...identity });
    else reactionDescriptors.push(descriptor);
  }
  if (unknown.length > 0 || taskType === undefined || triggerDescriptor === undefined) {
    return { exit: "blocked", blockReason: { kind: "descriptor_unknown", descriptors: unknown } };
  }

  // 3. 구조
  const issues: ValidationIssue[] = [];
  const input = declaration.input;
  const inputIsObject = isPlainObject(input);
  if (!inputIsObject) {
    issues.push({ area: "input", path: [], code: "input_not_object" });
  } else {
    issues.push(...inputIssues(taskType, input, taskTypeFieldProfile(taskType).schemaKeys));
  }

  const trigger = parseTrigger(triggerDescriptor, declaration.trigger, issues);

  const policyResult = parseTaskPolicy(declaration.policy);
  if (!policyResult.ok) {
    issues.push({
      area: "policy",
      path: isPlainObject(declaration.policy) ? policyResult.error.field.split(".") : [],
      code: "policy_invalid",
      detail: policyResult.error.reason,
    });
  }

  const reactionCheck = checkReactionSpecs(declaredReactions, reactionDescriptors);
  for (const issue of reactionCheck.issues) {
    issues.push({
      area: "reactions",
      path: issue.path,
      code: issue.code,
      ...(issue.detail !== undefined ? { detail: issue.detail } : {}),
    });
  }

  if (issues.length > 0 || !inputIsObject || trigger === undefined || !policyResult.ok) {
    return { exit: "validation_failed", issues };
  }
  const normalized: NormalizedTaskDeclaration = {
    trigger,
    policy: policyResult.value,
    reactions: reactionCheck.specs,
  };

  // 4. 승인 채널
  const verdict = judgeApprovalSurface({
    taskType,
    policy: policyResult.value,
    declaredReactions: reactionDescriptors,
  });
  if (!verdict.accepted) {
    return {
      exit: "blocked",
      blockReason: {
        kind: "approval_surface_refused",
        reason: verdict.reason,
        declaredSurface: "out_of_band",
      },
      normalized,
    };
  }

  // 5. 누락 입력
  const declaredBindings: unknown = declaration.inputBindings;
  const boundFields = new Set(isPlainObject(declaredBindings) ? Object.keys(declaredBindings) : []);
  const requests = missingInputRequests(taskType, input, policyResult.value, boundFields);
  if (requests.length > 0) return { exit: "input_requested", requests, normalized };

  // 6. 성공
  return { exit: "valid", normalized };
}

/**
 * Task 레코드의 검증 선언으로 검증한다. 검증 판정과 재계획 게이트가 같은 선언·같은 등록부로 같은 출구를
 * 얻도록 선언 구성을 한 곳에 둔다.
 */
export function validateTaskRecord(
  registries: DomainRegistries,
  task: Pick<TaskRecord, "type" | "input" | "trigger" | "policy" | "reactions" | "inputBindings">,
): TaskValidationResult {
  return validateTask(registries, {
    type: task.type,
    input: task.input,
    trigger: task.trigger,
    policy: task.policy,
    reactions: task.reactions,
    inputBindings: task.inputBindings,
  });
}

function parseTrigger(
  descriptor: TriggerDescriptor,
  raw: unknown,
  issues: ValidationIssue[],
): TriggerSpec | undefined {
  const parsed = descriptor.schema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        area: "trigger",
        path: issue.path.map(pathSegment),
        code: "trigger_invalid",
        detail: issue.code,
      });
    }
  }
  if (isPlainObject(raw) && raw["recurrence"] !== undefined) {
    issues.push({
      area: "trigger",
      path: ["recurrence"],
      code: "recurrence_not_allowed_on_task_trigger",
    });
  }
  return parsed.success ? (parsed.data as TriggerSpec) : undefined;
}
