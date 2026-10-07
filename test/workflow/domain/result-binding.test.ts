// SC-036~SC-039, SC-047~SC-050 — 입력 결합 계획 검증·호환성 증명·누락 아님·첫 효과 1회 해석·결합 인지 충족·기록 값.
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  BUILTIN_REACTIONS,
  BUILTIN_TASK_TYPES,
  BUILTIN_TRIGGERS,
  createDomainRegistries,
  createTaskTypeRegistry,
  DomainInvariantError,
  executeCommand,
  parseDataSchema,
  proveSchemaSubset,
  shapeOf,
  validateTask,
} from "../../../src/workflow/domain/index.js";
import type {
  CommandOutcome,
  DomainDeps,
  InputBinding,
  PlanTaskDraft,
  TaskId,
  TaskPolicy,
  TaskRecord,
  TaskTypeDescriptor,
  WorkAggregate,
} from "../../../src/workflow/domain/index.js";
import {
  basePolicy,
  committedChain,
  draft,
  meta,
  patchTask,
  planInput,
  reachWorkState,
  testDeps,
} from "./helpers/fixtures.js";
import {
  PROBE_CONSUMER_TASK_TYPE,
  PROBE_CONSUMER_TEXT_SAFETY_TASK_TYPE,
  PROBE_OBJECT_OUTPUT_TASK_TYPE,
  PROBE_PRODUCER_TASK_TYPE,
  probeOverridePromptTaskType,
  probeTaskType,
  testRegistries,
} from "./helpers/registry-fixtures.js";
import { eventTypes, payloadOf } from "./helpers/commits.js";
import {
  CONFIRMATION_INPUT,
  CONFIRMATION_TYPE,
  Journal,
  NOTIFICATION_TYPE,
  NOW,
  agentGoalDraft,
  beginConfirmation,
  complete,
  dependencyTrigger,
  fail,
  grantTaskDecision,
  independentDigest,
  planDecision,
  replanSignal,
  runToCompleted,
  skip,
  start,
  startJournal,
  taskCommand,
  taskEventTypes,
  taskPayload,
  validate,
} from "./helpers/scenario.js";

const PRODUCER = { id: PROBE_PRODUCER_TASK_TYPE.id, version: PROBE_PRODUCER_TASK_TYPE.version };
const CONSUMER = { id: PROBE_CONSUMER_TASK_TYPE.id, version: PROBE_CONSUMER_TASK_TYPE.version };

function bindingDeps(seed: string, redact?: DomainDeps["redactOutputs"]): DomainDeps {
  const deps = testDeps(
    seed,
    testRegistries({ taskTypes: [PROBE_PRODUCER_TASK_TYPE, PROBE_CONSUMER_TASK_TYPE] }),
  );
  return redact === undefined ? deps : { ...deps, redactOutputs: redact };
}

function fromTask(ref: string, output: string): InputBinding {
  return { from: "task", task: { draftRef: ref }, output };
}

/** 요약 Task(agent_goal)와 그 summary 를 message 로 결합한 필수 알림 Task 초안. */
function summaryAndNotification(notificationOverrides?: Partial<PlanTaskDraft>): PlanTaskDraft[] {
  return [
    agentGoalDraft("summary"),
    draft("notify", {
      type: NOTIFICATION_TYPE,
      input: { target: "owner", importance: "normal" },
      inputBindings: { message: fromTask("summary", "summary") },
      dependsOn: [{ draftRef: "summary" }],
      ...notificationOverrides,
    }),
  ];
}

function commitPlanOn(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  plan: ReturnType<typeof planInput>,
) {
  return executeCommand(deps, aggregate, {
    kind: "commit_plan",
    expectedRevision: aggregate.work.revision,
    meta: meta(NOW),
    plan,
  });
}

/** 결합 필드를 안전 관련으로 선언한 소비자 판의 등록부(등록부 drift 대용). */
function safetyDriftDeps(seed: string): DomainDeps {
  return testDeps(
    seed,
    testRegistries({
      taskTypes: [PROBE_PRODUCER_TASK_TYPE, PROBE_CONSUMER_TEXT_SAFETY_TASK_TYPE],
    }),
  );
}

function committedCommit(outcome: CommandOutcome) {
  if (outcome.kind !== "committed") throw new Error(`expected committed, got ${outcome.kind}`);
  return { commit: outcome.commit, aggregate: outcome.aggregate };
}

interface Issue {
  readonly kind: string;
  readonly [key: string]: unknown;
}

function firstPlanIssues(deps: DomainDeps, drafts: readonly PlanTaskDraft[]): readonly Issue[] {
  const { commit } = committedCommit(commitPlanOn(deps, planningAggregate(), planInput(drafts)));
  if (!eventTypes(commit).includes("work_plan_invalid")) return [];
  expect(eventTypes(commit)).not.toContain("task_created");
  return payloadOf(commit, "work_plan_invalid")["issues"] as readonly Issue[];
}

/** 첫 계획 전 PLANNING Work — 계획 판정은 호출 측 deps(시험 유형 등록부)로 한다. */
function planningAggregate(): WorkAggregate {
  return reachWorkState("PLANNING").aggregate;
}

function taskByRef(aggregate: WorkAggregate, ref: string): TaskRecord {
  const task = Object.values(aggregate.tasks).find((t) => t.draftRef === ref);
  if (task === undefined) throw new Error(`expected task ${ref}`);
  return task;
}

describe("SC-036: 유효한 결합은 커밋되고 Task 가 결합을 보유한다", () => {
  function committedSummaryAndNotification() {
    return committedCommit(
      commitPlanOn(bindingDeps("sc036"), planningAggregate(), planInput(summaryAndNotification())),
    );
  }

  it("Happy: 요약 → 알림 message 결합(의존 포함)이 커밋되고 알림 레코드가 그 결합을 싣는다 (test_SC036_summary_to_message_binding_commits)", () => {
    const { commit, aggregate } = committedSummaryAndNotification();
    expect(eventTypes(commit)).toContain("work_plan_committed");
    const summary = taskByRef(aggregate, "summary");
    expect(taskByRef(aggregate, "notify").inputBindings).toEqual({
      message: { from: "task", task: { taskId: summary.id }, output: "summary" },
    });
    expect(summary.inputBindings).toEqual({});
  });

  it("Edge: 결합 소비자의 입력에 그 필드가 없다 (test_SC036_bound_field_absent_from_input)", () => {
    const { aggregate } = committedSummaryAndNotification();
    const input = taskByRef(aggregate, "notify").input as Record<string, unknown>;
    expect(Object.hasOwn(input, "message")).toBe(false);
    expect(input).toEqual({ target: "owner", importance: "normal" });
  });

  it("Error: task_created.inputBindings 가 {taskId} 로 해석된 결합을 싣고 결합 없는 Task 는 필드를 생략한다 (test_SC036_task_created_carries_resolved_binding)", () => {
    const { commit, aggregate } = committedSummaryAndNotification();
    const summary = taskByRef(aggregate, "summary");
    const notify = taskByRef(aggregate, "notify");
    expect(taskPayload(commit, notify.id, "task_created")["inputBindings"]).toEqual({
      message: { from: "task", task: { taskId: summary.id }, output: "summary" },
    });
    expect(taskPayload(commit, summary.id, "task_created")).not.toHaveProperty("inputBindings");
  });
});

/** 재계획 결합 시험용: anchor(필수 READY)·완료 생산자(prodDone)·건너뛴 생산자(prodSkip)·note 없이 완료한 생산자(prodNote). */
function producersReplan(seed: string) {
  const deps = bindingDeps(seed);
  const { journal, ids } = startJournal(
    [
      draft("anchor"),
      draft("prodDone", { type: PRODUCER }),
      draft("prodSkip", { type: PRODUCER }),
      draft("prodNote", { type: PRODUCER }),
    ],
    deps,
  );
  const id = (ref: string) => ids[ref] as TaskId;
  validate(journal, id("anchor"));
  runToCompleted(journal, id("prodDone"), { text: "produced", stamp: "s", note: "n" });
  validate(journal, id("prodSkip"));
  skip(journal, id("prodSkip"));
  runToCompleted(journal, id("prodNote"), { text: "produced", stamp: "s" });
  journal.apply(replanSignal(journal));
  return { journal, id };
}

function consumerDraft(
  ref: string,
  field: string,
  producer: { taskId: TaskId } | { draftRef: string },
  output: string,
  input: Record<string, unknown> = {},
) {
  return draft(ref, {
    type: CONSUMER,
    input: { ...(field === "text" ? {} : { text: "direct" }), ...input },
    inputBindings: { [field]: { from: "task", task: producer, output } },
    dependsOn: [producer],
  });
}

function replanIssues(
  journal: Journal,
  retain: readonly TaskId[],
  tasks: readonly PlanTaskDraft[],
): readonly Issue[] {
  const outcome = commitPlanOn(
    journal.deps,
    journal.aggregate,
    planInput(tasks, { basePlanRevision: journal.aggregate.work.planRevision, retain }),
  );
  const { commit } = committedCommit(outcome);
  expect(eventTypes(commit)).toContain("work_plan_invalid");
  expect(eventTypes(commit)).not.toContain("task_created");
  return payloadOf(commit, "work_plan_invalid")["issues"] as readonly Issue[];
}

describe("SC-037: 결합 위반은 각각 계획 무효다", () => {
  it("Happy: 선언되지 않은 출력 결합은 binding_output_undeclared 다 (test_SC037_undeclared_output_binding_invalid)", () => {
    const issues = firstPlanIssues(
      bindingDeps("sc037a"),
      summaryAndNotification({ inputBindings: { message: fromTask("summary", "headline") } }),
    );
    expect(issues).toContainEqual({
      kind: "binding_output_undeclared",
      draftRef: "notify",
      field: "message",
      output: "headline",
    });
    // 대조: 선언 출력이면 무효가 아니다.
    expect(firstPlanIssues(bindingDeps("sc037a2"), summaryAndNotification())).toEqual([]);
  });

  it("Edge: 의존 아님·supersede 생산자·스키마 불일치·건너뛴 보존 생산자·출력 없는 완료 보존 생산자가 각각 이름 이슈다 (test_SC037_dependency_member_schema_skipped_absent_violations_named)", () => {
    // (1) 의존 목록에 없는 생산자
    expect(
      firstPlanIssues(bindingDeps("sc037b1"), summaryAndNotification({ dependsOn: [] })),
    ).toContainEqual({
      kind: "binding_producer_not_dependency",
      draftRef: "notify",
      field: "message",
      ref: { draftRef: "summary" },
    });
    // (2) 스키마 불일치(문자열 출력 → 숫자 입력)
    expect(
      firstPlanIssues(bindingDeps("sc037b2"), [
        agentGoalDraft("summary"),
        consumerDraft("consumer", "count", { draftRef: "summary" }, "summary"),
      ]),
    ).toContainEqual({
      kind: "binding_schema_incompatible",
      draftRef: "consumer",
      field: "count",
      reason: "not_provable",
    });
    const { journal, id } = producersReplan("sc037b3");
    const keepAll = [id("anchor"), id("prodDone"), id("prodSkip"), id("prodNote")];
    // (3) supersede 된 생산자(결과 revision member 아님)
    expect(
      replanIssues(
        journal,
        [id("anchor"), id("prodSkip"), id("prodNote")],
        [consumerDraft("consumer", "text", { taskId: id("prodDone") }, "text")],
      ),
    ).toContainEqual({
      kind: "binding_producer_not_member",
      draftRef: "consumer",
      field: "text",
      ref: { taskId: id("prodDone") },
    });
    // (4) 건너뛰기로 종결된 보존 생산자
    expect(
      replanIssues(journal, keepAll, [
        consumerDraft("consumer", "text", { taskId: id("prodSkip") }, "text"),
      ]),
    ).toContainEqual({
      kind: "binding_producer_without_output",
      draftRef: "consumer",
      field: "text",
      reason: "skipped",
    });
    // (5) 선택 출력 없이 완료된 보존 생산자
    expect(
      replanIssues(journal, keepAll, [
        draft("consumer", {
          inputBindings: {
            note: { from: "task", task: { taskId: id("prodNote") }, output: "note" },
          },
          dependsOn: [{ taskId: id("prodNote") }],
        }),
      ]),
    ).toContainEqual({
      kind: "binding_producer_without_output",
      draftRef: "consumer",
      field: "note",
      reason: "output_absent",
    });
    // 대조: 같은 재계획에서 출력이 있는 보존 생산자 결합은 커밋된다.
    const valid = committedCommit(
      commitPlanOn(
        journal.deps,
        journal.aggregate,
        planInput([consumerDraft("consumer", "text", { taskId: id("prodDone") }, "text")], {
          basePlanRevision: journal.aggregate.work.planRevision,
          retain: keepAll,
        }),
      ),
    );
    expect(eventTypes(valid.commit)).toContain("work_plan_committed");
  });

  it("Edge: 안전 관련 입력 필드를 채우는 결합은 직접 커밋·제안·grant 재검증 모두 binding_safety_field 다 (test_SC037_binding_to_safety_field_invalid_on_all_paths)", () => {
    const toNotification = (field: "target" | "message", input: Record<string, unknown>) => [
      draft("producer", { type: PRODUCER }),
      draft("notify", {
        type: NOTIFICATION_TYPE,
        input,
        inputBindings: { [field]: fromTask("producer", "text") },
        dependsOn: [{ draftRef: "producer" }],
      }),
    ];
    const SAFETY = { kind: "binding_safety_field", draftRef: "notify", field: "target" };
    const toTarget = toNotification("target", { message: "hello", importance: "normal" });
    // 직접 커밋
    expect(firstPlanIssues(bindingDeps("sc037s1"), toTarget)).toContainEqual(SAFETY);
    // 제안
    const proposed = committedCommit(
      executeCommand(bindingDeps("sc037s2"), planningAggregate(), {
        kind: "propose_plan",
        expectedRevision: planningAggregate().work.revision,
        meta: meta(NOW),
        plan: planInput(toTarget),
        summary: "safety binding",
      }),
    );
    expect(eventTypes(proposed.commit)).toEqual(["work_plan_invalid"]);
    expect(payloadOf(proposed.commit, "work_plan_invalid")["issues"]).toContainEqual(SAFETY);
    // 대조: 같은 생산 출력을 안전 관련이 아닌 message 에 결합하면 커밋된다.
    expect(
      firstPlanIssues(
        bindingDeps("sc037s3"),
        toNotification("message", { target: "owner", importance: "normal" }),
      ),
    ).toEqual([]);

    // grant 재검증: 제안 뒤 등록부가 결합 필드를 안전 관련으로 선언하면 grant 가 철회·낡음이 된다.
    const consumerPlan = planInput([
      draft("producer", { type: PRODUCER }),
      consumerDraft("consumer", "text", { draftRef: "producer" }, "text"),
    ]);
    const waiting = committedCommit(
      executeCommand(bindingDeps("sc037s4"), planningAggregate(), {
        kind: "propose_plan",
        expectedRevision: planningAggregate().work.revision,
        meta: meta(NOW),
        plan: consumerPlan,
        summary: "binding grant",
      }),
    ).aggregate;
    expect(waiting.work.state).toBe("WAITING_APPROVAL");
    const drifted = planDecision(new Journal(safetyDriftDeps("sc037s5"), waiting, []), "grant");
    expect(drifted.kind).toBe("rejected_stale");
    const chain = committedChain(drifted);
    expect(chain.map(eventTypes)).toEqual([["work_plan_withdrawn"], ["signal_rejected_stale"]]);
    const [withdrawal] = chain;
    if (withdrawal === undefined) throw new Error("expected withdrawal commit");
    expect(payloadOf(withdrawal, "work_plan_withdrawn")["issues"]).toContainEqual({
      kind: "binding_safety_field",
      draftRef: "consumer",
      field: "text",
    });
    // 대조: 원래 등록부면 같은 grant 가 커밋된다.
    expect(planDecision(new Journal(bindingDeps("sc037s6"), waiting, []), "grant").kind).toBe(
      "accepted",
    );
  });

  it("Error: occurrence 필드 결합과 직접 값 겹침이 각각 이름 이슈이고 Task 가 커밋되지 않는다 (test_SC037_occurrence_and_overlap_bindings_invalid)", () => {
    expect(
      firstPlanIssues(
        bindingDeps("sc037c1"),
        summaryAndNotification({
          inputBindings: { message: { from: "occurrence", field: "signal" } },
        }),
      ),
    ).toContainEqual({
      kind: "binding_occurrence_unavailable",
      draftRef: "notify",
      field: "message",
    });
    expect(
      firstPlanIssues(
        bindingDeps("sc037c2"),
        summaryAndNotification({
          input: { target: "owner", importance: "normal", message: "direct" },
        }),
      ),
    ).toContainEqual({ kind: "binding_overlaps_input", draftRef: "notify", field: "message" });
  });
});

describe("SC-038: 호환성을 증명하지 못하는 결합은 무효다", () => {
  function issuesFor(seed: string, field: string, output: string) {
    return firstPlanIssues(bindingDeps(seed), [
      draft("producer", { type: PRODUCER }),
      consumerDraft("consumer", field, { draftRef: "producer" }, output),
    ]);
  }
  const NOT_PROVABLE = (field: string) => ({
    kind: "binding_schema_incompatible",
    draftRef: "consumer",
    field,
    reason: "not_provable",
  });

  it("Happy: 소비자 필드의 정규식 검사(문자열 형식)는 증명 불가다 (test_SC038_consumer_regex_not_provable)", () => {
    expect(issuesFor("sc038a", "coded", "text")).toContainEqual(NOT_PROVABLE("coded"));
    // 대조: 같은 생산 출력을 형식 검사 없는 문자열 필드에 결합하면 증명된다.
    expect(issuesFor("sc038a2", "text", "text")).toEqual([]);
  });

  it("Edge: 생산자 출력의 transform(pipe)은 증명 불가다 (test_SC038_producer_transform_not_provable)", () => {
    expect(issuesFor("sc038b", "text", "stamp")).toContainEqual(NOT_PROVABLE("text"));
  });

  it("Error: 소비자 측 배타 union(JSON oneOf)은 증명 불가다 (test_SC038_consumer_exclusive_union_not_provable)", () => {
    expect(issuesFor("sc038c", "either", "text")).toContainEqual(NOT_PROVABLE("either"));
  });

  const proves = (producer: z.ZodType, consumer: z.ZodType) =>
    proveSchemaSubset(shapeOf(producer, "producer"), shapeOf(consumer, "consumer"));

  it("Edge: 생산자 intersection 은 한 part 가 맞아도 증명 불가다 — 그 파싱 출력을 소비자가 거절한다 (test_SC038_producer_intersection_not_provable)", () => {
    const producer = z.intersection(
      z.strictObject({ a: z.string() }),
      z.strictObject({ b: z.string() }),
    );
    const consumer = z.strictObject({ a: z.string() });
    const produced = producer.safeParse({ a: "x", b: "y" });
    expect(produced.success).toBe(true);
    if (!produced.success) return;
    expect(produced.data).toEqual({ a: "x", b: "y" });
    expect(consumer.safeParse(produced.data).success).toBe(false);
    expect(proves(producer, consumer)).toBe(false);
    // 대조: 생산자 strip 객체는 파싱 출력에서 모르는 키를 버리므로 소비자 strict 객체로 증명된다.
    const strip = z.object({ a: z.string() });
    const stripped = strip.safeParse({ a: "x", b: "y" });
    expect(stripped.success && consumer.safeParse(stripped.data).success).toBe(true);
    expect(proves(strip, consumer)).toBe(true);
  });

  it("Edge: 숫자 값 enum 소비자의 값 집합은 zod 와 같아 역매핑 이름 literal 은 증명 불가, 숫자 literal 은 증명된다 (test_SC038_consumer_numeric_enum_values_match_zod)", () => {
    const consumer = z.enum({ A: 0, B: 1, "0": "A", "1": "B" });
    expect(consumer.safeParse("A").success).toBe(false);
    expect(consumer.safeParse(0).success).toBe(true);
    expect(proves(z.literal("A"), consumer)).toBe(false);
    expect(proves(z.literal(0), consumer)).toBe(true);
    // 대조: 숫자 값이 없는 enum 객체는 이름이 아니라 값 문자열로 증명된다.
    const named = z.enum({ First: "A", Second: "B" });
    expect(named.safeParse("A").success).toBe(true);
    expect(proves(z.literal("A"), named)).toBe(true);
  });

  it("Edge: 사용자 when·abort 를 단 검사는 양측에서 증명 불가다 — 꺼진 when 의 생산자 길이 검사는 짧은 값을 통과시킨다 (test_SC038_conditional_or_aborting_checks_not_provable)", () => {
    // zod 는 검사 정의의 when 을 런타임에 받지만 공개 매개변수 타입에는 없다.
    const checkParams = (params: { when?: () => boolean; abort?: boolean }) =>
      params as { abort?: boolean };
    const producer = z.string().min(5, checkParams({ when: () => false }));
    const consumer = z.string().min(5);
    expect(producer.safeParse("ab").success).toBe(true);
    expect(consumer.safeParse("ab").success).toBe(false);
    expect(proves(producer, consumer)).toBe(false);
    const OPAQUE = { k: "opaque" };
    for (const schema of [
      z.number().gt(1, checkParams({ when: () => true })),
      z.string().min(5, { abort: true }),
      producer,
    ])
      for (const side of ["producer", "consumer"] as const)
        expect(shapeOf(schema, side), side).toEqual(OPAQUE);
    // 대조: 통제 필드가 없거나 zod 기본값인 검사는 판독된다.
    expect(proves(z.string().min(5), consumer)).toBe(true);
    for (const side of ["producer", "consumer"] as const)
      expect(shapeOf(z.number().int(), side), side).toMatchObject({ k: "number", int: true });
    const fromJsonSchema = parseDataSchema({ type: "string", minLength: 1 });
    expect(fromJsonSchema.ok).toBe(true);
    if (fromJsonSchema.ok) expect(proves(fromJsonSchema.value, z.string().min(1))).toBe(true);
  });

  it("Edge: 소비자 exactOptional 필드는 증명 불가다 — 생산자 optional 의 undefined 값 키를 소비자가 거절한다 (test_SC038_consumer_exact_optional_not_provable)", () => {
    const producer = z.strictObject({ k: z.string().optional() });
    const consumer = z.strictObject({ k: z.string().exactOptional() });
    const produced = producer.safeParse({ k: undefined });
    expect(produced.success).toBe(true);
    if (!produced.success) return;
    expect(Object.hasOwn(produced.data, "k")).toBe(true);
    expect(consumer.safeParse(produced.data).success).toBe(false);
    expect(proves(producer, consumer)).toBe(false);
    // 대조: 소비자 optional 이면 증명되고, 생산자 exactOptional 은 소비자 optional 로 증명된다.
    expect(proves(producer, z.strictObject({ k: z.string().optional() }))).toBe(true);
    expect(
      proves(
        z.strictObject({ k: z.string().exactOptional() }),
        z.strictObject({ k: z.string().optional() }),
      ),
    ).toBe(true);
  });

  /** 자기 열거 속성 하나를 더한 모양 — `__proto__` 는 객체 리터럴로 두면 프로토타입이 바뀌므로 정의로 둔다. */
  function withOwnKey(
    shape: Readonly<Record<string, z.ZodType>>,
    key: string,
    field: z.ZodType,
  ): Record<string, z.ZodType> {
    const out: Record<string, z.ZodType> = { ...shape };
    Object.defineProperty(out, key, {
      value: field,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return out;
  }

  /** probe_consumer@1 의 다른 판 — 객체 입력 필드 `record` 모양에 선택 속성 `key` 를 더한다(같은 ID). */
  function recordConsumerType(key: string): TaskTypeDescriptor {
    return {
      ...PROBE_CONSUMER_TASK_TYPE,
      schema: z.strictObject({
        text: z.string().min(1),
        record: z
          .strictObject(
            withOwnKey({ a: z.string(), k: z.string().optional() }, key, z.string().optional()),
          )
          .optional(),
      }),
    };
  }

  it("Edge: 소비자 객체 모양의 상속 멤버 이름 키는 증명 불가다 — 기록 값의 상속 멤버를 소비자가 값으로 검사한다 (test_SC038_consumer_inherited_member_key_not_provable)", () => {
    const producer = z.strictObject({ a: z.string() });
    const recordedOf = (schema: z.ZodType, value: unknown): unknown =>
      JSON.parse(JSON.stringify(schema.parse(value))) as unknown;
    const recorded = recordedOf(producer, { a: "x" });
    const optionalString = z.string().optional();

    const protoShape = withOwnKey({ a: z.string() }, "__proto__", optionalString);
    expect(Object.keys(protoShape)).toEqual(["a", "__proto__"]);
    const rejecting: readonly [string, z.ZodType, z.ZodType, unknown][] = [
      [
        "toString",
        producer,
        z.strictObject(withOwnKey({ a: z.string() }, "toString", optionalString)),
        recorded,
      ],
      ["__proto__", producer, z.strictObject(protoShape), recorded],
      [
        "nested valueOf",
        z.strictObject({ o: producer }),
        z.strictObject({
          o: z.strictObject(withOwnKey({ a: z.string() }, "valueOf", optionalString)),
        }),
        recordedOf(z.strictObject({ o: producer }), { o: { a: "x" } }),
      ],
    ];
    for (const [name, from, to, value] of rejecting) {
      expect(to.safeParse(value).success, name).toBe(false);
      expect(proves(from, to), name).toBe(false);
    }

    const constructorKey = z.strictObject(
      withOwnKey({ a: z.string() }, "constructor", z.unknown().optional()),
    );
    const accepted = constructorKey.safeParse(recorded);
    expect(accepted.success).toBe(true);
    if (accepted.success) {
      expect(Object.hasOwn(accepted.data, "constructor")).toBe(true);
      expect(typeof (accepted.data as Record<string, unknown>)["constructor"]).toBe("function");
    }
    expect(proves(producer, constructorKey)).toBe(false);

    // 대조: 같은 모양에서 키 이름만 상속 멤버가 아니면 증명되고 소비자가 기록 값을 받는다.
    const renamed = z.strictObject(withOwnKey({ a: z.string() }, "toStr", optionalString));
    expect(renamed.safeParse(recorded).success).toBe(true);
    expect(proves(producer, renamed)).toBe(true);
    // 대조: 생산자 측에만 상속 멤버 이름 속성이 있으면 판독이 유지된다.
    const inheritedProducer = z.strictObject(
      withOwnKey({ a: z.string() }, "toString", optionalString),
    );
    expect(shapeOf(inheritedProducer, "producer")).toMatchObject({ k: "object" });
    expect(proves(inheritedProducer, z.object({ a: z.string() }))).toBe(true);

    // 계획 경로: 객체 출력을 상속 멤버 이름 키가 있는 소비자 객체 필드에 결합하면 계획 무효다.
    const planIssues = (seed: string, key: string) =>
      firstPlanIssues(
        testDeps(
          seed,
          testRegistries({ taskTypes: [PROBE_OBJECT_OUTPUT_TASK_TYPE, recordConsumerType(key)] }),
        ),
        [
          draft("producer", {
            type: {
              id: PROBE_OBJECT_OUTPUT_TASK_TYPE.id,
              version: PROBE_OBJECT_OUTPUT_TASK_TYPE.version,
            },
          }),
          draft("consumer", {
            type: CONSUMER,
            input: { text: "direct" },
            inputBindings: { record: fromTask("producer", "record") },
            dependsOn: [{ draftRef: "producer" }],
          }),
        ],
      );
    expect(planIssues("sc038h3a", "toString")).toContainEqual(NOT_PROVABLE("record"));
    expect(planIssues("sc038h3b", "toStr")).toEqual([]);
  });

  it("Error: 객체 수준 검사를 단 입력 스키마의 TaskType 은 등록이 거절되고, 필드 수준 검사·검사 없는 스키마·내장 유형은 등록된다 (test_SC038_task_type_input_schema_with_object_level_check_refused_at_registration)", () => {
    const fields = { subject: z.string().min(1) };
    const refusal = {
      ok: false,
      error: {
        kind: "descriptor_invalid",
        axis: "task_type",
        id: "probe_extension",
        version: 1,
        defect: { code: "schema_has_object_check" },
      },
    };
    const refined = z.strictObject(fields).refine(() => true);
    const objectLevel: readonly [string, TaskTypeDescriptor["schema"]][] = [
      ["refine", refined],
      ["superRefine", z.strictObject(fields).superRefine(() => undefined)],
      ["check", z.strictObject(fields).check(() => undefined)],
      ["overwrite", z.strictObject(fields).overwrite((value) => value)],
    ];
    for (const [name, schema] of objectLevel) {
      expect(schema instanceof z.ZodObject, name).toBe(true);
      expect(createTaskTypeRegistry([probeTaskType({ schema })]), name).toEqual(refusal);
    }
    expect(
      createDomainRegistries({
        taskTypes: [...BUILTIN_TASK_TYPES, probeTaskType({ schema: refined })],
        triggers: BUILTIN_TRIGGERS,
        reactions: BUILTIN_REACTIONS,
      }),
    ).toEqual(refusal);

    // zod 4 의 instanceof 는 `_zod.traits` 덕 타이핑이다 — 정의 없이 ZodObject 로 판정되는 위장 객체(다른 생성 경로 대용).
    const lookalike = {};
    Object.defineProperty(lookalike, "_zod", {
      value: { traits: new Set(["ZodType", "$ZodType", "ZodObject", "$ZodObject"]) },
      enumerable: false,
    });
    expect(lookalike instanceof z.ZodObject).toBe(true);
    expect(
      createTaskTypeRegistry([
        probeTaskType({ schema: lookalike as unknown as TaskTypeDescriptor["schema"] }),
      ]),
    ).toEqual(refusal);

    // 대조: 객체 수준 검사만 뺀 같은 스키마와 필드 수준 refine 은 등록되고, 내장 등록부가 구성된다.
    expect(createTaskTypeRegistry([probeTaskType({ schema: z.strictObject(fields) })]).ok).toBe(
      true,
    );
    expect(
      createTaskTypeRegistry([
        probeTaskType({
          schema: z.strictObject({
            subject: z
              .string()
              .min(1)
              .refine(() => true),
          }),
        }),
      ]).ok,
    ).toBe(true);
    expect(
      createDomainRegistries({
        taskTypes: BUILTIN_TASK_TYPES,
        triggers: BUILTIN_TRIGGERS,
        reactions: BUILTIN_REACTIONS,
      }).ok,
    ).toBe(true);
  });
});

describe("SC-039: 결합이 채울 필드는 누락 입력이 아니다", () => {
  const PROMPT_TYPE = probeOverridePromptTaskType();
  const registries = testRegistries({ taskTypes: [PROMPT_TYPE] });
  const declaration = (input: Record<string, unknown>, bindings?: Record<string, unknown>) => ({
    type: { id: PROMPT_TYPE.id, version: PROMPT_TYPE.version },
    input,
    trigger: { kind: "immediate", version: 1, triggerId: "t" },
    policy: basePolicy(),
    ...(bindings !== undefined ? { inputBindings: bindings } : {}),
  });
  const BINDING = { first: { from: "task", task: { draftRef: "p" }, output: "text" } };

  function requestedFields(result: ReturnType<typeof validateTask>): string[] {
    return result.exit === "input_requested" ? result.requests.map((r) => r.field) : [];
  }

  it("Happy: 결합 필드 + 빈 필수 필드면 빈 필드만 요청한다 (test_SC039_bound_field_not_requested)", () => {
    const result = validateTask(registries, declaration({}, BINDING));
    expect(result.exit).toBe("input_requested");
    expect(requestedFields(result)).toEqual(["second"]);
  });

  it("Edge: 결합이 유일한 빈 필수 필드를 채우면 valid 다 (test_SC039_only_bound_required_fields_valid)", () => {
    expect(validateTask(registries, declaration({ second: "value" }, BINDING)).exit).toBe("valid");
  });

  it("Error: 결합 없는 같은 입력은 두 필드를 모두 요청한다(대조) (test_SC039_without_binding_both_requested)", () => {
    expect(requestedFields(validateTask(registries, declaration({})))).toEqual(["first", "second"]);
    expect(validateTask(registries, declaration({ second: "value" })).exit).toBe("input_requested");
  });
});

/** 요약 Task 완료 → 결합 알림 Task(재시도 정책)를 둔 Work. */
function summaryThenNotification(
  seed: string,
  redact?: DomainDeps["redactOutputs"],
  notificationPolicy?: Partial<TaskPolicy>,
) {
  const deps = bindingDeps(seed, redact);
  const { journal, ids } = startJournal(
    summaryAndNotification(
      notificationPolicy !== undefined ? { policy: basePolicy(notificationPolicy) } : undefined,
    ),
    deps,
  );
  const summary = ids["summary"] as TaskId;
  const notify = ids["notify"] as TaskId;
  validate(journal, summary);
  validate(journal, notify);
  return { journal, summary, notify };
}

describe("SC-047: 결합은 첫 attempt 에서 한 번 해석·기록되고 재사용된다", () => {
  it("Happy: 첫 task_started 에만 boundInputs(결과 ID·digest)가 있고 셋째 시작까지 재해석이 없다 (test_SC047_bindings_resolved_once_on_first_start)", () => {
    const { journal, summary, notify } = summaryThenNotification("sc047a");
    start(journal, summary);
    complete(journal, summary, { summary: "Weekly report ready" });
    const result = journal.task(summary).result;
    if (result === undefined) throw new Error("expected summary result");
    const first = start(journal, notify);
    const expected = [
      {
        field: "message",
        binding: { from: "task", task: { taskId: summary }, output: "summary" },
        resultId: result.id,
        digest: independentDigest("Weekly report ready"),
      },
    ];
    expect(taskPayload(first, notify, "task_started")["boundInputs"]).toEqual(expected);
    expect(journal.task(notify).boundInputs).toEqual(expected);
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      fail(journal, notify);
      journal.apply(taskCommand(journal.deps, journal.aggregate, notify, { kind: "retry_ready" }));
      const again = start(journal, notify);
      expect(taskPayload(again, notify, "task_started")).not.toHaveProperty("boundInputs");
      expect(taskPayload(again, notify, "task_started")["attemptNo"]).toBe(attempt);
      expect(journal.task(notify).boundInputs).toEqual(expected);
    }
    expect(journal.task(summary).lastAttemptNo).toBe(1);
    expect(journal.task(summary).result).toEqual(result);
  });

  it("Edge: 확인 Task 소비자는 첫 task_waiting_confirmation 에 기록된다 (test_SC047_confirmation_consumer_resolved_on_first_wait)", () => {
    const deps = bindingDeps("sc047b");
    const { journal, ids } = startJournal(
      [
        agentGoalDraft("summary"),
        draft("confirm", {
          type: CONFIRMATION_TYPE,
          input: { targetActor: CONFIRMATION_INPUT.targetActor, allowedDecisions: ["accept"] },
          inputBindings: { prompt: fromTask("summary", "summary") },
          dependsOn: [{ draftRef: "summary" }],
        }),
      ],
      deps,
    );
    const summary = ids["summary"] as TaskId;
    const confirm = ids["confirm"] as TaskId;
    runToCompleted(journal, summary, { summary: "Ship it?" });
    validate(journal, confirm);
    const waiting = beginConfirmation(journal, confirm);
    expect(taskPayload(waiting, confirm, "task_waiting_confirmation")["boundInputs"]).toEqual([
      {
        field: "prompt",
        binding: { from: "task", task: { taskId: summary }, output: "summary" },
        resultId: journal.task(summary).result?.id,
        digest: independentDigest("Ship it?"),
      },
    ]);
  });

  it("Error: 생산자 결과가 없을 때 시작은 binding_unresolved 로 거절된다 (test_SC047_start_refused_when_producer_result_missing)", () => {
    const { journal, summary, notify } = summaryThenNotification("sc047c");
    const refused = taskCommand(journal.deps, journal.aggregate, notify, { kind: "start_attempt" });
    expect(refused.kind).toBe("rejected");
    if (refused.kind === "rejected") {
      expect(refused.rejection.reason).toBe("condition_not_met");
      expect(refused.rejection.detail).toBe("binding_unresolved");
    }
    expect(committedChain(refused)).toEqual([]);
    // 대조: 생산자 결과가 기록되면 같은 시작이 수용된다.
    runToCompleted(journal, summary, { summary: "Now ready" });
    expect(
      taskCommand(journal.deps, journal.aggregate, notify, { kind: "start_attempt" }).kind,
    ).toBe("committed");
  });

  it("Error: 결합 커밋 뒤 등록부가 결합 필드를 안전 관련으로 선언하면 첫 시작이 binding_safety_field 로 거절된다 (test_SC047_start_refused_when_bound_field_became_safety_relevant)", () => {
    const { journal, ids } = startJournal(
      [
        draft("producer", { type: PRODUCER }),
        consumerDraft("consumer", "text", { draftRef: "producer" }, "text"),
      ],
      bindingDeps("sc047s"),
    );
    const producer = ids["producer"] as TaskId;
    const consumer = ids["consumer"] as TaskId;
    runToCompleted(journal, producer, { text: "produced", stamp: "s" });
    validate(journal, consumer);
    expect(journal.task(consumer).state).toBe("READY");
    // 등록부 drift 대용: 같은 유형·판의 안전 필드 선언만 바뀐 등록부로 판정한다.
    const refused = taskCommand(safetyDriftDeps("sc047s2"), journal.aggregate, consumer, {
      kind: "start_attempt",
    });
    expect(refused.kind).toBe("rejected");
    if (refused.kind === "rejected") {
      expect(refused.rejection.reason).toBe("condition_not_met");
      expect(refused.rejection.detail).toBe("binding_safety_field");
    }
    expect(committedChain(refused)).toEqual([]);
    // 대조: 원래 등록부면 같은 시작이 결합을 해석해 커밋된다.
    const started = journal.apply(
      taskCommand(journal.deps, journal.aggregate, consumer, { kind: "start_attempt" }),
    );
    expect(taskPayload(started, consumer, "task_started")["boundInputs"]).toEqual([
      expect.objectContaining({ field: "text", digest: independentDigest("produced") }),
    ]);
  });

  it("Edge: 실행 전 승인 주차는 결합을 해석하지 않고, 승인 뒤 첫 효과에서 해석한다 (test_SC047_approval_park_path_does_not_resolve)", () => {
    const { journal, summary, notify } = summaryThenNotification("sc047d", undefined, {
      approvalRequiredBeforeExecute: true,
    });
    // 생산자 결과가 없어도 검증 출구의 승인 주차는 거절되지 않고 해석 기록이 없다.
    expect(journal.task(notify).state).toBe("BLOCKED_AWAITING_HUMAN");
    expect(journal.task(notify).boundInputs).toBeUndefined();
    runToCompleted(journal, summary, { summary: "Approved summary" });
    journal.apply(grantTaskDecision(journal, notify));
    expect(journal.task(notify).state).toBe("READY");
    const first = start(journal, notify);
    expect(taskPayload(first, notify, "task_started")["boundInputs"]).toEqual([
      expect.objectContaining({ field: "message", digest: independentDigest("Approved summary") }),
    ]);
  });

  it("Error: 해석 값이 소비자 필드 스키마를 어기면 증명 결함으로 DomainInvariantError 다 (test_SC047_resolved_value_rechecked_against_consumer_schema)", () => {
    const { journal, summary, notify } = summaryThenNotification("sc047e");
    runToCompleted(journal, summary, { summary: "fine" });
    // 레코드 패치: 계획 검증이 막는 결합(자유 문자열 출력 → 열거 입력)을 다른 생성 경로 대용으로 재현한다.
    const patched = patchTask(journal.aggregate, notify, {
      input: { target: "owner" },
      inputBindings: {
        importance: { from: "task", task: { taskId: summary }, output: "summary" },
        message: { from: "task", task: { taskId: summary }, output: "summary" },
      },
    });
    expect(() => taskCommand(journal.deps, patched, notify, { kind: "start_attempt" })).toThrow(
      DomainInvariantError,
    );
    // 대조: 원래 결합(문자열 출력)은 같은 시작이 커밋된다.
    expect(
      taskCommand(journal.deps, journal.aggregate, notify, { kind: "start_attempt" }).kind,
    ).toBe("committed");
  });
});

/** 생산자(probe_producer)와 소비자(의존 충족 Trigger)를 둔 Work. `bound` 면 소비자가 생산자 출력에 결합한다. */
function dependencyPair(
  seed: string,
  options: { bound: boolean; output?: "text" | "note"; validateConsumer?: boolean },
) {
  const output = options.output ?? "text";
  // text 는 probe_consumer 의 필수 필드로, note 는 형식 검사 없는 generic_task 의 선택 필드로 받는다.
  const consumerShape: Partial<PlanTaskDraft> =
    output === "text"
      ? { type: CONSUMER, input: options.bound ? {} : { text: "direct" } }
      : { input: {} };
  const consumer = draft("consumer", {
    ...consumerShape,
    dependsOn: [{ draftRef: "producer" }],
    trigger: dependencyTrigger("consumer"),
    ...(options.bound ? { inputBindings: { [output]: fromTask("producer", output) } } : {}),
  });
  const { journal, ids } = startJournal(
    [draft("producer", { type: PRODUCER }), consumer, draft("anchor")],
    bindingDeps(seed),
  );
  const producer = ids["producer"] as TaskId;
  const consumerId = ids["consumer"] as TaskId;
  validate(journal, producer);
  validate(journal, ids["anchor"] as TaskId);
  if (options.validateConsumer ?? true) validate(journal, consumerId);
  return { journal, producer, consumer: consumerId };
}

describe("SC-048: 결합된 출력이 없는 생산자 종결은 의존 불충족이다", () => {
  it("Happy: 건너뛴 생산자에 결합한 소비자는 불충족 정책(block)대로 라우팅되고 발화하지 않는다 (test_SC048_skipped_bound_producer_routes_consumer)", () => {
    const { journal, producer, consumer } = dependencyPair("sc048a", { bound: true });
    expect(journal.task(consumer).state).toBe("READY");
    const commit = skip(journal, producer);
    expect(taskEventTypes(commit, consumer)).toEqual(["task_blocked"]);
    expect(taskPayload(commit, consumer, "task_blocked")["blockReason"]).toEqual({
      kind: "dependency_unsatisfied",
      dependencyTaskIds: [producer],
    });
    expect(journal.task(consumer).state).toBe("BLOCKED");
  });

  it("Edge: 선택 출력 없이 완료한 생산자의 그 출력에 결합한 소비자도 같다 (test_SC048_absent_optional_output_routes_consumer)", () => {
    const { journal, producer, consumer } = dependencyPair("sc048b", {
      bound: true,
      output: "note",
    });
    start(journal, producer);
    const commit = complete(journal, producer, { text: "t", stamp: "s" });
    expect(taskEventTypes(commit, consumer)).toEqual(["task_blocked"]);
    expect(taskEventTypes(commit, consumer)).not.toContain("task_scheduled");
    // 대조: 같은 결합에 선택 출력이 있으면 의존 완료로 발화한다.
    const withNote = dependencyPair("sc048b2", { bound: true, output: "note" });
    start(withNote.journal, withNote.producer);
    const fired = complete(withNote.journal, withNote.producer, {
      text: "t",
      stamp: "s",
      note: "n",
    });
    expect(taskEventTypes(fired, withNote.consumer)).toEqual(["task_scheduled"]);
  });

  it("Error: 생산자가 이미 그렇게 종결된 뒤 검증되는 소비자는 검증 커밋에서 라우팅된다 (test_SC048_already_terminal_producer_routes_at_validation)", () => {
    const { journal, producer, consumer } = dependencyPair("sc048c", {
      bound: true,
      validateConsumer: false,
    });
    const skipCommit = skip(journal, producer);
    expect(taskEventTypes(skipCommit, consumer)).toEqual([]);
    expect(journal.task(consumer).state).toBe("DRAFT");
    const validation = journal.apply(
      taskCommand(journal.deps, journal.aggregate, consumer, { kind: "begin_validation" }),
    );
    expect(taskEventTypes(validation, consumer)).toEqual([
      "task_validation_started",
      "task_blocked",
    ]);
  });
});

describe("SC-049: 결합 없는 의존은 데이터를 넘기지 않고 기존 충족 규칙을 따른다", () => {
  it("Happy: 결합 없이 의존만 하는 소비자는 건너뛴 생산자로도 충족돼 발화한다 (test_SC049_unbound_dependency_on_skipped_producer_satisfied)", () => {
    const { journal, producer, consumer } = dependencyPair("sc049a", { bound: false });
    const commit = skip(journal, producer);
    expect(taskEventTypes(commit, consumer)).toEqual(["task_scheduled"]);
    expect(taskPayload(commit, consumer, "task_scheduled")["cause"]).toBe(
      "dependency_satisfaction",
    );
  });

  it("Edge: 결합 없는 소비자의 해석 기록은 빈 목록이다 (test_SC049_unbound_consumer_records_empty_bound_inputs)", () => {
    const { journal, ids } = startJournal(
      [draft("producer"), draft("consumer", { dependsOn: [{ draftRef: "producer" }] })],
      bindingDeps("sc049b"),
    );
    const consumer = ids["consumer"] as TaskId;
    runToCompleted(journal, ids["producer"] as TaskId);
    validate(journal, consumer);
    const first = start(journal, consumer);
    expect(taskPayload(first, consumer, "task_started")["boundInputs"]).toEqual([]);
    expect(journal.task(consumer).boundInputs).toEqual([]);
  });

  it("Error: 같은 구성에 결합을 더하면 건너뛴 생산자가 불충족이 된다(대조) (test_SC049_adding_binding_makes_skipped_producer_unsatisfying)", () => {
    const unbound = dependencyPair("sc049c1", { bound: false });
    const bound = dependencyPair("sc049c2", { bound: true });
    expect(taskEventTypes(skip(unbound.journal, unbound.producer), unbound.consumer)).toEqual([
      "task_scheduled",
    ]);
    expect(taskEventTypes(skip(bound.journal, bound.producer), bound.consumer)).toEqual([
      "task_blocked",
    ]);
  });
});

describe("SC-050: 결합은 기록된 값만 넘기고 digest 는 기록된 값 위에서 계산된다", () => {
  const MASKED = "[masked]";
  const maskSummary: DomainDeps["redactOutputs"] = (outputs) =>
    Object.hasOwn(outputs, "summary") ? { ...outputs, summary: MASKED } : outputs;

  function resolvedAfterMasking(seed: string) {
    const { journal, summary, notify } = summaryThenNotification(seed, maskSummary);
    start(journal, summary);
    complete(journal, summary, { summary: "token=abc123" });
    const first = start(journal, notify);
    return { journal, summary, notify, first };
  }

  it("Happy: 결합 해석이 가리키는 결과의 기록 출력이 마스킹 뒤 값이다 (test_SC050_bound_value_equals_recorded_output)", () => {
    const { journal, summary, notify } = resolvedAfterMasking("sc050a");
    const result = journal.task(summary).result;
    expect(result?.outputs).toEqual({ summary: MASKED });
    const [bound] = journal.task(notify).boundInputs ?? [];
    expect(bound?.resultId).toBe(result?.id);
    expect(bound?.digest).toBe(independentDigest(result?.outputs["summary"]));
  });

  it("Edge: 결합 digest 가 기록 값의 독립 정규 JSON sha256 이고 원래 값의 것이 아니다 (test_SC050_binding_digest_equals_independent_sha256)", () => {
    const { notify, first } = resolvedAfterMasking("sc050b");
    const [bound] = taskPayload(first, notify, "task_started")["boundInputs"] as readonly {
      digest: string;
    }[];
    expect(bound?.digest).toBe(independentDigest(MASKED));
    expect(bound?.digest).not.toBe(independentDigest("token=abc123"));
  });

  it("Error: 결과 digest 는 마스킹 주입 값 기준 기록 출력의 정규 JSON sha256 이다 (test_SC050_result_digest_over_redacted_outputs)", () => {
    const { journal, summary } = resolvedAfterMasking("sc050c");
    const result = journal.task(summary).result;
    expect(result?.digest).toBe(independentDigest({ summary: MASKED }));
    expect(result?.digest).not.toBe(independentDigest({ summary: "token=abc123" }));
  });

  it("Error: 마스킹 주입이 없거나 객체가 아닌 값을 돌려주면 결과를 기록하지 않고 DomainInvariantError 다 (test_SC050_missing_or_invalid_redactor_throws_without_result)", () => {
    for (const [index, redact] of [undefined, () => "masked" as never].entries()) {
      const base = bindingDeps(`sc050d${index}`);
      const deps: DomainDeps =
        redact === undefined
          ? {
              ids: base.ids,
              operationalDefaults: base.operationalDefaults,
              registries: base.registries,
            }
          : { ...base, redactOutputs: redact };
      const { journal, ids } = startJournal(summaryAndNotification(), deps);
      const summary = ids["summary"] as TaskId;
      validate(journal, summary);
      start(journal, summary);
      const attemptId = journal.task(summary).openAttempt?.attemptId;
      if (attemptId === undefined) throw new Error("expected open attempt");
      expect(() =>
        taskCommand(journal.deps, journal.aggregate, summary, {
          kind: "record_attempt_outcome",
          attemptId,
          outcome: { kind: "completed", evidence: {}, outputs: { summary: "secret" } },
        }),
      ).toThrow(DomainInvariantError);
      expect(journal.task(summary).result).toBeUndefined();
    }
  });
});
