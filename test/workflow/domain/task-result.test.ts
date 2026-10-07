// SC-040~SC-046, SC-050 — dataSchema 허용 목록·무시 키워드·결과 기록·불변·출력 위반 재시도·크기 상한·누락·
// 비선언 출력·기록 값의 재생 일치.
import { describe, expect, it } from "vitest";
import {
  DomainInvariantError,
  checkReportedOutputs,
  executeCommand,
  parseDataSchema,
  validateTask,
} from "../../../src/workflow/domain/index.js";
import type {
  DomainCommit,
  DomainDeps,
  TaskId,
  TaskPolicy,
} from "../../../src/workflow/domain/index.js";
import {
  at,
  basePolicy,
  committedChain,
  applyCommits,
  draft,
  foldCommits,
  meta,
  patchTask,
  planInput,
  reachWorkState,
  testDeps,
} from "./helpers/fixtures.js";
import { PROBE_OBJECT_OUTPUT_TASK_TYPE, testRegistries } from "./helpers/registry-fixtures.js";
import { eventTypes, payloadOf } from "./helpers/commits.js";
import {
  AGENT_GOAL_INPUT,
  AGENT_GOAL_TYPE,
  agentGoalDraft,
  beginConfirmation,
  complete,
  confirmationDraft,
  confirmationSignal,
  fail,
  independentCanonicalJson,
  independentDigest,
  skip,
  start,
  startJournal,
  taskCommand,
  taskPayload,
  validate,
} from "./helpers/scenario.js";

const ALLOWED_DATA_SCHEMA = {
  type: "object",
  title: "Report data",
  properties: { count: { type: "number", minimum: 0 }, label: { type: "string", maxLength: 20 } },
  required: ["count"],
  additionalProperties: false,
};

const IGNORED_OR_THROWING: Record<string, Record<string, unknown>> = {
  not: { not: { type: "string" } },
  if: { if: { type: "string" }, then: { type: "string", minLength: 1 } },
  uniqueItems: { type: "array", items: { type: "number" }, uniqueItems: true },
  contains: { type: "array", contains: { type: "number" } },
  minContains: { type: "array", contains: { type: "number" }, minContains: 2 },
  maxContains: { type: "array", contains: { type: "number" }, maxContains: 1 },
};

function agentDeclaration(dataSchema: unknown) {
  return {
    type: AGENT_GOAL_TYPE,
    input: { ...AGENT_GOAL_INPUT, dataSchema },
    trigger: { kind: "immediate", version: 1, triggerId: "agent" },
    policy: basePolicy(),
  };
}

function planCommit(dataSchema: unknown) {
  const { deps, aggregate } = reachWorkState("PLANNING");
  const outcome = executeCommand(deps, aggregate, {
    kind: "commit_plan",
    expectedRevision: aggregate.work.revision,
    meta: meta(at("2026-01-01T00:00:00Z")),
    plan: planInput([agentGoalDraft("agent", { dataSchema })]),
  });
  if (outcome.kind !== "committed") throw new Error(`expected committed, got ${outcome.kind}`);
  return outcome.commit;
}

interface WeakeningForm {
  readonly name: string;
  readonly schema: () => unknown;
  readonly issue: { readonly code: string; readonly keyword: string };
}

/** 허용 목록을 통과하던 변환 약화 형태 — 변환 결과가 JSON Schema 보다 넓은 값을 받아들였다. */
const WEAKENING_FORMS: readonly WeakeningForm[] = [
  {
    name: "strict object with anyOf",
    schema: () => ({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
      anyOf: [{ type: "object" }],
    }),
    issue: { code: "combinator_with_siblings", keyword: "anyOf" },
  },
  {
    name: "allOf",
    schema: () => ({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
        { type: "object", properties: { b: { type: "string" } }, additionalProperties: false },
      ],
    }),
    issue: { code: "keyword_not_allowed", keyword: "allOf" },
  },
  {
    name: "oneOf",
    schema: () => ({ oneOf: [{ type: "integer" }, { type: "number", minimum: 2 ** 53 }] }),
    issue: { code: "keyword_not_allowed", keyword: "oneOf" },
  },
  {
    name: "minItems without items",
    schema: () => ({ type: "array", minItems: 2 }),
    issue: { code: "keyword_without_items", keyword: "minItems" },
  },
  {
    name: "minLength 2",
    schema: () => ({ type: "string", minLength: 2 }),
    issue: { code: "keyword_value_invalid", keyword: "minLength" },
  },
  {
    name: "top-level __proto__",
    // JSON 원본 그대로 — 객체 리터럴의 __proto__ 는 own 키가 되지 않는다.
    schema: () => JSON.parse('{"__proto__":{"type":"string"},"type":"object"}') as unknown,
    issue: { code: "keyword_not_allowed", keyword: "__proto__" },
  },
];

/** 같은 축의 허용 형태(대조). */
const ALLOWED_COUNTERPARTS: readonly Record<string, unknown>[] = [
  { anyOf: [{ type: "string" }, { type: "number" }] },
  { type: "array", items: true, minItems: 2 },
  { type: "string", minLength: 1, maxLength: 5 },
];

describe("SC-040: 허용 목록 밖 키워드를 쓴 dataSchema 는 거절된다", () => {
  const registries = testDeps().registries;

  it("Happy: 허용 키워드만 쓴 dataSchema 는 Task 검증을 통과하고 계획이 커밋된다 (test_SC040_allowed_keywords_pass_task_and_plan)", () => {
    expect(validateTask(registries, agentDeclaration(ALLOWED_DATA_SCHEMA)).exit).toBe("valid");
    const commit = planCommit(ALLOWED_DATA_SCHEMA);
    expect(eventTypes(commit)).toContain("work_plan_committed");
    expect(eventTypes(commit)).toContain("task_created");
  });

  it("Edge: not·if·uniqueItems·contains·minContains·maxContains 각각 Task 검증이 validation_failed 다 (test_SC040_six_keywords_refused_in_task_validation)", () => {
    for (const [keyword, schema] of Object.entries(IGNORED_OR_THROWING)) {
      const result = validateTask(registries, agentDeclaration(schema));
      expect(result.exit, keyword).toBe("validation_failed");
      if (result.exit === "validation_failed")
        expect(
          result.issues.some((i) => i.area === "input" && i.path[0] === "dataSchema"),
          keyword,
        ).toBe(true);
    }
  });

  it("Error: 같은 여섯 dataSchema 를 실은 계획은 draft_invalid 로 무효다 (test_SC040_six_keywords_plan_invalid)", () => {
    for (const [keyword, schema] of Object.entries(IGNORED_OR_THROWING)) {
      const commit = planCommit(schema);
      expect(eventTypes(commit), keyword).not.toContain("task_created");
      const issues = payloadOf(commit, "work_plan_invalid")["issues"] as readonly {
        kind: string;
        draftRef?: string;
      }[];
      expect(
        issues.map((i) => [i.kind, i.draftRef]),
        keyword,
      ).toContainEqual(["draft_invalid", "agent"]);
    }
  });

  it("Edge: 조합 노드 형제·allOf·oneOf·items 없는 개수·minLength 2·최상위 __proto__ 가 Task 검증과 계획에서 각각 거절된다 (test_SC040_weakening_schema_forms_refused_in_task_and_plan)", () => {
    for (const form of WEAKENING_FORMS) {
      const result = validateTask(registries, agentDeclaration(form.schema()));
      expect(result.exit, form.name).toBe("validation_failed");
      if (result.exit === "validation_failed")
        expect(result.issues, form.name).toContainEqual(
          expect.objectContaining({
            area: "input",
            code: "input_field_invalid",
            path: expect.arrayContaining(["dataSchema"]) as unknown,
          }),
        );
      const commit = planCommit(form.schema());
      expect(eventTypes(commit), form.name).not.toContain("task_created");
      const issues = payloadOf(commit, "work_plan_invalid")["issues"] as readonly {
        kind: string;
        draftRef?: string;
      }[];
      expect(
        issues.map((i) => [i.kind, i.draftRef]),
        form.name,
      ).toContainEqual(["draft_invalid", "agent"]);
    }
    // 대조: 같은 축의 허용 형태는 Task 검증을 통과하고 계획이 커밋된다.
    for (const schema of ALLOWED_COUNTERPARTS) {
      const label = JSON.stringify(schema);
      expect(validateTask(registries, agentDeclaration(schema)).exit, label).toBe("valid");
      expect(eventTypes(planCommit(schema)), label).toContain("work_plan_committed");
    }
  });
});

describe("SC-041: 변환이 무시하는 키워드가 검증을 통과시키지 않는다", () => {
  const registries = testDeps().registries;
  // 레코드 패치 대용: 계획·Task 검증이 막는 dataSchema 를 가진 Task 를 결과 검사 함수에 직접 넘긴다.
  const patchedTask = (dataSchema: unknown) => ({
    type: AGENT_GOAL_TYPE,
    input: { ...AGENT_GOAL_INPUT, dataSchema },
  });
  const LIMITS = { resultInlineMaxBytes: 65_536 };

  it("Happy: uniqueItems 배열 스키마는 변환 함수가 거절한다 (test_SC041_unique_items_schema_refused_by_parser)", () => {
    const parsed = parseDataSchema({ type: "array", items: { type: "number" }, uniqueItems: true });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok)
      expect(parsed.error).toContainEqual(
        expect.objectContaining({ code: "keyword_not_allowed", keyword: "uniqueItems" }),
      );
    // 대조: 같은 배열 스키마에서 uniqueItems 만 빼면 변환된다.
    const plain = parseDataSchema({ type: "array", items: { type: "number" } });
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.value.safeParse([1, 1]).success).toBe(true);
      expect(plain.value.safeParse(["x"]).success).toBe(false);
    }
  });

  it("Edge: 결과 검사 함수 직접 호출에서 무시 키워드 스키마는 output_schema_unsupported 이고 값이 유효로 판정되지 않는다 (test_SC041_output_check_refuses_ignored_keyword_schema)", () => {
    const duplicates = checkReportedOutputs(
      registries,
      patchedTask({ type: "array", items: { type: "number" }, uniqueItems: true }),
      { summary: "s", data: [1, 1] },
      LIMITS,
    );
    expect(duplicates.ok).toBe(false);
    if (!duplicates.ok)
      expect(duplicates.issues).toContainEqual(
        expect.objectContaining({ code: "output_schema_unsupported", output: "data" }),
      );
    const noMatch = checkReportedOutputs(
      registries,
      patchedTask({ type: "array", contains: { type: "number" } }),
      { summary: "s", data: ["a", "b"] },
      LIMITS,
    );
    expect(noMatch.ok).toBe(false);
    // 대조: 허용 스키마면 같은 경로가 통과한다.
    expect(
      checkReportedOutputs(
        registries,
        patchedTask({ type: "array", items: { type: "number" } }),
        { summary: "s", data: [1, 1] },
        LIMITS,
      ).ok,
    ).toBe(true);
    // 같은 직접 경로의 앞뒤 검사: 미등록 유형은 이후 검사 없이 task_type_unknown, 정규 JSON 불가 값은 outputs_not_json.
    expect(
      checkReportedOutputs(
        registries,
        { type: { id: "probe_missing", version: 1 }, input: {} },
        { summary: "s" },
        LIMITS,
      ),
    ).toEqual({ ok: false, issues: [{ code: "task_type_unknown" }] });
    const notJson = checkReportedOutputs(
      registries,
      patchedTask({}),
      { summary: "s", data: Number.NaN },
      LIMITS,
    );
    expect(notJson.ok).toBe(false);
    if (!notJson.ok)
      expect(notJson.issues).toContainEqual(
        expect.objectContaining({ code: "outputs_not_json", reason: "non_finite_number" }),
      );
  });

  it("Edge: 변환 약화 형태는 변환 함수가 이슈 코드로 거절하고 결과 검사가 output_schema_unsupported 이며, 그 형태가 통과시키던 위반 값이 결과로 기록되지 않는다 (test_SC041_weakening_schema_forms_refused_by_parser_and_output_check)", () => {
    for (const form of WEAKENING_FORMS) {
      const parsed = parseDataSchema(form.schema());
      expect(parsed.ok, form.name).toBe(false);
      if (!parsed.ok)
        expect(parsed.error, form.name).toContainEqual(expect.objectContaining(form.issue));
      const checked = checkReportedOutputs(
        registries,
        patchedTask(form.schema()),
        { summary: "s", data: "x" },
        LIMITS,
      );
      expect(checked.ok, form.name).toBe(false);
      if (!checked.ok)
        expect(checked.issues, form.name).toContainEqual(
          expect.objectContaining({ code: "output_schema_unsupported", output: "data" }),
        );
    }
    // 결함 재현: 약화 형태가 통과시키던 위반 data 를 실제 완료 경로에 넣는다.
    const founding: readonly {
      schema: unknown;
      data: unknown;
      allowed: unknown;
      allowedAccepts: boolean;
    }[] = [
      {
        schema: (WEAKENING_FORMS[0] as WeakeningForm).schema(),
        data: { a: "x", extra: 1 },
        allowed: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          additionalProperties: false,
        },
        allowedAccepts: false,
      },
      {
        schema: { type: "array", minItems: 2 },
        data: [],
        allowed: { type: "array", items: true, minItems: 2 },
        allowedAccepts: false,
      },
      {
        // 코드 포인트 1개(UTF-16 코드 단위 2개) — JSON Schema minLength 는 코드 포인트를 센다.
        schema: { type: "string", minLength: 2 },
        data: "\u{1F600}",
        allowed: { type: "string", minLength: 1 },
        allowedAccepts: true,
      },
    ];
    for (const [index, { schema, data, allowed, allowedAccepts }] of founding.entries()) {
      const { journal, agent } = agentTask(`sc041f${index}`);
      start(journal, agent);
      // 레코드 패치: 검증이 막는 dataSchema 를 실행 중 Task 에 둔다(다른 생성 경로 대용).
      journal.aggregate = patchTask(journal.aggregate, agent, {
        input: { ...AGENT_GOAL_INPUT, dataSchema: schema },
      });
      const commit = complete(journal, agent, { summary: "s", data });
      expect(eventTypes(commit), String(index)).not.toContain("task_completed");
      expect(journal.task(agent).result, String(index)).toBeUndefined();
      const outcome = attemptOutcomeIssues(commit, agent, "task_failed");
      expect(outcome["code"], String(index)).toBe("output_schema_violation");
      expect(outcome["outputIssues"], String(index)).toContainEqual(
        expect.objectContaining({ code: "output_schema_unsupported", output: "data" }),
      );
      // 대조: 같은 축의 허용 형태는 같은 값을 JSON Schema 의미대로 판정한다.
      const judged = checkReportedOutputs(
        registries,
        patchedTask(allowed),
        { summary: "s", data },
        LIMITS,
      );
      expect(judged.ok, String(index)).toBe(allowedAccepts);
    }
  });

  it("Error: contains 스키마를 선언한 Task 는 검증에서 거절된다 (test_SC041_contains_schema_task_refused)", () => {
    expect(
      validateTask(registries, agentDeclaration({ type: "array", contains: { type: "number" } }))
        .exit,
    ).toBe("validation_failed");
    expect(
      validateTask(registries, agentDeclaration({ type: "array", items: { type: "number" } })).exit,
    ).toBe("valid");
  });

  it("Edge: 보고 출력의 own __proto__ 키는 dataSchema 출력·선언 zod 출력 모두 위치를 단 출력 위반이고 결과로 기록되지 않는다 (test_SC041_own_proto_key_in_reported_output_violates)", () => {
    const STRICT_A = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    // JSON 원본 그대로 — 객체 리터럴의 __proto__ 는 own 키가 되지 않는다.
    const violations: readonly {
      name: string;
      dataSchema: unknown;
      data: unknown;
      path: readonly string[];
      clean: unknown;
    }[] = [
      {
        name: "top-level",
        dataSchema: STRICT_A,
        data: JSON.parse('{"a":"x","__proto__":{"b":1}}') as unknown,
        path: ["__proto__"],
        clean: { a: "x" },
      },
      {
        name: "nested",
        dataSchema: { type: "object" },
        data: JSON.parse('{"a":{"__proto__":1}}') as unknown,
        path: ["a", "__proto__"],
        clean: { a: { b: 1 } },
      },
    ];
    for (const [index, { name, dataSchema, data, path, clean }] of violations.entries()) {
      const { journal, agent } = agentTask(`sc041p${index}`, undefined, undefined, { dataSchema });
      start(journal, agent);
      const commit = complete(journal, agent, { summary: "s", data });
      expect(eventTypes(commit), name).not.toContain("task_completed");
      expect(journal.task(agent).result, name).toBeUndefined();
      const outcome = attemptOutcomeIssues(commit, agent, "task_failed");
      expect(outcome["code"], name).toBe("output_schema_violation");
      expect(outcome["outputIssues"], name).toContainEqual(
        expect.objectContaining({ code: "output_forbidden_key", output: "data", path }),
      );
      // 대조: __proto__ 키가 없는 같은 모양의 값은 완료된다.
      const control = agentTask(`sc041q${index}`, undefined, undefined, { dataSchema });
      start(control.journal, control.agent);
      const completed = complete(control.journal, control.agent, { summary: "s", data: clean });
      expect(eventTypes(completed), name).toContain("task_completed");
    }
    // 대조: 값이 문자열 "__proto__" 인 것은 키가 아니므로 완료된다.
    const stringValue = agentTask("sc041r", undefined, undefined, { dataSchema: STRICT_A });
    start(stringValue.journal, stringValue.agent);
    expect(
      eventTypes(
        complete(stringValue.journal, stringValue.agent, {
          summary: "s",
          data: { a: "__proto__" },
        }),
      ),
    ).toContain("task_completed");

    // 선언 zod strict 출력도 같다.
    const objectDeps = testDeps(
      "sc041o",
      testRegistries({ taskTypes: [PROBE_OBJECT_OUTPUT_TASK_TYPE] }),
    );
    const OBJECT_TYPE = {
      id: PROBE_OBJECT_OUTPUT_TASK_TYPE.id,
      version: PROBE_OBJECT_OUTPUT_TASK_TYPE.version,
    };
    const { journal, ids } = startJournal(
      [draft("forbidden", { type: OBJECT_TYPE }), draft("plain", { type: OBJECT_TYPE })],
      objectDeps,
    );
    const forbidden = ids["forbidden"] as TaskId;
    const plain = ids["plain"] as TaskId;
    validate(journal, forbidden);
    validate(journal, plain);
    start(journal, forbidden);
    const refused = complete(journal, forbidden, {
      record: JSON.parse('{"a":"x","__proto__":{"k":"y"}}') as unknown,
    });
    expect(eventTypes(refused)).not.toContain("task_completed");
    expect(attemptOutcomeIssues(refused, forbidden, "task_failed")["outputIssues"]).toContainEqual(
      expect.objectContaining({
        code: "output_forbidden_key",
        output: "record",
        path: ["__proto__"],
      }),
    );
    start(journal, plain);
    expect(eventTypes(complete(journal, plain, { record: { a: "x" } }))).toContain(
      "task_completed",
    );
  });
});

/** 에이전트 유형 Task 하나(정책 덮어쓰기 가능)를 READY 로 둔 Work. */
function agentTask(
  seed: string,
  policy?: Partial<TaskPolicy>,
  deps?: DomainDeps,
  input: Record<string, unknown> = {},
) {
  const { journal, ids } = startJournal(
    [agentGoalDraft("agent", input, policy !== undefined ? { policy: basePolicy(policy) } : {})],
    deps ?? testDeps(seed),
  );
  const agent = ids["agent"] as TaskId;
  validate(journal, agent);
  return { journal, agent };
}

function attemptOutcomeIssues(
  commit: DomainCommit,
  agent: TaskId,
  type: "task_retry_wait" | "task_failed",
) {
  const payload = taskPayload(commit, agent, type);
  const outcome = (
    type === "task_failed"
      ? (payload["reason"] as Record<string, unknown>)["outcome"]
      : payload["outcome"]
  ) as Record<string, unknown>;
  return outcome;
}

describe("SC-042: 결과는 만족 종결 이벤트에 한 번 기록된다", () => {
  it("Happy: 에이전트 성공 attempt 는 task_completed.result{res_, attemptId, outputs, digest} 다 (test_SC042_agent_success_records_result)", () => {
    const { journal, agent } = agentTask("sc042a");
    start(journal, agent);
    const attemptId = journal.task(agent).openAttempt?.attemptId;
    const commit = complete(journal, agent, { summary: "Findings summarized" });
    const result = taskPayload(commit, agent, "task_completed")["result"] as Record<
      string,
      unknown
    >;
    expect(String(result["id"])).toMatch(/^res_/);
    expect(result["attemptId"]).toBe(attemptId);
    expect(result["outputs"]).toEqual({ summary: "Findings summarized" });
    expect(result["digest"]).toBe(independentDigest({ summary: "Findings summarized" }));
    const event = commit.events.find((e) => e.type === "task_completed");
    expect(journal.task(agent).result).toEqual({ ...result, taskId: agent, eventId: event?.id });
  });

  it("Edge: 수락된 확인 Task 는 결정·결정 시각 결과를, 알림 Task 는 빈 출력 결과를 남긴다 (test_SC042_confirmation_and_notification_results)", () => {
    const { journal, ids } = startJournal(
      [
        confirmationDraft("confirm"),
        draft("notify", {
          type: { id: "notification", version: 1 },
          input: { target: "owner", message: "done", importance: "low" },
        }),
      ],
      testDeps("sc042b"),
    );
    const confirm = ids["confirm"] as TaskId;
    const notify = ids["notify"] as TaskId;
    validate(journal, confirm);
    validate(journal, notify);
    beginConfirmation(journal, confirm);
    const decidedAt = at("2026-01-01T00:30:00Z");
    const accepted = journal.apply(confirmationSignal(journal, confirm, "accept", decidedAt));
    const confirmationResult = taskPayload(accepted, confirm, "confirmation_accepted")[
      "result"
    ] as Record<string, unknown>;
    expect(String(confirmationResult["id"])).toMatch(/^res_/);
    expect(confirmationResult).not.toHaveProperty("attemptId");
    expect(confirmationResult["outputs"]).toEqual({ decision: "accept", decidedAt });
    expect(confirmationResult["digest"]).toBe(independentDigest({ decision: "accept", decidedAt }));
    start(journal, notify);
    const notified = complete(journal, notify);
    const notificationResult = taskPayload(notified, notify, "task_completed")["result"] as Record<
      string,
      unknown
    >;
    expect(notificationResult["outputs"]).toEqual({});
    expect(notificationResult["digest"]).toBe(independentDigest({}));
  });

  it("Edge: 확인 수락 결과 검사가 실패하면 신호를 confirmation_result_invalid 로 거절하고 키를 선점하지 않는다 (test_SC042_confirmation_result_invalid_refuses_signal)", () => {
    // 상한 설정 오류(결정 출력보다 작은 상한)로 결과 검사가 실패하는 경우.
    const base = testDeps("sc042d");
    const deps: DomainDeps = {
      ...base,
      operationalDefaults: { agentDispatchDeadlineMs: 600_000, resultInlineMaxBytes: 8 },
    };
    const { journal, ids } = startJournal([confirmationDraft("confirm")], deps);
    const confirm = ids["confirm"] as TaskId;
    validate(journal, confirm);
    beginConfirmation(journal, confirm);
    const before = journal.aggregate;
    const judged = confirmationSignal(journal, confirm, "accept");
    expect(judged.kind).toBe("not_applicable");
    if (judged.kind === "not_applicable") {
      expect(judged.rejection.reason).toBe("invalid_input");
      expect(judged.rejection.detail).toBe("confirmation_result_invalid");
    }
    expect(committedChain(judged)).toEqual([]);
    expect(journal.task(confirm).state).toBe("WAITING_CONFIRMATION");
    expect(journal.aggregate.acceptedSignalKeys).toEqual(before.acceptedSignalKeys);
    // 대조: 상한이 충분하면 같은 결정이 수락된다.
    const ok = startJournal([confirmationDraft("confirm")], testDeps("sc042e"));
    const okConfirm = ok.ids["confirm"] as TaskId;
    validate(ok.journal, okConfirm);
    beginConfirmation(ok.journal, okConfirm);
    expect(confirmationSignal(ok.journal, okConfirm, "accept").kind).toBe("accepted");
  });

  it("Error: 건너뛰기 종결은 결과가 없다 (test_SC042_skip_records_no_result)", () => {
    const { journal, agent } = agentTask("sc042c");
    const commit = skip(journal, agent);
    expect(taskPayload(commit, agent, "task_skipped")).not.toHaveProperty("result");
    expect(journal.task(agent).state).toBe("SKIPPED");
    expect(journal.task(agent).result).toBeUndefined();
  });
});

describe("SC-043: 기록된 결과는 바뀌지 않는다", () => {
  function lateResult(seed: string) {
    const { journal, agent } = agentTask(seed);
    start(journal, agent);
    const firstAttempt = journal.task(agent).openAttempt?.attemptId;
    if (firstAttempt === undefined) throw new Error("expected first attempt");
    fail(journal, agent);
    journal.apply(taskCommand(journal.deps, journal.aggregate, agent, { kind: "retry_ready" }));
    start(journal, agent);
    complete(journal, agent, { summary: "second attempt" });
    const recorded = journal.task(agent);
    const outcome = taskCommand(journal.deps, journal.aggregate, agent, {
      kind: "record_attempt_outcome",
      attemptId: firstAttempt,
      outcome: { kind: "completed", evidence: {}, outputs: { summary: "late first attempt" } },
    });
    const after = applyCommits(journal.aggregate, committedChain(outcome));
    return { agent, recorded, outcome, after };
  }

  it("Happy: 이전 attempt 의 늦은 결과가 와도 결과 ID·출력·digest 가 그대로다 (test_SC043_late_result_keeps_recorded_result)", () => {
    const { agent, recorded, after } = lateResult("sc043a");
    expect(recorded.result?.outputs).toEqual({ summary: "second attempt" });
    expect(after.tasks[agent]?.result).toEqual(recorded.result);
  });

  it("Edge: 늦은 결과는 stale_transition_rejected 로 기록된다 (test_SC043_late_result_recorded_as_stale)", () => {
    const { outcome } = lateResult("sc043b");
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.rejection.reason).toBe("terminal_subject");
    const chain = committedChain(outcome);
    expect(chain.map(eventTypes)).toEqual([["stale_transition_rejected"]]);
    const [record] = chain;
    if (record !== undefined)
      expect(payloadOf(record, "stale_transition_rejected")["reason"]).toBe("terminal_subject");
  });

  it("Error: Task revision 이 그대로다 (test_SC043_late_result_keeps_revision)", () => {
    const { agent, recorded, after } = lateResult("sc043c");
    expect(after.tasks[agent]?.revision).toBe(recorded.revision);
    expect(after.tasks[agent]?.state).toBe("COMPLETED");
  });

  it("Edge: 기록된 출력은 마스킹 주입이 돌려준 객체와 참조를 나누지 않는 동결 사본이라 기록 뒤 그 객체를 바꿔도 결과가 그대로다 (test_SC043_recorded_outputs_are_frozen_copies_unaffected_by_caller_mutation)", () => {
    const held: { value?: Record<string, unknown> } = {};
    const base = testDeps("sc043g");
    const deps: DomainDeps = {
      ...base,
      redactOutputs: (outputs) => {
        held.value = JSON.parse(JSON.stringify(outputs)) as Record<string, unknown>;
        return held.value;
      },
    };
    const { journal, agent } = agentTask("sc043g", undefined, deps, { dataSchema: {} });
    start(journal, agent);
    const reported = { summary: "kept", data: { nested: { value: 1 }, list: [1, 2] } };
    const commit = complete(journal, agent, reported);
    const returned = held.value;
    if (returned === undefined) throw new Error("expected redactor call");
    const fromEvent = taskPayload(commit, agent, "task_completed")["result"] as {
      outputs: Record<string, unknown>;
      digest: string;
    };
    const fromRecord = journal.task(agent).result;
    if (fromRecord === undefined) throw new Error("expected recorded result");
    const expected = JSON.parse(JSON.stringify(reported)) as unknown;
    for (const outputs of [fromEvent.outputs, fromRecord.outputs as Record<string, unknown>]) {
      expect(outputs).not.toBe(returned);
      expect(outputs["data"]).not.toBe(returned["data"]);
      expectDeeplyFrozen(outputs);
    }

    const data = returned["data"] as { nested: { value: number }; list: number[] };
    returned["summary"] = "changed";
    data.nested.value = 2;
    data.list.push(3);
    (returned as Record<string, unknown>)["extra"] = "added";

    expect(fromEvent.outputs).toStrictEqual(expected);
    expect(fromRecord.outputs).toStrictEqual(expected);
    expect(fromEvent.digest).toBe(independentDigest(expected));
    expect(fromRecord.digest).toBe(fromEvent.digest);
    // 대조: 바꾸지 않은 같은 흐름의 기록과 같다.
    const control = agentTask("sc043g", undefined, testDeps("sc043g"), { dataSchema: {} });
    start(control.journal, control.agent);
    complete(control.journal, control.agent, reported);
    expect(control.journal.task(control.agent).result?.outputs).toStrictEqual(expected);
    expect(control.journal.task(control.agent).result?.digest).toBe(fromEvent.digest);
  });
});

describe("SC-044: 스키마를 어긴 완료는 실패한 attempt 이고 결과는 성공 attempt 에서 하나만 나온다", () => {
  const RETRY_ON_VIOLATION: Partial<TaskPolicy> = {
    retry: {
      maxAttempts: 3,
      initialDelayMs: 1_000,
      maxDelayMs: 60_000,
      backoff: "fixed",
      retryableErrors: ["output_schema_violation"],
    },
  };

  it("Happy: 요약 출력이 문자열이 아닌 첫 완료는 output_schema_violation 사유로 RETRY_WAIT 이고 task_completed 가 아니다 (test_SC044_invalid_output_enters_retry_wait_not_completed)", () => {
    const { journal, agent } = agentTask("sc044a", RETRY_ON_VIOLATION);
    start(journal, agent);
    const commit = complete(journal, agent, { summary: 42 });
    expect(eventTypes(commit)).not.toContain("task_completed");
    expect(journal.task(agent).state).toBe("RETRY_WAIT");
    const outcome = attemptOutcomeIssues(commit, agent, "task_retry_wait");
    expect(outcome["kind"]).toBe("failed");
    expect(outcome["code"]).toBe("output_schema_violation");
    expect(outcome["outputIssues"]).toContainEqual(
      expect.objectContaining({ code: "output_invalid", output: "summary" }),
    );
    expect(journal.task(agent).result).toBeUndefined();
  });

  it("Edge: 둘째 attempt 의 유효 출력에서 결과가 하나만 나온다 (test_SC044_single_result_from_valid_attempt)", () => {
    const { journal, agent } = agentTask("sc044b", RETRY_ON_VIOLATION);
    const historyStart = journal.commits.length;
    start(journal, agent);
    complete(journal, agent, { summary: 42 });
    journal.apply(taskCommand(journal.deps, journal.aggregate, agent, { kind: "retry_ready" }));
    start(journal, agent);
    const secondAttempt = journal.task(agent).openAttempt?.attemptId;
    complete(journal, agent, { summary: "valid summary" });
    const completions = journal.commits
      .slice(historyStart)
      .flatMap((c) => c.events)
      .filter((e) => e.type === "task_completed");
    expect(completions).toHaveLength(1);
    expect(journal.task(agent).result?.attemptId).toBe(secondAttempt);
    expect(journal.task(agent).result?.outputs).toEqual({ summary: "valid summary" });
  });

  it("Error: 재시도 불가 정책이면 위반 완료가 FAILED 로 끝난다 (test_SC044_non_retryable_violation_fails)", () => {
    const { journal, agent } = agentTask("sc044c");
    start(journal, agent);
    const commit = complete(journal, agent, { summary: 42 });
    expect(journal.task(agent).state).toBe("FAILED");
    const outcome = attemptOutcomeIssues(commit, agent, "task_failed");
    expect(outcome["code"]).toBe("output_schema_violation");
    expect(journal.task(agent).result).toBeUndefined();
  });
});

describe("SC-045: 크기 상한을 넘는 출력은 실패한 attempt 다", () => {
  // UTF-8 다바이트 문자를 넣어 UTF-16 길이로 세는 구현과 구별한다.
  const OUTPUTS = { summary: "요약 완료 — ready" };
  const BYTES = Buffer.byteLength(independentCanonicalJson(OUTPUTS), "utf8");
  const withLimit = (seed: string, limit: unknown): DomainDeps => {
    const deps = testDeps(seed);
    return {
      ...deps,
      operationalDefaults: {
        agentDispatchDeadlineMs: 600_000,
        resultInlineMaxBytes: limit as number,
      },
    };
  };

  it("Happy: 정규 JSON UTF-8 길이가 상한 N 과 같은 출력은 완료된다 (test_SC045_output_at_limit_completes)", () => {
    expect(BYTES).toBeGreaterThan(independentCanonicalJson(OUTPUTS).length);
    const { journal, agent } = agentTask("sc045a", undefined, withLimit("sc045a", BYTES));
    start(journal, agent);
    complete(journal, agent, OUTPUTS);
    expect(journal.task(agent).state).toBe("COMPLETED");
    expect(journal.task(agent).result?.outputs).toEqual(OUTPUTS);
  });

  it("Edge: 상한보다 1 바이트 큰 출력은 outputs_too_large 위반 실패 attempt 다 (test_SC045_output_over_limit_violates)", () => {
    const { journal, agent } = agentTask("sc045b", undefined, withLimit("sc045b", BYTES - 1));
    start(journal, agent);
    const commit = complete(journal, agent, OUTPUTS);
    expect(journal.task(agent).state).toBe("FAILED");
    const outcome = attemptOutcomeIssues(commit, agent, "task_failed");
    expect(outcome["code"]).toBe("output_schema_violation");
    expect(outcome["outputIssues"]).toContainEqual({
      code: "outputs_too_large",
      bytes: BYTES,
      limit: BYTES - 1,
    });
    expect(journal.task(agent).result).toBeUndefined();
  });

  it("Error: 상한 0·음수·비정수·부재는 기본값 없이 DomainInvariantError 이고 결과가 없다 (test_SC045_invalid_or_missing_limit_throws_without_result)", () => {
    for (const [index, limit] of [0, -1, 1.5, Number.NaN, undefined].entries()) {
      const base = withLimit(`sc045c${index}`, 1);
      const deps: DomainDeps = {
        ...base,
        operationalDefaults:
          limit === undefined
            ? { agentDispatchDeadlineMs: 600_000 }
            : { agentDispatchDeadlineMs: 600_000, resultInlineMaxBytes: limit },
      };
      const { journal, agent } = agentTask(`sc045c${index}`, undefined, deps);
      start(journal, agent);
      const attemptId = journal.task(agent).openAttempt?.attemptId;
      if (attemptId === undefined) throw new Error("expected open attempt");
      expect(
        () =>
          taskCommand(journal.deps, journal.aggregate, agent, {
            kind: "record_attempt_outcome",
            attemptId,
            outcome: { kind: "completed", evidence: {}, outputs: { summary: "x" } },
          }),
        String(limit),
      ).toThrow(DomainInvariantError);
      expect(journal.task(agent).result).toBeUndefined();
    }
  });
});

describe("SC-046: 필수 출력 누락과 선언되지 않은 출력은 위반이다", () => {
  it("Happy: 요약 누락은 output_missing 위반 실패 attempt 다 (test_SC046_missing_summary_violates)", () => {
    const { journal, agent } = agentTask("sc046a");
    start(journal, agent);
    const commit = complete(journal, agent, {});
    expect(journal.task(agent).state).toBe("FAILED");
    expect(attemptOutcomeIssues(commit, agent, "task_failed")["outputIssues"]).toContainEqual({
      code: "output_missing",
      output: "summary",
    });
  });

  it("Edge: 선언되지 않은 출력 이름은 output_undeclared 위반이다 (test_SC046_undeclared_output_violates)", () => {
    const { journal, agent } = agentTask("sc046b");
    start(journal, agent);
    const commit = complete(journal, agent, { summary: "ok", verdict: "extra" });
    expect(journal.task(agent).state).toBe("FAILED");
    expect(attemptOutcomeIssues(commit, agent, "task_failed")["outputIssues"]).toContainEqual({
      code: "output_undeclared",
      output: "verdict",
    });
    // 출력 자체가 객체가 아니면 outputs_not_object 위반이다.
    const notObject = agentTask("sc046b2");
    start(notObject.journal, notObject.agent);
    const rejected = complete(notObject.journal, notObject.agent, "plain text");
    expect(attemptOutcomeIssues(rejected, notObject.agent, "task_failed")["outputIssues"]).toEqual([
      { code: "outputs_not_object" },
    ]);
  });

  it("Error: dataSchema 를 선언했는데 data 가 없으면 data 없는 결과로 완료된다 (test_SC046_data_schema_without_data_completes)", () => {
    const { journal, agent } = agentTask("sc046c", undefined, undefined, {
      dataSchema: ALLOWED_DATA_SCHEMA,
    });
    start(journal, agent);
    complete(journal, agent, { summary: "no structured data" });
    expect(journal.task(agent).state).toBe("COMPLETED");
    expect(journal.task(agent).result?.outputs).toEqual({ summary: "no structured data" });
    // 대조: data 가 있으면 스키마로 검사된다(위반 값은 실패).
    const violating = agentTask("sc046c2", undefined, undefined, {
      dataSchema: ALLOWED_DATA_SCHEMA,
    });
    start(violating.journal, violating.agent);
    complete(violating.journal, violating.agent, { summary: "s", data: { count: "many" } });
    expect(violating.journal.task(violating.agent).state).toBe("FAILED");
  });
});

/** 배열·객체를 모든 깊이에서 동결했는지 확인한다. */
function expectDeeplyFrozen(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value), path).toBe(true);
  for (const [key, child] of Object.entries(value)) expectDeeplyFrozen(child, `${path}.${key}`);
}

describe("SC-050: 기록된 값은 재생한 값과 같다", () => {
  it("Edge: 값이 undefined 인 출력 속성은 기록되지 않고, 라이브 결과가 JSON 왕복한 커밋을 fold 한 결과와 같다 (test_SC050_recorded_outputs_drop_undefined_keys_and_match_replay)", () => {
    const dataSchema = {
      type: "object",
      properties: { a: { type: "string" }, k: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    const { journal, agent } = agentTask("sc050u", undefined, undefined, { dataSchema });
    start(journal, agent);
    const commit = complete(journal, agent, { summary: "s", data: { a: "x", k: undefined } });
    const result = taskPayload(commit, agent, "task_completed")["result"] as {
      outputs: Record<string, unknown>;
      digest: string;
    };
    const recorded = journal.task(agent).result;
    if (recorded === undefined) throw new Error("expected recorded result");
    for (const outputs of [result.outputs, recorded.outputs as Record<string, unknown>])
      expect(Object.hasOwn(outputs["data"] as object, "k")).toBe(false);
    expect(recorded.outputs).toStrictEqual({ summary: "s", data: { a: "x" } });
    expect(result.digest).toBe(independentDigest({ summary: "s", data: { a: "x" } }));
    const replayed = foldCommits(JSON.parse(JSON.stringify(journal.commits)) as DomainCommit[]);
    expect(replayed.tasks[agent]?.result).toStrictEqual(recorded);
    // 대조: undefined 값이 없는 같은 출력은 같은 기록·digest 다.
    const control = agentTask("sc050v", undefined, undefined, { dataSchema });
    start(control.journal, control.agent);
    complete(control.journal, control.agent, { summary: "s", data: { a: "x" } });
    expect(control.journal.task(control.agent).result?.outputs).toStrictEqual(recorded.outputs);
    expect(control.journal.task(control.agent).result?.digest).toBe(result.digest);
  });
});
