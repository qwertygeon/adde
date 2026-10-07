/**
 * zod 스키마 정의 → SchemaShape 판독과 보수적 부분집합 증명(건전·불완전). 판독 화이트리스트 밖의
 * 정의·검사는 불투명이고, 불투명은 증명할 수 없다. 판독은 분류 공개 표면(`schema.def`)과 검사
 * 인스턴스의 정의(`check._zod.def`)를 쓰며 zod 정확 판 고정에 묶인다 — 형태가 바뀌어 읽지 못하면
 * 불투명으로 떨어져 증명 불가(거절 방향)가 된다.
 */
import * as z from "zod";

export interface Bound {
  readonly value: number;
  readonly inclusive: boolean;
}

export type SchemaShape =
  | { readonly k: "unknown" }
  | { readonly k: "opaque" }
  | { readonly k: "string"; readonly min: number; readonly max?: number }
  | { readonly k: "number"; readonly int: boolean; readonly lower?: Bound; readonly upper?: Bound }
  | { readonly k: "boolean" }
  | { readonly k: "null" }
  | { readonly k: "literal"; readonly values: readonly (string | number | boolean | null)[] }
  | { readonly k: "array"; readonly item: SchemaShape; readonly min: number; readonly max?: number }
  | {
      readonly k: "object";
      readonly props: Readonly<
        Record<string, { readonly shape: SchemaShape; readonly optional: boolean }>
      >;
      /** "none" = 추가 키가 나타나지 않음(strict·생산자 strip), 그 밖 = 추가 키 값의 형태(loose → unknown) */
      readonly extra: SchemaShape | "none";
    }
  | { readonly k: "union"; readonly options: readonly SchemaShape[] }
  | { readonly k: "intersection"; readonly parts: readonly SchemaShape[] }
  | { readonly k: "optional"; readonly inner: SchemaShape };

export type ShapeSide = "producer" | "consumer";

const OPAQUE: SchemaShape = { k: "opaque" };
const UNKNOWN: SchemaShape = { k: "unknown" };

type Def = Readonly<Record<string, unknown>>;

function isRecord(raw: unknown): raw is Readonly<Record<string, unknown>> {
  return typeof raw === "object" && raw !== null;
}

function defOf(schema: unknown): Def | undefined {
  if (!isRecord(schema)) return undefined;
  const def = schema["def"];
  return isRecord(def) && typeof def["type"] === "string" ? def : undefined;
}

/** 검사 정의 목록. 검사 표면을 읽지 못하면 undefined(불투명). */
function checkDefs(def: Def): readonly Def[] | undefined {
  const checks = def["checks"];
  if (checks === undefined) return [];
  if (!Array.isArray(checks)) return undefined;
  const out: Def[] = [];
  for (const check of checks) {
    if (!isRecord(check)) return undefined;
    const inner = check["_zod"];
    if (!isRecord(inner) || !isRecord(inner["def"])) return undefined;
    out.push(inner["def"]);
  }
  return out;
}

/**
 * zod 가 길이 검사에 넣는 기본 실행 조건(값이 nullish 가 아니고 길이가 있을 때)의 소스 텍스트. 같은 설치본
 * zod 로 계산하므로 판이 바뀌면 기준도 같이 바뀐다. 함수 객체는 검사마다 달라 텍스트로 대조한다.
 */
const DEFAULT_LENGTH_GUARD_TEXTS: ReadonlySet<string> = (() => {
  const texts = new Set<string>();
  for (const schema of [z.string().min(0), z.string().max(0), z.string().length(0)]) {
    for (const check of schema.def.checks ?? []) {
      const when: unknown = check._zod.def.when;
      if (typeof when === "function") texts.add(Function.prototype.toString.call(when));
    }
  }
  return texts;
})();

/**
 * 검사의 실행 조건(when)·중단 표시(abort)를 판독할 수 있는가. when 이 있으면 그 결과가 참일 때만 검사가
 * 돌아 수용 집합이 넓어지므로, 길이 검사의 zod 기본 조건 밖의 when 은 불투명이다. 수 검사에는 zod 가 기본
 * 조건을 넣지 않아 when 이 있으면 사용자 조건이다. abort 참 값은 판 올림 의미 drift 에 대비해 불투명이다.
 */
function controlReadable(check: Def, defaultLengthGuardAllowed: boolean): boolean {
  if (check["abort"]) return false;
  const when = check["when"];
  if (when === undefined) return true;
  if (!defaultLengthGuardAllowed || typeof when !== "function") return false;
  try {
    return DEFAULT_LENGTH_GUARD_TEXTS.has(Function.prototype.toString.call(when));
  } catch {
    return false;
  }
}

function isNonNegativeInteger(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
}

/** 문자열·배열 길이 검사 → [min, max]. 화이트리스트 밖 검사면 undefined. */
function lengthBounds(checks: readonly Def[]): { min: number; max?: number } | undefined {
  let min = 0;
  let max: number | undefined;
  for (const check of checks) {
    if (!controlReadable(check, true)) return undefined;
    const kind = check["check"];
    if (kind === "min_length" && isNonNegativeInteger(check["minimum"])) {
      min = Math.max(min, check["minimum"]);
    } else if (kind === "max_length" && isNonNegativeInteger(check["maximum"])) {
      max = max === undefined ? check["maximum"] : Math.min(max, check["maximum"]);
    } else if (kind === "length_equals" && isNonNegativeInteger(check["length"])) {
      min = Math.max(min, check["length"]);
      max = max === undefined ? check["length"] : Math.min(max, check["length"]);
    } else {
      return undefined;
    }
  }
  return max === undefined ? { min } : { min, max };
}

function tighterLower(a: Bound | undefined, b: Bound): Bound {
  if (a === undefined || b.value > a.value) return b;
  if (b.value === a.value && !b.inclusive) return b;
  return a;
}

function tighterUpper(a: Bound | undefined, b: Bound): Bound {
  if (a === undefined || b.value < a.value) return b;
  if (b.value === a.value && !b.inclusive) return b;
  return a;
}

function boundOf(check: Def): Bound | undefined {
  const value = check["value"];
  const inclusive = check["inclusive"];
  if (typeof value !== "number" || Number.isNaN(value) || typeof inclusive !== "boolean") {
    return undefined;
  }
  return { value, inclusive };
}

function numberShape(def: Def, checks: readonly Def[]): SchemaShape {
  // 검사이기도 한 수 정의(z.int() 류)는 자기 자신을 첫 검사로 돌린다.
  if (def["check"] !== undefined && !controlReadable(def, false)) return OPAQUE;
  let int = false;
  if (def["format"] !== undefined) {
    if (def["format"] !== "safeint") return OPAQUE;
    int = true;
  }
  let lower: Bound | undefined;
  let upper: Bound | undefined;
  for (const check of checks) {
    if (!controlReadable(check, false)) return OPAQUE;
    const kind = check["check"];
    if (kind === "number_format") {
      if (check["format"] !== "safeint") return OPAQUE;
      int = true;
    } else if (kind === "greater_than") {
      const bound = boundOf(check);
      if (bound === undefined) return OPAQUE;
      lower = tighterLower(lower, bound);
    } else if (kind === "less_than") {
      const bound = boundOf(check);
      if (bound === undefined) return OPAQUE;
      upper = tighterUpper(upper, bound);
    } else {
      return OPAQUE;
    }
  }
  return {
    k: "number",
    int,
    ...(lower !== undefined ? { lower } : {}),
    ...(upper !== undefined ? { upper } : {}),
  };
}

function isLiteralValue(raw: unknown): raw is string | number | boolean | null {
  return (
    raw === null ||
    typeof raw === "string" ||
    typeof raw === "boolean" ||
    (typeof raw === "number" && Number.isFinite(raw))
  );
}

function read(schema: unknown, side: ShapeSide, visiting: Set<object>): SchemaShape {
  const def = defOf(schema);
  if (def === undefined) return OPAQUE;
  const node = schema as object;
  if (visiting.has(node)) return OPAQUE;
  visiting.add(node);
  try {
    return readDef(schema, def, side, visiting);
  } finally {
    visiting.delete(node);
  }
}

/**
 * 소비자 측 optional 은 값 undefined 도 받는 일반 optional 일 때만 판독한다. exactOptional 은 정의 형이 같은
 * optional 이지만 그 값을 거절해 더 좁고, 인스턴스 traits 를 읽지 못하면 구분할 수 없다.
 */
function isPlainOptional(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  const inner = schema["_zod"];
  if (!isRecord(inner)) return false;
  const traits = inner["traits"];
  return traits instanceof Set && !traits.has("$ZodExactOptional");
}

function readDef(schema: unknown, def: Def, side: ShapeSide, visiting: Set<object>): SchemaShape {
  if (def["coerce"] === true) return OPAQUE;
  const checks = checkDefs(def);
  if (checks === undefined) return OPAQUE;
  switch (def["type"]) {
    case "unknown":
    case "any":
      return checks.length === 0 ? UNKNOWN : OPAQUE;
    case "string": {
      if (def["format"] !== undefined) return OPAQUE;
      const bounds = lengthBounds(checks);
      if (bounds === undefined) return OPAQUE;
      return { k: "string", ...bounds };
    }
    case "number":
      return numberShape(def, checks);
    case "boolean":
      return checks.length === 0 ? { k: "boolean" } : OPAQUE;
    case "null":
      return checks.length === 0 ? { k: "null" } : OPAQUE;
    case "literal": {
      const values = def["values"];
      if (checks.length > 0 || !Array.isArray(values) || !values.every(isLiteralValue)) {
        return OPAQUE;
      }
      return { k: "literal", values: [...values] };
    }
    case "enum": {
      const entries = def["entries"];
      if (checks.length > 0 || !isRecord(entries)) return OPAQUE;
      const values = [...new Set(enumValues(entries))];
      if (!values.every((v) => typeof v === "string" || typeof v === "number")) return OPAQUE;
      if (!values.every(isLiteralValue)) return OPAQUE;
      return { k: "literal", values };
    }
    case "array": {
      const bounds = lengthBounds(checks);
      if (bounds === undefined) return OPAQUE;
      return { k: "array", item: read(def["element"], side, visiting), ...bounds };
    }
    case "object":
      return checks.length === 0 ? objectShape(def, side, visiting) : OPAQUE;
    case "union": {
      if (checks.length > 0) return OPAQUE;
      if (side === "consumer" && def["inclusive"] === false) return OPAQUE;
      const options = def["options"];
      if (!Array.isArray(options) || options.length === 0) return OPAQUE;
      return { k: "union", options: options.map((option) => read(option, side, visiting)) };
    }
    case "intersection":
      // 생산자 intersection 의 파싱 출력은 두 part 의 출력을 합치고 양쪽 모두가 모르는 키만
      // 거절한다 — strict part 가 무력화되고 strip part 가 버린 키가 되살아나 part 별 판독이
      // 건전하지 않다. 소비자 intersection 의 수용 집합은 part 별 수용 집합의 교집합보다 넓다.
      if (side === "producer" || checks.length > 0) return OPAQUE;
      return {
        k: "intersection",
        parts: [read(def["left"], side, visiting), read(def["right"], side, visiting)],
      };
    case "optional":
      if (checks.length > 0) return OPAQUE;
      if (side === "consumer" && !isPlainOptional(schema)) return OPAQUE;
      return { k: "optional", inner: read(def["innerType"], side, visiting) };
    case "nullable":
      if (checks.length > 0) return OPAQUE;
      return { k: "union", options: [read(def["innerType"], side, visiting), { k: "null" }] };
    default:
      return OPAQUE;
  }
}

/** zod 의 enum 값 계산과 같다 — 숫자 값이 있으면 그 숫자와 같은 수치 키의 항목(역매핑)을 뺀다. */
function enumValues(entries: Readonly<Record<string, unknown>>): unknown[] {
  const numericValues = Object.values(entries).filter((v) => typeof v === "number");
  // indexOf(엄격 비교) 그대로 — includes 는 NaN 값이 모든 비수치 키를 지우게 만든다.
  return Object.entries(entries)
    .filter(([key]) => numericValues.indexOf(+key) === -1)
    .map(([, value]) => value);
}

function objectShape(def: Def, side: ShapeSide, visiting: Set<object>): SchemaShape {
  const shape = def["shape"];
  if (!isRecord(shape)) return OPAQUE;
  const keys = Object.keys(shape);
  // zod 객체 파싱은 속성 존재를 `key in input` 으로 판정해 상속 멤버를 값으로 검사한다. 기록 값에 그 키가
  // 없어도 소비자 검사가 실패할 수 있으므로 상속 멤버 이름 키를 가진 소비자는 증명하지 않는다.
  if (side === "consumer" && keys.some((key) => key in Object.prototype)) return OPAQUE;
  const props: Record<string, { readonly shape: SchemaShape; readonly optional: boolean }> = {};
  for (const key of keys) {
    const fieldShape = read(shape[key], side, visiting);
    const optional = fieldShape.k === "optional";
    Object.defineProperty(props, key, {
      value: { shape: optional ? fieldShape.inner : fieldShape, optional },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const catchall = def["catchall"];
  let extra: SchemaShape | "none";
  if (catchall === undefined) {
    // strip: 파싱 출력은 추가 키를 버리고(생산자), 입력의 추가 키는 받아들인다(소비자).
    extra = side === "producer" ? "none" : UNKNOWN;
  } else {
    const catchallDef = defOf(catchall);
    if (catchallDef === undefined) return OPAQUE;
    extra = catchallDef["type"] === "never" ? "none" : read(catchall, side, visiting);
  }
  return { k: "object", props, extra };
}

/** 화이트리스트 판독. 소비자 측 배타 union·생산자 측 intersection·화이트리스트 밖 정의·검사는 opaque.
 *  enum 값은 zod 와 같은 식(숫자 값과 같은 수치 키 항목 제외). 검사 통제 필드 — 길이 검사는 when 부재 또는
 *  zod 기본 길이 조건만, 수 검사·검사이기도 한 수 정의는 when 부재만, abort 참 값은 opaque. 소비자 측
 *  exactOptional·traits 판독 불가 optional 은 opaque. 소비자 측 객체 모양에 상속 멤버 이름(`Object.prototype`
 *  사슬에 있는 이름) 키가 있으면 모든 깊이에서 opaque. */
export function shapeOf(schema: z.ZodType, side: ShapeSide): SchemaShape {
  return read(schema, side, new Set());
}

function withinLength(
  producer: { readonly min: number; readonly max?: number },
  consumer: { readonly min: number; readonly max?: number },
): boolean {
  if (producer.min < consumer.min) return false;
  if (consumer.max === undefined) return true;
  return producer.max !== undefined && producer.max <= consumer.max;
}

function lowerWithin(producer: Bound | undefined, consumer: Bound | undefined): boolean {
  if (consumer === undefined) return true;
  if (producer === undefined) return false;
  if (producer.value > consumer.value) return true;
  if (producer.value < consumer.value) return false;
  return consumer.inclusive || !producer.inclusive;
}

function upperWithin(producer: Bound | undefined, consumer: Bound | undefined): boolean {
  if (consumer === undefined) return true;
  if (producer === undefined) return false;
  if (producer.value < consumer.value) return true;
  if (producer.value > consumer.value) return false;
  return consumer.inclusive || !producer.inclusive;
}

function inBound(value: number, lower: Bound | undefined, upper: Bound | undefined): boolean {
  if (lower !== undefined && (lower.inclusive ? value < lower.value : value <= lower.value)) {
    return false;
  }
  if (upper !== undefined && (upper.inclusive ? value > upper.value : value >= upper.value)) {
    return false;
  }
  return true;
}

/** 원시값 v 를 consumer 가 받아들이는지 직접 판정한다. */
function accepts(consumer: SchemaShape, value: string | number | boolean | null): boolean {
  switch (consumer.k) {
    case "unknown":
      return true;
    case "opaque":
      return false;
    case "optional":
      return accepts(consumer.inner, value);
    case "union":
      return consumer.options.some((option) => accepts(option, value));
    case "intersection":
      return consumer.parts.every((part) => accepts(part, value));
    case "string":
      return (
        typeof value === "string" &&
        value.length >= consumer.min &&
        (consumer.max === undefined || value.length <= consumer.max)
      );
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (!consumer.int || Number.isSafeInteger(value)) &&
        inBound(value, consumer.lower, consumer.upper)
      );
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "literal":
      return consumer.values.includes(value);
    case "array":
    case "object":
      return false;
    default: {
      const exhaustive: never = consumer;
      throw new Error(`accepts: 알 수 없는 형태 ${String(exhaustive)}`);
    }
  }
}

function proveObject(
  producer: Extract<SchemaShape, { k: "object" }>,
  consumer: Extract<SchemaShape, { k: "object" }>,
): boolean {
  for (const key of Object.keys(consumer.props)) {
    const c = consumer.props[key] as { readonly shape: SchemaShape; readonly optional: boolean };
    if (Object.hasOwn(producer.props, key)) {
      const p = producer.props[key] as { readonly shape: SchemaShape; readonly optional: boolean };
      if (p.optional && !c.optional) return false;
      if (!proveSchemaSubset(p.shape, c.shape)) return false;
    } else {
      if (!c.optional) return false;
      if (producer.extra !== "none" && !proveSchemaSubset(producer.extra, c.shape)) return false;
    }
  }
  for (const key of Object.keys(producer.props)) {
    if (Object.hasOwn(consumer.props, key)) continue;
    const p = producer.props[key] as { readonly shape: SchemaShape; readonly optional: boolean };
    if (consumer.extra === "none" || !proveSchemaSubset(p.shape, consumer.extra)) return false;
  }
  if (producer.extra !== "none") {
    if (consumer.extra === "none" || !proveSchemaSubset(producer.extra, consumer.extra)) {
      return false;
    }
  }
  return true;
}

/** 건전: true 면 producer 가 받아들이는(파싱 출력) 모든 값을 consumer 가 받아들인다. 불완전 허용. */
export function proveSchemaSubset(producer: SchemaShape, consumer: SchemaShape): boolean {
  // 1
  if (consumer.k === "unknown") return true;
  if (producer.k === "opaque" || consumer.k === "opaque") return false;
  // 2
  if (producer.k === "optional") {
    return consumer.k === "optional" && proveSchemaSubset(producer.inner, consumer.inner);
  }
  if (consumer.k === "optional") return proveSchemaSubset(producer, consumer.inner);
  // 3
  if (producer.k === "union") {
    return producer.options.every((option) => proveSchemaSubset(option, consumer));
  }
  // 판독은 생산자 intersection 을 opaque 로 만든다. 직접 구성된 형태도 같은 이유로 증명하지 않는다.
  if (producer.k === "intersection") return false;
  // 4
  if (consumer.k === "intersection") {
    return consumer.parts.every((part) => proveSchemaSubset(producer, part));
  }
  if (consumer.k === "union") {
    return consumer.options.some((option) => proveSchemaSubset(producer, option));
  }
  // 5
  if (producer.k === "literal") return producer.values.every((value) => accepts(consumer, value));
  // 6
  switch (producer.k) {
    case "string":
      return consumer.k === "string" && withinLength(producer, consumer);
    case "number":
      return (
        consumer.k === "number" &&
        (!consumer.int || producer.int) &&
        lowerWithin(producer.lower, consumer.lower) &&
        upperWithin(producer.upper, consumer.upper)
      );
    case "boolean":
      return (
        consumer.k === "boolean" ||
        (consumer.k === "literal" && accepts(consumer, true) && accepts(consumer, false))
      );
    case "null":
      return consumer.k === "null";
    case "array":
      return (
        consumer.k === "array" &&
        proveSchemaSubset(producer.item, consumer.item) &&
        withinLength(producer, consumer)
      );
    case "object":
      return consumer.k === "object" && proveObject(producer, consumer);
    case "unknown":
      return false;
    default: {
      const exhaustive: never = producer;
      throw new Error(`proveSchemaSubset: 알 수 없는 형태 ${String(exhaustive)}`);
    }
  }
}
