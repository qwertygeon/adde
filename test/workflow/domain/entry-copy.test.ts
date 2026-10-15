// 공개 진입 사본 — 명령·신호·결정 적용 입력은 진입에서 정규 JSON 동결 사본 하나로 떠지고, 판정·기록은 그 사본만 읽는다.
// 사본을 뜰 수 없는 값은 커밋 없이 거절되고, 완료 보고의 outputs·evidence 만 따로 떠서 실패 attempt 로 바뀐다.
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  ACTOR_SOURCES,
  CANCEL_ORIGIN_KINDS,
  DomainInvariantError,
  PENDING_DECISION_KINDS,
  TASK_COMMAND_ROWS,
  TASK_NON_ROW_COMMANDS,
  WORK_COMMAND_ROWS,
  canonicalJson,
  createWork,
  deriveSignalDedupKey,
  executeCommand,
  isEngineCommit,
  judgeDefinitionSignal,
  judgeSignal,
  judgeTaskExternalSignal,
  nextEntityId,
  parseProjectId,
} from "../../../src/workflow/domain/index.js";
import type {
  CommandOutcome,
  DecisionSignal,
  DefinitionControlSignal,
  DomainCommit,
  DomainDeps,
  ExternalSignal,
  PendingDecision,
  TaskCommand,
  TaskId,
  TaskPolicy,
  TaskTypeDescriptor,
  TriggerSpec,
  UtcInstant,
  WorkAggregate,
  WorkCommand,
} from "../../../src/workflow/domain/index.js";
import {
  at,
  deadLetterDecision,
  draft,
  meta,
  mustOk,
  planInput,
  reachTaskState,
  reachWorkState,
  requireTaskFor,
  taskSubjectPendingDecision,
  testDeps,
} from "./helpers/fixtures.js";
import { GENERIC_TASK_TYPE, testRegistries } from "./helpers/registry-fixtures.js";
import {
  FIXTURE_SIGNAL_NAME,
  FIXTURE_SIGNAL_SOURCE,
  controlSignal,
  definitionDeps,
  externalSignal,
  registerDefinition,
} from "./helpers/definition-fixtures.js";
import { eventTypes, payloadOf } from "./helpers/commits.js";
import { start, startJournal, validate } from "./helpers/scenario.js";

const NOW = at("2026-01-01T00:00:00Z");
const INVALID: CommandOutcome = { kind: "rejected", rejection: { reason: "invalid_input" } };
const NOT_APPLICABLE_INVALID = { kind: "not_applicable", rejection: { reason: "invalid_input" } };

type Fixture = {
  readonly deps: DomainDeps;
  readonly aggregate: WorkAggregate;
  readonly taskId: TaskId;
};
type Payload = Record<string, unknown>;

/** 컨테이너 n 겹 — 가장 안쪽 `{leaf: 1}` 이 n 번째 컨테이너다. */
function nest(n: number): Payload {
  let value: Payload = { leaf: 1 };
  for (let i = 1; i < n; i += 1) value = { a: value };
  return value;
}

function invalidWith(detail: string): CommandOutcome {
  return { kind: "rejected", rejection: { reason: "invalid_input", detail } };
}

/** Task 명령 — 형 검사를 거치지 않은 호출자 값을 그대로 넘긴다. 기본 meta·revision 은 현재 레코드. */
function onTask(f: Fixture, body: Payload): CommandOutcome {
  return executeCommand(f.deps, f.aggregate, {
    taskId: f.taskId,
    expectedRevision: requireTaskFor(f.aggregate, f.taskId).revision,
    meta: meta(NOW),
    ...body,
  } as unknown as TaskCommand);
}

function onWork(deps: DomainDeps, aggregate: WorkAggregate, body: Payload): CommandOutcome {
  return executeCommand(deps, aggregate, {
    expectedRevision: aggregate.work.revision,
    meta: meta(NOW),
    ...body,
  } as unknown as WorkCommand);
}

function committed(outcome: CommandOutcome): { commit: DomainCommit; aggregate: WorkAggregate } {
  if (outcome.kind !== "committed")
    throw new Error(`expected committed, got ${JSON.stringify(outcome)}`);
  return { commit: outcome.commit, aggregate: outcome.aggregate };
}

/** 읽을 때마다 다음 값을 내는 열거 가능 접근자를 단다. 호출 수를 센다. */
function withAccessor(target: Payload, key: string, values: readonly unknown[]): () => number {
  let calls = 0;
  Object.defineProperty(target, key, {
    get: () => {
      const value = values[Math.min(calls, values.length - 1)];
      calls += 1;
      return value;
    },
    enumerable: true,
    configurable: true,
  });
  return () => calls;
}

function isDeepFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

function running(policy?: Partial<TaskPolicy>): Fixture & { attemptId: string } {
  const f = reachTaskState("RUNNING", policy !== undefined ? { policy } : {});
  const attemptId = requireTaskFor(f.aggregate, f.taskId).openAttempt?.attemptId;
  if (attemptId === undefined) throw new Error("expected open attempt");
  return { ...f, attemptId };
}

function report(f: Fixture & { attemptId: string }, outcome: unknown, extra: Payload = {}) {
  return onTask(f, { kind: "record_attempt_outcome", attemptId: f.attemptId, outcome, ...extra });
}

const RETRY_ON_VIOLATION: Partial<TaskPolicy> = {
  retry: {
    maxAttempts: 3,
    initialDelayMs: 1_000,
    maxDelayMs: 60_000,
    backoff: "fixed",
    retryableErrors: ["output_schema_violation"],
  },
};

const NO_RETRY_ON_VIOLATION: Partial<TaskPolicy> = {
  retry: {
    maxAttempts: 1,
    initialDelayMs: 1_000,
    maxDelayMs: 1_000,
    backoff: "fixed",
    retryableErrors: ["output_schema_violation"],
  },
};

/** 실패 attempt 의 시도 결과(task_retry_wait.outcome 또는 task_failed.reason.outcome). */
function failedOutcome(commit: DomainCommit): Payload {
  if (eventTypes(commit).includes("task_retry_wait"))
    return payloadOf(commit, "task_retry_wait")["outcome"] as Payload;
  const reason = payloadOf(commit, "task_failed")["reason"] as Payload;
  return reason["outcome"] as Payload;
}

const LISTENER: TriggerSpec = {
  kind: "signal",
  version: 1,
  triggerId: "listener",
  sourceId: FIXTURE_SIGNAL_SOURCE,
  signal: FIXTURE_SIGNAL_NAME,
} as TriggerSpec;

/** 출력 data 가 임의 JSON 값인 시험 유형 — 출력 깊이 경계가 선언 검사에 걸리지 않게 한다. */
const DEEP_OUTPUT_TYPE: TaskTypeDescriptor = {
  ...GENERIC_TASK_TYPE,
  id: "probe_deep_output",
  version: 1,
  outputs: { data: z.unknown() },
};

function deepOutputRunning(seed: string): Fixture & { attemptId: string } {
  const deps = testDeps(seed, testRegistries({ taskTypes: [DEEP_OUTPUT_TYPE] }));
  const { journal, ids } = startJournal(
    [draft("t", { type: { id: DEEP_OUTPUT_TYPE.id, version: DEEP_OUTPUT_TYPE.version } })],
    deps,
  );
  const taskId = ids["t"] as TaskId;
  validate(journal, taskId);
  start(journal, taskId);
  const attemptId = journal.task(taskId).openAttempt?.attemptId;
  if (attemptId === undefined) throw new Error("expected open attempt");
  return { deps: journal.deps, aggregate: journal.aggregate, taskId, attemptId };
}

describe("SC-001: 진입 뒤 호출자 값을 바꿔도 커밋된 값은 진입 시점 값이다", () => {
  it("Happy: 사후 변경된 결정 객체 — pendingDecision 은 진입 값이고 다른 참조이며 깊게 동결된다 (test_SC001_park_decision_mutated_after_entry_unchanged)", () => {
    const f = reachTaskState("READY");
    const decision = { ...taskSubjectPendingDecision(f.deps, f.taskId, NOW) } as Payload;
    const snapshot = structuredClone(decision);
    const { commit } = committed(
      onTask(f, { kind: "park_awaiting_human", cause: "unattended_eligibility_refused", decision }),
    );
    decision["summary"] = "changed after entry";
    (decision["surfaceDeliveries"] as unknown[]).push("late");
    const recorded = payloadOf(commit, "task_awaiting_human")["pendingDecision"];
    expect(recorded).toEqual(snapshot);
    expect(recorded).not.toBe(decision);
    expect(isDeepFrozen(recorded)).toBe(true);
  });

  it("Edge: 사후 변경된 취소 출처 — 커밋 origin 은 바뀌지 않고 공유되지 않는다 (test_SC001_cancel_origin_mutated_after_entry_unchanged)", () => {
    const f = reachTaskState("READY");
    const origin: Payload = {
      kind: "vault_signal",
      actorSource: "human_local",
      signalId: nextEntityId(f.deps.ids, "signal"),
    };
    const entryValue = { ...origin };
    const { commit } = committed(
      onTask(f, { kind: "cancel_task", origin, meta: meta(NOW, "human_local") }),
    );
    origin["signalId"] = "sig_mutatedlater1";
    const recorded = payloadOf(commit, "task_canceled")["origin"];
    expect(recorded).toEqual(entryValue);
    expect(recorded).not.toBe(origin);
  });

  it("Error: 함수 필드를 가진 결정은 사본 실패로 커밋 없이 거절된다 (test_SC001_function_in_decision_rejected)", () => {
    const f = reachTaskState("READY");
    const decision = { ...taskSubjectPendingDecision(f.deps, f.taskId, NOW), note: () => "x" };
    expect(
      onTask(f, { kind: "park_awaiting_human", cause: "unattended_eligibility_refused", decision }),
    ).toEqual(INVALID);
  });

  it("Edge: 커밋되는 대기 결정은 파싱 결과라 모르는 키가 없고 시각이 정규 표기다 (test_SC001_parsed_pending_decision_committed)", () => {
    const f = reachTaskState("READY");
    const decision = {
      ...taskSubjectPendingDecision(f.deps, f.taskId, NOW),
      note: "dropped",
      requestedAt: "2026-03-01T00:00:00Z",
    };
    const { commit, aggregate } = committed(
      onTask(f, { kind: "park_awaiting_human", cause: "unattended_eligibility_refused", decision }),
    );
    const recorded = payloadOf(commit, "task_awaiting_human")["pendingDecision"] as Payload;
    expect(recorded).not.toHaveProperty("note");
    expect(recorded["requestedAt"]).toBe("2026-03-01T00:00:00.000Z");
    expect(requireTaskFor(aggregate, f.taskId).pendingDecision?.requestedAt).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });
});

describe("SC-002: 접근자 값은 진입에서 한 번만 관측된다", () => {
  it("Happy: 번갈아 내는 actorSource 접근자 — 검사·커밋 값이 같고 접근자는 한 번 불린다 (test_SC002_alternating_actor_source_observed_once)", () => {
    const f = reachTaskState("READY");
    const origin: Payload = { kind: "vault_signal", signalId: nextEntityId(f.deps.ids, "signal") };
    const calls = withAccessor(origin, "actorSource", ["human_local", "unknown", "human_local"]);
    const { commit } = committed(
      onTask(f, { kind: "cancel_task", origin, meta: meta(NOW, "human_local") }),
    );
    expect((payloadOf(commit, "task_canceled")["origin"] as Payload)["actorSource"]).toBe(
      "human_local",
    );
    expect(calls()).toBe(1);
  });

  it("Edge: 제어 요청 출처 접근자가 처음 unknown 이면 그 값으로 커밋되고 한 번 불린다 (test_SC002_control_request_accessor_observed_once)", () => {
    const f = reachTaskState("READY");
    const origin: Payload = {
      kind: "control_request",
      controlRequestId: nextEntityId(f.deps.ids, "controlRequest"),
      keyId: "fixture-key",
    };
    const calls = withAccessor(origin, "actorSource", ["unknown", "human_local"]);
    const { commit } = committed(
      onTask(f, { kind: "cancel_task", origin, meta: meta(NOW, "unknown") }),
    );
    expect((payloadOf(commit, "task_canceled")["origin"] as Payload)["actorSource"]).toBe(
      "unknown",
    );
    expect(calls()).toBe(1);
  });

  it("Error: 첫 관측값이 meta 출처와 다르면 커밋 없이 거절되고 접근자는 한 번 불린다 (test_SC002_first_observation_mismatch_rejected)", () => {
    const f = reachTaskState("READY");
    const origin: Payload = { kind: "vault_signal", signalId: nextEntityId(f.deps.ids, "signal") };
    const calls = withAccessor(origin, "actorSource", ["unknown", "human_local"]);
    const outcome = onTask(f, { kind: "cancel_task", origin, meta: meta(NOW, "human_local") });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.rejection.reason).toBe("invalid_input");
    expect(outcome.record).toBeUndefined();
    expect(calls()).toBe(1);
  });
});

describe("SC-003: 신호 진입도 사본 하나로 후보 키와 기록을 만든다", () => {
  function confirmationSignal(f: Fixture, overrides: Payload): DecisionSignal {
    const task = requireTaskFor(f.aggregate, f.taskId);
    const signal: Payload = {
      type: "confirmation_decision",
      taskId: f.taskId,
      confirmationId: task.confirmationId,
      decision: "reject",
      signalId: nextEntityId(f.deps.ids, "signal"),
      actorSource: "human_local",
      receivedAt: NOW,
      ...overrides,
    };
    return signal as unknown as DecisionSignal;
  }

  function keyFor(f: Fixture, revision: number): string {
    const task = requireTaskFor(f.aggregate, f.taskId);
    return mustOk(
      deriveSignalDedupKey({
        signalType: "confirmation_decision",
        confirmationId: task.confirmationId as never,
        expectedRevision: revision,
        decision: "reject",
      }),
    );
  }

  it("Happy: 판정 중 바뀌는 expectedRevision — 후보 키·기록이 진입 값 하나로 만들어진다 (test_SC003_changing_expected_revision_single_value)", () => {
    const f = reachTaskState("WAITING_CONFIRMATION");
    const revision = requireTaskFor(f.aggregate, f.taskId).revision;
    const signal = confirmationSignal(f, {}) as unknown as Payload;
    const calls = withAccessor(signal, "expectedRevision", [revision, revision + 5, revision + 9]);
    const judged = judgeSignal(
      f.deps,
      f.aggregate,
      signal as unknown as DecisionSignal,
      { kind: "none" },
      NOW,
    );
    expect(judged.kind).toBe("accepted");
    if (judged.kind !== "accepted") return;
    expect(judged.dedupKey).toBe(keyFor(f, revision));
    expect(payloadOf(judged.commit, "signal_accepted")["dedupKey"]).toBe(keyFor(f, revision));
    expect(calls()).toBe(1);
  });

  it("Edge: 사람 아닌 출처 + 바뀌는 revision — 기록 candidateKey 가 첫 관측값의 키다 (test_SC003_forged_provenance_record_uses_entry_value)", () => {
    const f = reachTaskState("WAITING_CONFIRMATION");
    const signal = confirmationSignal(f, { actorSource: "unknown" }) as unknown as Payload;
    const calls = withAccessor(signal, "expectedRevision", [41, 42, 43]);
    const judged = judgeSignal(
      f.deps,
      f.aggregate,
      signal as unknown as DecisionSignal,
      { kind: "none" },
      NOW,
    );
    expect(judged.kind).toBe("forged_provenance");
    if (judged.kind !== "forged_provenance") return;
    expect(
      payloadOf(judged.commit, "confirmation_rejected_forged_provenance")["candidateKey"],
    ).toBe(keyFor(f, 41));
    expect(calls()).toBe(1);
  });

  it("Error: NaN 을 담은 신호는 사본 실패로 not_applicable invalid_input 이다 (test_SC003_non_json_signal_not_applicable)", () => {
    const f = reachTaskState("WAITING_CONFIRMATION");
    const signal = confirmationSignal(f, { expectedRevision: Number.NaN });
    expect(judgeSignal(f.deps, f.aggregate, signal, { kind: "none" }, NOW)).toEqual(
      NOT_APPLICABLE_INVALID,
    );
  });

  it("Edge: 값이 undefined 인 subject.taskId 는 없는 키라 Work 주체 취소로 수용된다 (test_SC003_undefined_task_subject_key_cancels_work)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const signal = {
      type: "cancel_requested",
      subject: { taskId: undefined, workId: aggregate.work.id },
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: aggregate.work.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    } as unknown as DecisionSignal;
    const judged = judgeSignal(deps, aggregate, signal, { kind: "none" }, NOW);
    expect(judged.kind).toBe("accepted");
    if (judged.kind !== "accepted") return;
    expect(eventTypes(judged.commit)).toContain("work_canceled");
    expect(judged.aggregate.work.state).toBe("CANCELED");
  });

  it("Edge: 신호 진입 시각은 정규 표기로 기록된다 (test_SC003_signal_now_normalized_in_record)", () => {
    const f = reachTaskState("WAITING_CONFIRMATION");
    const signal = confirmationSignal(f, { actorSource: "unknown" });
    const raw = "2026-03-01T00:00:00Z" as UtcInstant;
    const judged = judgeSignal(f.deps, f.aggregate, signal, { kind: "none" }, raw);
    expect(judged.kind).toBe("forged_provenance");
    if (judged.kind !== "forged_provenance") return;
    expect(judged.commit.events.map((e) => e.occurredAt)).toEqual(["2026-03-01T00:00:00.000Z"]);
  });
});

describe("SC-004: Work 생성은 검사한 사본의 출처를 커밋한다", () => {
  function createWith(deps: DomainDeps, source: unknown): CommandOutcome {
    return createWork(deps, {
      kind: "create_work",
      meta: meta(NOW),
      projectId: mustOk(parseProjectId("prj_entrycopy004")),
      title: "entry copy",
      objective: "entry copy",
      source: source as never,
    });
  }

  it("Happy: 검사 뒤 definition_occurrence 로 바뀌는 접근자 — 커밋 출처는 markdown 이다 (test_SC004_source_kind_switch_records_checked_value)", () => {
    const source: Payload = { documentId: "doc-entry" };
    const calls = withAccessor(source, "kind", ["markdown", "definition_occurrence"]);
    const { commit, aggregate } = committed(createWith(testDeps("ec004h"), source));
    expect((payloadOf(commit, "work_created")["source"] as Payload)["kind"]).toBe("markdown");
    expect(aggregate.work.source.kind).toBe("markdown");
    expect(calls()).toBe(1);
  });

  it("Edge: 처음부터 definition_occurrence 면 기존 상세로 거절된다 (test_SC004_initial_definition_occurrence_rejected)", () => {
    const source: Payload = { documentId: "doc-entry" };
    withAccessor(source, "kind", ["definition_occurrence", "markdown"]);
    expect(createWith(testDeps("ec004e"), source)).toEqual(
      invalidWith("definition_occurrence_by_materialization_only"),
    );
  });

  it("Error: source 가 객체가 아니면 커밋 없이 거절된다 (test_SC004_non_object_source_rejected)", () => {
    expect(createWith(testDeps("ec004r"), null)).toEqual(invalidWith("work_source_malformed"));
  });
});

describe("SC-005: 정규 JSON 이 아닌 명령은 커밋 없이 invalid_input 이다", () => {
  class Probe {
    readonly x = 1;
  }

  function beginValidation(f: Fixture, overrides: Payload): CommandOutcome {
    return onTask(f, { kind: "begin_validation", ...overrides });
  }

  it("Happy: 함수·NaN·순환·클래스 인스턴스 필드는 넷 모두 거절된다 (test_SC005_function_nan_cycle_instance_rejected)", () => {
    const f = reachTaskState("DRAFT");
    const cyclic: Payload = { kind: "user" };
    cyclic["self"] = cyclic;
    const cases: readonly Payload[] = [
      { meta: { ...meta(NOW), actor: () => "x" } },
      { expectedRevision: Number.NaN },
      { meta: { ...meta(NOW), actor: cyclic } },
      { meta: { ...meta(NOW), actor: new Probe() } },
    ];
    for (const [index, overrides] of cases.entries())
      expect(beginValidation(f, overrides), String(index)).toEqual(INVALID);
  });

  it("Edge: 배열 안 undefined 와 깊이 65 는 거절된다 (test_SC005_undefined_in_array_and_too_deep_rejected)", () => {
    const f = reachTaskState("DRAFT");
    expect(beginValidation(f, { meta: { ...meta(NOW), actor: { ids: [undefined] } } })).toEqual(
      INVALID,
    );
    expect(beginValidation(f, { meta: { ...meta(NOW), actor: nest(63) } })).toEqual(INVALID);
  });

  it("Error: 대조 — 같은 명령의 JSON 값은 판정된다 (test_SC005_json_command_judged)", () => {
    const f = reachTaskState("DRAFT");
    const { aggregate } = committed(beginValidation(f, { meta: { ...meta(NOW), actor: nest(4) } }));
    expect(requireTaskFor(aggregate, f.taskId).state).toBe("VALIDATING");
  });

  it("Edge: 값이 undefined 인 decision 키는 없는 키라 deadLetterDecision 으로 주차한다 (test_SC005_undefined_decision_key_parks_with_dead_letter_decision)", () => {
    const f = running();
    const decision: PendingDecision = deadLetterDecision(f.deps, f.taskId, NOW);
    const { aggregate } = committed(
      report(f, {
        kind: "effect_dead_lettered",
        decision: undefined,
        deadLetterDecision: decision,
      }),
    );
    const task = requireTaskFor(aggregate, f.taskId);
    expect(task.state).toBe("BLOCKED_AWAITING_HUMAN");
    expect(task.pendingDecision).toEqual(decision);
  });

  it("Edge: 명령 진입 시각은 정규 표기로 envelope 에 실린다 (test_SC005_meta_now_normalized_in_envelope)", () => {
    for (const [raw, expected] of [
      ["2026-03-01T00:00:00Z", "2026-03-01T00:00:00.000Z"],
      ["2026-03-01T00:00:00.5Z", "2026-03-01T00:00:00.500Z"],
    ] as const) {
      const f = reachTaskState("DRAFT");
      const { commit } = committed(
        beginValidation(f, { meta: { now: raw, actorSource: "adde_self" } }),
      );
      expect(
        commit.events.map((e) => e.occurredAt),
        raw,
      ).toEqual(commit.events.map(() => expected));
    }
  });

  it("Edge: plan 아래 컨테이너 64 단은 진입을 통과하고 65 단은 커밋 없이 거절된다 (test_SC005_plan_depth_boundary_64_accepted_65_rejected)", () => {
    // plan(1)·tasks(2)·초안(3) 아래 input 이 나머지 단을 채운다.
    const propose = (inputContainers: number) => {
      const { deps, aggregate } = reachWorkState("PLANNING");
      return onWork(deps, aggregate, {
        kind: "propose_plan",
        plan: planInput([draft("deep", { input: nest(inputContainers) })]),
        summary: "depth boundary",
      });
    };
    const accepted = propose(61);
    expect(accepted.kind).toBe("committed");
    if (accepted.kind === "committed")
      expect(eventTypes(accepted.commit)).toContain("work_plan_invalid");
    expect(propose(62)).toEqual(INVALID);
  });

  it("Edge: 진입 검사가 읽는 공개 상수 표는 동결돼 있고 표 밖 출처 명령은 여전히 거절된다 (test_SC005_entry_constant_tables_frozen)", () => {
    const tables: readonly (readonly [string, unknown])[] = [
      ["ACTOR_SOURCES", ACTOR_SOURCES],
      ["CANCEL_ORIGIN_KINDS", CANCEL_ORIGIN_KINDS],
      ["PENDING_DECISION_KINDS", PENDING_DECISION_KINDS],
      ["TASK_NON_ROW_COMMANDS", TASK_NON_ROW_COMMANDS],
      ["TASK_COMMAND_ROWS", TASK_COMMAND_ROWS],
      ["WORK_COMMAND_ROWS", WORK_COMMAND_ROWS],
      ...Object.entries(TASK_COMMAND_ROWS).map(
        ([k, rows]) => [`TASK_COMMAND_ROWS.${k}`, rows] as const,
      ),
      ...Object.entries(WORK_COMMAND_ROWS).map(
        ([k, rows]) => [`WORK_COMMAND_ROWS.${k}`, rows] as const,
      ),
    ];
    for (const [name, table] of tables) expect(Object.isFrozen(table), name).toBe(true);
    for (const table of [
      ACTOR_SOURCES,
      CANCEL_ORIGIN_KINDS,
      PENDING_DECISION_KINDS,
      TASK_NON_ROW_COMMANDS,
    ])
      expect(() => (table as unknown as unknown[]).push("robot")).toThrow(TypeError);
    expect(() => {
      (TASK_COMMAND_ROWS as unknown as Record<string, unknown>)["robot"] = [];
    }).toThrow(TypeError);
    expect(ACTOR_SOURCES).not.toContain("robot");
    const f = reachTaskState("DRAFT");
    expect(
      onTask(f, { kind: "begin_validation", meta: { now: NOW, actorSource: "robot" } }),
    ).toEqual(INVALID);
  });
});

describe("SC-006: 정규 JSON 이 아닌 신호는 기록 없이 not_applicable invalid_input 이다", () => {
  function controlWith(seed: string, overrides: Payload) {
    const r = registerDefinition(definitionDeps(seed));
    const signal = {
      ...controlSignal(r.journal.deps, {
        definitionId: r.definitionId,
        expectedRevision: r.journal.definition(r.definitionId).revision,
        action: "pause",
      }),
      ...overrides,
    } as DefinitionControlSignal;
    return judgeDefinitionSignal(r.journal.deps, r.state, signal, NOW);
  }

  it("Happy: 외톨이 surrogate signalId 의 정의 제어는 커밋 없이 거절된다 (test_SC006_lone_surrogate_control_signal_rejected)", () => {
    expect(controlWith("ec006h", { signalId: "a\uD800" })).toEqual(NOT_APPLICABLE_INVALID);
  });

  it("Edge: surrogate 쌍은 정상 문자열이라 판정된다 (test_SC006_surrogate_pair_judged)", () => {
    expect(controlWith("ec006e", { signalId: "a😀" }).kind).toBe("accepted");
  });

  it("Error: 사람 아닌 출처라도 사본 실패가 출처 거절 기록보다 먼저다 (test_SC006_copy_failure_precedes_provenance_record)", () => {
    expect(controlWith("ec006r", { signalId: "a\uD800", actorSource: "agent_session" })).toEqual(
      NOT_APPLICABLE_INVALID,
    );
    expect(controlWith("ec006c", { actorSource: "agent_session" }).kind).toBe("rejected");
  });

  it("Edge: Task 대상 외부 신호 payload 는 컨테이너 64 단까지 판정되고 65 단은 거절된다 (test_SC006_external_payload_depth_boundary)", () => {
    const judgeWith = (seed: string, containers: number) => {
      const { journal, ids } = startJournal(
        [draft("listener", { trigger: LISTENER })],
        testDeps(seed),
      );
      const taskId = ids["listener"] as TaskId;
      validate(journal, taskId);
      const signal: ExternalSignal = externalSignal(journal.deps, {
        subject: { taskId },
        sourceOccurrenceId: `src-${containers}`,
        payload: nest(containers),
        receivedAt: NOW,
      });
      return judgeTaskExternalSignal(journal.deps, journal.aggregate, signal, NOW);
    };
    expect(judgeWith("ec006p64", 64).kind).toBe("accepted");
    expect(judgeWith("ec006p65", 65)).toEqual(NOT_APPLICABLE_INVALID);
  });
});

describe("SC-007: fail_planning 의 무효 계획 이슈는 배열이어야 한다", () => {
  it("Happy: 배열이 아닌 issues 는 커밋 없이 거절된다 (test_SC007_non_array_invalid_plan_issues_rejected)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    expect(
      onWork(deps, aggregate, { kind: "fail_planning", invalidPlan: { issues: "x" } }),
    ).toEqual(invalidWith("invalid_plan_malformed"));
  });

  it("Edge: 객체가 아닌 invalidPlan 은 거절된다 (test_SC007_non_object_invalid_plan_rejected)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    expect(onWork(deps, aggregate, { kind: "fail_planning", invalidPlan: 3 })).toEqual(
      invalidWith("invalid_plan_malformed"),
    );
  });

  it("Error: 대조 — 배열 이슈와 invalidPlan 부재는 커밋된다 (test_SC007_array_issues_and_absent_invalid_plan_commit)", () => {
    const first = reachWorkState("PLANNING");
    const withIssues = committed(
      onWork(first.deps, first.aggregate, { kind: "fail_planning", invalidPlan: { issues: [] } }),
    );
    expect(eventTypes(withIssues.commit)).toEqual(["work_plan_invalid", "work_failed"]);
    const second = reachWorkState("PLANNING");
    const absent = committed(onWork(second.deps, second.aggregate, { kind: "fail_planning" }));
    expect(eventTypes(absent.commit)).toEqual(["work_failed"]);
  });
});

describe("SC-008: request_work_input 의 요청은 배열이어야 한다", () => {
  it("Happy: 배열이 아닌 requests 는 커밋 없이 거절된다 (test_SC008_non_array_requests_rejected)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    expect(onWork(deps, aggregate, { kind: "request_work_input", requests: {} })).toEqual(
      invalidWith("input_requests_not_array"),
    );
  });

  it("Edge: requests 가 없으면 거절된다 (test_SC008_missing_requests_rejected)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    expect(onWork(deps, aggregate, { kind: "request_work_input" })).toEqual(
      invalidWith("input_requests_not_array"),
    );
  });

  it("Error: 대조 — 빈 배열은 커밋된다 (test_SC008_empty_requests_commit)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const { aggregate: after } = committed(
      onWork(deps, aggregate, { kind: "request_work_input", requests: [] }),
    );
    expect(after.work.state).toBe("WAITING_INPUT");
  });
});

describe("SC-009: 주차·포기 원인은 계약 열거값이어야 한다", () => {
  function park(f: Fixture, cause: unknown, omitCause = false): CommandOutcome {
    return onTask(f, {
      kind: "park_awaiting_human",
      ...(omitCause ? {} : { cause }),
      decision: taskSubjectPendingDecision(f.deps, f.taskId, NOW),
    });
  }

  it("Happy: 열거 밖 cause 는 커밋 없이 거절된다 (test_SC009_out_of_enum_cause_rejected)", () => {
    expect(park(reachTaskState("READY"), "gate_denied")).toEqual(invalidWith("park_cause_invalid"));
  });

  it("Edge: cause 누락·비문자열은 거절된다 (test_SC009_missing_or_non_string_cause_rejected)", () => {
    expect(park(reachTaskState("READY"), undefined, true)).toEqual(
      invalidWith("park_cause_invalid"),
    );
    expect(park(reachTaskState("READY"), 1)).toEqual(invalidWith("park_cause_invalid"));
  });

  it("Error: 대조 — 계약 값은 커밋된다 (test_SC009_contract_cause_commits)", () => {
    const f = reachTaskState("READY");
    const { aggregate } = committed(park(f, "unattended_eligibility_refused"));
    expect(requireTaskFor(aggregate, f.taskId).state).toBe("BLOCKED_AWAITING_HUMAN");
  });

  it("Edge: 종결 Task 의 형 위반 주차는 엔진의 종결 기록이 먼저다 (test_SC009_terminal_task_malformed_park_records_terminal_subject)", () => {
    const outcome = park(reachTaskState("COMPLETED"), "gate_denied");
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.rejection).toEqual({ reason: "terminal_subject" });
    if (outcome.record === undefined) throw new Error("expected terminal record");
    expect(eventTypes(outcome.record)).toEqual(["stale_transition_rejected"]);
    expect(isEngineCommit(outcome.record)).toBe(true);
  });

  it("Error: abandon_retries 의 열거 밖 cause 는 거절된다 (test_SC009_abandon_cause_out_of_enum_rejected)", () => {
    const f = reachTaskState("RETRY_WAIT");
    expect(onTask(f, { kind: "abandon_retries", cause: "whatever" })).toEqual(
      invalidWith("abandon_cause_invalid"),
    );
  });

  it("Error: blocked 결과의 cause 가 프로토타입 이름이면 결정 종류 불일치로 거절된다 (test_SC009_blocked_cause_prototype_name_rejected)", () => {
    const f = running();
    expect(
      report(f, {
        kind: "blocked",
        cause: "toString",
        decision: taskSubjectPendingDecision(f.deps, f.taskId, NOW),
      }),
    ).toEqual(invalidWith("주차 원인과 결정 종류가 맞지 않음"));
  });
});

describe("SC-010: 커밋된 무효 계획 이슈는 호출자 배열과 공유되지 않는다", () => {
  it("Happy: 실행 뒤 호출자 이슈 배열에 원소를 더해도 커밋 이슈는 진입 값이다 (test_SC010_issue_array_growth_unshared)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const issues: unknown[] = [{ kind: "draft_invalid", draftRef: "a" }];
    const { commit } = committed(
      onWork(deps, aggregate, { kind: "fail_planning", invalidPlan: { issues } }),
    );
    issues.push({ kind: "late" });
    expect(payloadOf(commit, "work_plan_invalid")["issues"]).toEqual([
      { kind: "draft_invalid", draftRef: "a" },
    ]);
  });

  it("Edge: 이슈 원소를 바꿔도 커밋 원소는 바뀌지 않고 동결돼 있다 (test_SC010_issue_element_mutation_unshared)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const element: Payload = { kind: "draft_invalid", draftRef: "a" };
    const { commit } = committed(
      onWork(deps, aggregate, { kind: "fail_planning", invalidPlan: { issues: [element] } }),
    );
    element["draftRef"] = "mutated";
    const [recorded] = payloadOf(commit, "work_plan_invalid")["issues"] as Payload[];
    expect(recorded).toEqual({ kind: "draft_invalid", draftRef: "a" });
    expect(Object.isFrozen(recorded)).toBe(true);
  });

  it("Error: 함수 이슈 원소는 사본 실패로 거절된다 (test_SC010_function_issue_rejected)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    expect(
      onWork(deps, aggregate, { kind: "fail_planning", invalidPlan: { issues: [() => "x"] } }),
    ).toEqual(INVALID);
  });
});

describe("SC-011: 정규 JSON 이 아닌 보고 출력은 실패 attempt 다", () => {
  it("Happy: 재시도가 남은 비JSON outputs 는 outputs_not_json 실패 attempt 로 RETRY_WAIT 다 (test_SC011_non_json_outputs_failed_attempt_retry_wait)", () => {
    const f = running(RETRY_ON_VIOLATION);
    const { commit, aggregate } = committed(
      report(f, { kind: "completed", evidence: {}, outputs: { summary: () => "x" } }),
    );
    expect(requireTaskFor(aggregate, f.taskId).state).toBe("RETRY_WAIT");
    const outcome = failedOutcome(commit);
    expect(outcome["code"]).toBe("output_schema_violation");
    expect(outcome["outputIssues"]).toEqual([
      { code: "outputs_not_json", reason: "unsupported_type", path: ["summary"] },
    ]);
    expect(eventTypes(commit)).not.toContain("task_completed");
  });

  it("Edge: 재시도가 소진되면 FAILED 다 (test_SC011_non_json_outputs_retry_exhausted_failed)", () => {
    const f = running(NO_RETRY_ON_VIOLATION);
    const { commit, aggregate } = committed(
      report(f, { kind: "completed", evidence: {}, outputs: { summary: () => "x" } }),
    );
    expect(requireTaskFor(aggregate, f.taskId).state).toBe("FAILED");
    expect(failedOutcome(commit)["code"]).toBe("output_schema_violation");
  });

  it("Error: 완료가 아닌 결과의 비JSON 필드는 커밋 없이 거절된다 (test_SC011_non_json_field_on_failed_outcome_rejected)", () => {
    const f = running(RETRY_ON_VIOLATION);
    expect(report(f, { kind: "failed", code: "fixture_retryable", outputs: () => "x" })).toEqual(
      INVALID,
    );
  });

  it("Error: 격리 경로 밖 비JSON 은 상세 없이 거절되고 Task 는 RUNNING 에 남는다 (test_SC011_non_isolated_non_json_keeps_running)", () => {
    const f = running(RETRY_ON_VIOLATION);
    expect(report(f, { kind: "completed", evidence: {}, jitterDrawMs: Number.NaN })).toEqual(
      INVALID,
    );
    expect(
      onTask(f, {
        kind: "record_attempt_outcome",
        attemptId: `${f.attemptId}\uD800`,
        outcome: { kind: "completed", evidence: {} },
      }),
    ).toEqual(INVALID);
    expect(requireTaskFor(f.aggregate, f.taskId).state).toBe("RUNNING");
  });

  it("Edge: outputs 컨테이너 64 단은 출력 검사로 완료되고 65 단은 too_deep 실패 attempt 다 (test_SC011_outputs_depth_boundary_64_completed_65_failed)", () => {
    // outputs(1) 아래 data 가 나머지 단을 채운다.
    const at64 = deepOutputRunning("ec011d64");
    const done = committed(
      report(at64, { kind: "completed", evidence: {}, outputs: { data: nest(63) } }),
    );
    expect(requireTaskFor(done.aggregate, at64.taskId).state).toBe("COMPLETED");
    const at65 = deepOutputRunning("ec011d65");
    const failed = committed(
      report(at65, { kind: "completed", evidence: {}, outputs: { data: nest(64) } }),
    );
    const [issue] = failedOutcome(failed.commit)["outputIssues"] as Payload[];
    expect(issue?.["code"]).toBe("outputs_not_json");
    expect(issue?.["reason"]).toBe("too_deep");
    expect(issue?.["path"]).toHaveLength(64);
  });
});

describe("SC-012: 정규 JSON 이 아닌 evidence 는 evidence_not_json 실패 attempt 다", () => {
  it("Happy: 순환 evidence 는 evidence_not_json{cycle} 실패 attempt 이고 Task 가 RUNNING 이 아니다 (test_SC012_cyclic_evidence_failed_attempt)", () => {
    const f = running();
    const e: Record<string, unknown> = {};
    e["self"] = e;
    const { commit, aggregate } = committed(report(f, { kind: "completed", evidence: e }));
    expect(requireTaskFor(aggregate, f.taskId).state).not.toBe("RUNNING");
    expect(failedOutcome(commit)["outputIssues"]).toEqual([
      { code: "evidence_not_json", reason: "cycle", path: ["self"] },
    ]);
  });

  it("Edge: outputs·evidence 가 둘 다 실패하면 이슈 둘이 출력 → evidence 순이다 (test_SC012_outputs_and_evidence_both_issues)", () => {
    const f = running();
    const { commit } = committed(
      report(f, { kind: "completed", evidence: () => "e", outputs: { summary: () => "o" } }),
    );
    expect(failedOutcome(commit)["outputIssues"]).toEqual([
      { code: "outputs_not_json", reason: "unsupported_type", path: ["summary"] },
      { code: "evidence_not_json", reason: "unsupported_type", path: [] },
    ]);
  });

  it("Error: evidence 외톨이 surrogate 키는 정규화된 경로로 기록되고 페이로드가 정규 JSON 이다 (test_SC012_evidence_lone_surrogate_key_path_well_formed)", () => {
    const f = running();
    const { commit } = committed(report(f, { kind: "completed", evidence: { "\uD800": 1 } }));
    expect(failedOutcome(commit)["outputIssues"]).toEqual([
      { code: "evidence_not_json", reason: "lone_surrogate", path: ["�"] },
    ]);
    expect(canonicalJson(commit.events.map((event) => event.payload)).ok).toBe(true);
  });

  it("Edge: 격리 실패가 있으면 마스킹 주입 불변식을 검사하지 않아 실패 attempt 다 (test_SC012_isolated_failure_skips_redactor_invariant)", () => {
    const f = running();
    const { redactOutputs: _dropped, ...withoutRedactor } = f.deps;
    void _dropped;
    const noRedactor = { ...f, deps: withoutRedactor as DomainDeps };
    const e: Record<string, unknown> = {};
    e["self"] = e;
    const { aggregate } = committed(report(noRedactor, { kind: "completed", evidence: e }));
    expect(requireTaskFor(aggregate, f.taskId).state).toBe("FAILED");
    // 대조: 출력을 기록하는 경로에서는 같은 주입 결함이 불변식 예외다.
    expect(() => report(noRedactor, { kind: "completed", evidence: {} })).toThrow(
      DomainInvariantError,
    );
  });
});

describe("SC-013: 사본에 성공한 evidence 는 그 사본이 task_completed 에 기록된다", () => {
  it("Happy: JSON evidence 는 진입 값으로 동결·비공유 기록된다 (test_SC013_evidence_frozen_copy)", () => {
    const f = running();
    const evidence = { notes: ["a"] };
    const { commit } = committed(report(f, { kind: "completed", evidence }));
    evidence.notes.push("b");
    const recorded = payloadOf(commit, "task_completed")["evidence"];
    expect(recorded).toEqual({ notes: ["a"] });
    expect(recorded).not.toBe(evidence);
    expect(isDeepFrozen(recorded)).toBe(true);
  });

  it("Edge: evidence 가 없으면 페이로드에 evidence 가 없다 (test_SC013_absent_evidence_omitted)", () => {
    const f = running();
    const { commit } = committed(report(f, { kind: "completed" }));
    expect(payloadOf(commit, "task_completed")).not.toHaveProperty("evidence");
  });

  it("Error: evidence 만 비JSON 이어도 완료가 아니라 실패 attempt 다 (test_SC013_evidence_only_failure_not_completed)", () => {
    const f = running();
    const { commit, aggregate } = committed(report(f, { kind: "completed", evidence: () => "x" }));
    expect(eventTypes(commit)).not.toContain("task_completed");
    expect(requireTaskFor(aggregate, f.taskId).state).not.toBe("COMPLETED");
    expect(failedOutcome(commit)["outputIssues"]).toEqual([
      { code: "evidence_not_json", reason: "unsupported_type", path: [] },
    ]);
  });
});
