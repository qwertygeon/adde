// 정의·Task 대상 외부 신호 판정 순서와 schedule_task 의 계약 입력 occurrence ID 대조.
import { describe, expect, it } from "vitest";
import {
  deriveOccurrenceId,
  executeCommand,
  executeDefinitionCommand,
  findSteward,
  judgeDefinitionSignal,
  judgeTaskExternalSignal,
  nextEntityId,
  workflowStateOf,
} from "../../../src/workflow/domain/index.js";
import type {
  CommandOutcome,
  DomainCommit,
  DomainDeps,
  EventId,
  ExternalSignal,
  OccurrenceId,
  SignalJudgement,
  TaskId,
  TriggerSpec,
  UtcInstant,
  WorkAggregate,
} from "../../../src/workflow/domain/index.js";
import {
  FIXTURE_SIGNAL_NAME,
  FIXTURE_SIGNAL_SOURCE,
  dayAt,
  controlSignal,
  definitionDeps,
  externalSignal,
  payloadsOf,
  registerAndMaterializeFirst,
  registerDefinition,
  signalDefinitionDraft,
  typesOf,
  withPendingSignalAcceptance,
} from "./helpers/definition-fixtures.js";
import { STEWARD_MEMBER } from "./helpers/definition-row-cases.js";
import {
  at,
  basePolicy,
  draft,
  entityId,
  meta,
  mustOk,
  patchTask,
  requireTaskFor,
  testDeps,
} from "./helpers/fixtures.js";
import {
  Journal,
  NOW,
  atTrigger,
  grantTaskDecision,
  startJournal,
  taskCommand,
  validate,
} from "./helpers/scenario.js";

const LISTENER: TriggerSpec = {
  kind: "signal",
  version: 1,
  triggerId: "listener",
  sourceId: FIXTURE_SIGNAL_SOURCE,
  signal: FIXTURE_SIGNAL_NAME,
} as TriggerSpec;

function label(judged: { kind: string; reason?: string; rejection?: { reason: string } }): string {
  if (judged.kind === "not_applicable") return `not_applicable:${judged.rejection?.reason ?? ""}`;
  if (judged.kind === "rejected" || judged.kind === "rejected_stale")
    return `${judged.kind}:${judged.reason ?? ""}`;
  return judged.kind;
}

/** 외부 신호 Trigger 를 단 Task 를 READY 에 둔 진행기. */
function readyListener(seed: string): { journal: Journal; taskId: TaskId } {
  const { journal, ids } = startJournal([draft("listener", { trigger: LISTENER })], testDeps(seed));
  const taskId = ids["listener"] as TaskId;
  validate(journal, taskId);
  expect(journal.task(taskId).state).toBe("READY");
  return { journal, taskId };
}

function taskSignal(
  deps: DomainDeps,
  taskId: TaskId,
  sourceOccurrenceId: string,
  overrides: Partial<ExternalSignal> = {},
): ExternalSignal {
  return {
    ...externalSignal(deps, { subject: { taskId }, sourceOccurrenceId, receivedAt: NOW }),
    ...overrides,
  };
}

function judgeTask(journal: Journal, signal: ExternalSignal): SignalJudgement {
  return judgeTaskExternalSignal(journal.deps, journal.aggregate, signal, NOW);
}

function signalDefinition(seed: string) {
  return registerDefinition(definitionDeps(seed), {
    draft: signalDefinitionDraft(),
    tasks: STEWARD_MEMBER,
  });
}

function commitOf(outcome: CommandOutcome): DomainCommit {
  if (outcome.kind !== "committed")
    throw new Error(`expected committed, got ${JSON.stringify(outcome)}`);
  return outcome.commit;
}

describe("SC-045: 정의 대상 외부 신호", () => {
  it("Happy: ACTIVE·PAUSED 정의의 일치 신호는 수용되어 materialize·보류된다 (test_SC045_definition_signal_materializes_or_holds)", () => {
    const active = signalDefinition("ext045a");
    const accepted = active.journal.external(active.definitionId, "src-1", dayAt(0));
    expect(label(accepted)).toBe("accepted");
    if (accepted.kind === "accepted") expect(typesOf(accepted.commit)).toContain("trigger_fired");
    const paused = signalDefinition("ext045p");
    expect(paused.journal.control(paused.definitionId, "pause", dayAt(0)).kind).toBe("accepted");
    const held = paused.journal.external(paused.definitionId, "src-1", dayAt(0, "08:00"));
    expect(label(held)).toBe("accepted");
    if (held.kind === "accepted") {
      expect(
        payloadsOf(held.commit, "work_definition_occurrence_held").map((h) => h["cause"]),
      ).toEqual(["definition_paused"]);
    }
  });

  it("Edge: STOPPED 정의는 terminal_subject 다 (test_SC045_stopped_definition_terminal_subject)", () => {
    const { journal, definitionId } = signalDefinition("ext045e");
    expect(journal.control(definitionId, "stop", dayAt(0)).kind).toBe("accepted");
    expect(label(journal.external(definitionId, "src-1", dayAt(0, "08:00")))).toBe(
      "rejected_stale:terminal_subject",
    );
  });

  it("Error: 이름·출처 불일치와 일정 활성화는 trigger_mismatch 이고 정의가 그대로다 (test_SC045_mismatch_trigger_mismatch_unchanged)", () => {
    const { journal, definitionId } = signalDefinition("ext045x");
    const before = journal.definition(definitionId);
    expect(label(journal.external(definitionId, "src-1", dayAt(0), { signalName: "other" }))).toBe(
      "rejected:trigger_mismatch",
    );
    expect(
      label(journal.external(definitionId, "src-2", dayAt(0), { sourceId: "other_source" })),
    ).toBe("rejected:trigger_mismatch");
    expect(journal.definition(definitionId)).toEqual(before);
    const scheduled = registerDefinition(definitionDeps("ext045y"), { tasks: STEWARD_MEMBER });
    const scheduledBefore = scheduled.journal.definition(scheduled.definitionId);
    expect(label(scheduled.journal.external(scheduled.definitionId, "src-1", dayAt(0)))).toBe(
      "rejected:trigger_mismatch",
    );
    expect(scheduled.journal.definition(scheduled.definitionId)).toEqual(scheduledBefore);
  });
});

describe("SC-046: Task 대상 외부 신호", () => {
  it("Happy: READY Task 의 일치 신호는 수용 이벤트에서 파생한 occurrence 로 예약된다 (test_SC046_ready_task_signal_schedules_from_accepted_event)", () => {
    const { journal, taskId } = readyListener("ext046");
    const judged = judgeTask(journal, taskSignal(journal.deps, taskId, "src-1"));
    expect(judged.kind).toBe("accepted");
    if (judged.kind !== "accepted") return;
    expect(typesOf(judged.commit)).toEqual(["signal_accepted", "task_scheduled"]);
    const acceptedEvent = judged.commit.events[0];
    if (acceptedEvent === undefined) throw new Error("expected signal_accepted");
    const occurrenceId = mustOk(
      deriveOccurrenceId({
        kind: "event_caused",
        ownerId: taskId,
        triggerId: "listener",
        causingEvent: { id: acceptedEvent.id as EventId, occurredAt: acceptedEvent.occurredAt },
      }),
    );
    expect(payloadsOf(judged.commit, "task_scheduled")[0]).toEqual({
      occurrenceId,
      cause: "external_signal",
      causingEventId: acceptedEvent.id,
    });
    expect(requireTaskFor(judged.aggregate, taskId).pendingSignalAcceptance).toBeUndefined();
  });

  it("Edge: COMPLETED 는 terminal_subject, DRAFT 는 unexpected_state 다 (test_SC046_completed_and_draft_refused)", () => {
    const { journal, ids } = startJournal(
      [draft("listener", { trigger: LISTENER })],
      testDeps("ext046e"),
    );
    const taskId = ids["listener"] as TaskId;
    expect(label(judgeTask(journal, taskSignal(journal.deps, taskId, "src-1")))).toBe(
      "rejected:unexpected_state",
    );
    // 레코드 패치: 종결 상태 Task(완료 경로 대용 — 신호 Trigger Task 를 끝까지 진행하는 경로가 길다).
    journal.aggregate = patchTask(journal.aggregate, taskId, { state: "COMPLETED" });
    expect(label(judgeTask(journal, taskSignal(journal.deps, taskId, "src-2")))).toBe(
      "rejected_stale:terminal_subject",
    );
  });

  it("Error: 불일치 신호는 trigger_mismatch 이고 occurrence 없이 Task 가 그대로다 (test_SC046_mismatch_no_occurrence)", () => {
    const { journal, taskId } = readyListener("ext046x");
    const before = journal.task(taskId);
    const judged = judgeTask(
      journal,
      taskSignal(journal.deps, taskId, "src-1", { signalName: "other" }),
    );
    expect(label(judged)).toBe("rejected:trigger_mismatch");
    if (judged.kind === "rejected") expect(typesOf(judged.commit)).toEqual(["signal_rejected"]);
    expect(journal.task(taskId)).toEqual(before);
  });
});

describe("SC-047: 외부 신호 판정 순서는 중복 → 종결 → 상태 → Trigger 다", () => {
  it("Happy: 중복과 다른 요인이 함께면 두 대상 모두 중복이다 (test_SC047_duplicate_first_both_subjects)", () => {
    const { journal, taskId } = readyListener("ext047");
    journal.apply(judgeTask(journal, taskSignal(journal.deps, taskId, "src-1")));
    expect(journal.task(taskId).state).toBe("SCHEDULED");
    // 같은 출처 회차의 재전달 — Task 는 이제 SCHEDULED(상태 요인)지만 중복이 먼저다.
    expect(label(judgeTask(journal, taskSignal(journal.deps, taskId, "src-1")))).toBe("duplicate");
    const def = signalDefinition("ext047d");
    expect(def.journal.external(def.definitionId, "src-1", dayAt(0)).kind).toBe("accepted");
    expect(def.journal.control(def.definitionId, "stop", dayAt(0, "08:00")).kind).toBe("accepted");
    expect(label(def.journal.external(def.definitionId, "src-1", dayAt(0, "09:00")))).toBe(
      "duplicate",
    );
  });

  it("Edge: 종결·상태·불일치가 함께면 terminal_subject 다 (test_SC047_terminal_before_state_and_trigger)", () => {
    const { journal, taskId } = readyListener("ext047e");
    journal.aggregate = patchTask(journal.aggregate, taskId, { state: "COMPLETED" });
    expect(
      label(judgeTask(journal, taskSignal(journal.deps, taskId, "src-1", { signalName: "other" }))),
    ).toBe("rejected_stale:terminal_subject");
    const def = signalDefinition("ext047f");
    expect(def.journal.control(def.definitionId, "stop", dayAt(0)).kind).toBe("accepted");
    expect(
      label(def.journal.external(def.definitionId, "src-1", dayAt(0), { signalName: "other" })),
    ).toBe("rejected_stale:terminal_subject");
  });

  it("Error: Task 는 상태가 불일치보다 먼저고 정의는 불일치만 남는다 (test_SC047_state_before_trigger)", () => {
    const { journal, ids } = startJournal(
      [draft("listener", { trigger: LISTENER })],
      testDeps("ext047x"),
    );
    const taskId = ids["listener"] as TaskId;
    expect(
      label(judgeTask(journal, taskSignal(journal.deps, taskId, "src-1", { signalName: "other" }))),
    ).toBe("rejected:unexpected_state");
    const def = signalDefinition("ext047y");
    expect(def.journal.control(def.definitionId, "pause", dayAt(0)).kind).toBe("accepted");
    expect(
      label(def.journal.external(def.definitionId, "src-1", dayAt(0), { signalName: "other" })),
    ).toBe("rejected:trigger_mismatch");
  });
});

describe("SC-048: schedule_task 는 계약 입력으로 다시 계산한 occurrence ID 만 받는다", () => {
  const AT_FIRE = at("2026-01-01T01:00:00Z");

  function scheduleTask(
    journal: Journal,
    taskId: TaskId,
    occurrenceId: OccurrenceId,
    cause: "schedule" | "external_signal" | "retry",
  ): CommandOutcome {
    return taskCommand(journal.deps, journal.aggregate, taskId, {
      kind: "schedule_task",
      occurrenceId,
      cause,
    });
  }

  /** 열린 attempt 를 재시도 가능 실패로 끝내 RETRY_WAIT 에 둔다. */
  function failAttempt(journal: Journal, taskId: TaskId, now: UtcInstant): void {
    const attemptId = journal.task(taskId).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    journal.apply(
      executeCommand(journal.deps, journal.aggregate, {
        kind: "record_attempt_outcome",
        taskId,
        expectedRevision: journal.task(taskId).revision,
        meta: meta(now),
        attemptId,
        outcome: { kind: "failed", code: "fixture_retryable" },
      }),
    );
  }

  function retryId(taskId: TaskId, occurredAt: UtcInstant, attemptNo: number): OccurrenceId {
    return mustOk(
      deriveOccurrenceId({
        kind: "execution_retry",
        ownerId: taskId,
        triggerId: "retry",
        causingEvent: { occurredAt },
        attemptNo,
      }),
    );
  }

  it("Happy: 시각·외부 신호·재시도 원인의 계약 입력 ID 가 예약되고 외부 신호 원인은 수용 참조를 소비한다 (test_SC048_contract_inputs_schedule_each_cause)", () => {
    const { journal, ids } = startJournal(
      [
        draft("timed", { trigger: atTrigger("timed", { kind: "skip" }) }),
        draft("listener", { trigger: LISTENER }),
        draft("retry"),
      ],
      testDeps("ext048"),
    );
    for (const ref of ["timed", "listener", "retry"]) validate(journal, ids[ref] as TaskId);
    const timed = ids["timed"] as TaskId;
    const scheduleId = mustOk(
      deriveOccurrenceId({
        kind: "schedule",
        ownerId: timed,
        triggerId: "timed",
        scheduledForUtc: AT_FIRE,
        recurrenceIndex: 0,
      }),
    );
    expect(typesOf(journal.apply(scheduleTask(journal, timed, scheduleId, "schedule")))).toContain(
      "task_scheduled",
    );

    const listener = ids["listener"] as TaskId;
    // 레코드 패치: 미소비 외부 신호 수용 참조(수용·예약이 한 커밋인 흐름에서 남길 수 없는 상태 — 다른 생성 경로 대용).
    const accepted = withPendingSignalAcceptance(journal.aggregate, listener);
    journal.aggregate = accepted.aggregate;
    const external = journal.apply(
      scheduleTask(journal, listener, accepted.occurrenceId, "external_signal"),
    );
    expect(payloadsOf(external, "task_scheduled")[0]?.["causingEventId"]).toBe(
      accepted.ref.eventId,
    );
    expect(journal.task(listener).pendingSignalAcceptance).toBeUndefined();

    const retry = ids["retry"] as TaskId;
    journal.apply(taskCommand(journal.deps, journal.aggregate, retry, { kind: "start_attempt" }));
    failAttempt(journal, retry, NOW);
    expect(journal.task(retry).state).toBe("RETRY_WAIT");
    expect(
      typesOf(journal.apply(scheduleTask(journal, retry, retryId(retry, NOW, 1), "retry"))),
    ).toContain("task_scheduled");
  });

  it("Edge: 둘째 재시도 대기는 그 이벤트의 시각·attempt 번호로 파생해야 수용된다 (test_SC048_retry_uses_latest_retry_wait)", () => {
    const { journal, ids } = startJournal([draft("retry")], testDeps("ext048e"));
    const retry = ids["retry"] as TaskId;
    validate(journal, retry);
    journal.apply(taskCommand(journal.deps, journal.aggregate, retry, { kind: "start_attempt" }));
    failAttempt(journal, retry, NOW);
    journal.apply(scheduleTask(journal, retry, retryId(retry, NOW, 1), "retry"));
    const fired = journal.task(retry).scheduledOccurrenceId;
    journal.apply(
      taskCommand(journal.deps, journal.aggregate, retry, {
        kind: "start_attempt",
        ...(fired !== undefined ? { firedOccurrenceId: fired } : {}),
      }),
    );
    const second = at("2026-01-01T00:20:00Z");
    failAttempt(journal, retry, second);
    expect(journal.task(retry).state).toBe("RETRY_WAIT");
    const stale = scheduleTask(journal, retry, retryId(retry, NOW, 1), "retry");
    expect(stale).toMatchObject({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "occurrence_id_mismatch" },
    });
    expect(
      typesOf(journal.apply(scheduleTask(journal, retry, retryId(retry, second, 2), "retry"))),
    ).toContain("task_scheduled");
  });

  it("Error: 하나 바꾼 ID·출처 다른 수용 참조·수용 참조 없음은 거절되고 Task 가 그대로이며 승인 주차가 없다 (test_SC048_altered_ids_and_source_refused_without_park)", () => {
    const { journal, ids } = startJournal(
      [
        draft("timed", { trigger: atTrigger("timed", { kind: "skip" }) }),
        draft("listener", { trigger: LISTENER }),
      ],
      testDeps("ext048x"),
    );
    for (const ref of ["timed", "listener"]) validate(journal, ids[ref] as TaskId);
    const timed = ids["timed"] as TaskId;
    const listener = ids["listener"] as TaskId;
    // 레코드 패치: 실행 전 승인이 남은 READY(검증 차단 → unblock 경로 대용) — 거절이 주차보다 먼저임을 본다.
    const gate = (aggregate: WorkAggregate, taskId: TaskId) =>
      patchTask(aggregate, taskId, {
        policy: basePolicy({ approvalRequiredBeforeExecute: true }),
        preExecutionApproved: false,
      });
    journal.aggregate = gate(gate(journal.aggregate, timed), listener);
    const refuse = (outcome: CommandOutcome, detail: string) => {
      expect(outcome, detail).toEqual({
        kind: "rejected",
        rejection: { reason: "condition_not_met", detail },
      });
    };
    const altered = mustOk(
      deriveOccurrenceId({
        kind: "schedule",
        ownerId: timed,
        triggerId: "timed",
        scheduledForUtc: AT_FIRE,
        recurrenceIndex: 1,
      }),
    );
    const timedBefore = journal.task(timed);
    refuse(scheduleTask(journal, timed, altered, "schedule"), "occurrence_id_mismatch");
    expect(journal.task(timed)).toEqual(timedBefore);

    const otherSource = withPendingSignalAcceptance(journal.aggregate, listener, {
      sourceId: "other_source",
    });
    refuse(
      taskCommand(journal.deps, otherSource.aggregate, listener, {
        kind: "schedule_task",
        occurrenceId: otherSource.occurrenceId,
        cause: "external_signal",
      }),
      "signal_source_mismatch",
    );
    const fabricated = mustOk(
      deriveOccurrenceId({
        kind: "event_caused",
        ownerId: listener,
        triggerId: "listener",
        causingEvent: { id: entityId("event", "evt_fabricated001"), occurredAt: NOW },
      }),
    );
    const listenerBefore = journal.task(listener);
    refuse(
      scheduleTask(journal, listener, fabricated, "external_signal"),
      "accepted_signal_missing",
    );
    expect(journal.task(listener)).toEqual(listenerBefore);
    // 대조: 계약 입력 ID 는 승인 주차로 간다.
    const parked = scheduleTask(
      journal,
      timed,
      mustOk(
        deriveOccurrenceId({
          kind: "schedule",
          ownerId: timed,
          triggerId: "timed",
          scheduledForUtc: AT_FIRE,
          recurrenceIndex: 0,
        }),
      ),
      "schedule",
    );
    expect(typesOf(commitOf(parked))).toContain("task_awaiting_human");
  });

  it("Edge: 수용 하나는 예약 하나만 허용하고 실행 전 승인 주차는 참조를 소비하지 않는다 (test_SC048_accepted_signal_reference_consumed_once)", () => {
    const { journal, taskId } = readyListener("ext048s");
    const accepted = journal.apply(judgeTask(journal, taskSignal(journal.deps, taskId, "src-1")));
    const occurrenceId = payloadsOf(accepted, "task_scheduled")[0]?.[
      "occurrenceId"
    ] as OccurrenceId;
    journal.apply(
      taskCommand(journal.deps, journal.aggregate, taskId, { kind: "unschedule_task" }),
    );
    expect(journal.task(taskId).state).toBe("READY");
    expect(scheduleTask(journal, taskId, occurrenceId, "external_signal")).toEqual({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "accepted_signal_missing" },
    });

    // 대조: 실행 전 승인 주차는 참조를 남겨 grant 뒤 같은 ID 로 예약된다.
    const gated = readyListener("ext048t");
    const ref = withPendingSignalAcceptance(gated.journal.aggregate, gated.taskId);
    gated.journal.aggregate = patchTask(ref.aggregate, gated.taskId, {
      policy: basePolicy({ approvalRequiredBeforeExecute: true }),
      preExecutionApproved: false,
    });
    const parked = gated.journal.apply(
      scheduleTask(gated.journal, gated.taskId, ref.occurrenceId, "external_signal"),
    );
    expect(typesOf(parked)).toContain("task_awaiting_human");
    expect(gated.journal.task(gated.taskId).pendingSignalAcceptance?.eventId).toBe(ref.ref.eventId);
    gated.journal.apply(grantTaskDecision(gated.journal, gated.taskId));
    expect(gated.journal.task(gated.taskId).state).toBe("READY");
    const scheduled = gated.journal.apply(
      scheduleTask(gated.journal, gated.taskId, ref.occurrenceId, "external_signal"),
    );
    expect(typesOf(scheduled)).toContain("task_scheduled");
  });
});

const INVALID = { kind: "not_applicable", rejection: { reason: "invalid_input" } };

describe("SC-047: 외부 신호 필드 형 위반", () => {
  it("Error: 문자열이 아닌 출처·이름·출처 회차 ID 와 정의 ID 는 두 대상 모두 기록 없이 invalid_input 이다 (test_SC047_external_signal_field_types_refused)", () => {
    const fieldCases: readonly [string, Partial<Record<keyof ExternalSignal, unknown>>][] = [
      ["numeric sourceOccurrenceId", { sourceOccurrenceId: 42 }],
      ["non-string sourceId", { sourceId: 7 }],
      ["non-string signalName", { signalName: null }],
    ];

    const { journal, taskId } = readyListener("ext047shape");
    const taskBase = taskSignal(journal.deps, taskId, "42");
    for (const [label, patch] of fieldCases) {
      expect(
        judgeTask(journal, { ...taskBase, ...patch } as unknown as ExternalSignal),
        label,
      ).toEqual(INVALID);
    }
    const taskAccepted = judgeTask(journal, taskBase);
    expect(taskAccepted.kind).toBe("accepted");
    if (taskAccepted.kind === "accepted") journal.aggregate = taskAccepted.aggregate;
    expect(
      judgeTask(journal, { ...taskBase, sourceOccurrenceId: 42 } as unknown as ExternalSignal),
    ).toEqual(INVALID);

    const definition = signalDefinition("ext047shaped");
    const defBase = externalSignal(definition.journal.deps, {
      subject: { definitionId: definition.definitionId },
      sourceOccurrenceId: "42",
      receivedAt: NOW,
    });
    const judgeDef = (signal: unknown) =>
      judgeDefinitionSignal(
        definition.journal.deps,
        definition.journal.state,
        signal as ExternalSignal,
        NOW,
      );
    for (const [label, patch] of [
      ...fieldCases,
      ["numeric definitionId", { subject: { definitionId: 7 } }] as const,
    ]) {
      expect(judgeDef({ ...defBase, ...patch }), label).toEqual(INVALID);
    }
    expect(definition.journal.signal(defBase, NOW).kind).toBe("accepted");
    expect(judgeDef({ ...defBase, sourceOccurrenceId: 42 })).toEqual(INVALID);
  });
});

describe("SC-045: 정의 ID 가 없는 입력과 관리 Work 조회", () => {
  it("Error: 정의 ID 없는 입력은 invalid_input 이고 정의 없는 Work 만 있으면 관리 Work 조회가 없음이다 (test_SC045_definitionless_input_and_steward_lookup)", () => {
    const r = registerAndMaterializeFirst(definitionDeps("ext045nodef"));
    const { journal } = r;
    const markdown = journal.createMarkdownWork(dayAt(0, "08:00"));
    const deps = journal.deps;
    const now = dayAt(0, "08:00");
    const pending = journal.definition(r.definitionId).pendingSchedule?.occurrenceId;

    const external = externalSignal(deps, {
      subject: { definitionId: r.definitionId },
      sourceOccurrenceId: "s-1",
      receivedAt: now,
    });
    expect(
      judgeDefinitionSignal(
        deps,
        journal.state,
        { ...external, subject: { definitionId: undefined } } as never,
        now,
      ),
    ).toEqual(INVALID);
    const control = controlSignal(deps, {
      definitionId: r.definitionId,
      expectedRevision: journal.definition(r.definitionId).revision,
      action: "pause",
    });
    expect(
      judgeDefinitionSignal(
        deps,
        journal.state,
        { ...control, definitionId: undefined } as never,
        now,
      ),
    ).toEqual(INVALID);
    for (const kind of ["resolve_due_schedule", "release_held_occurrence"] as const) {
      expect(
        executeDefinitionCommand(deps, journal.state, {
          kind,
          occurrenceId: pending,
          meta: meta(now),
        } as never),
        kind,
      ).toEqual({ kind: "rejected", rejection: { reason: "invalid_input" } });
    }

    const occurrenceWork = journal.work(r.firstWorkId);
    expect(findSteward(workflowStateOf([occurrenceWork]), undefined as never)).toBeUndefined();
    expect(
      findSteward(workflowStateOf([occurrenceWork, journal.work(markdown)]), undefined as never),
    ).toBeUndefined();

    // 대조: 형식이 맞지만 관리 Work 가 없는 정의 ID 는 unknown_subject, 관리 Work 의 정의 ID 는 그 Work 자체다.
    const stray = nextEntityId(deps.ids, "workDefinition");
    const strayJudged = judgeDefinitionSignal(
      deps,
      journal.state,
      { ...external, subject: { definitionId: stray } },
      now,
    );
    expect(strayJudged).toEqual({
      kind: "not_applicable",
      rejection: { reason: "unknown_subject" },
    });
    expect(findSteward(journal.state, r.definitionId)).toBe(journal.state.works[r.stewardId]);
  });
});

describe("SC-046: Task 대상 진입은 신호를 한 번 읽는다", () => {
  function readCounting(base: ExternalSignal): { signal: ExternalSignal; reads: () => number } {
    let reads = 0;
    const received = { ...base } as Record<string, unknown>;
    Object.defineProperty(received, "sourceId", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? FIXTURE_SIGNAL_SOURCE : "other_source";
      },
    });
    return { signal: received as unknown as ExternalSignal, reads: () => reads };
  }

  it("Edge: 읽을 때마다 바뀌는 필드도 Task 진입이 한 번만 읽고 첫 값으로 판정한다 (test_SC046_task_entry_reads_signal_once)", () => {
    const { journal, taskId } = readyListener("ext046once");
    const counted = readCounting(taskSignal(journal.deps, taskId, "o-1"));
    const judged = judgeTask(journal, counted.signal);
    expect(counted.reads()).toBe(1);
    expect(judged.kind).toBe("accepted");
    if (judged.kind !== "accepted") return;
    expect(typesOf(judged.commit)).toEqual(["signal_accepted", "task_scheduled"]);
    expect(
      (payloadsOf(judged.commit, "signal_accepted")[0]?.["trigger"] as { sourceId?: string })
        .sourceId,
    ).toBe(FIXTURE_SIGNAL_SOURCE);

    // 대조: 정의 대상 진입도 같은 접근자를 한 번 읽는다.
    const definition = signalDefinition("ext046oncedef");
    const defCounted = readCounting(
      externalSignal(definition.journal.deps, {
        subject: { definitionId: definition.definitionId },
        sourceOccurrenceId: "s-1",
        receivedAt: NOW,
      }),
    );
    expect(definition.journal.signal(defCounted.signal, NOW).kind).toBe("accepted");
    expect(defCounted.reads()).toBe(1);
  });
});
