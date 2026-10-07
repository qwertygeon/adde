/**
 * 입력 결합 — 계획 결합 검사(결합당 첫 실패), 첫 효과 시작에서의 해석, 결합 인지 의존 충족 판정.
 * 결합은 생산자 결과에 기록된 출력값만 넘긴다. 결합 출처의 종류는 선언 형태(`from`)로만 가르고,
 * 유형·Trigger 식별자나 occurrence 필드 값으로 분기하지 않는다.
 */
import { type Result, ok, err, DomainInvariantError } from "../result.js";
import type { TaskId, ResultId } from "../ids.js";
import type { ContentHash } from "../derivation/dedup-key.js";
import { canonicalJsonDigest } from "../derivation/canonical-json.js";
import type { DomainRegistries } from "../registry/registries.js";
import type { TaskTypeDescriptor } from "../registry/descriptors.js";
import { resolveTaskOutput } from "../registry/outputs.js";
import type { TaskRecord, WorkAggregate, WorkSource } from "../aggregate.js";
import type { TaskRef, PlanTaskDraft } from "../commands.js";
import type { PlanValidationIssue } from "../plan-graph.js";
import { isSatisfyingTerminal, isTerminalTaskState } from "../task-state.js";
import { parseDataSchema } from "./data-schema.js";
import type { SchemaShape } from "./schema-shape.js";
import { proveSchemaSubset, shapeOf } from "./schema-shape.js";
import type * as z from "zod";

export type OccurrenceBindingField = "scheduledForUtc" | "localDate" | "timezone" | "signal";

export type InputBinding =
  | { readonly from: "task"; readonly task: TaskRef; readonly output: string }
  | { readonly from: "occurrence"; readonly field: OccurrenceBindingField };

export interface BoundInput {
  readonly field: string;
  /** 커밋된 형태({taskId}). */
  readonly binding: InputBinding;
  /** from:"task" */
  readonly resultId?: ResultId;
  /** canonicalJsonDigest(결합 값) */
  readonly digest: ContentHash;
}

export type BindingResolutionFailure =
  | {
      readonly kind: "producer_result_missing";
      readonly field: string;
      readonly producerTaskId: TaskId;
    }
  | { readonly kind: "occurrence_unsupported"; readonly field: string }
  | { readonly kind: "safety_field_bound"; readonly field: string };

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function isTaskRef(raw: unknown): raw is TaskRef {
  if (!isPlainObject(raw)) return false;
  if (hasExactKeys(raw, ["draftRef"])) return typeof raw["draftRef"] === "string";
  if (hasExactKeys(raw, ["taskId"])) return typeof raw["taskId"] === "string";
  return false;
}

/** 결합 선언의 형태 판정 — 정의된 두 형태 밖의 키·값은 형태 위반이다. */
export function isInputBinding(raw: unknown): raw is InputBinding {
  if (!isPlainObject(raw)) return false;
  if (raw["from"] === "task") {
    return (
      hasExactKeys(raw, ["from", "task", "output"]) &&
      isTaskRef(raw["task"]) &&
      typeof raw["output"] === "string"
    );
  }
  if (raw["from"] === "occurrence") {
    return hasExactKeys(raw, ["from", "field"]) && typeof raw["field"] === "string";
  }
  return false;
}

function sameRef(a: TaskRef, b: TaskRef): boolean {
  if ("draftRef" in a) return "draftRef" in b && a.draftRef === b.draftRef;
  return "taskId" in b && a.taskId === b.taskId;
}

/**
 * 소비자 descriptor 가 안전 관련으로 선언한 입력 필드인가. 안전 관련 필드는 사람이 채우고 계획자의
 * 추론으로 채우지 않는다 — 결합은 다른 Task 의 출력이 채우므로 같은 금지에 든다.
 */
function isSafetyRelevantField(consumer: TaskTypeDescriptor, field: string): boolean {
  return (
    Object.hasOwn(consumer.inputFields, field) &&
    consumer.inputFields[field]?.safetyRelevant === true
  );
}

/**
 * 결합한 생산자가 출력 없이 종결됐는가 — 비종결이면 undefined, SKIPPED 면 "skipped", 결과가 없거나
 * 결과 출력에 그 이름이 없으면 "output_absent".
 */
export function producerWithoutOutputReason(
  record: TaskRecord,
  output: string,
): "skipped" | "output_absent" | undefined {
  if (!isTerminalTaskState(record.state)) return undefined;
  if (record.state === "SKIPPED") return "skipped";
  const outputs = record.result?.outputs;
  if (outputs === undefined || !Object.hasOwn(outputs, output)) return "output_absent";
  return undefined;
}

function unwrapOptional(shape: SchemaShape): SchemaShape {
  return shape.k === "optional" ? shape.inner : shape;
}

/** 계획 결합 검사의 결과 revision 문맥. */
export interface PlanBindingContext {
  readonly registries: DomainRegistries;
  readonly aggregate: WorkAggregate;
  /** 같은 제안의 초안(draftRef → 초안). 중복 draftRef 는 첫 초안. */
  readonly drafts: ReadonlyMap<string, PlanTaskDraft>;
  /** 보존 집합 중 기준 member 인 것. */
  readonly retained: ReadonlySet<TaskId>;
  readonly workSource: WorkSource;
}

interface ProducerView {
  readonly type: { readonly id: string; readonly version: number };
  readonly input: unknown;
  readonly record?: TaskRecord;
}

function producerOf(context: PlanBindingContext, ref: TaskRef): ProducerView | undefined {
  if ("draftRef" in ref) {
    const draft = context.drafts.get(ref.draftRef);
    return draft === undefined ? undefined : { type: draft.type, input: draft.input };
  }
  if (!context.retained.has(ref.taskId)) return undefined;
  const record = context.aggregate.tasks[ref.taskId];
  return record === undefined ? undefined : { type: record.type, input: record.input, record };
}

/**
 * 초안 하나의 결합 검사 — 필드 이름 정렬, 결합당 첫 실패 하나. 소비자 descriptor 가 없는 초안은
 * 건너뛴다(초안 검증이 이미 무효로 판정한다).
 */
export function checkDraftBindings(
  context: PlanBindingContext,
  draft: PlanTaskDraft,
): readonly PlanValidationIssue[] {
  const declared = draft.inputBindings as unknown;
  if (declared === undefined) return [];
  const consumer = context.registries.taskTypes.get(draft.type.id, draft.type.version);
  if (consumer === undefined) return [];
  const draftRef = draft.draftRef;
  if (!isPlainObject(declared)) return [{ kind: "binding_malformed", draftRef, field: "" }];
  const issues: PlanValidationIssue[] = [];
  for (const field of Object.keys(declared).sort()) {
    const issue = checkOneBinding(context, draft, consumer, field, declared[field]);
    if (issue !== undefined) issues.push(issue);
  }
  return issues;
}

function checkOneBinding(
  context: PlanBindingContext,
  draft: PlanTaskDraft,
  consumer: TaskTypeDescriptor,
  field: string,
  binding: unknown,
): PlanValidationIssue | undefined {
  const draftRef = draft.draftRef;
  const consumerShape = consumer.schema.shape as Readonly<Record<string, z.ZodType>>;
  if (!isInputBinding(binding)) return { kind: "binding_malformed", draftRef, field };
  if (binding.from === "occurrence" && context.workSource.kind !== "definition_occurrence") {
    return { kind: "binding_occurrence_unavailable", draftRef, field };
  }
  if (!Object.hasOwn(consumerShape, field)) {
    return { kind: "binding_input_field_unknown", draftRef, field };
  }
  if (isSafetyRelevantField(consumer, field)) {
    return { kind: "binding_safety_field", draftRef, field };
  }
  const input = draft.input;
  if (isPlainObject(input) && Object.hasOwn(input, field) && input[field] !== undefined) {
    return { kind: "binding_overlaps_input", draftRef, field };
  }
  if (binding.from === "occurrence") return undefined;

  const ref = binding.task;
  const producer = producerOf(context, ref);
  if (producer === undefined) return { kind: "binding_producer_not_member", draftRef, field, ref };
  if (!draft.dependsOn.some((dependency) => sameRef(dependency, ref))) {
    return { kind: "binding_producer_not_dependency", draftRef, field, ref };
  }
  const producerType = context.registries.taskTypes.get(producer.type.id, producer.type.version);
  const resolved =
    producerType === undefined
      ? undefined
      : resolveTaskOutput(producerType, producer.input, binding.output);
  if (resolved === undefined) {
    return { kind: "binding_output_undeclared", draftRef, field, output: binding.output };
  }
  const record = producer.record;
  const withoutOutput =
    record === undefined ? undefined : producerWithoutOutputReason(record, binding.output);
  if (withoutOutput !== undefined) {
    return { kind: "binding_producer_without_output", draftRef, field, reason: withoutOutput };
  }

  let producerSchema: z.ZodType;
  if (resolved.source === "declared") {
    producerSchema = resolved.schema;
  } else {
    const parsed = parseDataSchema(resolved.schema);
    if (!parsed.ok) {
      return {
        kind: "binding_schema_incompatible",
        draftRef,
        field,
        reason: "producer_schema_unsupported",
      };
    }
    producerSchema = parsed.value;
  }
  const consumerSchema = consumerShape[field] as z.ZodType;
  const provable = proveSchemaSubset(
    unwrapOptional(shapeOf(producerSchema, "producer")),
    unwrapOptional(shapeOf(consumerSchema, "consumer")),
  );
  if (!provable) {
    return { kind: "binding_schema_incompatible", draftRef, field, reason: "not_provable" };
  }
  return undefined;
}

/** 필드 정렬. 결합이 없으면 ok([]). 해석 값이 소비자 필드 스키마를 어기면 DomainInvariantError. */
export function resolveBoundInputs(
  registries: DomainRegistries,
  aggregate: WorkAggregate,
  task: TaskRecord,
): Result<readonly BoundInput[], BindingResolutionFailure> {
  const fields = Object.keys(task.inputBindings).sort();
  if (fields.length === 0) return ok([]);
  const consumer = registries.taskTypes.get(task.type.id, task.type.version);
  if (consumer === undefined) {
    throw new DomainInvariantError(
      `결합 해석: 소비자 TaskType 이 등록부에 없다 ${task.type.id}@${task.type.version}`,
    );
  }
  const consumerShape = consumer.schema.shape as Readonly<Record<string, z.ZodType>>;
  const bound: BoundInput[] = [];
  for (const field of fields) {
    // 커밋 뒤 descriptor 선언이 바뀌어도 안전 관련 필드는 결합 값으로 채우지 않는다.
    if (isSafetyRelevantField(consumer, field)) return err({ kind: "safety_field_bound", field });
    const binding = task.inputBindings[field] as InputBinding;
    if (binding.from === "occurrence") return err({ kind: "occurrence_unsupported", field });
    if (!("taskId" in binding.task)) {
      throw new DomainInvariantError(
        `결합 해석: 커밋된 결합이 TaskId 로 해석돼 있지 않다 ${field}`,
      );
    }
    const producerTaskId = binding.task.taskId;
    const result = aggregate.tasks[producerTaskId]?.result;
    if (result === undefined || !Object.hasOwn(result.outputs, binding.output)) {
      return err({ kind: "producer_result_missing", field, producerTaskId });
    }
    const value = result.outputs[binding.output];
    const digest = canonicalJsonDigest(value);
    if (!digest.ok) {
      throw new DomainInvariantError(`결합 해석: 기록된 출력이 정규 JSON 이 아니다 ${field}`);
    }
    const fieldSchema = consumerShape[field];
    if (fieldSchema === undefined || !fieldSchema.safeParse(value).success) {
      throw new DomainInvariantError(
        `결합 해석: 해석 값이 소비자 필드 스키마를 어긴다(호환성 증명 결함) ${field}`,
      );
    }
    bound.push({ field, binding, resultId: result.id, digest: digest.value });
  }
  return ok(bound);
}

/** 결합한 생산자 중 SKIPPED 이거나 만족 종결인데 결과에 결합 출력이 없는 것(dependsOn 순). */
export function bindingUnsatisfiedProducerIds(
  aggregate: WorkAggregate,
  task: TaskRecord,
): readonly TaskId[] {
  const outputsByProducer = new Map<string, string[]>();
  for (const binding of Object.values(task.inputBindings)) {
    if (binding.from !== "task" || !("taskId" in binding.task)) continue;
    const list = outputsByProducer.get(binding.task.taskId) ?? [];
    list.push(binding.output);
    outputsByProducer.set(binding.task.taskId, list);
  }
  if (outputsByProducer.size === 0) return [];
  const out: TaskId[] = [];
  for (const dependencyId of task.dependsOn) {
    if (out.includes(dependencyId)) continue;
    const outputs = outputsByProducer.get(dependencyId);
    if (outputs === undefined) continue;
    const producer = aggregate.tasks[dependencyId];
    if (producer === undefined) continue;
    if (producer.state === "SKIPPED") {
      out.push(dependencyId);
      continue;
    }
    if (!isSatisfyingTerminal(producer.state)) continue;
    const recorded = producer.result?.outputs;
    if (recorded === undefined || outputs.some((name) => !Object.hasOwn(recorded, name))) {
      out.push(dependencyId);
    }
  }
  return out;
}
