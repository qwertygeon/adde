/**
 * 정규 JSON(RFC 8785) 직렬화·digest·UTF-8 길이. 객체 키는 UTF-16 코드 단위 사전순, 수·문자열은
 * `JSON.stringify` 표기, 값이 `undefined` 인 객체 속성은 생략한다. 같은 값은 키 순서와 무관하게 같은
 * 문자열이 된다 — 제안·결과·결합 digest 가 이 문자열의 sha256 이다.
 */
import { type Result, ok, err } from "../result.js";
import type { ContentHash } from "./dedup-key.js";
import { contentHashOf } from "./dedup-key.js";

export const CANONICAL_JSON_MAX_DEPTH = 64;

export type CanonicalJsonErrorReason =
  | "unsupported_type"
  | "non_finite_number"
  | "non_plain_object"
  | "lone_surrogate"
  | "undefined_in_array"
  | "cycle"
  | "too_deep";

export interface CanonicalJsonError {
  readonly kind: "canonical_json";
  readonly reason: CanonicalJsonErrorReason;
  readonly path: readonly (string | number)[];
}

class CanonicalJsonFailure {
  constructor(
    readonly reason: CanonicalJsonErrorReason,
    readonly path: readonly (string | number)[],
  ) {}
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function serializeString(text: string, path: readonly (string | number)[]): string {
  if (hasLoneSurrogate(text)) throw new CanonicalJsonFailure("lone_surrogate", path);
  return JSON.stringify(text);
}

function isPlainRecord(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialize(
  value: unknown,
  path: (string | number)[],
  ancestors: Set<object>,
  depth: number,
): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonFailure("non_finite_number", [...path]);
      return JSON.stringify(value);
    case "string":
      return serializeString(value, [...path]);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new CanonicalJsonFailure("unsupported_type", [...path]);
    case "object":
      break;
    default:
      throw new CanonicalJsonFailure("unsupported_type", [...path]);
  }
  const container = value as object;
  if (ancestors.has(container)) throw new CanonicalJsonFailure("cycle", [...path]);
  if (depth + 1 > CANONICAL_JSON_MAX_DEPTH) throw new CanonicalJsonFailure("too_deep", [...path]);
  if (Array.isArray(container)) {
    if (Object.getPrototypeOf(container) !== Array.prototype) {
      throw new CanonicalJsonFailure("non_plain_object", [...path]);
    }
    ancestors.add(container);
    const parts: string[] = [];
    for (let index = 0; index < container.length; index += 1) {
      const element: unknown = container[index];
      path.push(index);
      if (element === undefined) throw new CanonicalJsonFailure("undefined_in_array", [...path]);
      parts.push(serialize(element, path, ancestors, depth + 1));
      path.pop();
    }
    ancestors.delete(container);
    return `[${parts.join(",")}]`;
  }
  if (!isPlainRecord(container)) throw new CanonicalJsonFailure("non_plain_object", [...path]);
  ancestors.add(container);
  const record = container as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    path.push(key);
    const member = record[key];
    if (member !== undefined) {
      const serializedKey = serializeString(key, [...path]);
      parts.push(`${serializedKey}:${serialize(member, path, ancestors, depth + 1)}`);
    }
    path.pop();
  }
  ancestors.delete(container);
  return `{${parts.join(",")}}`;
}

/** RFC 8785. 객체 키는 UTF-16 코드 단위 사전순, 값이 undefined 인 속성은 생략, -0 은 "0". */
export function canonicalJson(value: unknown): Result<string, CanonicalJsonError> {
  try {
    return ok(serialize(value, [], new Set(), 0));
  } catch (error) {
    if (error instanceof CanonicalJsonFailure) {
      return err({ kind: "canonical_json", reason: error.reason, path: error.path });
    }
    throw error;
  }
}

/** contentHashOf(canonicalJson(value)). */
export function canonicalJsonDigest(value: unknown): Result<ContentHash, CanonicalJsonError> {
  const json = canonicalJson(value);
  if (!json.ok) return json;
  return ok(contentHashOf(json.value));
}

/** 고립 서러게이트 없는 문자열의 UTF-8 바이트 수(코드 포인트별 1~4). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) as number;
    if (codePoint < 0x80) bytes += 1;
    else if (codePoint < 0x800) bytes += 2;
    else if (codePoint < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function deepFreeze(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

/**
 * 정규 JSON 문자열 json 하나와 json 을 다시 파싱한 깊은 동결 사본 value 를 함께 돌려준다. 기록 값·크기·
 * digest 를 같은 문자열에서 만들기 위해서다. value 는 원본과 참조를 공유하지 않고 값이 undefined 인 키가
 * 없으며, 정규 JSON 왕복이 같은 문자열을 내므로 canonicalJson(value) 는 json 과 같다.
 */
export function canonicalJsonSnapshot(
  value: unknown,
): Result<{ readonly json: string; readonly value: unknown }, CanonicalJsonError> {
  const json = canonicalJson(value);
  if (!json.ok) return json;
  return ok(
    Object.freeze({ json: json.value, value: deepFreeze(JSON.parse(json.value) as unknown) }),
  );
}

/**
 * 정규 JSON 문자열을 다시 파싱한 사본을 깊게 동결해 돌려준다(canonicalJsonSnapshot 의 value). 사본은
 * 원본과 참조를 공유하지 않고, canonicalJson(사본) 은 canonicalJson(value) 와 같다.
 */
export function canonicalJsonFrozenCopy(value: unknown): Result<unknown, CanonicalJsonError> {
  const snapshot = canonicalJsonSnapshot(value);
  if (!snapshot.ok) return snapshot;
  return ok(snapshot.value.value);
}
