// 개정 재예약(같은 주기 회차 중복 없음·유지 판정·고른 행 유지·잃는 주기 기록)·개정의 보류 해소·취소 ID 회차의 해소.
import { describe, expect, it } from "vitest";
import { DomainInvariantError } from "../../../src/workflow/domain/index.js";
import type {
  DefinitionRecord,
  DomainCommit,
  OccurrenceId,
  RecurrenceStep,
  WorkDefinitionId,
  WorkId,
  WorkflowState,
} from "../../../src/workflow/domain/index.js";
import {
  commitOf,
  dailyActivation,
  dayAt,
  definitionEventsIn,
  definitionDeps,
  definitionDraft,
  payloadsOf,
  planInvalidIssues,
  definitionInvalidReasons,
  registerAndMaterializeFirst,
  registerDefinition,
  scheduleOccurrenceId,
  signalActivation,
  signalDefinitionDraft,
  stepActivation,
  testStepRecurrence,
  testWeeklyPeriodRecurrence,
  typesOf,
} from "./helpers/definition-fixtures.js";
import type { MisfireSpec, StepPeriod, WorkflowJournal } from "./helpers/definition-fixtures.js";
import { STEWARD_MEMBER } from "./helpers/definition-row-cases.js";

function committed(outcome: { kind: string; commit?: DomainCommit }): DomainCommit {
  if (
    (outcome.kind !== "committed" && outcome.kind !== "accepted") ||
    outcome.commit === undefined
  ) {
    throw new Error(`expected a commit, got ${JSON.stringify(outcome)}`);
  }
  return outcome.commit;
}

function revisedNext(commit: DomainCommit): unknown {
  return payloadsOf(commit, "work_definition_revised")[0]?.["nextSchedule"];
}

function canceledAt(commit: DomainCommit): unknown[] {
  return payloadsOf(commit, "trigger_canceled").map((c) => c["scheduledForUtc"]);
}

function skips(commit: DomainCommit): Record<string, unknown>[] {
  return payloadsOf(commit, "work_definition_occurrences_skipped");
}

function at0700(seed: string) {
  return registerDefinition(definitionDeps(seed), { tasks: STEWARD_MEMBER });
}

const EIGHT = dailyActivation({ localTime: "08:00" });
const SEVEN = dailyActivation({ localTime: "07:00" });

describe("SC-042: 개정 재예약은 같은 주기 회차를 다시 만들지 않는다", () => {
  it("Happy: D 07:00 materialize 뒤 08:00 개정은 D+1 07:00 을 취소하고 첫 회차를 D+1 08:00 으로 둔다 (test_SC042_amendment_no_second_occurrence_same_date)", () => {
    const { journal, definitionId } = at0700("amd042");
    committed(journal.resolveDue(definitionId, dayAt(0)));
    const grant = committed(journal.amend(definitionId, { activation: EIGHT }, dayAt(0, "07:30")));
    expect(canceledAt(grant)).toEqual([dayAt(1)]);
    expect((revisedNext(grant) as { scheduledForUtc: string }).scheduledForUtc).toBe(
      dayAt(1, "08:00"),
    );
    expect(journal.definition(definitionId).pendingSchedule?.scheduledForUtc).toBe(
      dayAt(1, "08:00"),
    );
  });

  it("Edge: 활성화가 그대로인 개정은 대기 행을 유지하고 trigger_canceled 가 없다 (test_SC042_identical_activation_keeps_pending_row)", () => {
    const { journal, definitionId } = at0700("amd042e");
    committed(journal.resolveDue(definitionId, dayAt(0)));
    const before = journal.definition(definitionId).pendingSchedule;
    const grant = committed(journal.amend(definitionId, { title: "renamed" }, dayAt(0, "07:30")));
    expect(typesOf(grant)).not.toContain("trigger_canceled");
    expect(journal.definition(definitionId).pendingSchedule?.occurrenceId).toBe(
      before?.occurrenceId,
    );
    expect(journal.definition(definitionId).retiredOccurrenceIds).toEqual([]);
  });

  it("Error: 회차 이력 없는 개정의 첫 회차는 커밋 이후다 (test_SC042_amendment_without_history_starts_after_commit)", () => {
    const { journal, definitionId } = at0700("amd042x");
    const commitAt = dayAt(-1, "13:00");
    const grant = committed(journal.amend(definitionId, { activation: EIGHT }, commitAt));
    const next = revisedNext(grant) as { scheduledForUtc: string };
    expect(next.scheduledForUtc).toBe(dayAt(0, "08:00"));
    expect(Date.parse(next.scheduledForUtc)).toBeGreaterThanOrEqual(Date.parse(commitAt));
  });

  it("Edge: 되돌림 개정은 잃는 주기를 건너뜀으로 기록하고 취소한 ID 를 다시 발급하지 않는다 (test_SC042_revert_amendment_records_lost_period_skip)", () => {
    const { journal, definitionId } = at0700("amd042r");
    committed(journal.resolveDue(definitionId, dayAt(0)));
    const first = committed(journal.amend(definitionId, { activation: EIGHT }, dayAt(0, "07:30")));
    expect(canceledAt(first)).toEqual([dayAt(1)]);
    const second = committed(journal.amend(definitionId, { activation: SEVEN }, dayAt(0, "07:40")));
    expect(canceledAt(second)).toEqual([dayAt(1, "08:00")]);
    expect(skips(second).map((s) => [s["reason"], s["count"], s["firstOriginalInstant"]])).toEqual([
      ["definition_revised", 1, dayAt(1)],
    ]);
    expect((revisedNext(second) as { scheduledForUtc: string }).scheduledForUtc).toBe(dayAt(2));
    const retired = journal.definition(definitionId).retiredOccurrenceIds;
    expect(retired).toHaveLength(2);
    expect(retired).not.toContain(journal.definition(definitionId).pendingSchedule?.occurrenceId);
  });

  it("Edge: 미도래 동일 ID 유지 판정이 주기 필터보다 먼저다 — 주 단위 주기 포트의 제목만 개정 (test_SC042_keep_check_precedes_period_filter)", () => {
    // 03-02 은 월요일 — 같은 ISO 주 안에 materialize 회차와 미도래 대기 행이 함께 있다.
    const weekly = () =>
      registerDefinition(definitionDeps("amd042w", undefined, testWeeklyPeriodRecurrence), {
        draft: definitionDraft({ activation: dailyActivation({ anchorUtc: dayAt(1) }) }),
        tasks: STEWARD_MEMBER,
      });
    const kept = weekly();
    committed(kept.journal.resolveDue(kept.definitionId, dayAt(1)));
    const pending = kept.journal.definition(kept.definitionId).pendingSchedule;
    expect(pending?.scheduledForUtc).toBe(dayAt(2));
    const grant = committed(
      kept.journal.amend(kept.definitionId, { title: "renamed" }, dayAt(1, "09:00")),
    );
    expect(typesOf(grant)).not.toContain("trigger_canceled");
    expect(kept.journal.definition(kept.definitionId).pendingSchedule?.occurrenceId).toBe(
      pending?.occurrenceId,
    );

    // 대조: 활성화 시각을 바꾸면 같은 주 후보는 건너뛰고 기존 행을 취소한다.
    const moved = registerDefinition(
      definitionDeps("amd042v", undefined, testWeeklyPeriodRecurrence),
      {
        draft: definitionDraft({ activation: dailyActivation({ anchorUtc: dayAt(1) }) }),
        tasks: STEWARD_MEMBER,
      },
    );
    committed(moved.journal.resolveDue(moved.definitionId, dayAt(1)));
    const movedGrant = committed(
      moved.journal.amend(
        moved.definitionId,
        { activation: dailyActivation({ anchorUtc: dayAt(1), localTime: "08:00" }) },
        dayAt(1, "09:00"),
      ),
    );
    expect(canceledAt(movedGrant)).toEqual([dayAt(2)]);
    expect((revisedNext(movedGrant) as { scheduledForUtc: string }).scheduledForUtc).toBe(
      dayAt(8, "08:00"),
    );
  });
});

describe("SC-043: 개정은 보류 일정 회차를 건너뛰고 이후 회차는 새 revision 이다", () => {
  it("Happy: 보류 일정 하나를 개정하면 건너뜀 하나이고 이후 회차 Work 는 새 revision 이다 (test_SC043_amendment_skips_held_schedule_one_event)", () => {
    const { journal, definitionId } = at0700("amd043");
    committed(journal.resolveDue(definitionId, dayAt(0)));
    committed(journal.resolveDue(definitionId, dayAt(1)));
    const grant = committed(journal.amend(definitionId, { title: "renamed" }, dayAt(1, "08:00")));
    expect(skips(grant).map((s) => [s["reason"], s["count"]])).toEqual([["definition_revised", 1]]);
    journal.completeWork(journal.occurrenceWorkIds(definitionId)[0] as WorkId, dayAt(1, "09:00"));
    committed(journal.resolveDue(definitionId, dayAt(2)));
    const latest = journal.occurrenceWorkIds(definitionId).at(-1) as WorkId;
    expect(
      (journal.work(latest).work.source as { definitionRevision: number }).definitionRevision,
    ).toBe(2);
  });

  it("Edge: 대기 행이 도래한 상태의 개정은 그 행을 건너뜀 개수에 넣는다 (test_SC043_due_row_counted_in_amendment_skip)", () => {
    const { journal, definitionId } = at0700("amd043e");
    committed(journal.resolveDue(definitionId, dayAt(0)));
    const grant = committed(journal.amend(definitionId, { title: "renamed" }, dayAt(1, "08:00")));
    expect(skips(grant).map((s) => [s["count"], s["firstOriginalInstant"]])).toEqual([
      [1, dayAt(1)],
    ]);
    expect(typesOf(grant)).not.toContain("trigger_canceled");
  });

  it("Error: 낡은 기대 revision 의 개정은 계획 무효이고 아무것도 해소하지 않는다 (test_SC043_stale_amendment_resolves_nothing)", () => {
    const { journal, definitionId } = at0700("amd043x");
    committed(journal.resolveDue(definitionId, dayAt(0)));
    committed(journal.resolveDue(definitionId, dayAt(1)));
    const before = journal.definition(definitionId);
    const proposed = committed(
      journal.proposeAmendment(definitionId, { title: "stale" }, dayAt(1, "08:00"), {
        expectedRevision: 0,
      }),
    );
    expect(definitionInvalidReasons(planInvalidIssues(proposed))).toEqual([
      "amends_revision_mismatch",
    ]);
    expect(typesOf(proposed)).not.toContain("work_definition_occurrences_skipped");
    expect(journal.definition(definitionId)).toEqual(before);
  });
});

describe("SC-044: 개정은 같은 출처·이름의 보류 신호 회차를 유지한다", () => {
  function twoHeldSignals(seed: string) {
    const registered = registerDefinition(definitionDeps(seed), {
      draft: signalDefinitionDraft(),
      tasks: STEWARD_MEMBER,
    });
    const { journal, definitionId } = registered;
    for (const s of ["open", "h1", "h2"]) committed(journal.external(definitionId, s, dayAt(0)));
    expect(journal.definition(definitionId).held).toHaveLength(2);
    return registered;
  }
  const freeSlot = (
    journal: WorkflowJournal,
    definitionId: Parameters<WorkflowJournal["definition"]>[0],
  ) =>
    journal.completeWork(journal.occurrenceWorkIds(definitionId)[0] as WorkId, dayAt(0, "09:00"));

  it("Happy: 같은 출처·이름 개정은 보류를 유지하고 해제 회차는 새 revision 이다 (test_SC044_same_signal_amendment_keeps_holds)", () => {
    const { journal, definitionId } = twoHeldSignals("amd044");
    const grant = committed(journal.amend(definitionId, { title: "renamed" }, dayAt(0, "08:00")));
    expect(skips(grant)).toEqual([]);
    expect(journal.definition(definitionId).held).toHaveLength(2);
    freeSlot(journal, definitionId);
    committed(journal.release(definitionId, dayAt(0, "09:01")));
    const latest = journal.occurrenceWorkIds(definitionId).at(-1) as WorkId;
    expect(
      (journal.work(latest).work.source as { definitionRevision: number }).definitionRevision,
    ).toBe(2);
  });

  it("Edge: 다른 신호 이름 개정은 보류 둘을 건너뜀 하나로 기록한다 (test_SC044_other_signal_amendment_skips_holds)", () => {
    const { journal, definitionId } = twoHeldSignals("amd044e");
    const grant = committed(
      journal.amend(
        definitionId,
        { activation: signalActivation({ signal: "other_ready" }) },
        dayAt(0, "08:00"),
      ),
    );
    expect(skips(grant).map((s) => [s["reason"], s["count"]])).toEqual([["definition_revised", 2]]);
    expect(journal.definition(definitionId).held).toEqual([]);
  });

  it("Error: 신호에서 일정으로 개정하면 보류를 건너뛰고 첫 일정 회차를 등록한다 (test_SC044_signal_to_schedule_skips_and_registers)", () => {
    const { journal, definitionId } = twoHeldSignals("amd044x");
    const grant = committed(journal.amend(definitionId, { activation: SEVEN }, dayAt(0, "08:00")));
    expect(skips(grant).map((s) => [s["reason"], s["count"]])).toEqual([["definition_revised", 2]]);
    expect((revisedNext(grant) as { scheduledForUtc: string }).scheduledForUtc).toBe(dayAt(1));
  });

  it("Edge: 유지된 보류의 해제는 파생에 쓴 triggerId 로 발화하고 occurrence ID 가 그대로다 (test_SC044_released_hold_fires_with_derivation_trigger_id)", () => {
    const { journal, definitionId } = twoHeldSignals("amd044t");
    const oldest = journal.definition(definitionId).held[0];
    committed(
      journal.amend(
        definitionId,
        { activation: signalActivation({ triggerId: "renamed_trigger" }) },
        dayAt(0, "08:00"),
      ),
    );
    expect(journal.definition(definitionId).held[0]?.occurrenceId).toBe(oldest?.occurrenceId);
    freeSlot(journal, definitionId);
    const released = committed(journal.release(definitionId, dayAt(0, "09:01")));
    expect(
      payloadsOf(released, "trigger_fired").map((f) => [f["triggerId"], f["occurrenceId"]]),
    ).toEqual([[oldest?.triggerId, oldest?.occurrenceId]]);
    expect(oldest?.triggerId).toBe("on_signal");
  });
});

const STEPS_RULE = "test-steps";
const HELD = "work_definition_occurrence_held";
const SKIPPED = "work_definition_occurrences_skipped";
const WORK_BUNDLE = [
  "work_created",
  "work_planning_started",
  "task_created",
  "work_plan_committed",
  "work_ready",
];

function step(scheduledForUtc: RecurrenceStep["scheduledForUtc"], recurrenceIndex: number) {
  return { scheduledForUtc, recurrenceIndex };
}

function scheduleRow(definitionId: WorkDefinitionId, step: RecurrenceStep) {
  return {
    occurrenceId: scheduleOccurrenceId(
      definitionId,
      "daily",
      step.scheduledForUtc,
      step.recurrenceIndex,
    ),
    triggerId: "daily",
    scheduledForUtc: step.scheduledForUtc,
    recurrenceIndex: step.recurrenceIndex,
  };
}

function definitionIn(state: WorkflowState, definitionId: WorkDefinitionId): DefinitionRecord {
  const record = Object.values(state.works).find(
    (w) => w.definition?.id === definitionId,
  )?.definition;
  if (record === undefined) throw new Error(`no definition ${definitionId} in state`);
  return record;
}

/** 직접 적용 상태와 커밋 이력을 접은 상태의 정의 기록. */
function bothViews(journal: WorkflowJournal, definitionId: WorkDefinitionId): DefinitionRecord[] {
  return [journal.definition(definitionId), definitionIn(journal.folded(), definitionId)];
}

function skipRows(commit: DomainCommit): unknown[][] {
  return skips(commit).map((s) => [
    s["reason"],
    s["count"],
    s["firstOriginalInstant"],
    s["lastOriginalInstant"],
  ]);
}

function retire(journal: WorkflowJournal, stewardId: WorkId, occurrenceId: OccurrenceId): void {
  journal.patchWork(stewardId, (aggregate) => {
    const definition = aggregate.definition;
    if (definition === undefined) throw new Error("steward has no definition");
    return {
      ...aggregate,
      definition: {
        ...definition,
        retiredOccurrenceIds: [...definition.retiredOccurrenceIds, occurrenceId],
      },
    };
  });
}

/** 로그 전체에서 그 시각을 담은 건너뜀 이벤트 수. */
function skipsCovering(journal: WorkflowJournal, instant: string): number {
  return journal.commits
    .flatMap((c) => skips(c))
    .filter(
      (s) =>
        Date.parse(String(s["firstOriginalInstant"])) <= Date.parse(instant) &&
        Date.parse(instant) <= Date.parse(String(s["lastOriginalInstant"])),
    ).length;
}

describe("SC-042: 개정이 고른 행이 미도래 대기 행과 같은 회차면 유지한다", () => {
  const sameDayPort = (period: StepPeriod) =>
    testStepRecurrence({
      rule: STEPS_RULE,
      period,
      steps: [step(dayAt(0, "20:00"), 0), step(dayAt(1), 1), step(dayAt(2), 2)],
    });

  it("Edge: 같은 주기로 넘긴 뒤 고른 행이 대기 행과 같으면 취소·재발급 없이 유지한다 (test_SC042_selected_row_matching_pending_kept_not_reissued)", () => {
    // (a) 현지 날짜 주기 — D 20:00 은 materialize 한 D 07:00 과 같은 날이라 넘기고 D+1 07:00(회차 1)을 고른다.
    const a = registerAndMaterializeFirst(
      definitionDeps("amd042k", undefined, sameDayPort("local_date")),
    );
    const pending = a.journal.definition(a.definitionId).pendingSchedule;
    expect(pending).toMatchObject(scheduleRow(a.definitionId, step(dayAt(1), 1)));
    const grantA = committed(
      a.journal.amend(
        a.definitionId,
        { activation: stepActivation(STEPS_RULE) },
        dayAt(0, "08:00"),
      ),
    );
    expect(typesOf(grantA)).not.toContain("trigger_canceled");
    expect(revisedNext(grantA)).toEqual(scheduleRow(a.definitionId, step(dayAt(1), 1)));
    for (const view of bothViews(a.journal, a.definitionId)) {
      expect(view.pendingSchedule?.occurrenceId).toBe(pending?.occurrenceId);
      expect(view.retiredOccurrenceIds).toEqual([]);
    }
    a.journal.completeWork(a.firstWorkId, dayAt(0, "09:00"));
    const fired = committed(a.journal.resolveDue(a.definitionId, dayAt(1)));
    expect(payloadsOf(fired, "trigger_fired").map((f) => f["occurrenceId"])).toEqual([
      pending?.occurrenceId,
    ]);

    // (b) UTC 시 단위 주기 — D 20:00 은 다른 주기라 취소 ID 일 때만 넘기고 잃는 주기로 기록한다.
    const b = registerAndMaterializeFirst(
      definitionDeps("amd042kb", undefined, sameDayPort("utc_hour")),
    );
    const pendingB = b.journal.definition(b.definitionId).pendingSchedule;
    // 레코드 패치: D 20:00 회차 ID 가 이미 취소된 상태. 대기 행이 된 적 없는 회차라 명령 경로로 만들 수 없어 다른 생성 경로 대용으로 둔다.
    retire(
      b.journal,
      b.stewardId,
      scheduleRow(b.definitionId, step(dayAt(0, "20:00"), 0)).occurrenceId,
    );
    const grantB = committed(
      b.journal.amend(
        b.definitionId,
        { activation: stepActivation(STEPS_RULE) },
        dayAt(0, "08:00"),
      ),
    );
    expect(typesOf(grantB)).not.toContain("trigger_canceled");
    expect(skipRows(grantB)).toEqual([
      ["definition_revised", 1, dayAt(0, "20:00"), dayAt(0, "20:00")],
    ]);
    expect(b.journal.definition(b.definitionId).pendingSchedule?.occurrenceId).toBe(
      pendingB?.occurrenceId,
    );

    // (c) ISO 주 주기 — D 는 월요일. 같은 주로 넘긴 후보는 대기 행과 같은 회차여도 유지하지 않는다.
    const weekly = (seed: string, pendingIndex: number) => {
      const port = testStepRecurrence({
        rule: STEPS_RULE,
        period: "iso_week",
        steps: [step(dayAt(1, "20:00"), 1), step(dayAt(2), pendingIndex), step(dayAt(9), 9)],
      });
      const r = registerAndMaterializeFirst(definitionDeps(seed, undefined, port));
      r.journal.completeWork(r.firstWorkId, dayAt(0, "09:00"));
      committed(r.journal.resolveDue(r.definitionId, dayAt(1)));
      const before = r.journal.definition(r.definitionId).pendingSchedule;
      expect(before).toMatchObject(scheduleRow(r.definitionId, step(dayAt(2), 2)));
      const grant = committed(
        r.journal.amend(
          r.definitionId,
          { activation: stepActivation(STEPS_RULE) },
          dayAt(1, "08:00"),
        ),
      );
      return { r, before, grant };
    };
    const sameIndex = weekly("amd042kc", 2);
    expect(payloadsOf(sameIndex.grant, "trigger_canceled").map((c) => c["occurrenceId"])).toEqual([
      sameIndex.before?.occurrenceId,
    ]);
    expect(revisedNext(sameIndex.grant)).toEqual(
      scheduleRow(sameIndex.r.definitionId, step(dayAt(9), 9)),
    );

    // 대조: 같은 시각을 다른 회차 번호로 내도 결과는 같다 — 취소와 새 행 하나.
    const otherIndex = weekly("amd042kd", 5);
    expect(canceledAt(otherIndex.grant)).toEqual([dayAt(2)]);
    expect(
      otherIndex.r.journal.definition(otherIndex.r.definitionId).pendingSchedule,
    ).toMatchObject(scheduleRow(otherIndex.r.definitionId, step(dayAt(9), 9)));
  });
});

describe("SC-042: 취소 ID 회차는 다시 발급하지 않고 잃는 주기로 한 번 기록한다", () => {
  // 개정 뒤 규칙: 회차 0 = D+1 05:00, 회차 1 = D+1 07:00(개정이 취소한 기존 대기 행과 같은 ID), 회차 2 = D+2 07:00.
  const RETIRED_STEPS = [
    step(dayAt(1, "05:00"), 0),
    step(dayAt(1), 1),
    step(dayAt(2), 2),
    step(dayAt(3), 3),
  ];

  function retiredRowDefinition(
    seed: string,
    options: { misfire?: MisfireSpec; period?: StepPeriod; steps?: readonly RecurrenceStep[] } = {},
  ) {
    const port = testStepRecurrence({
      rule: STEPS_RULE,
      period: options.period ?? "local_date",
      steps: options.steps ?? RETIRED_STEPS,
    });
    const r = registerAndMaterializeFirst(definitionDeps(seed, undefined, port));
    const activation = stepActivation(
      STEPS_RULE,
      options.misfire !== undefined ? { misfire: options.misfire } : {},
    );
    const grant = committed(r.journal.amend(r.definitionId, { activation }, dayAt(0, "08:00")));
    const retiredId = scheduleRow(r.definitionId, step(dayAt(1), 1)).occurrenceId;
    expect(payloadsOf(grant, "trigger_canceled").map((c) => c["occurrenceId"])).toEqual([
      retiredId,
    ]);
    expect(r.journal.definition(r.definitionId).pendingSchedule?.scheduledForUtc).toBe(
      dayAt(1, "05:00"),
    );
    expect(r.journal.definition(r.definitionId).retiredOccurrenceIds).toEqual([retiredId]);
    return { ...r, retiredId };
  }

  /** 늦게 해소한 결과 — D+1 05:00 하나를 발화하고 취소 ID 인 D+1 07:00 을 잃는 주기로 기록한다. */
  function expectLateFireWithLostRow(commit: DomainCommit, definitionId: WorkDefinitionId) {
    expect(typesOf(commit)).toEqual(["trigger_fired", ...WORK_BUNDLE, SKIPPED]);
    const fired = payloadsOf(commit, "trigger_fired")[0];
    expect(fired?.["originalInstant"]).toBe(dayAt(1, "05:00"));
    expect(fired?.["nextSchedule"]).toEqual(scheduleRow(definitionId, step(dayAt(2), 2)));
    expect(skipRows(commit)).toEqual([["definition_revised", 1, dayAt(1), dayAt(1)]]);
  }

  function expectNoRetiredIdInUse(journal: WorkflowJournal, definitionId: WorkDefinitionId) {
    for (const view of bothViews(journal, definitionId)) {
      const inUse = [
        ...view.materialized.map((m) => m.occurrenceId),
        ...view.held.map((h) => h.occurrenceId),
        ...(view.pendingSchedule !== undefined ? [view.pendingSchedule.occurrenceId] : []),
      ];
      for (const id of inUse) expect(view.retiredOccurrenceIds).not.toContain(id);
    }
  }

  it("Happy: 다음 행 계산은 취소 ID 회차를 넘기고 그 회차를 잃는 주기 건너뜀으로 기록한다 (test_SC042_resolution_skips_retired_id_as_lost_period)", () => {
    // (a) 첫 회차 Work 가 열려 있어 D+1 05:00 은 보류된다.
    const a = retiredRowDefinition("amd042ra");
    expect(a.journal.definition(a.definitionId).lastResolvedSchedule).toEqual({
      scheduledForUtc: dayAt(0),
      recurrenceIndex: 0,
    });
    const held = committed(a.journal.resolveDue(a.definitionId, dayAt(1, "05:00")));
    expect(typesOf(held)).toEqual([HELD, SKIPPED]);
    expect(payloadsOf(held, HELD)[0]?.["nextSchedule"]).toEqual(
      scheduleRow(a.definitionId, step(dayAt(2), 2)),
    );
    expect(skipRows(held)).toEqual([["definition_revised", 1, dayAt(1), dayAt(1)]]);
    expect("nextSchedule" in (skips(held)[0] ?? {})).toBe(false);
    for (const view of bothViews(a.journal, a.definitionId)) {
      expect(view.pendingSchedule?.scheduledForUtc).toBe(dayAt(2));
      expect(view.retiredOccurrenceIds).not.toContain(view.pendingSchedule?.occurrenceId);
      expect(view.lastResolvedSchedule).toEqual({ scheduledForUtc: dayAt(1), recurrenceIndex: 1 });
    }

    // (b) 회차 1 뒤 회차가 없으면 발화·잃는 주기 기록 뒤 계열 끝으로 중지한다.
    const b = retiredRowDefinition("amd042rb", { steps: RETIRED_STEPS.slice(0, 2) });
    b.journal.completeWork(b.firstWorkId, dayAt(0, "09:00"));
    const last = committed(b.journal.resolveDue(b.definitionId, dayAt(1, "05:00")));
    expect(typesOf(last)).toEqual([
      "trigger_fired",
      ...WORK_BUNDLE,
      SKIPPED,
      "work_definition_stopped",
      "work_completed",
    ]);
    expect(payloadsOf(last, "trigger_fired")[0]?.["nextSchedule"]).toBeNull();
    expect(skipRows(last)).toEqual([["definition_revised", 1, dayAt(1), dayAt(1)]]);
    expect(payloadsOf(last, "work_definition_stopped")[0]?.["stopOrigin"]).toMatchObject({
      kind: "series_exhausted",
    });
    expect(b.journal.definition(b.definitionId).state).toBe("STOPPED");

    // 대조: D+1 07:00 을 다른 회차 번호로 내면 취소 ID 가 아니라 건너뜀 없이 대기 행이 된다.
    const c = retiredRowDefinition("amd042rc", {
      steps: [step(dayAt(1, "05:00"), 0), step(dayAt(1), 7), step(dayAt(2), 8)],
    });
    const contrast = committed(c.journal.resolveDue(c.definitionId, dayAt(1, "05:00")));
    expect(typesOf(contrast)).toEqual([HELD]);
    expect(c.journal.definition(c.definitionId).pendingSchedule).toMatchObject(
      scheduleRow(c.definitionId, step(dayAt(1), 7)),
    );
  });

  it("Edge: 만기 집합의 취소 ID 회차는 정책 건너뜀과 따로 기록하고 중지 건너뜀은 나누지 않는다 (test_SC042_lost_due_rows_split_from_policy_skip_not_stop_skip)", () => {
    // (a) misfire skip — D+1 05:00 은 정책 건너뜀, D+1 07:00 은 잃는 주기 건너뜀.
    const a = retiredRowDefinition("amd042sa", { misfire: { kind: "skip" } });
    a.journal.completeWork(a.firstWorkId, dayAt(0, "09:00"));
    const late = committed(a.journal.resolveDue(a.definitionId, dayAt(1, "07:30")));
    expect(typesOf(late)).toEqual([SKIPPED, SKIPPED]);
    expect(skipRows(late)).toEqual([
      ["misfire_skip", 1, dayAt(1, "05:00"), dayAt(1, "05:00")],
      ["definition_revised", 1, dayAt(1), dayAt(1)],
    ]);
    expect(skips(late)[0]?.["nextSchedule"]).toEqual(
      scheduleRow(a.definitionId, step(dayAt(2), 2)),
    );
    expect("nextSchedule" in (skips(late)[1] ?? {})).toBe(false);

    // 대조: 제때(D+1 06:00) 해소하면 D+1 05:00 을 materialize 하고 앞선 취소 ID 회차를 기록한다.
    const onTime = retiredRowDefinition("amd042s6", { misfire: { kind: "skip" } });
    onTime.journal.completeWork(onTime.firstWorkId, dayAt(0, "09:00"));
    const fired = committed(onTime.journal.resolveDue(onTime.definitionId, dayAt(1, "06:00")));
    expect(typesOf(fired)).toEqual(["trigger_fired", ...WORK_BUNDLE, SKIPPED]);
    expect(payloadsOf(fired, "trigger_fired")[0]?.["originalInstant"]).toBe(dayAt(1, "05:00"));
    expect(skipRows(fired)).toEqual([["definition_revised", 1, dayAt(1), dayAt(1)]]);

    // (b) 중지는 만기 회차 전부를 건너뜀 하나로 기록한다 — 잃는 주기 건너뜀을 따로 두지 않는다.
    const b = retiredRowDefinition("amd042sb");
    b.journal.completeWork(b.firstWorkId, dayAt(0, "09:00"));
    const stopped = commitOf(b.journal.control(b.definitionId, "stop", dayAt(1, "07:30")));
    expect(definitionEventsIn(stopped)).toEqual(["work_definition_stopped", SKIPPED]);
    expect(skipRows(stopped)).toEqual([["definition_stopped", 2, dayAt(1, "05:00"), dayAt(1)]]);
  });

  it("Edge: fire_once_now 후보는 취소 ID 를 뺀 만기 회차의 마지막이다 (test_SC042_fire_once_now_candidate_is_last_issuable_row)", () => {
    const main = retiredRowDefinition("amd042fa");
    main.journal.completeWork(main.firstWorkId, dayAt(0, "09:00"));
    const late = committed(main.journal.resolveDue(main.definitionId, dayAt(1, "07:30")));
    expectLateFireWithLostRow(late, main.definitionId);
    expectNoRetiredIdInUse(main.journal, main.definitionId);

    // 변형 (i): 첫 회차 Work 가 열려 있으면 같은 후보를 보류한다.
    const open = retiredRowDefinition("amd042fi");
    const held = committed(open.journal.resolveDue(open.definitionId, dayAt(1, "07:30")));
    expect(typesOf(held)).toEqual([HELD, SKIPPED]);
    const heldPayload = payloadsOf(held, HELD)[0];
    expect((heldPayload?.["occurrence"] as { originalInstant?: string }).originalInstant).toBe(
      dayAt(1, "05:00"),
    );
    expect(heldPayload?.["nextSchedule"]).toEqual(
      scheduleRow(open.definitionId, step(dayAt(2), 2)),
    );
    expect(skipRows(held)).toEqual([["definition_revised", 1, dayAt(1), dayAt(1)]]);
    expectNoRetiredIdInUse(open.journal, open.definitionId);

    // 변형 (ii): 일시정지 중 도래하고 재개(지연 표식) 뒤 해소해도 같다.
    const paused = retiredRowDefinition("amd042fp");
    paused.journal.completeWork(paused.firstWorkId, dayAt(0, "09:00"));
    commitOf(paused.journal.control(paused.definitionId, "pause", dayAt(0, "10:00")));
    commitOf(paused.journal.control(paused.definitionId, "resume", dayAt(1, "07:30")));
    expect(paused.journal.definition(paused.definitionId).pendingSchedule?.overdue).toBe(true);
    const resumed = committed(paused.journal.resolveDue(paused.definitionId, dayAt(1, "07:30")));
    expectLateFireWithLostRow(resumed, paused.definitionId);

    // 대조: catch_up_bounded(2) 도 발급 가능한 만기 회차가 하나라 같은 결과다.
    const bounded = retiredRowDefinition("amd042fc", {
      misfire: { kind: "catch_up_bounded", maxCatchUp: 2 },
    });
    bounded.journal.completeWork(bounded.firstWorkId, dayAt(0, "09:00"));
    const caught = committed(bounded.journal.resolveDue(bounded.definitionId, dayAt(1, "07:30")));
    expectLateFireWithLostRow(caught, bounded.definitionId);
    expectNoRetiredIdInUse(bounded.journal, bounded.definitionId);
  });

  it("Edge: 보류 해제는 장부를 내리지 않아 뒤 개정이 같은 잃는 주기를 다시 기록하지 않는다 (test_SC042_last_resolved_never_lowers_so_lost_period_recorded_once)", () => {
    const r = retiredRowDefinition("amd042lr", { period: "utc_hour" });
    expect(r.journal.definition(r.definitionId).lastResolvedSchedule).toEqual({
      scheduledForUtc: dayAt(0),
      recurrenceIndex: 0,
    });
    const resolved = committed(r.journal.resolveDue(r.definitionId, dayAt(1, "05:00")));
    expect(typesOf(resolved)).toEqual([HELD, SKIPPED]);
    // 대조: 해소 커밋은 장부를 D 07:00 에서 D+1 07:00 으로 올린다.
    expect(r.journal.definition(r.definitionId).lastResolvedSchedule).toEqual({
      scheduledForUtc: dayAt(1),
      recurrenceIndex: 1,
    });
    r.journal.completeWork(r.firstWorkId, dayAt(1, "05:30"));
    const released = committed(r.journal.release(r.definitionId, dayAt(1, "06:00")));
    expect(payloadsOf(released, "trigger_fired").map((f) => f["originalInstant"])).toEqual([
      dayAt(1, "05:00"),
    ]);
    for (const view of bothViews(r.journal, r.definitionId)) {
      expect(view.lastResolvedSchedule).toEqual({ scheduledForUtc: dayAt(1), recurrenceIndex: 1 });
    }
    const pending = r.journal.definition(r.definitionId).pendingSchedule;
    expect(pending?.scheduledForUtc).toBe(dayAt(2));
    const amended = committed(
      r.journal.amend(r.definitionId, { title: "renamed" }, dayAt(1, "06:30")),
    );
    expect(typesOf(amended)).not.toContain(SKIPPED);
    expect(typesOf(amended)).not.toContain("trigger_canceled");
    expect(r.journal.definition(r.definitionId).pendingSchedule?.occurrenceId).toBe(
      pending?.occurrenceId,
    );
    expect(skipsCovering(r.journal, dayAt(1))).toBe(1);
  });

  it("Edge: 보류 회차를 건너뛰는 개정은 장부를 내리지 않는다 (test_SC042_amendment_skip_of_held_keeps_last_resolved)", () => {
    const r = retiredRowDefinition("amd042ls", { period: "utc_hour" });
    const from = r.journal.commits.length;
    expect(typesOf(committed(r.journal.resolveDue(r.definitionId, dayAt(1, "05:00"))))).toEqual([
      HELD,
      SKIPPED,
    ]);
    const first = committed(
      r.journal.amend(r.definitionId, { title: "renamed" }, dayAt(1, "06:00")),
    );
    expect(skipRows(first)).toEqual([
      ["definition_revised", 1, dayAt(1, "05:00"), dayAt(1, "05:00")],
    ]);
    for (const view of bothViews(r.journal, r.definitionId)) {
      expect(view.held).toEqual([]);
      expect(view.lastResolvedSchedule).toEqual({ scheduledForUtc: dayAt(1), recurrenceIndex: 1 });
    }
    const second = committed(
      r.journal.amend(r.definitionId, { title: "renamed again" }, dayAt(1, "06:30")),
    );
    expect(typesOf(second)).not.toContain(SKIPPED);
    expect(skipsCovering(r.journal, dayAt(1))).toBe(1);
    expect(r.journal.commits.slice(from).flatMap((c) => typesOf(c))).not.toContain("trigger_fired");
  });

  it("Error: 대기 행 ID 가 취소 목록에 있으면 해소가 불변식 오류로 닫힌다 (test_SC042_retired_pending_row_fails_closed_on_resolution)", () => {
    const r = retiredRowDefinition("amd042rx");
    const pending = r.journal.definition(r.definitionId).pendingSchedule;
    if (pending === undefined) throw new Error("expected pending row");
    // 레코드 패치: 대기 행 ID 가 취소 목록에 든 상태. 명령 경로는 이 상태를 만들지 않으므로 다른 생성 경로 대용으로 둔다.
    retire(r.journal, r.stewardId, pending.occurrenceId);
    const stateBefore = r.journal.state;
    const commitsBefore = r.journal.commits.length;
    expect(() => r.journal.resolveDue(r.definitionId, dayAt(1, "05:00"))).toThrow(
      DomainInvariantError,
    );
    expect(r.journal.state).toBe(stateBefore);
    expect(r.journal.commits).toHaveLength(commitsBefore);

    // 대조: 패치하지 않은 같은 정의의 같은 해소는 커밋한다.
    const clean = retiredRowDefinition("amd042ry");
    expect(clean.journal.resolveDue(clean.definitionId, dayAt(1, "05:00")).kind).toBe("committed");
  });
});

describe("SC-042: catch_up_bounded 후보는 발급 가능한 만기 회차에서 고른다", () => {
  it("Edge: 만기 집합의 마지막이 취소 ID 여도 후보는 발급 가능한 회차의 마지막 k 개다 (test_SC042_catch_up_candidates_from_issuable_rows)", () => {
    const rule = "test-steps-catchup";
    const port = testStepRecurrence({
      rule,
      period: "local_date",
      steps: [
        step(dayAt(1, "05:00"), 3),
        step(dayAt(1, "06:00"), 4),
        step(dayAt(1), 5),
        step(dayAt(2), 6),
      ],
    });
    const r = registerAndMaterializeFirst(
      definitionDeps("amd042cu", undefined, port),
      definitionDraft({ activation: dailyActivation({ anchorUtc: dayAt(-4) }) }),
    );
    const pending = r.journal.definition(r.definitionId).pendingSchedule;
    expect(pending).toMatchObject(scheduleRow(r.definitionId, step(dayAt(1), 5)));
    const grant = committed(
      r.journal.amend(
        r.definitionId,
        {
          activation: stepActivation(rule, {
            misfire: { kind: "catch_up_bounded", maxCatchUp: 2 },
            anchorUtc: dayAt(-4),
          }),
        },
        dayAt(0, "08:00"),
      ),
    );
    expect(payloadsOf(grant, "trigger_canceled").map((c) => c["occurrenceId"])).toEqual([
      scheduleRow(r.definitionId, step(dayAt(1), 5)).occurrenceId,
    ]);
    r.journal.completeWork(r.firstWorkId, dayAt(0, "09:00"));
    const late = committed(r.journal.resolveDue(r.definitionId, dayAt(1, "07:30")));
    expect(typesOf(late)).toEqual(["trigger_fired", ...WORK_BUNDLE, HELD, SKIPPED]);
    expect(payloadsOf(late, "trigger_fired")[0]?.["originalInstant"]).toBe(dayAt(1, "05:00"));
    expect(
      (payloadsOf(late, HELD)[0]?.["occurrence"] as { originalInstant?: string }).originalInstant,
    ).toBe(dayAt(1, "06:00"));
    expect(skipRows(late)).toEqual([["definition_revised", 1, dayAt(1), dayAt(1)]]);
  });
});
