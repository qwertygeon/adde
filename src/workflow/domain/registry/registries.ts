/**
 * 확장 등록부 — descriptor 목록에서 한 번에 구성하는 불변 등록부. 결함·`(id, version)` 충돌은 구성
 * 실패(입력 순서로 첫 실패)이고 덮어쓰기는 없다. 조회는 `(id, version)` 정확 일치이며 다른 버전으로
 * 대체하지 않는다. descriptor 는 한 번만 읽어 분리 사본을 만들고 식별·결함·충돌·저장을 모두 그
 * 사본으로 한다(읽을 때마다 값이 달라지는 입력이 검사와 다른 값을 저장하지 못하게). 저장 사본의
 * 평범한 데이터는 모든 깊이에서 동결한다 — 스키마 객체·함수는 첫 검증 때 자기 내부 캐시를 기록하므로
 * 참조 그대로 두고 동결하지 않는다.
 */
import * as z from "zod";
import { type Result, ok, err } from "../result.js";
import type {
  TaskTypeDescriptor,
  TriggerDescriptor,
  ReactionDescriptor,
  InputFieldMetadata,
} from "./descriptors.js";
import { EXECUTION_EFFECTS, FIRING_MODES } from "./descriptors.js";
import { computeTaskTypeFieldProfile, rememberTaskTypeFieldProfile } from "./field-profile.js";

export type RegistryAxis = "task_type" | "trigger" | "reaction";

export type DescriptorDefect =
  | { readonly code: "identity_invalid" }
  | { readonly code: "execution_effect_invalid" }
  | { readonly code: "schema_not_object" }
  | { readonly code: "required_field_without_metadata"; readonly field: string }
  | { readonly code: "metadata_for_unknown_field"; readonly field: string }
  | { readonly code: "metadata_invalid"; readonly field: string }
  | { readonly code: "safety_field_has_default"; readonly field: string }
  | { readonly code: "conditional_field_not_optional"; readonly field: string }
  | { readonly code: "output_from_unknown_input"; readonly output: string; readonly field: string }
  | { readonly code: "output_invalid"; readonly output: string }
  | { readonly code: "declaration_invalid"; readonly declaration: string };

export type RegistryConstructionError =
  | {
      readonly kind: "registration_collision";
      readonly axis: RegistryAxis;
      readonly id: string;
      readonly version: number;
    }
  | {
      readonly kind: "descriptor_invalid";
      readonly axis: RegistryAxis;
      readonly id: string;
      readonly version: number;
      readonly defect: DescriptorDefect;
    };

export interface DescriptorRegistry<D> {
  /** 저장된 동결 사본(같은 객체)을 반환한다. */
  get(id: string, version: number): D | undefined;
  /** id(코드 단위) → version 오름차순. */
  list(): readonly D[];
}

export type TaskTypeRegistry = DescriptorRegistry<TaskTypeDescriptor>;
export type TriggerRegistry = DescriptorRegistry<TriggerDescriptor>;
export type ReactionRegistry = DescriptorRegistry<ReactionDescriptor>;

export interface DomainRegistries {
  readonly taskTypes: TaskTypeRegistry;
  readonly triggers: TriggerRegistry;
  readonly reactions: ReactionRegistry;
}

const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,63}$/;
const OCCURRENCE_DERIVATION_KINDS: readonly string[] = ["none", "schedule", "event_caused"];
const DECLARED_AS_VALUES: readonly string[] = ["execution_effect", "transition_reaction"];

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isValidIdentity(id: unknown, version: unknown): boolean {
  return (
    typeof id === "string" &&
    IDENTIFIER_RE.test(id) &&
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= 1
  );
}

function isStringArray(raw: unknown): raw is readonly string[] {
  return Array.isArray(raw) && raw.every((v) => typeof v === "string");
}

function identityKey(id: string, version: number): string {
  return `${id}@${version}`;
}

function compareIdentity(
  a: { readonly id: string; readonly version: number },
  b: { readonly id: string; readonly version: number },
): number {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.version - b.version;
}

interface FieldSchema {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

function taskTypeDefect(descriptor: TaskTypeDescriptor): DescriptorDefect | undefined {
  if (!isValidIdentity(descriptor.id, descriptor.version)) return { code: "identity_invalid" };
  if (!EXECUTION_EFFECTS.includes(descriptor.executionEffect)) {
    return { code: "execution_effect_invalid" };
  }
  if (!(descriptor.schema instanceof z.ZodObject)) return { code: "schema_not_object" };
  if (!isPlainObject(descriptor.inputFields)) {
    return { code: "declaration_invalid", declaration: "inputFields" };
  }
  const shape = descriptor.schema.shape as Readonly<Record<string, FieldSchema>>;
  const schemaKeys = Object.keys(shape);
  const inputFields = descriptor.inputFields as Readonly<Record<string, unknown>>;

  for (const key of schemaKeys) {
    const field = shape[key] as FieldSchema;
    if (!field.safeParse(undefined).success && !Object.hasOwn(inputFields, key)) {
      return { code: "required_field_without_metadata", field: key };
    }
  }
  for (const key of Object.keys(inputFields)) {
    if (!Object.hasOwn(shape, key)) return { code: "metadata_for_unknown_field", field: key };
  }
  for (const key of Object.keys(inputFields)) {
    if (!isValidMetadata(inputFields[key])) return { code: "metadata_invalid", field: key };
  }
  for (const key of Object.keys(inputFields)) {
    const metadata = inputFields[key] as InputFieldMetadata;
    const field = shape[key] as FieldSchema;
    const empty = field.safeParse(undefined);
    if (metadata.safetyRelevant && empty.success && empty.data !== undefined) {
      return { code: "safety_field_has_default", field: key };
    }
    if (metadata.requiredWhen !== undefined && !empty.success) {
      return { code: "conditional_field_not_optional", field: key };
    }
  }

  if (!isPlainObject(descriptor.outputs)) {
    return { code: "declaration_invalid", declaration: "outputs" };
  }
  for (const [name, declaration] of Object.entries(descriptor.outputs)) {
    if (declaration instanceof z.ZodType) continue;
    if (isPlainObject(declaration) && typeof declaration["outputSchemaFromInput"] === "string") {
      const field = declaration["outputSchemaFromInput"];
      if (!Object.hasOwn(shape, field)) {
        return { code: "output_from_unknown_input", output: name, field };
      }
      continue;
    }
    return { code: "output_invalid", output: name };
  }

  const capabilities = descriptor.capabilities as unknown;
  if (
    !isPlainObject(capabilities) ||
    typeof capabilities["canAutoPlan"] !== "boolean" ||
    typeof capabilities["requiresHumanBeforeExecute"] !== "boolean"
  ) {
    return { code: "declaration_invalid", declaration: "capabilities" };
  }
  if (typeof descriptor.approvalGatesQuestionOnly !== "boolean") {
    return { code: "declaration_invalid", declaration: "approvalGatesQuestionOnly" };
  }
  if (typeof descriptor.executionIsWaitRequest !== "boolean") {
    return { code: "declaration_invalid", declaration: "executionIsWaitRequest" };
  }
  if (
    descriptor.describeMissingInput !== undefined &&
    typeof descriptor.describeMissingInput !== "function"
  ) {
    return { code: "declaration_invalid", declaration: "describeMissingInput" };
  }
  return undefined;
}

function isValidMetadata(raw: unknown): raw is InputFieldMetadata {
  if (!isPlainObject(raw)) return false;
  if (typeof raw["question"] !== "string" || raw["question"].trim().length === 0) return false;
  if (typeof raw["safetyRelevant"] !== "boolean") return false;
  const requiredWhen = raw["requiredWhen"];
  return requiredWhen === undefined || requiredWhen === "unattended_eligible";
}

function triggerDefect(descriptor: TriggerDescriptor): DescriptorDefect | undefined {
  if (!isValidIdentity(descriptor.kind, descriptor.version)) return { code: "identity_invalid" };
  if (!(descriptor.schema instanceof z.ZodObject)) return { code: "schema_not_object" };
  if (!FIRING_MODES.includes(descriptor.firing)) {
    return { code: "declaration_invalid", declaration: "firing" };
  }
  const derivation = descriptor.occurrenceDerivation as unknown;
  if (
    !isPlainObject(derivation) ||
    typeof derivation["kind"] !== "string" ||
    !OCCURRENCE_DERIVATION_KINDS.includes(derivation["kind"]) ||
    (derivation["kind"] !== "none" && !isStringArray(derivation["inputs"]))
  ) {
    return { code: "declaration_invalid", declaration: "occurrenceDerivation" };
  }
  return undefined;
}

function reactionDefect(descriptor: ReactionDescriptor): DescriptorDefect | undefined {
  if (!isValidIdentity(descriptor.kind, descriptor.version)) return { code: "identity_invalid" };
  const invalid = (declaration: string): DescriptorDefect => ({
    code: "declaration_invalid",
    declaration,
  });
  if (typeof descriptor.performsExternalEffect !== "boolean") {
    return invalid("performsExternalEffect");
  }
  if (typeof descriptor.usesAddeCredentials !== "boolean") return invalid("usesAddeCredentials");
  if (typeof descriptor.dispatchesAgent !== "boolean") return invalid("dispatchesAgent");
  const retry = descriptor.retry as unknown;
  if (
    !isPlainObject(retry) ||
    !isStringArray(retry["permanentErrorCodes"]) ||
    typeof retry["canEndAmbiguous"] !== "boolean"
  ) {
    return invalid("retry");
  }
  if (descriptor.usesAddeCredentials && !descriptor.performsExternalEffect) {
    return invalid("usesAddeCredentials");
  }
  if (
    descriptor.dispatchesAgent &&
    (!descriptor.performsExternalEffect || descriptor.usesAddeCredentials)
  ) {
    return invalid("dispatchesAgent");
  }
  if (descriptor.retry.canEndAmbiguous && !descriptor.performsExternalEffect) {
    return invalid("retry");
  }
  if (!DECLARED_AS_VALUES.includes(descriptor.declaredAs)) return invalid("declaredAs");
  const logicalId = descriptor.reactionLogicalId as unknown;
  if (!isPlainObject(logicalId)) return invalid("reactionLogicalId");
  const isFixed = logicalId["kind"] === "fixed";
  if (!isFixed && logicalId["kind"] !== "per_declaration") return invalid("reactionLogicalId");
  if (isFixed !== (descriptor.declaredAs === "execution_effect")) {
    return invalid("reactionLogicalId");
  }
  if (
    isFixed &&
    (typeof logicalId["value"] !== "string" || !IDENTIFIER_RE.test(logicalId["value"]))
  ) {
    return invalid("reactionLogicalId");
  }
  if (!(descriptor.paramsSchema instanceof z.ZodObject)) return invalid("paramsSchema");
  return undefined;
}

function isPlainData(value: unknown): value is object {
  if (Array.isArray(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 선언 데이터가 평범한 데이터가 아님 — 순환, 또는 스키마·함수가 아닌 비평범 객체(클래스 인스턴스 등). */
class NotPlainDeclaration {}

/** `"__proto__"` 같은 키도 프로토타입을 바꾸지 않는 일반 속성으로 쓴다. */
function defineData(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** zod 값 또는 그렇게 위장한 객체(zod 의 `instanceof` 는 `_zod` 내부 표식으로 판정한다). */
function isSchemaLike(value: object): boolean {
  return value instanceof z.ZodType || "_zod" in value;
}

/**
 * 선언 데이터를 재귀 복사한다(자기 열거 문자열 키를 키마다 한 번 읽음). 함수·원시값은 그대로 두고,
 * zod 스키마는 스키마 자리(`schemaAllowed`)에서만 참조로 둔다. 그 밖의 자리의 스키마·위장 객체,
 * 비평범 객체, 순환은 NotPlainDeclaration 으로 거절한다 — 복사·동결할 수 없는 객체를 저장하면 구성
 * 뒤에 선언이 바뀔 수 있다.
 */
function copyPlain(value: unknown, ancestors: Set<object>, schemaAllowed: boolean): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (isSchemaLike(value)) {
    if (schemaAllowed && value instanceof z.ZodType) return value;
    throw new NotPlainDeclaration();
  }
  if (!isPlainData(value)) throw new NotPlainDeclaration();
  if (ancestors.has(value)) throw new NotPlainDeclaration();
  ancestors.add(value);
  const source = value as Record<string, unknown>;
  const out: object = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(source)) {
    defineData(out, key, copyPlain(source[key], ancestors, false));
  }
  ancestors.delete(value);
  return out;
}

/** 축별 스키마 자리 — 필드 자체가 스키마이거나(`whole`), 필드의 각 값이 스키마일 수 있다(`values`). */
interface SchemaPositions {
  readonly whole: readonly string[];
  readonly values: readonly string[];
}

function copyField(key: string, value: unknown, root: object, positions: SchemaPositions): unknown {
  if (positions.whole.includes(key)) return copyPlain(value, new Set([root]), true);
  if (!positions.values.includes(key) || typeof value !== "object" || value === null) {
    return copyPlain(value, new Set([root]), false);
  }
  if (isSchemaLike(value) || !isPlainData(value) || Array.isArray(value)) {
    throw new NotPlainDeclaration();
  }
  const source = value as Record<string, unknown>;
  const out = {};
  for (const childKey of Object.keys(source)) {
    defineData(out, childKey, copyPlain(source[childKey], new Set([root, value]), true));
  }
  return out;
}

function deepFreezePlain(value: unknown): void {
  if (!isPlainData(value)) return;
  for (const child of Object.values(value)) deepFreezePlain(child);
  Object.freeze(value);
}

type DetachedCopy =
  | { readonly ok: true; readonly copy: Record<string, unknown> }
  | { readonly ok: false; readonly top: Record<string, unknown>; readonly invalidField: string };

/** descriptor 의 분리 사본. 최상위 값도 키마다 한 번만 읽고, 거절은 그 최상위 필드로 보고한다. */
function detach(descriptor: unknown, positions: SchemaPositions): DetachedCopy {
  const source = descriptor as Record<string, unknown>;
  const top: Record<string, unknown> = {};
  for (const key of Object.keys(source)) defineData(top, key, source[key]);
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(top)) {
    try {
      defineData(copy, key, copyField(key, top[key], source, positions));
    } catch (error) {
      if (error instanceof NotPlainDeclaration) return { ok: false, top, invalidField: key };
      throw error;
    }
  }
  return { ok: true, copy };
}

interface AxisSpec<D> {
  readonly axis: RegistryAxis;
  readonly identity: (d: D) => { readonly id: string; readonly version: number };
  readonly defect: (d: D) => DescriptorDefect | undefined;
  readonly schemaPositions: SchemaPositions;
  /** 동결된 사본으로 하는 축별 후처리. */
  readonly afterFreeze?: (d: D) => void;
}

function buildRegistry<D>(
  spec: AxisSpec<D>,
  descriptors: readonly D[],
): Result<DescriptorRegistry<D>, RegistryConstructionError> {
  const byKey = new Map<string, D>();
  for (const descriptor of descriptors) {
    const detached = detach(descriptor, spec.schemaPositions);
    if (!detached.ok) {
      const { id, version } = spec.identity(detached.top as D);
      return err({
        kind: "descriptor_invalid",
        axis: spec.axis,
        id,
        version,
        defect: { code: "declaration_invalid", declaration: detached.invalidField },
      });
    }
    const copy = detached.copy as D;
    const { id, version } = spec.identity(copy);
    const defect = spec.defect(copy);
    if (defect !== undefined) {
      return err({ kind: "descriptor_invalid", axis: spec.axis, id, version, defect });
    }
    const key = identityKey(id, version);
    if (byKey.has(key)) {
      return err({ kind: "registration_collision", axis: spec.axis, id, version });
    }
    deepFreezePlain(copy);
    spec.afterFreeze?.(copy);
    byKey.set(key, copy);
  }
  const sorted = Object.freeze(
    [...byKey.values()].sort((a, b) => compareIdentity(spec.identity(a), spec.identity(b))),
  );
  return ok(
    Object.freeze({
      get(id: string, version: number): D | undefined {
        return byKey.get(identityKey(id, version));
      },
      list(): readonly D[] {
        return sorted;
      },
    }),
  );
}

function identityOf(id: unknown, version: unknown): { id: string; version: number } {
  return {
    id: typeof id === "string" ? id : String(id),
    version: typeof version === "number" ? version : Number.NaN,
  };
}

export function createTaskTypeRegistry(
  descriptors: readonly TaskTypeDescriptor[],
): Result<TaskTypeRegistry, RegistryConstructionError> {
  return buildRegistry<TaskTypeDescriptor>(
    {
      axis: "task_type",
      identity: (d) => identityOf(d.id, d.version),
      defect: taskTypeDefect,
      schemaPositions: { whole: ["schema"], values: ["outputs"] },
      afterFreeze: (d) => rememberTaskTypeFieldProfile(d, computeTaskTypeFieldProfile(d)),
    },
    descriptors,
  );
}

export function createTriggerRegistry(
  descriptors: readonly TriggerDescriptor[],
): Result<TriggerRegistry, RegistryConstructionError> {
  return buildRegistry<TriggerDescriptor>(
    {
      axis: "trigger",
      identity: (d) => identityOf(d.kind, d.version),
      defect: triggerDefect,
      schemaPositions: { whole: ["schema"], values: [] },
    },
    descriptors,
  );
}

export function createReactionRegistry(
  descriptors: readonly ReactionDescriptor[],
): Result<ReactionRegistry, RegistryConstructionError> {
  return buildRegistry<ReactionDescriptor>(
    {
      axis: "reaction",
      identity: (d) => identityOf(d.kind, d.version),
      defect: reactionDefect,
      schemaPositions: { whole: ["paramsSchema"], values: [] },
    },
    descriptors,
  );
}

/** TaskType → Trigger → Reaction 순으로 첫 오류. */
export function createDomainRegistries(input: {
  readonly taskTypes: readonly TaskTypeDescriptor[];
  readonly triggers: readonly TriggerDescriptor[];
  readonly reactions: readonly ReactionDescriptor[];
}): Result<DomainRegistries, RegistryConstructionError> {
  const taskTypes = createTaskTypeRegistry(input.taskTypes);
  if (!taskTypes.ok) return taskTypes;
  const triggers = createTriggerRegistry(input.triggers);
  if (!triggers.ok) return triggers;
  const reactions = createReactionRegistry(input.reactions);
  if (!reactions.ok) return reactions;
  return ok(
    Object.freeze({
      taskTypes: taskTypes.value,
      triggers: triggers.value,
      reactions: reactions.value,
    }),
  );
}
