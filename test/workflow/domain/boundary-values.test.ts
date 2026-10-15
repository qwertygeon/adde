// 경계 밖 값 — 후보 키·진단 문자열화, 출처 판정 전 키 파생, 신호 출처 열거, 외부 신호 subject 규칙.
import { describe, expect, it } from "vitest";
import {
  DomainInvariantError,
  deriveSignalDedupKey,
  evaluateFanOutConcurrency,
  judgeDefinitionSignal,
  judgeDelegationResponseStaleness,
  judgeSignal,
  judgeTaskExternalSignal,
  nextEntityId,
} from "../../../src/workflow/domain/index.js";
import type {
  DecisionSignal,
  DefinitionControlSignal,
  DelegationResponseSignal,
  DomainCommit,
  DomainDeps,
  ExternalSignal,
  RecurrenceExpander,
  SignalDedupInput,
  TaskId,
  TriggerSpec,
  UtcInstant,
  WorkAggregate,
  WorkDefinitionId,
} from "../../../src/workflow/domain/index.js";
import {
  FIXTURE_SIGNAL_NAME,
  FIXTURE_SIGNAL_SOURCE,
  WorkflowJournal,
  controlSignal,
  dayAt,
  definitionDeps,
  externalSignal,
  payloadsOf,
  registerDefinition,
  signalDefinitionDraft,
  testDailyRecurrence,
} from "./helpers/definition-fixtures.js";
import { at, draft, reachTaskState, requireTaskFor, testDeps } from "./helpers/fixtures.js";
import { startJournal, validate } from "./helpers/scenario.js";

const NOW = at("2026-01-01T00:00:00Z");
const TO_STRING_OBJECT = { toString: 1 };
const NOT_APPLICABLE_INVALID = { kind: "not_applicable", rejection: { reason: "invalid_input" } };
const HASH = "9f2c" + "0".repeat(60);
const OCCURRENCE = "occ_" + "A".repeat(26);

const LISTENER: TriggerSpec = {
  kind: "signal",
  version: 1,
  triggerId: "listener",
  sourceId: FIXTURE_SIGNAL_SOURCE,
  signal: FIXTURE_SIGNAL_NAME,
} as TriggerSpec;

function readyListener(seed: string): {
  deps: DomainDeps;
  aggregate: WorkAggregate;
  taskId: TaskId;
} {
  const { journal, ids } = startJournal([draft("listener", { trigger: LISTENER })], testDeps(seed));
  const taskId = ids["listener"] as TaskId;
  validate(journal, taskId);
  return { deps: journal.deps, aggregate: journal.aggregate, taskId };
}

function definitionControl(
  deps: DomainDeps,
  definitionId: WorkDefinitionId,
  expectedRevision: unknown,
  actorSource: unknown,
): DefinitionControlSignal {
  return {
    ...controlSignal(deps, { definitionId, expectedRevision: 0, action: "pause" }),
    expectedRevision: expectedRevision as number,
    actorSource: actorSource as DefinitionControlSignal["actorSource"],
  };
}

function cancelRequested(
  deps: DomainDeps,
  subject: unknown,
  expectedRevision: unknown,
  actorSource: unknown,
): DecisionSignal {
  return {
    type: "cancel_requested",
    subject: subject as { taskId: TaskId },
    signalId: nextEntityId(deps.ids, "signal"),
    expectedRevision: expectedRevision as number,
    actorSource: actorSource as "unknown",
    receivedAt: NOW,
  };
}

function confirmation(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  taskId: TaskId,
  overrides: Record<string, unknown>,
): DecisionSignal {
  const task = requireTaskFor(aggregate, taskId);
  return {
    type: "confirmation_decision",
    taskId,
    confirmationId: task.confirmationId as never,
    decision: "accept",
    signalId: nextEntityId(deps.ids, "signal"),
    expectedRevision: task.revision,
    actorSource: "unknown",
    receivedAt: NOW,
    ...overrides,
  } as DecisionSignal;
}

function recordOf(judged: { kind: string; commit?: DomainCommit }, type: string) {
  if (judged.commit === undefined) throw new Error(`expected a record commit, got ${judged.kind}`);
  const [payload] = payloadsOf(judged.commit, type);
  if (payload === undefined) throw new Error(`expected ${type} in record`);
  return payload;
}

/** 등록한 정의를 같은 상태·이력에서 다른 반복 포트로 해소하는 진행기. */
function withPort(seed: string, port: RecurrenceExpander) {
  const registered = registerDefinition(definitionDeps(seed));
  const journal = new WorkflowJournal(
    { ...registered.journal.deps, recurrence: port },
    registered.journal.state,
    registered.journal.commits,
  );
  return { journal, definitionId: registered.definitionId };
}

function portReturning(scheduledForUtc: unknown, recurrenceIndex: unknown): RecurrenceExpander {
  return {
    firstAtOrAfter: () =>
      ({ scheduledForUtc, recurrenceIndex }) as unknown as ReturnType<
        RecurrenceExpander["firstAtOrAfter"]
      >,
    periodOf: (activation: TriggerSpec, at: UtcInstant) =>
      testDailyRecurrence.periodOf(activation, at),
  };
}

describe("SC-036: 사람 아닌 정의 제어는 계약 밖 revision 에서도 출처 거절 기록으로 끝난다", () => {
  it("Happy: agent_session 출처 + {toString:1} revision 은 signal_rejected 기록이고 정의는 그대로다 (test_SC036_non_human_control_to_string_revision_recorded)", () => {
    const r = registerDefinition(definitionDeps("bv036h"));
    const before = r.journal.definition(r.definitionId);
    const signal = definitionControl(
      r.journal.deps,
      r.definitionId,
      TO_STRING_OBJECT,
      "agent_session",
    );
    const judged = judgeDefinitionSignal(r.journal.deps, r.state, signal, NOW);
    expect(judged.kind).toBe("rejected");
    if (judged.kind !== "rejected") return;
    expect(judged.reason).toBe("provenance_not_human");
    const recorded = recordOf(judged, "signal_rejected");
    expect(recorded["reason"]).toBe("provenance_not_human");
    expect(recorded["candidateKey"]).toBe(
      `definition_control:${r.definitionId}:{"toString":1}:pause`,
    );
    expect(judged.state.works[r.stewardId]?.definition).toEqual(before);
  });

  it("Edge: 배열·null·불리언 revision 도 같은 출처 거절 기록이다 (test_SC036_non_human_control_other_revisions_recorded)", () => {
    const r = registerDefinition(definitionDeps("bv036e"));
    for (const [revision, text] of [
      [[1, 2], "[1,2]"],
      [null, "null"],
      [true, "true"],
    ] as const) {
      const signal = definitionControl(r.journal.deps, r.definitionId, revision, "agent_session");
      const judged = judgeDefinitionSignal(r.journal.deps, r.state, signal, NOW);
      expect(judged.kind, text).toBe("rejected");
      expect(recordOf(judged, "signal_rejected")["candidateKey"], text).toBe(
        `definition_control:${r.definitionId}:${text}:pause`,
      );
    }
  });

  it("Error: 같은 신호를 두 번 판정하면 같은 기록 페이로드다 (test_SC036_repeat_same_record_payload)", () => {
    const r = registerDefinition(definitionDeps("bv036r"));
    const signal = definitionControl(
      r.journal.deps,
      r.definitionId,
      TO_STRING_OBJECT,
      "agent_session",
    );
    const first = judgeDefinitionSignal(r.journal.deps, r.state, signal, NOW);
    const second = judgeDefinitionSignal(r.journal.deps, r.state, signal, NOW);
    expect(recordOf(second, "signal_rejected")).toEqual(recordOf(first, "signal_rejected"));
  });

  it("Error: 정의 제어 신호 출처가 없거나 열거 밖이면 기록 없이 거절된다 (test_SC036_control_signal_actor_source_out_of_enum_rejected)", () => {
    const r = registerDefinition(definitionDeps("bv036x"));
    const base = controlSignal(r.journal.deps, {
      definitionId: r.definitionId,
      expectedRevision: r.journal.definition(r.definitionId).revision,
      action: "pause",
    });
    const { actorSource: _omitted, ...missing } = base;
    void _omitted;
    for (const signal of [missing, { ...base, actorSource: "robot" }]) {
      const judged = judgeDefinitionSignal(
        r.journal.deps,
        r.state,
        signal as DefinitionControlSignal,
        NOW,
      );
      expect(judged).toEqual(NOT_APPLICABLE_INVALID);
    }
  });
});

describe("SC-037: 사람 아닌 cancel_requested 는 계약 밖 revision 에서도 출처 거절 기록으로 끝난다", () => {
  it("Happy: unknown 출처 + {toString:1} revision 의 Task 취소 요청은 signal_rejected 기록이다 (test_SC037_non_human_cancel_request_recorded)", () => {
    const { deps, aggregate, taskId } = reachTaskState("READY");
    const judged = judgeSignal(
      deps,
      aggregate,
      cancelRequested(deps, { taskId }, TO_STRING_OBJECT, "unknown"),
      { kind: "none" },
      NOW,
    );
    expect(judged.kind).toBe("rejected");
    const recorded = recordOf(judged, "signal_rejected");
    expect(recorded["reason"]).toBe("provenance_not_human");
    expect(recorded["candidateKey"]).toBe(`cancel_requested:${taskId}:{"toString":1}`);
  });

  it("Edge: Work subject 도 같은 기록이다 (test_SC037_work_subject_recorded)", () => {
    const { deps, aggregate } = reachTaskState("READY");
    const judged = judgeSignal(
      deps,
      aggregate,
      cancelRequested(deps, { workId: aggregate.work.id }, TO_STRING_OBJECT, "unknown"),
      { kind: "none" },
      NOW,
    );
    expect(judged.kind).toBe("rejected");
    expect(recordOf(judged, "signal_rejected")["candidateKey"]).toBe(
      `cancel_requested:${aggregate.work.id}:{"toString":1}`,
    );
  });

  it("Error: 형식은 맞지만 없는 Task subject 는 기록 없이 unknown_subject 다 (test_SC037_unknown_task_subject_not_applicable)", () => {
    const { deps, aggregate } = reachTaskState("READY");
    const judged = judgeSignal(
      deps,
      aggregate,
      cancelRequested(deps, { taskId: "tsk_absentsubject1" }, TO_STRING_OBJECT, "unknown"),
      { kind: "none" },
      NOW,
    );
    expect(judged).toEqual({ kind: "not_applicable", rejection: { reason: "unknown_subject" } });
  });
});

describe("SC-038: 사람 아닌 확인 결정은 계약 밖 값에서도 위조 출처 기록으로 끝난다", () => {
  it("Happy: unknown 출처 + {toString:1} revision 은 confirmation_rejected_forged_provenance 기록이다 (test_SC038_non_human_confirmation_recorded)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const judged = judgeSignal(
      deps,
      aggregate,
      confirmation(deps, aggregate, taskId, { expectedRevision: TO_STRING_OBJECT }),
      { kind: "none" },
      NOW,
    );
    expect(judged.kind).toBe("forged_provenance");
    const recorded = recordOf(judged, "confirmation_rejected_forged_provenance");
    const confirmationId = requireTaskFor(aggregate, taskId).confirmationId;
    expect(recorded["candidateKey"]).toBe(
      `confirmation_decision:${confirmationId}:{"toString":1}:accept`,
    );
  });

  it("Edge: 객체 confirmationId 도 키 파생 예외 없이 같은 기록이다 (test_SC038_object_confirmation_id_recorded)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const judged = judgeSignal(
      deps,
      aggregate,
      confirmation(deps, aggregate, taskId, { confirmationId: { a: 1 } }),
      { kind: "none" },
      NOW,
    );
    expect(judged.kind).toBe("forged_provenance");
    const revision = requireTaskFor(aggregate, taskId).revision;
    expect(recordOf(judged, "confirmation_rejected_forged_provenance")["candidateKey"]).toBe(
      `confirmation_decision:{"a":1}:${revision}:accept`,
    );
  });

  it("Error: 열거 밖 decision 은 기록 없는 invalid_input 이다 (test_SC038_out_of_enum_decision_rejected)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const judged = judgeSignal(
      deps,
      aggregate,
      confirmation(deps, aggregate, taskId, { decision: "maybe" }),
      { kind: "none" },
      NOW,
    );
    expect(judged).toEqual(NOT_APPLICABLE_INVALID);
  });

  it("Error: 확인 결정 출처 열거 밖·위임 응답 출처 누락은 기록 없이 거절된다 (test_SC038_decision_and_delegation_actor_source_out_of_enum_rejected)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    expect(
      judgeSignal(
        deps,
        aggregate,
        confirmation(deps, aggregate, taskId, { actorSource: "robot" }),
        { kind: "none" },
        NOW,
      ),
    ).toEqual(NOT_APPLICABLE_INVALID);
    const delegation = {
      type: "delegation_response",
      signalId: nextEntityId(deps.ids, "signal"),
      taskId,
      expectedRevision: requireTaskFor(aggregate, taskId).revision,
      occurrenceId: OCCURRENCE,
      responseContentHash: HASH,
      receivedAt: NOW,
    } as unknown as DelegationResponseSignal;
    expect(judgeDelegationResponseStaleness(deps, aggregate, delegation, undefined, NOW)).toEqual(
      NOT_APPLICABLE_INVALID,
    );
    expect(
      judgeDelegationResponseStaleness(
        deps,
        aggregate,
        { ...delegation, actorSource: "human_local" },
        undefined,
        NOW,
      ).kind,
    ).toBe("staleness_passed");
  });
});

describe("SC-039: 신호 후보 키는 계약 형 입력에서 지금과 같은 글자다", () => {
  const derive = (input: Record<string, unknown>) =>
    deriveSignalDedupKey(input as unknown as SignalDedupInput);

  it("Happy: 신호 종류 9 개의 계약 형 입력 키가 템플릿 글자와 같다 (test_SC039_contract_form_keys_unchanged)", () => {
    const cases: readonly (readonly [Record<string, unknown>, string])[] = [
      [
        {
          signalType: "confirmation_decision",
          confirmationId: "cfm_x",
          expectedRevision: 3,
          decision: "accept",
        },
        "confirmation_decision:cfm_x:3:accept",
      ],
      [
        {
          signalType: "input_provided",
          subjectId: "tsk_x",
          questionId: "completionEvidence",
          answerContentHash: HASH,
        },
        "input_provided:tsk_x:completionEvidence:" + HASH,
      ],
      [
        { signalType: "cancel_requested", subjectId: "tsk_x", expectedRevision: 3 },
        "cancel_requested:tsk_x:3",
      ],
      [
        { signalType: "human_decision", decisionId: "dec_x", expectedRevision: 7, choice: "grant" },
        "human_decision:dec_x:7:grant",
      ],
      [
        {
          signalType: "delegation_response",
          taskId: "tsk_x",
          expectedRevision: 7,
          occurrenceId: OCCURRENCE,
          responseContentHash: HASH,
        },
        "delegation_response:tsk_x:7:" + OCCURRENCE + ":" + HASH,
      ],
      [
        { signalType: "replan_requested", workId: "wrk_x", expectedRevision: 7 },
        "replan_requested:wrk_x:7",
      ],
      [
        {
          signalType: "definition_control",
          definitionId: "wdf_x",
          expectedRevision: 4,
          action: "pause",
        },
        "definition_control:wdf_x:4:pause",
      ],
      [
        { signalType: "agent_result", dispatchId: "dsp_x", resultContentHash: HASH },
        "agent_result:dsp_x:" + HASH,
      ],
      [
        {
          signalType: "external_signal",
          subjectId: "tsk_x",
          sourceId: "copy_adapter",
          signalName: "copy_done",
          sourceOccurrenceId: "operation_42",
        },
        'external_signal:tsk_x:["copy_adapter","copy_done","operation_42"]',
      ],
    ];
    expect(cases).toHaveLength(9);
    for (const [input, key] of cases) expect(derive(input), key).toEqual({ ok: true, value: key });
  });

  it("Edge: revision 0 과 큰 안전 정수는 십진 표기 그대로다 (test_SC039_revision_zero_and_large_safe_integer)", () => {
    expect(
      derive({ signalType: "cancel_requested", subjectId: "tsk_x", expectedRevision: 0 }),
    ).toEqual({
      ok: true,
      value: "cancel_requested:tsk_x:0",
    });
    expect(
      derive({
        signalType: "replan_requested",
        workId: "wrk_x",
        expectedRevision: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ ok: true, value: "replan_requested:wrk_x:9007199254740991" });
  });

  it("Error: 외부 신호·입력 제공의 문자열 필드가 문자열이 아니면 not_a_string 파생 오류다 (test_SC039_external_signal_non_string_field_error)", () => {
    expect(
      derive({
        signalType: "external_signal",
        subjectId: "tsk_x",
        sourceId: 1,
        signalName: "copy_done",
        sourceOccurrenceId: "operation_42",
      }),
    ).toEqual({
      ok: false,
      error: { kind: "derivation_input", field: "sourceId", reason: "not_a_string" },
    });
    expect(
      derive({
        signalType: "input_provided",
        subjectId: "tsk_x",
        questionId: { a: 1 },
        answerContentHash: HASH,
      }),
    ).toEqual({
      ok: false,
      error: { kind: "derivation_input", field: "questionId", reason: "not_a_string" },
    });
  });
});

describe("SC-040: 사람 출처 정의 제어의 계약 밖 revision 은 기록 없는 invalid_input 이다", () => {
  it("Happy: human_local + {toString:1} revision 은 기록 없이 거절된다 (test_SC040_human_control_to_string_revision_rejected)", () => {
    const r = registerDefinition(definitionDeps("bv040h"));
    const signal = definitionControl(
      r.journal.deps,
      r.definitionId,
      TO_STRING_OBJECT,
      "human_local",
    );
    expect(judgeDefinitionSignal(r.journal.deps, r.state, signal, NOW)).toEqual(
      NOT_APPLICABLE_INVALID,
    );
  });

  it("Edge: 소수·음수 revision 도 같다 (test_SC040_human_control_fraction_negative_rejected)", () => {
    const r = registerDefinition(definitionDeps("bv040e"));
    for (const revision of [1.5, -1]) {
      const signal = definitionControl(r.journal.deps, r.definitionId, revision, "human_local");
      expect(judgeDefinitionSignal(r.journal.deps, r.state, signal, NOW), String(revision)).toEqual(
        NOT_APPLICABLE_INVALID,
      );
    }
  });

  it("Error: 대조 — 현재 정수 revision 은 수용된다 (test_SC040_integer_revision_accepted)", () => {
    const r = registerDefinition(definitionDeps("bv040r"));
    const revision = r.journal.definition(r.definitionId).revision;
    const signal = definitionControl(r.journal.deps, r.definitionId, revision, "human_local");
    expect(judgeDefinitionSignal(r.journal.deps, r.state, signal, NOW).kind).toBe("accepted");
  });
});

describe("SC-041: 반복 포트·fan-out 한도의 계약 밖 값은 DomainInvariantError 로 끝난다", () => {
  it("Happy: 포트가 {toString:1} 회차를 내면 일정 해소가 DomainInvariantError 다 (test_SC041_port_to_string_object_invariant)", () => {
    const { journal, definitionId } = withPort("bv041h", portReturning(TO_STRING_OBJECT, 1));
    expect(() => journal.resolveDue(definitionId, dayAt(0))).toThrow(DomainInvariantError);
    expect(() => evaluateFanOutConcurrency(TO_STRING_OBJECT as unknown as number, [])).toThrow(
      DomainInvariantError,
    );
  });

  it("Edge: 포트가 수·null·배열 회차를 내도 DomainInvariantError 다 (test_SC041_port_number_null_array_invariant)", () => {
    for (const [index, value] of ([1, null, [1, 2]] as const).entries()) {
      const { journal, definitionId } = withPort(`bv041e${index}`, portReturning(value, 1));
      expect(() => journal.resolveDue(definitionId, dayAt(0)), String(index)).toThrow(
        DomainInvariantError,
      );
    }
  });

  it("Error: 정상 시각에 객체 회차 번호를 내면 TypeError 가 아니라 DomainInvariantError 다 (test_SC041_port_object_recurrence_index_invariant)", () => {
    const { journal, definitionId } = withPort("bv041r", portReturning(dayAt(1), { a: 1 }));
    expect(() => journal.resolveDue(definitionId, dayAt(0))).toThrow(DomainInvariantError);
  });
});

describe("SC-042: 정의 대상 외부 신호의 subject 는 definitionId 하나여야 한다", () => {
  function judge(seed: string, subjectOf: (definitionId: WorkDefinitionId) => unknown) {
    const r = registerDefinition(definitionDeps(seed), { draft: signalDefinitionDraft() });
    const signal = externalSignal(r.journal.deps, {
      subject: { definitionId: r.definitionId },
      sourceOccurrenceId: "src-1",
      receivedAt: NOW,
    });
    const withSubject = { ...signal, subject: subjectOf(r.definitionId) } as ExternalSignal;
    return judgeDefinitionSignal(r.journal.deps, r.state, withSubject, NOW);
  }

  it("Happy: definitionId·taskId 두 키 subject 는 커밋 없이 거절되고 대조로 단일 키는 수용된다 (test_SC042_two_key_subject_definition_rejected)", () => {
    expect(judge("bv042h", (definitionId) => ({ definitionId, taskId: "tsk_x1" }))).toEqual(
      NOT_APPLICABLE_INVALID,
    );
    expect(judge("bv042c", (definitionId) => ({ definitionId })).kind).toBe("accepted");
  });

  it("Edge: 다른 키·키 0 개 subject 는 상세 없이 거절된다 (test_SC042_other_key_or_empty_subject_rejected)", () => {
    expect(judge("bv042e1", () => ({ workId: "wrk_x1" }))).toEqual(NOT_APPLICABLE_INVALID);
    expect(judge("bv042e2", () => ({}))).toEqual(NOT_APPLICABLE_INVALID);
    expect(judge("bv042e3", () => ({ definitionId: undefined }))).toEqual(NOT_APPLICABLE_INVALID);
  });

  it("Error: Task 단일 키 subject 는 task_subject_not_definition_signal 상세다 (test_SC042_task_only_subject_detail)", () => {
    expect(judge("bv042r", () => ({ taskId: "tsk_x1" }))).toEqual({
      kind: "not_applicable",
      rejection: { reason: "invalid_input", detail: "task_subject_not_definition_signal" },
    });
  });
});

describe("SC-043: Task 대상 외부 신호의 subject 는 taskId 하나여야 한다", () => {
  function judge(seed: string, subject: unknown, overrides: Record<string, unknown> = {}) {
    const { deps, aggregate, taskId } = readyListener(seed);
    const signal = {
      ...externalSignal(deps, {
        subject: { taskId },
        sourceOccurrenceId: "src-1",
        receivedAt: NOW,
      }),
      subject,
      ...overrides,
    } as ExternalSignal;
    return { taskId, judged: judgeTaskExternalSignal(deps, aggregate, signal, NOW) };
  }

  it("Happy: definitionId·taskId 두 키 subject 는 커밋 없이 거절된다 (test_SC043_two_key_subject_task_rejected)", () => {
    const { deps, aggregate, taskId } = readyListener("bv043h");
    const signal = {
      ...externalSignal(deps, {
        subject: { taskId },
        sourceOccurrenceId: "src-1",
        receivedAt: NOW,
      }),
      subject: { definitionId: "wdf_x1", taskId },
    } as ExternalSignal;
    expect(judgeTaskExternalSignal(deps, aggregate, signal, NOW)).toEqual(NOT_APPLICABLE_INVALID);
    const control = {
      ...externalSignal(deps, {
        subject: { taskId },
        sourceOccurrenceId: "src-2",
        receivedAt: NOW,
      }),
    } as ExternalSignal;
    expect(judgeTaskExternalSignal(deps, aggregate, control, NOW).kind).toBe("accepted");
  });

  it("Edge: 정의 단일 키 subject 는 거절된다 (test_SC043_definition_only_subject_task_rejected)", () => {
    expect(judge("bv043e", { definitionId: "wdf_x1" }).judged).toEqual(NOT_APPLICABLE_INVALID);
  });

  it("Error: 프로토타입 이름 Task ID 는 일반 Error 가 아니라 invalid_input 이다 (test_SC043_prototype_name_task_id_rejected)", () => {
    for (const [index, name] of ["constructor", "__proto__", "toString"].entries()) {
      expect(judge(`bv043r${index}`, { taskId: name }).judged, name).toEqual(
        NOT_APPLICABLE_INVALID,
      );
    }
  });

  it("Error: Task 대상 외부 신호 출처가 열거 밖이면 기록 없이 거절된다 (test_SC043_external_signal_actor_source_out_of_enum_rejected)", () => {
    const { deps, aggregate, taskId } = readyListener("bv043x");
    const signal = {
      ...externalSignal(deps, {
        subject: { taskId },
        sourceOccurrenceId: "src-1",
        receivedAt: NOW,
      }),
      actorSource: "robot",
    } as unknown as ExternalSignal;
    expect(judgeTaskExternalSignal(deps, aggregate, signal, NOW)).toEqual(NOT_APPLICABLE_INVALID);
  });
});

describe("SC-044: Task 대상 외부 신호의 subject 형이 틀리면 TypeError 가 아니라 invalid_input 이다", () => {
  function judge(seed: string, mutate: (signal: Record<string, unknown>) => void) {
    const { deps, aggregate, taskId } = readyListener(seed);
    const signal = {
      ...externalSignal(deps, {
        subject: { taskId },
        sourceOccurrenceId: "src-1",
        receivedAt: NOW,
      }),
    } as unknown as Record<string, unknown>;
    mutate(signal);
    return judgeTaskExternalSignal(deps, aggregate, signal as unknown as ExternalSignal, NOW);
  }

  it("Happy: subject null 은 invalid_input 이다 (test_SC044_null_subject_task_rejected)", () => {
    expect(judge("bv044h", (s) => (s["subject"] = null))).toEqual(NOT_APPLICABLE_INVALID);
  });

  it("Edge: 문자열·배열 subject 는 invalid_input 이다 (test_SC044_non_object_subject_task_rejected)", () => {
    expect(judge("bv044e1", (s) => (s["subject"] = "tsk_x"))).toEqual(NOT_APPLICABLE_INVALID);
    expect(judge("bv044e2", (s) => (s["subject"] = []))).toEqual(NOT_APPLICABLE_INVALID);
  });

  it("Error: subject 가 없으면 invalid_input 이다 (test_SC044_missing_subject_task_rejected)", () => {
    expect(judge("bv044r", (s) => delete s["subject"])).toEqual(NOT_APPLICABLE_INVALID);
  });
});
