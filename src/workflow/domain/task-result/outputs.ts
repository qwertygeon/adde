/**
 * 보고 출력 검사와 결과 준비. 순서는 마스킹 → 진입 사본 → 선언 검사 → 기록 사본 → 크기 → digest 다.
 * 보고 출력은 진입 사본으로 한 번만 읽고, 기록되는 값(파싱 결과의 정규 JSON 사본)·크기·digest 는 같은
 * 정규 JSON 문자열 하나에서 나온다 — 기록 값이 곧 결합 소비자에게 넘어가는 값이다. 위반 이슈에는 출력
 * 값·스키마 메시지를 싣지 않는다(코드·경로만).
 */
import { DomainInvariantError } from "../result.js";
import type { ResultId, AttemptId, TaskId, EventId } from "../ids.js";
import type { UtcInstant } from "../values.js";
import type { ContentHash } from "../derivation/dedup-key.js";
import { contentHashOf } from "../derivation/dedup-key.js";
import type { CanonicalJsonErrorReason } from "../derivation/canonical-json.js";
import {
  canonicalJsonFrozenCopy,
  canonicalJsonSnapshot,
  utf8ByteLength,
} from "../derivation/canonical-json.js";
import type { DomainRegistries } from "../registry/registries.js";
import type { AcceptanceOutputSource } from "../registry/descriptors.js";
import { resolveTaskOutputs } from "../registry/outputs.js";
import type { TaskRecord } from "../aggregate.js";
import type { DomainDeps } from "../engine.js";
import type { DataSchemaIssue } from "./data-schema.js";
import { parseDataSchema } from "./data-schema.js";

export const OUTPUT_SCHEMA_VIOLATION = "output_schema_violation";

export interface ResultLimits {
  readonly resultInlineMaxBytes: number;
}

export type OutputIssue =
  | { readonly code: "outputs_not_object" }
  | { readonly code: "task_type_unknown" }
  | { readonly code: "output_undeclared"; readonly output: string }
  | {
      readonly code: "output_schema_unsupported";
      readonly output: string;
      readonly schemaIssues: readonly DataSchemaIssue[];
    }
  | { readonly code: "output_missing"; readonly output: string }
  | {
      readonly code: "output_invalid";
      readonly output: string;
      readonly path: readonly (string | number)[];
      readonly schemaIssue: string;
    }
  | {
      readonly code: "outputs_not_json";
      readonly reason: CanonicalJsonErrorReason;
      readonly path: readonly (string | number)[];
    }
  | { readonly code: "outputs_too_large"; readonly bytes: number; readonly limit: number }
  /** path 는 출력 값 안 위치(마지막 원소 "__proto__"), 출력당 첫 위치 하나 */
  | {
      readonly code: "output_forbidden_key";
      readonly output: string;
      readonly path: readonly (string | number)[];
    };

export type OutputCheck =
  | {
      readonly ok: true;
      readonly outputs: Readonly<Record<string, unknown>>;
      readonly digest: ContentHash;
      readonly bytes: number;
    }
  | { readonly ok: false; readonly issues: readonly OutputIssue[] };

export interface RecordedTaskResult {
  readonly id: ResultId;
  readonly attemptId?: AttemptId;
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly digest: ContentHash;
}

export interface TaskResult extends RecordedTaskResult {
  readonly taskId: TaskId;
  readonly eventId: EventId;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isPresent(record: Record<string, unknown>, name: string): boolean {
  return Object.hasOwn(record, name) && record[name] !== undefined;
}

const FORBIDDEN_KEY = "__proto__";

/**
 * 값 안 own "__proto__" 키의 첫 위치(객체 키 정렬·배열 순서의 깊이 우선). zod 객체 파싱은 그 키를 알 수
 * 없는 키로 보고하지 않고 출력에서 버리므로, 스키마가 막는 키를 실은 보고가 위반 없이 통과하지 않게 한다.
 */
function forbiddenKeyPath(
  value: unknown,
  path: (string | number)[],
): readonly (string | number)[] | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      path.push(index);
      const found = forbiddenKeyPath(value[index], path);
      if (found !== undefined) return found;
      path.pop();
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    path.push(key);
    if (key === FORBIDDEN_KEY) return [...path];
    const found = forbiddenKeyPath(record[key], path);
    if (found !== undefined) return found;
    path.pop();
  }
  return undefined;
}

function pathSegment(segment: PropertyKey): string | number {
  return typeof segment === "number" ? segment : String(segment);
}

interface SafeParser {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: unknown }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly {
            readonly code: string;
            readonly path: readonly PropertyKey[];
          }[];
        };
      };
}

/**
 * 결정적·순수. 마스킹은 하지 않는다(호출자가 이미 마스킹한 값을 넘긴다). reported 는 진입 사본으로만 읽고,
 * ok 의 outputs 는 정규 JSON 사본(깊은 동결)이며 bytes·digest 는 같은 정규 JSON 문자열에서 계산한다.
 */
export function checkReportedOutputs(
  registries: DomainRegistries,
  task: {
    readonly type: { readonly id: string; readonly version: number };
    readonly input: unknown;
  },
  reported: unknown,
  limits: ResultLimits,
): OutputCheck {
  if (!isPlainObject(reported)) return { ok: false, issues: [{ code: "outputs_not_object" }] };
  const descriptor = registries.taskTypes.get(task.type.id, task.type.version);
  if (descriptor === undefined) return { ok: false, issues: [{ code: "task_type_unknown" }] };
  const captured = canonicalJsonFrozenCopy(reported);
  if (!captured.ok) {
    return {
      ok: false,
      issues: [
        { code: "outputs_not_json", reason: captured.error.reason, path: captured.error.path },
      ],
    };
  }
  const copy = captured.value as Record<string, unknown>;

  const resolved = resolveTaskOutputs(descriptor, task.input);
  const declaredNames = new Set(resolved.map((output) => output.name));
  const issues: OutputIssue[] = [];
  for (const name of Object.keys(copy).sort()) {
    if (isPresent(copy, name) && !declaredNames.has(name)) {
      issues.push({ code: "output_undeclared", output: name });
    }
  }

  const recorded: [string, unknown][] = [];
  for (const output of resolved) {
    let schema: SafeParser;
    if (output.source === "declared") {
      schema = output.schema as unknown as SafeParser;
    } else {
      const parsed = parseDataSchema(output.schema);
      if (!parsed.ok) {
        issues.push({
          code: "output_schema_unsupported",
          output: output.name,
          schemaIssues: parsed.error,
        });
        continue;
      }
      schema = parsed.value as unknown as SafeParser;
    }
    if (!isPresent(copy, output.name)) {
      if (!output.optional) issues.push({ code: "output_missing", output: output.name });
      continue;
    }
    const value = copy[output.name];
    const forbidden = forbiddenKeyPath(value, []);
    if (forbidden !== undefined) {
      issues.push({ code: "output_forbidden_key", output: output.name, path: forbidden });
      continue;
    }
    const result = schema.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          code: "output_invalid",
          output: output.name,
          path: issue.path.map(pathSegment),
          schemaIssue: issue.code,
        });
      }
      continue;
    }
    recorded.push([output.name, result.data]);
  }
  if (issues.length > 0) return { ok: false, issues };

  // 파싱 결과에는 값 undefined 키(선택 속성)·변환 값이 남을 수 있어 기록 값·크기·digest 를 정규 JSON
  // 문자열 하나에서 다시 만든다 — 재생(JSON 왕복)과 라이브 레코드가 같다.
  const snapshot = canonicalJsonSnapshot(Object.fromEntries(recorded));
  if (!snapshot.ok) {
    return {
      ok: false,
      issues: [
        { code: "outputs_not_json", reason: snapshot.error.reason, path: snapshot.error.path },
      ],
    };
  }
  const { json, value: outputs } = snapshot.value;
  const bytes = utf8ByteLength(json);
  if (bytes > limits.resultInlineMaxBytes) {
    return {
      ok: false,
      issues: [{ code: "outputs_too_large", bytes, limit: limits.resultInlineMaxBytes }],
    };
  }
  return {
    ok: true,
    outputs: outputs as Readonly<Record<string, unknown>>,
    digest: contentHashOf(json),
    bytes,
  };
}

/**
 * 보고 출력 → 비객체 위반 → deps.redactOutputs → checkReportedOutputs(deps 상한).
 * redactOutputs 부재·반환 비객체, resultInlineMaxBytes 무효는 DomainInvariantError.
 */
export function prepareReportedOutputs(
  deps: DomainDeps,
  task: Pick<TaskRecord, "type" | "input">,
  reported: unknown,
): OutputCheck {
  if (!isPlainObject(reported)) return { ok: false, issues: [{ code: "outputs_not_object" }] };
  const redact = deps.redactOutputs;
  if (redact === undefined) {
    throw new DomainInvariantError("결과 기록에는 출력 마스킹(redactOutputs) 주입이 필요하다");
  }
  const redacted: unknown = redact(reported);
  if (!isPlainObject(redacted)) {
    throw new DomainInvariantError("redactOutputs 가 일반 객체가 아닌 값을 반환했다");
  }
  const limit = deps.operationalDefaults.resultInlineMaxBytes;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new DomainInvariantError(
      "operationalDefaults.resultInlineMaxBytes 는 양의 안전 정수여야 한다",
    );
  }
  return checkReportedOutputs(deps.registries, task, redacted, { resultInlineMaxBytes: limit });
}

const ACCEPTANCE_VALUE: Readonly<
  Record<AcceptanceOutputSource, (decidedAt: UtcInstant) => unknown>
> = {
  decision: () => "accept",
  decidedAt: (decidedAt) => decidedAt,
};

/** acceptanceOutputs 선언으로 확인 수락 출력을 만든 뒤 prepareReportedOutputs 와 같은 경로. */
export function prepareAcceptanceOutputs(
  deps: DomainDeps,
  task: Pick<TaskRecord, "type" | "input">,
  decidedAt: UtcInstant,
): OutputCheck {
  const descriptor = deps.registries.taskTypes.get(task.type.id, task.type.version);
  if (descriptor === undefined) return { ok: false, issues: [{ code: "task_type_unknown" }] };
  const declared = descriptor.acceptanceOutputs ?? {};
  const outputs = Object.fromEntries(
    Object.keys(declared).map((name) => {
      const source = declared[name] as AcceptanceOutputSource;
      return [name, ACCEPTANCE_VALUE[source](decidedAt)];
    }),
  );
  return prepareReportedOutputs(deps, task, outputs);
}
