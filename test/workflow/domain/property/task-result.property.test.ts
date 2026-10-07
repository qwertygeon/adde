// SC-055 — property: 결과 digest = 기록 출력의 독립 정규 JSON sha256(같은 출력 같은 digest),
// 호환성 증명의 건전성(증명이 참이면 생산자가 받아들인 값을 소비자도 받아들인다 — 검사 통제 필드
// when·abort, 양측 exactOptional, 상속 멤버 이름 객체 키 포함).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as z from "zod";
import {
  checkReportedOutputs,
  proveSchemaSubset,
  shapeOf,
} from "../../../../src/workflow/domain/index.js";
import { testDeps } from "../helpers/fixtures.js";
import { AGENT_GOAL_INPUT, AGENT_GOAL_TYPE, independentDigest } from "../helpers/scenario.js";

describe("SC-055: property — 결과 digest", () => {
  const registries = testDeps().registries;
  // 레코드 패치 대용: 키워드 없는 dataSchema(임의 JSON 허용)를 가진 에이전트 Task 를 결과 검사에 직접 넘긴다.
  const task = { type: AGENT_GOAL_TYPE, input: { ...AGENT_GOAL_INPUT, dataSchema: {} } };
  const LIMITS = { resultInlineMaxBytes: 1_000_000 };

  it("Happy: 생성 JSON 출력의 결과 digest 가 독립 정규 JSON sha256 이고 같은 출력은 같은 digest 다 (test_SC055_property_result_digest_equals_canonical_sha256)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 16 }),
        jsonValueWithoutProtoKey,
        (summary, data) => {
          const outputs = { summary, data };
          const first = checkReportedOutputs(registries, task, outputs, LIMITS);
          expect(first.ok).toBe(true);
          if (!first.ok) return;
          expect(first.digest).toBe(independentDigest(outputs));
          const again = checkReportedOutputs(
            registries,
            task,
            JSON.parse(JSON.stringify(outputs)),
            LIMITS,
          );
          expect(again.ok && again.digest).toBe(first.digest);
        },
      ),
    );
  });

  it("Error: 생성 JSON 출력 안 어디든 own __proto__ 키가 있으면 그 위치로 output_forbidden_key 거절이고 그 키만 뺀 같은 값은 통과한다 (test_SC055_property_result_with_proto_key_refused_at_its_path)", () => {
    fc.assert(
      fc.property(protoKeyPlacement, ({ data, clean, path }) => {
        const refused = checkReportedOutputs(registries, task, { summary: "s", data }, LIMITS);
        expect(refused.ok).toBe(false);
        if (refused.ok) return;
        expect(refused.issues).toStrictEqual([
          { code: "output_forbidden_key", output: "data", path },
        ]);
        const accepted = checkReportedOutputs(
          registries,
          task,
          { summary: "s", data: clean },
          LIMITS,
        );
        expect(accepted.ok).toBe(true);
      }),
    );
  });
});

/** 값 안 어디든 own "__proto__" 키가 있는가(배열 원소·객체 값 재귀). */
function hasOwnProtoKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasOwnProtoKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.keys(value).some(
    (key) => key === "__proto__" || hasOwnProtoKey((value as Record<string, unknown>)[key]),
  );
}

// fc.jsonValue 는 own "__proto__" 키도 만든다 — 그 키는 출력 금지 키 검사가 거절하므로 통과 property 의
// 입력에서 빼고, 아래 거절 property 가 따로 다룬다.
const jsonValueWithoutProtoKey = fc
  .jsonValue({ maxDepth: 3 })
  .filter((value) => !hasOwnProtoKey(value));

/** own "__proto__" 키를 일반 속성으로 단다(대입은 프로토타입을 바꾸므로 정의로 단다). */
function withProtoKey(base: Record<string, unknown>, payload: unknown): Record<string, unknown> {
  const copy = { ...base };
  Object.defineProperty(copy, "__proto__", {
    value: payload,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return copy;
}

type Wrap =
  | { readonly k: "index"; readonly before: unknown[]; readonly after: unknown[] }
  | { readonly k: "key"; readonly key: string; readonly siblings: Record<string, unknown> };

const protoFreeKey = fc.string({ maxLength: 4 }).filter((key) => key !== "__proto__");
const protoFreeRecord = fc
  .dictionary(protoFreeKey, jsonValueWithoutProtoKey, { maxKeys: 3 })
  .map((record) => Object.fromEntries(Object.entries(record)));
const wrapArb: fc.Arbitrary<Wrap> = fc.oneof(
  fc.record({
    k: fc.constant("index" as const),
    before: fc.array(jsonValueWithoutProtoKey, { maxLength: 2 }),
    after: fc.array(jsonValueWithoutProtoKey, { maxLength: 2 }),
  }),
  fc.record({ k: fc.constant("key" as const), key: protoFreeKey, siblings: protoFreeRecord }),
);

/** own "__proto__" 키 하나를 둔 값·그 키만 뺀 값·키 위치. 나머지 내용은 그 키가 없다. */
const protoKeyPlacement = fc
  .record({
    leafSiblings: protoFreeRecord,
    payload: jsonValueWithoutProtoKey,
    wraps: fc.array(wrapArb, { maxLength: 3 }),
  })
  .map(({ leafSiblings, payload, wraps }) => {
    let data: unknown = withProtoKey(leafSiblings, payload);
    let clean: unknown = { ...leafSiblings };
    let path: (string | number)[] = ["__proto__"];
    for (const wrap of wraps) {
      if (wrap.k === "index") {
        data = [...wrap.before, data, ...wrap.after];
        clean = [...wrap.before, clean, ...wrap.after];
        path = [wrap.before.length, ...path];
      } else {
        data = { ...wrap.siblings, [wrap.key]: data };
        clean = { ...wrap.siblings, [wrap.key]: clean };
        path = [wrap.key, ...path];
      }
    }
    return { data, clean, path };
  });

// ---- 호환성 증명 건전성 -----------------------------------------------------

/** 경계 검사의 통제 필드 — 사용자 when(참·거짓 상수)·abort. */
type Ctl = "none" | "when_true" | "when_false" | "abort";

type Desc =
  | {
      readonly k: "string";
      readonly min: number;
      readonly max: number | undefined;
      readonly ctl: Ctl;
    }
  | {
      readonly k: "number";
      readonly int: boolean;
      readonly min: number | undefined;
      readonly max: number | undefined;
      readonly ctl: Ctl;
    }
  | { readonly k: "boolean" }
  | { readonly k: "literal"; readonly value: string | number | boolean }
  | { readonly k: "enum"; readonly options: readonly [string, ...string[]] }
  | { readonly k: "enum_object"; readonly entries: Readonly<Record<string, string | number>> }
  | {
      readonly k: "array";
      readonly item: Desc;
      readonly min: number;
      readonly max: number | undefined;
    }
  | {
      readonly k: "object";
      readonly mode: "strict" | "loose" | "strip";
      readonly props: Readonly<
        Record<string, { readonly desc: Desc; readonly optional: boolean; readonly exact: boolean }>
      >;
    }
  | { readonly k: "optional"; readonly inner: Desc }
  | { readonly k: "intersection"; readonly left: Desc; readonly right: Desc };

function ctlParams(ctl: Ctl) {
  switch (ctl) {
    case "none":
      return undefined;
    case "when_true":
      return { when: () => true };
    case "when_false":
      return { when: () => false };
    case "abort":
      return { abort: true };
  }
}

function build(desc: Desc): z.ZodType {
  switch (desc.k) {
    case "string": {
      let s = z.string().min(desc.min, ctlParams(desc.ctl));
      if (desc.max !== undefined) s = s.max(desc.max);
      return s;
    }
    case "number": {
      let n = desc.int ? z.number().int() : z.number();
      if (desc.min !== undefined) n = n.min(desc.min, ctlParams(desc.ctl));
      if (desc.max !== undefined) n = n.max(desc.max, ctlParams(desc.ctl));
      return n;
    }
    case "boolean":
      return z.boolean();
    case "literal":
      return z.literal(desc.value);
    case "enum":
      return z.enum(desc.options);
    case "enum_object":
      return z.enum(desc.entries);
    case "array": {
      let a = z.array(build(desc.item)).min(desc.min);
      if (desc.max !== undefined) a = a.max(desc.max);
      return a;
    }
    case "object": {
      const shape = Object.fromEntries(
        Object.entries(desc.props).map(([key, p]) => [
          key,
          !p.optional
            ? build(p.desc)
            : p.exact
              ? build(p.desc).exactOptional()
              : build(p.desc).optional(),
        ]),
      );
      if (desc.mode === "strict") return z.strictObject(shape);
      if (desc.mode === "loose") return z.looseObject(shape);
      return z.object(shape);
    }
    case "optional":
      return build(desc.inner).optional();
    case "intersection":
      return z.intersection(build(desc.left), build(desc.right));
  }
}

/** 숫자 값 enum 객체 — 숫자 TS enum 의 역매핑(값 → 이름) 항목을 포함한다. */
const ENUM_OBJECTS: readonly Readonly<Record<string, string | number>>[] = [
  { A: 0, B: 1, "0": "A", "1": "B" },
  { A: 1, "1": "A", B: "b" },
  { A: "a", B: "b" },
];

/** 객체 모양 키 후보 — 일반 이름과 상속 멤버 이름(값으로 읽히는 `Object.prototype` 멤버). */
const OBJECT_KEYS = ["x", "y", "toString", "constructor", "__proto__"] as const;

type Prop = { readonly desc: Desc; readonly optional: boolean; readonly exact: boolean };

/** 항목을 자기 열거 속성으로 둔다 — `__proto__` 키도 프로토타입이 아니라 자기 속성이 된다. */
function ownProps(entries: readonly (readonly [string, Prop])[]): Record<string, Prop> {
  const props: Record<string, Prop> = {};
  for (const [key, prop] of entries)
    Object.defineProperty(props, key, {
      value: prop,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return props;
}

const smallInt = fc.integer({ min: -2, max: 4 });
/** 길이 경계 — 상한은 하한 이상(하한 > 상한이면 zod 가 스키마를 만들 때 정규식 오류를 낸다). */
const lengthBounds = (maxMin: number) =>
  fc
    .tuple(
      fc.integer({ min: 0, max: maxMin }),
      fc.option(fc.integer({ min: 0, max: 2 }), { nil: undefined }),
    )
    .map(([min, extra]) => ({ min, max: extra === undefined ? undefined : min + extra }));
const ctlArb = fc.constantFrom<Ctl>("none", "none", "when_true", "when_false", "abort");
const descArb: fc.Arbitrary<Desc> = fc.letrec<{ desc: Desc }>((tie) => ({
  desc: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.tuple(lengthBounds(3), ctlArb).map(([b, ctl]) => ({ k: "string" as const, ...b, ctl })),
    fc.record({
      k: fc.constant("number" as const),
      int: fc.boolean(),
      min: fc.option(smallInt, { nil: undefined }),
      max: fc.option(smallInt, { nil: undefined }),
      ctl: ctlArb,
    }),
    fc.constant({ k: "boolean" as const }),
    fc.record({
      k: fc.constant("literal" as const),
      value: fc.constantFrom<string | number | boolean>("a", "b", 1, 2, true),
    }),
    fc.record({
      k: fc.constant("enum" as const),
      options: fc
        .uniqueArray(fc.constantFrom("a", "b", "c"), { minLength: 1, maxLength: 3 })
        .map((o) => o as [string, ...string[]]),
    }),
    fc
      .tuple(tie("desc"), lengthBounds(2))
      .map(([item, b]) => ({ k: "array" as const, item, ...b })),
    fc.record({
      k: fc.constant("object" as const),
      mode: fc.constantFrom("strict" as const, "loose" as const, "strip" as const),
      props: fc
        .uniqueArray(
          fc.tuple(
            fc.constantFrom(...OBJECT_KEYS),
            fc.record({ desc: tie("desc"), optional: fc.boolean(), exact: fc.boolean() }),
          ),
          { selector: ([key]) => key, maxLength: 2 },
        )
        .map(ownProps),
    }),
    fc.record({ k: fc.constant("optional" as const), inner: tie("desc") }),
    fc.record({
      k: fc.constant("enum_object" as const),
      entries: fc.constantFrom(...ENUM_OBJECTS),
    }),
    fc.record({ k: fc.constant("intersection" as const), left: tie("desc"), right: tie("desc") }),
  ),
})).desc;

const valueArb: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constantFrom<unknown>(
      "",
      "a",
      "b",
      "A",
      "B",
      "c",
      "ab",
      "abcd",
      "abcdef",
      0,
      1,
      2,
      -1,
      1.5,
      4,
      5,
      true,
      false,
      null,
      undefined,
    ),
    fc.array(tie("value"), { maxLength: 3 }),
    fc.dictionary(fc.constantFrom("x", "y", "z"), tie("value"), { maxKeys: 3 }),
  ),
})).value;

/** zod intersection 은 두 part 의 출력을 합치지 못하면 parse 중 예외를 던진다 — 수용하지 않은 것으로 본다. */
function safeParseOrThrown(
  schema: z.ZodType,
  value: unknown,
): { success: true; data: unknown } | { success: false } {
  try {
    const parsed = schema.safeParse(value);
    return parsed.success ? { success: true, data: parsed.data } : { success: false };
  } catch {
    return { success: false };
  }
}

const PLAIN_STRING: Desc = { k: "string", min: 0, max: undefined, ctl: "none" };
const STRICT_A: Desc = {
  k: "object",
  mode: "strict",
  props: { x: { desc: PLAIN_STRING, optional: false, exact: false } },
};
const STRICT_B: Desc = {
  k: "object",
  mode: "strict",
  props: { y: { desc: PLAIN_STRING, optional: false, exact: false } },
};
const optionalX = (exact: boolean): Desc => ({
  k: "object",
  mode: "strict",
  props: { x: { desc: PLAIN_STRING, optional: true, exact } },
});
const withOptionalKey = (key: string): Desc => ({
  k: "object",
  mode: "strict",
  props: ownProps([
    ["x", { desc: PLAIN_STRING, optional: false, exact: false }],
    [key, { desc: PLAIN_STRING, optional: true, exact: false }],
  ]),
});
/**
 * 결함 재현 입력: 생산자 strict∩strict 의 합친 출력, 숫자 enum 역매핑 이름 literal, 꺼진 사용자 when 의
 * 생산자 길이 검사, 생산자 optional 의 undefined 값 키를 소비자 exactOptional 이 받는 경우, 소비자 객체의
 * 상속 멤버 이름 선택 키(생산자에는 없음).
 */
const FOUNDING_EXAMPLES: [Desc, Desc | undefined, unknown[]][] = [
  [{ k: "intersection", left: STRICT_A, right: STRICT_B }, STRICT_A, [{ x: "a", y: "b" }]],
  [
    { k: "literal", value: "A" },
    { k: "enum_object", entries: { A: 0, B: 1, "0": "A", "1": "B" } },
    ["A"],
  ],
  [
    { k: "string", min: 5, max: undefined, ctl: "when_false" },
    { k: "string", min: 5, max: undefined, ctl: "none" },
    ["ab"],
  ],
  [optionalX(false), optionalX(true), [{ x: undefined }]],
  [STRICT_A, withOptionalKey("toString"), [{ x: "a" }]],
  [STRICT_A, withOptionalKey("__proto__"), [{ x: "a" }]],
];

/** 정규 JSON 왕복이 값을 바꾸지 않는가 — undefined·비유한 수·-0 이 없고 배열·객체·원시값만. */
function jsonFaithful(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value)) return value.every(jsonFaithful);
  if (typeof value === "object") return Object.values(value).every(jsonFaithful);
  return false;
}

describe("SC-055: property — 호환성 증명 건전성", () => {
  it("Edge: 증명이 참이면 생산자가 받아들인 값의 파싱 결과를 소비자도 받아들인다 (test_SC055_property_schema_subset_proof_sound)", () => {
    let proved = 0;
    fc.assert(
      fc.property(
        descArb,
        fc.oneof(descArb, fc.constant(undefined)),
        fc.array(valueArb, { minLength: 1, maxLength: 6 }),
        (producerDesc, consumerDescOrSame, values) => {
          const producer = build(producerDesc);
          const consumer = build(consumerDescOrSame ?? producerDesc);
          if (!proveSchemaSubset(shapeOf(producer, "producer"), shapeOf(consumer, "consumer")))
            return;
          proved += 1;
          for (const value of values) {
            const parsed = safeParseOrThrown(producer, value);
            if (!parsed.success) continue;
            expect(safeParseOrThrown(consumer, parsed.data).success).toBe(true);
            // 기록 값은 정규 JSON 이라 일반 객체(Object.prototype 상속)로 되돌아온다.
            if (!jsonFaithful(parsed.data)) continue;
            const recorded = JSON.parse(JSON.stringify(parsed.data)) as unknown;
            expect(safeParseOrThrown(consumer, recorded).success).toBe(true);
          }
        },
      ),
      { numRuns: 300, examples: FOUNDING_EXAMPLES },
    );
    // 공허 통과 방지: 증명이 참인 쌍이 실제로 생성돼 검사되었어야 한다.
    expect(proved).toBeGreaterThan(0);
  });
});
