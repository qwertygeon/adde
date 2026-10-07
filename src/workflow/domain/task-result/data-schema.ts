/**
 * 입력 필드가 정하는 출력 스키마(JSON Schema)의 허용 목록·구조 규칙·zod 변환. 변환은 일부 키워드를
 * 예외 없이 무시하므로(배열 원소 유일성·포함 조건·속성 수·형식 등), 허용 목록 밖 키워드가 하나라도
 * 있으면 변환 전에 거절한다. 주석 키워드는 검사를 통과하되 변환 전에 걷어낸다 — 변환이 설명을 전역
 * 등록부에 쓰고 기본값으로 파싱 결과를 바꾸기 때문이다. 변환은 호출마다 새 사설 등록부를 쓴다.
 */
import * as z from "zod";
import { type Result, ok, err } from "../result.js";
import { canonicalJson } from "../derivation/canonical-json.js";

export const DATA_SCHEMA_VALIDATION_KEYWORDS: readonly string[] = Object.freeze([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "anyOf",
]);

export const DATA_SCHEMA_ANNOTATION_KEYWORDS: readonly string[] = Object.freeze([
  "title",
  "description",
  "$comment",
  "examples",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

export const DATA_SCHEMA_TYPE_NAMES: readonly string[] = Object.freeze([
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "object",
  "array",
]);

export const DATA_SCHEMA_MAX_DEPTH = 32;

export type DataSchemaIssueCode =
  | "schema_not_json"
  | "schema_not_object_or_boolean"
  | "keyword_not_allowed"
  | "keyword_value_invalid"
  | "enum_const_with_siblings"
  | "keyword_without_type"
  | "required_not_in_properties"
  | "forbidden_property_name"
  | "too_deep"
  | "conversion_failed"
  | "combinator_with_siblings"
  | "keyword_without_items";

export interface DataSchemaIssue {
  readonly code: DataSchemaIssueCode;
  readonly path: readonly (string | number)[];
  readonly keyword?: string;
}

const VALIDATION_SET: ReadonlySet<string> = new Set(DATA_SCHEMA_VALIDATION_KEYWORDS);
const ANNOTATION_SET: ReadonlySet<string> = new Set(DATA_SCHEMA_ANNOTATION_KEYWORDS);
const TYPE_NAME_SET: ReadonlySet<string> = new Set(DATA_SCHEMA_TYPE_NAMES);

/** 형별 키워드 → 그 키워드를 쓰려면 `type` 에 있어야 하는 형(하나라도). */
const TYPED_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  minLength: ["string"],
  maxLength: ["string"],
  minimum: ["number", "integer"],
  maximum: ["number", "integer"],
  exclusiveMinimum: ["number", "integer"],
  exclusiveMaximum: ["number", "integer"],
  properties: ["object"],
  required: ["object"],
  additionalProperties: ["object"],
  items: ["array"],
  minItems: ["array"],
  maxItems: ["array"],
};

const COUNT_KEYWORDS: ReadonlySet<string> = new Set([
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
]);
const BOUND_KEYWORDS: ReadonlySet<string> = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
]);
/**
 * 조합 키워드는 `anyOf` 하나다. 변환은 한 노드의 조합들을 차례로 덮어쓰고, 조합이 `type` 등과 함께
 * 있으면 intersection 을 만든다 — intersection 은 양쪽이 모두 모르는 키만 거절하고 출력을 합쳐
 * `additionalProperties:false` 를 무력화한다. 배타 문맥(`oneOf`)은 하위의 좁힘(안전 정수·코드 단위
 * 길이)이 전체 판정을 약하게 만든다.
 */
const COMBINATOR_KEYWORDS: ReadonlySet<string> = new Set(["anyOf"]);

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isPrimitive(raw: unknown): boolean {
  return (
    raw === null || typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
  );
}

function declaredTypes(node: Record<string, unknown>): readonly string[] {
  const type = node["type"];
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}

function isValidTypeValue(raw: unknown): boolean {
  if (typeof raw === "string") return TYPE_NAME_SET.has(raw);
  if (!Array.isArray(raw) || raw.length === 0) return false;
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !TYPE_NAME_SET.has(entry) || seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}

function isValidKeywordValue(keyword: string, value: unknown): boolean {
  if (keyword === "type") return isValidTypeValue(value);
  if (keyword === "enum")
    return Array.isArray(value) && value.length > 0 && value.every(isPrimitive);
  if (keyword === "const") return isPrimitive(value);
  if (keyword === "properties") return isPlainObject(value);
  if (keyword === "required") {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
  }
  if (keyword === "additionalProperties" || keyword === "items") {
    return typeof value === "boolean" || isPlainObject(value);
  }
  // 변환은 문자열 길이를 UTF-16 코드 단위로 센다. 고립 서러게이트 없는 문자열에서 "1 이상" 만
  // 코드 포인트 기준과 일치하고 2 이상은 JSON Schema 보다 약해진다.
  if (keyword === "minLength") return value === 0 || value === 1;
  if (COUNT_KEYWORDS.has(keyword)) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }
  if (BOUND_KEYWORDS.has(keyword)) return typeof value === "number" && Number.isFinite(value);
  if (COMBINATOR_KEYWORDS.has(keyword)) return Array.isArray(value) && value.length > 0;
  return false;
}

function checkNode(
  node: unknown,
  path: readonly (string | number)[],
  depth: number,
  issues: DataSchemaIssue[],
): void {
  if (typeof node === "boolean") return;
  if (!isPlainObject(node)) {
    issues.push({ code: "schema_not_object_or_boolean", path });
    return;
  }
  if (depth > DATA_SCHEMA_MAX_DEPTH) {
    issues.push({ code: "too_deep", path });
    return;
  }
  const keys = Object.keys(node).sort();
  const validationKeys = keys.filter((key) => VALIDATION_SET.has(key));
  const types = declaredTypes(node);
  for (const keyword of keys) {
    if (ANNOTATION_SET.has(keyword)) continue;
    if (!VALIDATION_SET.has(keyword)) {
      issues.push({ code: "keyword_not_allowed", path, keyword });
      continue;
    }
    const value = node[keyword];
    if (!isValidKeywordValue(keyword, value)) {
      issues.push({ code: "keyword_value_invalid", path, keyword });
      continue;
    }
    if ((keyword === "enum" || keyword === "const") && validationKeys.length > 1) {
      issues.push({ code: "enum_const_with_siblings", path, keyword });
    }
    if (COMBINATOR_KEYWORDS.has(keyword) && validationKeys.length > 1) {
      issues.push({ code: "combinator_with_siblings", path, keyword });
    }
    const requiredTypes = TYPED_KEYWORDS[keyword];
    if (requiredTypes !== undefined && !requiredTypes.some((t) => types.includes(t))) {
      issues.push({ code: "keyword_without_type", path, keyword });
    }
    // 변환은 `items` 가 없는 배열에 개수 경계를 적용하지 않는다.
    if ((keyword === "minItems" || keyword === "maxItems") && !Object.hasOwn(node, "items")) {
      issues.push({ code: "keyword_without_items", path, keyword });
    }
    if (keyword === "required") {
      const properties = node["properties"];
      for (const [index, name] of (value as readonly string[]).entries()) {
        if (!isPlainObject(properties) || !Object.hasOwn(properties, name)) {
          issues.push({ code: "required_not_in_properties", path: [...path, "required", index] });
        }
      }
    }
    if (keyword === "properties") {
      const properties = value as Record<string, unknown>;
      for (const name of Object.keys(properties).sort()) {
        const childPath = [...path, "properties", name];
        if (name === "__proto__") {
          issues.push({ code: "forbidden_property_name", path: childPath });
          continue;
        }
        checkNode(properties[name], childPath, depth + 1, issues);
      }
    }
    if ((keyword === "additionalProperties" || keyword === "items") && isPlainObject(value)) {
      checkNode(value, [...path, keyword], depth + 1, issues);
    }
    if (COMBINATOR_KEYWORDS.has(keyword)) {
      (value as readonly unknown[]).forEach((child, index) => {
        checkNode(child, [...path, keyword, index], depth + 1, issues);
      });
    }
  }
}

/** 허용 목록·구조 규칙만(변환 없음). 루트는 일반 객체여야 한다. */
export function checkDataSchema(raw: unknown): readonly DataSchemaIssue[] {
  const json = canonicalJson(raw);
  if (!json.ok) return [{ code: "schema_not_json", path: json.error.path }];
  if (!isPlainObject(raw)) return [{ code: "schema_not_object_or_boolean", path: [] }];
  const issues: DataSchemaIssue[] = [];
  checkNode(raw, [], 1, issues);
  return issues;
}

/** 주석 키워드를 스키마 자리에서만 걷어낸 사본(속성 이름은 그대로). */
function stripAnnotations(node: unknown): unknown {
  if (!isPlainObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node)) {
    if (ANNOTATION_SET.has(key)) continue;
    const value = node[key];
    let copied: unknown = value;
    if (key === "properties" && isPlainObject(value)) {
      const properties: Record<string, unknown> = {};
      for (const name of Object.keys(value)) {
        Object.defineProperty(properties, name, {
          value: stripAnnotations(value[name]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      copied = properties;
    } else if (key === "additionalProperties" || key === "items") {
      copied = stripAnnotations(value);
    } else if (COMBINATOR_KEYWORDS.has(key) && Array.isArray(value)) {
      copied = value.map(stripAnnotations);
    }
    out[key] = copied;
  }
  return out;
}

/** check → 주석 제거 사본 → z.fromJSONSchema(사본, { registry: z.registry() }). 변환 예외는 conversion_failed. */
export function parseDataSchema(raw: unknown): Result<z.ZodType, readonly DataSchemaIssue[]> {
  const issues = checkDataSchema(raw);
  if (issues.length > 0) return err(issues);
  const stripped = stripAnnotations(raw) as Parameters<typeof z.fromJSONSchema>[0];
  try {
    return ok(z.fromJSONSchema(stripped, { registry: z.registry() }));
  } catch {
    return err([{ code: "conversion_failed", path: [] }]);
  }
}
