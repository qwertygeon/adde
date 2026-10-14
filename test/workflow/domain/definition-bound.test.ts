// 열린 회차 상한·지연 발화 정책별 보류·신호 보류·해제 순서·중지의 건너뜀 집계.
import { describe, expect, it } from "vitest";
import { findSteward, openOccurrenceCount } from "../../../src/workflow/domain/index.js";
import type { DomainCommit, WorkDefinitionId, WorkId } from "../../../src/workflow/domain/index.js";
import {
  DEF_NOW,
  dailyActivation,
  dayAt,
  definitionDeps,
  definitionDraft,
  payloadsOf,
  registerDefinition,
  signalDefinitionDraft,
  typesOf,
} from "./helpers/definition-fixtures.js";
import type { MisfireSpec, WorkflowJournal } from "./helpers/definition-fixtures.js";

function committed(outcome: { kind: string; commit?: DomainCommit }): DomainCommit {
  if (outcome.kind !== "committed" && outcome.kind !== "accepted") {
    throw new Error(`expected a commit, got ${JSON.stringify(outcome)}`);
  }
  if (outcome.commit === undefined) throw new Error("expected commit");
  return outcome.commit;
}

function scheduled(seed: string, misfire: MisfireSpec, maxOpenOccurrences = 1) {
  return registerDefinition(definitionDeps(seed), {
    draft: definitionDraft({ maxOpenOccurrences, activation: dailyActivation({ misfire }) }),
  });
}

function signaled(seed: string, maxOpenOccurrences = 1) {
  return registerDefinition(definitionDeps(seed), {
    draft: signalDefinitionDraft({ maxOpenOccurrences }),
  });
}

function heldInstants(journal: WorkflowJournal, definitionId: WorkDefinitionId): string[] {
  return journal.definition(definitionId).held.map((h) => h.originalInstant);
}

function skips(commits: readonly DomainCommit[]): Record<string, unknown>[] {
  return commits.flatMap((c) => payloadsOf(c, "work_definition_occurrences_skipped"));
}

function firstOccurrenceWork(journal: WorkflowJournal, definitionId: WorkDefinitionId): WorkId {
  const id = journal.occurrenceWorkIds(definitionId)[0];
  if (id === undefined) throw new Error("expected occurrence work");
  return id;
}

describe("SC-029: fire_once_now 는 보류 일정 회차를 하나로 유지한다", () => {
  it("Happy: 상한 1·열린 회차 1 에서 도래 셋이 앞 보류를 대체한다 (test_SC029_fire_once_now_supersedes_held_chain)", () => {
    const { journal, definitionId } = scheduled("bnd029", { kind: "fire_once_now" });
    committed(journal.resolveDue(definitionId, dayAt(0)));
    const commits: DomainCommit[] = [];
    for (const k of [1, 2, 3]) {
      commits.push(committed(journal.resolveDue(definitionId, dayAt(k))));
      expect(heldInstants(journal, definitionId), `day ${k}`).toEqual([dayAt(k)]);
    }
    expect(skips(commits).map((s) => [s["reason"], s["count"], s["firstOriginalInstant"]])).toEqual(
      [
        ["superseded_by_later", 1, dayAt(1)],
        ["superseded_by_later", 1, dayAt(2)],
      ],
    );
  });

  it("Edge: 자리가 빈 뒤 해제는 마지막 보류만 materialize 한다 (test_SC029_release_materializes_latest_held)", () => {
    const { journal, definitionId } = scheduled("bnd029e", { kind: "fire_once_now" });
    committed(journal.resolveDue(definitionId, dayAt(0)));
    for (const k of [1, 2, 3]) committed(journal.resolveDue(definitionId, dayAt(k)));
    journal.completeWork(firstOccurrenceWork(journal, definitionId), dayAt(3, "08:00"));
    const released = committed(journal.release(definitionId, dayAt(3, "08:00")));
    const fired = payloadsOf(released, "trigger_fired");
    expect(fired.map((f) => [f["originalInstant"], f["released"]])).toEqual([[dayAt(3), true]]);
    expect(journal.definition(definitionId).held).toEqual([]);
    expect(journal.definition(definitionId).materialized).toHaveLength(2);
  });

  it("Error: 여러 시각이 지난 뒤의 지연 해소도 보류 일정을 하나로 둔다 (test_SC029_overdue_resolution_keeps_one_held)", () => {
    const { journal, definitionId } = scheduled("bnd029x", { kind: "fire_once_now" });
    committed(journal.resolveDue(definitionId, dayAt(0)));
    const commit = committed(journal.resolveDue(definitionId, dayAt(3)));
    expect(heldInstants(journal, definitionId)).toEqual([dayAt(3)]);
    expect(skips([commit]).map((s) => [s["reason"], s["count"]])).toEqual([
      ["superseded_by_later", 2],
    ]);
  });
});

describe("SC-030: skip·catch_up_bounded 정책의 보류 수", () => {
  it("Happy: skip 은 도래 셋을 모두 건너뛴다 (test_SC030_skip_policy_skips_all)", () => {
    const { journal, definitionId } = scheduled("bnd030", { kind: "skip" });
    committed(journal.resolveDue(definitionId, dayAt(0)));
    const commits = [1, 2, 3].map((k) => committed(journal.resolveDue(definitionId, dayAt(k))));
    expect(journal.definition(definitionId).held).toEqual([]);
    const skipped = skips(commits);
    expect(skipped.map((s) => s["reason"])).toEqual([
      "misfire_skip",
      "misfire_skip",
      "misfire_skip",
    ]);
    expect(skipped.reduce((n, s) => n + Number(s["count"]), 0)).toBe(3);
  });

  it("Edge: catch_up_bounded 2 는 보류를 둘 이하로 두고 가장 오래된 것을 건너뛴다 (test_SC030_catch_up_bounded_keeps_at_most_two)", () => {
    const { journal, definitionId } = scheduled("bnd030e", {
      kind: "catch_up_bounded",
      maxCatchUp: 2,
    });
    committed(journal.resolveDue(definitionId, dayAt(0)));
    const commits = [1, 2, 3].map((k) => committed(journal.resolveDue(definitionId, dayAt(k))));
    expect(heldInstants(journal, definitionId)).toEqual([dayAt(2), dayAt(3)]);
    expect(skips(commits).map((s) => [s["reason"], s["firstOriginalInstant"]])).toEqual([
      ["superseded_by_later", dayAt(1)],
    ]);
  });

  it("Error: maxCatchUp 0 은 skip 과 같다 (test_SC030_catch_up_zero_behaves_as_skip)", () => {
    const { journal, definitionId } = scheduled("bnd030x", {
      kind: "catch_up_bounded",
      maxCatchUp: 0,
    });
    committed(journal.resolveDue(definitionId, dayAt(0)));
    const commits = [1, 2, 3].map((k) => committed(journal.resolveDue(definitionId, dayAt(k))));
    expect(journal.definition(definitionId).held).toEqual([]);
    expect(skips(commits).map((s) => s["reason"])).toEqual([
      "misfire_skip",
      "misfire_skip",
      "misfire_skip",
    ]);
  });

  it("Edge: skip 의 지연 판정은 회차별이다 — 앞 회차만 건너뛰고 제때 회차는 materialize, late 면 둘 다 건너뛴다 (test_SC030_skip_judges_overdue_per_occurrence)", () => {
    const onTime = scheduled("bnd030f1", { kind: "skip" });
    const commit = committed(onTime.journal.resolveDue(onTime.definitionId, dayAt(1)));
    expect(
      skips([commit]).map((s) => [s["reason"], s["count"], s["firstOriginalInstant"]]),
    ).toEqual([["misfire_skip", 1, dayAt(0)]]);
    expect(payloadsOf(commit, "trigger_fired").map((f) => f["originalInstant"])).toEqual([
      dayAt(1),
    ]);

    const late = scheduled("bnd030f2", { kind: "skip" });
    const lateCommit = committed(
      late.journal.resolveDue(late.definitionId, dayAt(1), { late: true }),
    );
    expect(skips([lateCommit]).map((s) => [s["reason"], s["count"]])).toEqual([
      ["misfire_skip", 2],
    ]);
    expect(typesOf(lateCommit)).not.toContain("trigger_fired");
  });

  it("Edge: 한 해소의 다중 후보는 같은 커밋의 앞 후보 결과를 반영한다 (test_SC030_candidates_see_earlier_candidates_in_commit)", () => {
    const { journal, definitionId } = scheduled("bnd030g", {
      kind: "catch_up_bounded",
      maxCatchUp: 3,
    });
    expect(journal.control(definitionId, "pause", DEF_NOW).kind).toBe("accepted");
    const resumed = journal.control(definitionId, "resume", dayAt(2, "08:00"));
    expect(resumed.kind).toBe("accepted");
    expect(journal.definition(definitionId).pendingSchedule?.overdue).toBe(true);
    const commit = committed(journal.resolveDue(definitionId, dayAt(2, "08:00")));
    expect(payloadsOf(commit, "trigger_fired").map((f) => f["originalInstant"])).toEqual([
      dayAt(0),
    ]);
    expect(
      payloadsOf(commit, "work_definition_occurrence_held").map((h) => [
        (h["occurrence"] as { originalInstant: string }).originalInstant,
        h["cause"],
      ]),
    ).toEqual([
      [dayAt(1), "open_bound"],
      [dayAt(2), "older_held"],
    ]);
    expect(openOccurrenceCount(journal.state, journal.definition(definitionId))).toBe(1);
  });
});

describe("SC-031: 신호 회차는 보류되어도 건너뛰지 않는다", () => {
  function fiveHeld(seed: string) {
    const registered = signaled(seed);
    const { journal, definitionId } = registered;
    committed(journal.external(definitionId, "src-0", dayAt(0)));
    const sources = ["src-1", "src-2", "src-3", "src-4", "src-5"];
    const commits = sources.map((s, i) =>
      committed(journal.external(definitionId, s, dayAt(0, `08:0${i}`))),
    );
    return { ...registered, sources, commits };
  }

  it("Happy: 상한에 닿은 신호 정의의 다섯 신호는 모두 보류되고 건너뜀이 없다 (test_SC031_signal_occurrences_all_held_never_skipped)", () => {
    const { journal, definitionId, commits } = fiveHeld("bnd031");
    expect(journal.definition(definitionId).held).toHaveLength(5);
    expect(skips(commits)).toEqual([]);
  });

  it("Edge: 보류 순서는 수용 순이다 (test_SC031_signal_holds_in_acceptance_order)", () => {
    const { journal, definitionId, sources } = fiveHeld("bnd031e");
    expect(
      journal
        .definition(definitionId)
        .held.map(
          (h) =>
            (h.input as { signal?: { sourceOccurrenceId: string } }).signal?.sourceOccurrenceId,
        ),
    ).toEqual(sources);
  });

  it("Error: 보류 중 회차의 재전달은 중복이고 보류가 늘지 않는다 (test_SC031_redelivery_not_held_twice)", () => {
    const { journal, definitionId } = fiveHeld("bnd031x");
    const again = journal.external(definitionId, "src-3", dayAt(0, "09:00"));
    expect(again.kind).toBe("duplicate");
    expect(journal.definition(definitionId).held).toHaveLength(5);
  });
});

describe("SC-032: 보류는 원래 순서로 해제되고 새 회차가 앞지르지 않는다", () => {
  function heldThree(seed: string) {
    const registered = signaled(seed, 2);
    const { journal, definitionId } = registered;
    for (const s of ["open-a", "open-b", "held-1", "held-2", "held-3"]) {
      committed(journal.external(definitionId, s, dayAt(0)));
    }
    for (const workId of journal.occurrenceWorkIds(definitionId))
      journal.completeWork(workId, dayAt(0, "08:00"));
    return registered;
  }
  const sourceOf = (journal: WorkflowJournal, workId: WorkId) =>
    (journal.work(workId).work.source as { input: { signal: { sourceOccurrenceId: string } } })
      .input.signal.sourceOccurrenceId;

  it("Happy: 해제 둘은 1·2 순으로 materialize 하고 새 회차는 3 뒤에 보류된다 (test_SC032_release_in_original_order_new_behind)", () => {
    const { journal, definitionId } = heldThree("bnd032");
    committed(journal.release(definitionId, dayAt(0, "08:01")));
    committed(journal.release(definitionId, dayAt(0, "08:02")));
    committed(journal.external(definitionId, "new-4", dayAt(0, "08:03")));
    expect(
      journal
        .occurrenceWorkIds(definitionId)
        .slice(2)
        .map((w) => sourceOf(journal, w)),
    ).toEqual(["held-1", "held-2"]);
    expect(
      journal
        .definition(definitionId)
        .held.map(
          (h) => (h.input as { signal: { sourceOccurrenceId: string } }).signal.sourceOccurrenceId,
        ),
    ).toEqual(["held-3", "new-4"]);
  });

  it("Edge: 새 신호 회차가 해제보다 먼저 와도 결과 순서가 같다 (test_SC032_new_arrival_before_release_same_order)", () => {
    const { journal, definitionId } = heldThree("bnd032e");
    committed(journal.external(definitionId, "new-4", dayAt(0, "08:00")));
    committed(journal.release(definitionId, dayAt(0, "08:01")));
    committed(journal.release(definitionId, dayAt(0, "08:02")));
    expect(
      journal
        .occurrenceWorkIds(definitionId)
        .slice(2)
        .map((w) => sourceOf(journal, w)),
    ).toEqual(["held-1", "held-2"]);
    expect(
      journal
        .definition(definitionId)
        .held.map(
          (h) => (h.input as { signal: { sourceOccurrenceId: string } }).signal.sourceOccurrenceId,
        ),
    ).toEqual(["held-3", "new-4"]);
  });

  it("Edge: 보류와 빈 자리가 함께 있는 일정 정의의 도래 처리는 held_release_pending 이다 (test_SC032_due_resolution_refused_while_release_pending)", () => {
    const { journal, definitionId } = scheduled("bnd032f", { kind: "fire_once_now" });
    committed(journal.resolveDue(definitionId, dayAt(0)));
    committed(journal.resolveDue(definitionId, dayAt(1)));
    journal.completeWork(firstOccurrenceWork(journal, definitionId), dayAt(2, "06:00"));
    const commitsBefore = journal.commits.length;
    expect(journal.resolveDue(definitionId, dayAt(2))).toEqual({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "held_release_pending" },
    });
    expect(journal.commits.length).toBe(commitsBefore);
    // 대조: 해제 뒤 같은 명령은 커밋되고 보류 회차는 건너뛰지 않고 materialize 된다.
    const released = committed(journal.release(definitionId, dayAt(2)));
    expect(payloadsOf(released, "trigger_fired").map((f) => f["originalInstant"])).toEqual([
      dayAt(1),
    ]);
    const due = committed(journal.resolveDue(definitionId, dayAt(2)));
    expect(skips([released, due])).toEqual([]);
  });

  it("Error: 빈 자리 없는 해제는 no_free_slot 이다 (test_SC032_release_without_free_slot_refused)", () => {
    const { journal, definitionId } = signaled("bnd032x");
    committed(journal.external(definitionId, "open", dayAt(0)));
    committed(journal.external(definitionId, "held", dayAt(0, "08:00")));
    expect(journal.release(definitionId, dayAt(0, "08:01"))).toEqual({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "no_free_slot" },
    });
  });
});

describe("SC-033: 중지의 건너뜀은 해소당 이벤트 하나다", () => {
  it("Happy: 보류 일정 둘·도래 시각 하나를 중지하면 건너뜀 하나에 개수 3 이다 (test_SC033_stop_one_skip_event_count_and_instants)", () => {
    const { journal, definitionId } = scheduled("bnd033", {
      kind: "catch_up_bounded",
      maxCatchUp: 2,
    });
    committed(journal.resolveDue(definitionId, dayAt(0)));
    committed(journal.resolveDue(definitionId, dayAt(1)));
    committed(journal.resolveDue(definitionId, dayAt(2)));
    const stop = committed(journal.control(definitionId, "stop", dayAt(3, "08:00")));
    const skipped = skips([stop]);
    expect(
      skipped.map((s) => [
        s["reason"],
        s["count"],
        s["firstOriginalInstant"],
        s["lastOriginalInstant"],
      ]),
    ).toEqual([["definition_stopped", 3, dayAt(1), dayAt(3)]]);
    expect(typesOf(stop)).not.toContain("trigger_canceled");
  });

  it("Edge: 보류 신호만 있으면 개수·시각은 수용 시각이다 (test_SC033_signal_holds_skip_instants_acceptance)", () => {
    const { journal, definitionId } = signaled("bnd033e");
    committed(journal.external(definitionId, "open", dayAt(0)));
    committed(journal.external(definitionId, "h1", dayAt(0, "08:00")));
    committed(journal.external(definitionId, "h2", dayAt(0, "09:00")));
    const stop = committed(journal.control(definitionId, "stop", dayAt(0, "10:00")));
    expect(
      skips([stop]).map((s) => [s["count"], s["firstOriginalInstant"], s["lastOriginalInstant"]]),
    ).toEqual([[2, dayAt(0, "08:00"), dayAt(0, "09:00")]]);
  });

  it("Error: 보류·도래가 없으면 건너뜀이 없고 trigger_canceled 만 있다 (test_SC033_nothing_to_skip_no_skip_event)", () => {
    const { journal, definitionId } = scheduled("bnd033x", { kind: "fire_once_now" });
    const stop = committed(journal.control(definitionId, "stop", DEF_NOW));
    expect(skips([stop])).toEqual([]);
    expect(typesOf(stop)).toContain("trigger_canceled");
  });
});

describe("SC-030: 보류가 상한에 닿은 뒤 후보가 여럿인 해소", () => {
  function fullHeldBound(seed: string) {
    const r = scheduled(seed, { kind: "catch_up_bounded", maxCatchUp: 2 });
    committed(r.journal.resolveDue(r.definitionId, dayAt(0)));
    committed(r.journal.resolveDue(r.definitionId, dayAt(1)));
    committed(r.journal.resolveDue(r.definitionId, dayAt(2)));
    expect(heldInstants(r.journal, r.definitionId)).toEqual([dayAt(1), dayAt(2)]);
    return r;
  }

  it("Edge: 후보마다 가장 오래된 보류를 한 번씩 밀어낸다 (test_SC030_full_held_bound_evicts_each_oldest_once)", () => {
    const r = fullHeldBound("bnd030full");
    const heldIds = r.journal.definition(r.definitionId).held.map((h) => h.occurrenceId);
    const commit = committed(r.journal.resolveDue(r.definitionId, dayAt(4)));
    expect(typesOf(commit)).toEqual([
      "work_definition_occurrences_skipped",
      "work_definition_occurrence_held",
      "work_definition_occurrence_held",
    ]);
    const skip = payloadsOf(commit, "work_definition_occurrences_skipped")[0];
    expect(skip?.["reason"]).toBe("superseded_by_later");
    expect(skip?.["count"]).toBe(2);
    expect(skip?.["heldOccurrenceIds"]).toEqual(heldIds);
    expect(heldInstants(r.journal, r.definitionId)).toEqual([dayAt(3), dayAt(4)]);
    const folded = findSteward(r.journal.folded(), r.definitionId)?.definition;
    expect(folded?.held.map((h) => h.originalInstant)).toEqual([dayAt(3), dayAt(4)]);

    // 대조: 후보 하나(D+3)면 가장 오래된 보류 하나만 밀어낸다.
    const one = fullHeldBound("bnd030one");
    const oldest = one.journal.definition(one.definitionId).held[0]?.occurrenceId;
    const single = committed(one.journal.resolveDue(one.definitionId, dayAt(3)));
    const singleSkip = payloadsOf(single, "work_definition_occurrences_skipped")[0];
    expect(singleSkip?.["count"]).toBe(1);
    expect(singleSkip?.["heldOccurrenceIds"]).toEqual([oldest]);
  });
});
