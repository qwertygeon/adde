// 20만 개 대량 배열 — 보류·만기 회차가 매우 많아도 중지·해소가 예외 없이 한 커밋으로 끝난다.
// 상태는 각 시험 본문에서 레코드 패치로 만든다(회차를 하나씩 커밋하지 않는다).
import { describe, expect, it } from "vitest";
import {
  DomainInvariantError,
  evolveCommit,
  judgeDefinitionSignal,
} from "../../../src/workflow/domain/index.js";
import type {
  DomainCommit,
  OccurrenceId,
  RecurrenceExpander,
  TriggerSpec,
  UtcInstant,
  WorkAggregate,
  WorkDefinitionId,
} from "../../../src/workflow/domain/index.js";
import {
  DEF_ANCHOR,
  WorkflowJournal,
  controlSignal,
  dayAt,
  definitionDeps,
  definitionDraft,
  payloadsOf,
  registerAndMaterializeFirst,
  registerDefinition,
  signalDefinitionDraft,
  stepActivation,
  testDailyRecurrence,
  typesOf,
  vaultOrigin,
} from "./helpers/definition-fixtures.js";
import type { MisfireSpec } from "./helpers/definition-fixtures.js";
import { at } from "./helpers/fixtures.js";

const BULK = 200_000;
const BULK_RULE = "test-bulk-seconds";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

type Step = ReturnType<RecurrenceExpander["firstAtOrAfter"]>;

/** 결정적 회차 ID — `occ_` + base32 26자. 파생 ID 와 겹치지 않게 첫 글자를 고정한다. */
function bulkOccurrenceId(index: number): OccurrenceId {
  let body = "";
  let rest = index;
  for (let i = 0; i < 25; i += 1) {
    body = (BASE32[rest % 32] as string) + body;
    rest = Math.floor(rest / 32);
  }
  return `occ_Z${body}` as OccurrenceId;
}

function committedCommit(outcome: { kind: string; commit?: DomainCommit }): DomainCommit {
  if ((outcome.kind !== "committed" && outcome.kind !== "accepted") || outcome.commit === undefined)
    throw new Error(`expected a commit, got ${outcome.kind}`);
  return outcome.commit;
}

function skips(commit: DomainCommit): Record<string, unknown>[] {
  return payloadsOf(commit, "work_definition_occurrences_skipped");
}

function stoppedBy(commit: DomainCommit): unknown[] {
  return payloadsOf(commit, "work_definition_stopped").map(
    (s) => (s["stopOrigin"] as Record<string, unknown>)["kind"],
  );
}

/** 보류 목록을 첫 보류 항목을 틀로 `count` 개로 바꾼다 — 회차 ID·번호만 다르다. */
function patchHeld(journal: WorkflowJournal, definitionId: WorkDefinitionId, count: number): void {
  const stewardId = journal.steward(definitionId).work.id;
  journal.patchWork(stewardId, (aggregate: WorkAggregate) => {
    const definition = aggregate.definition;
    const template = definition?.held[0];
    if (definition === undefined || template === undefined)
      throw new Error("expected one held occurrence to copy");
    const held = [template];
    for (let i = 1; i < count; i += 1) {
      const copy =
        template.recurrenceIndex !== undefined
          ? {
              ...template,
              occurrenceId: bulkOccurrenceId(i),
              recurrenceIndex: template.recurrenceIndex + i,
            }
          : { ...template, occurrenceId: bulkOccurrenceId(i) };
      held.push(copy);
    }
    return { ...aggregate, definition: { ...definition, held } };
  });
}

/** 일일 정의 — 첫 회차 Work 를 열어 둔 채 둘째 회차를 보류하고, 보류를 `count` 개로 늘린다. */
function scheduleWithHeld(seed: string, count: number) {
  const registered = registerAndMaterializeFirst(definitionDeps(seed));
  const { journal, definitionId } = registered;
  committedCommit(journal.resolveDue(definitionId, dayAt(1)));
  expect(journal.definition(definitionId).held).toHaveLength(1);
  patchHeld(journal, definitionId, count);
  return registered;
}

/** 신호 정의(열린 회차 1) — 첫 신호는 materialize, 둘째는 보류, 보류를 `count` 개로 늘린 뒤 첫 Work 를 끝낸다. */
function signalWithHeld(seed: string, maxOccurrences: number, count: number) {
  const registered = registerDefinition(definitionDeps(seed), {
    draft: signalDefinitionDraft({ maxOpenOccurrences: 1, maxOccurrences }),
  });
  const { journal, definitionId } = registered;
  committedCommit(journal.external(definitionId, "s1", dayAt(0)));
  committedCommit(journal.external(definitionId, "s2", dayAt(0, "08:00")));
  expect(journal.definition(definitionId).held).toHaveLength(1);
  if (count > 1) patchHeld(journal, definitionId, count);
  const [firstWorkId] = journal.occurrenceWorkIds(definitionId);
  if (firstWorkId === undefined) throw new Error("expected first occurrence work");
  journal.completeWork(firstWorkId, dayAt(0, "09:00"));
  return registered;
}

function secondsAfterAnchor(atOrAfter: UtcInstant): number {
  return Math.max(0, Math.ceil((Date.parse(atOrAfter) - Date.parse(DEF_ANCHOR)) / 1000));
}

function stepAt(k: number): Step {
  return {
    scheduledForUtc: new Date(Date.parse(DEF_ANCHOR) + k * 1000).toISOString() as UtcInstant,
    recurrenceIndex: k,
  };
}

function ruleOf(activation: TriggerSpec): unknown {
  return (activation as unknown as { readonly recurrence?: { readonly rule?: unknown } }).recurrence
    ?.rule;
}

/** 초 단위 산술 반복 포트 — 질의당 O(1). `earlyFrom` 이상 번호에서는 질의 시각보다 1초 이른 회차를 낸다. */
function secondsRecurrence(earlyFrom?: number): RecurrenceExpander {
  return {
    firstAtOrAfter(activation: TriggerSpec, atOrAfter: UtcInstant): Step {
      if (ruleOf(activation) !== BULK_RULE)
        return testDailyRecurrence.firstAtOrAfter(activation, atOrAfter);
      const k = secondsAfterAnchor(atOrAfter);
      if (earlyFrom !== undefined && k >= earlyFrom) {
        const early = stepAt(k - 1);
        return early;
      }
      return stepAt(k);
    },
    periodOf(activation: TriggerSpec, scheduledForUtc: UtcInstant): string {
      if (ruleOf(activation) !== BULK_RULE)
        return testDailyRecurrence.periodOf(activation, scheduledForUtc);
      return scheduledForUtc.slice(0, 19);
    },
  };
}

/** 첫 회차를 끝낸 초 단위 정의 — 다음 해소가 만기 회차 여럿을 한 번에 본다. */
function secondsDefinition(seed: string, misfire: MisfireSpec, port: RecurrenceExpander) {
  const deps = { ...definitionDeps(seed), recurrence: port };
  const registered = registerAndMaterializeFirst(
    deps,
    definitionDraft({ activation: stepActivation(BULK_RULE, { misfire }) }),
  );
  registered.journal.completeWork(registered.firstWorkId, DEF_ANCHOR);
  return registered;
}

/** 대기 행 다음 `count` 개 회차가 만기인 시각(마지막 회차 뒤 0.5초). */
function dueAfter(count: number): UtcInstant {
  return at(new Date(Date.parse(DEF_ANCHOR) + count * 1000 + 500).toISOString());
}

describe("SC-031: 보류 20만 개의 제어 중지", () => {
  it("Happy: 사람 출처 중지는 수용되고 STOPPED 이며 건너뜀 이벤트 하나가 200,000 회차를 센다 (test_SC031_bulk_held_control_stop)", () => {
    const { journal, definitionId } = scheduleWithHeld("bulk031h", BULK);
    const commit = committedCommit(journal.control(definitionId, "stop", dayAt(1, "08:00")));
    const skipped = skips(commit);
    expect(skipped.map((s) => [s["reason"], s["count"]])).toEqual([["definition_stopped", BULK]]);
    expect((skipped[0]?.["heldOccurrenceIds"] as unknown[]).length).toBe(BULK);
    expect(journal.definition(definitionId).state).toBe("STOPPED");
    expect(journal.definition(definitionId).held).toHaveLength(0);
  }, 15_000);

  it("Edge: 수용 커밋을 패치 전 관리 Work 에 재생하면 보류 0 의 STOPPED 다 (test_SC031_bulk_stop_commit_replays)", () => {
    const { journal, definitionId, stewardId } = scheduleWithHeld("bulk031e", BULK);
    const before = journal.work(stewardId);
    const commit = committedCommit(journal.control(definitionId, "stop", dayAt(1, "08:00")));
    const replayed = evolveCommit(
      before,
      commit.events.filter((event) => event.workId === stewardId),
    );
    expect(replayed.definition?.state).toBe("STOPPED");
    expect(replayed.definition?.held).toHaveLength(0);
    expect(replayed.definition).toEqual(journal.definition(definitionId));
  }, 15_000);

  it("Error: 사람 아닌 출처 중지는 출처 거절 기록이고 정의는 그대로다 (test_SC031_bulk_non_human_stop_recorded)", () => {
    const { journal, definitionId } = scheduleWithHeld("bulk031r", BULK);
    const before = journal.definition(definitionId);
    const signal = controlSignal(journal.deps, {
      definitionId,
      expectedRevision: before.revision,
      action: "stop",
      actorSource: "agent_session",
      receivedAt: dayAt(1, "08:00"),
    });
    const judged = judgeDefinitionSignal(journal.deps, journal.state, signal, dayAt(1, "08:00"));
    expect(judged.kind).toBe("rejected");
    if (judged.kind !== "rejected") return;
    expect(judged.reason).toBe("provenance_not_human");
    expect(judged.state.works[journal.steward(definitionId).work.id]?.definition).toBe(before);
    expect(before.held).toHaveLength(BULK);
  }, 15_000);
});

describe("SC-032: 보류 20만 개의 관리 Work 취소 연쇄 중지", () => {
  it("Happy: 유효한 cancel_work 는 같은 커밋에서 정의를 STOPPED 로 둔다 (test_SC032_bulk_steward_cancel_stops_definition)", () => {
    const { journal, definitionId, stewardId } = scheduleWithHeld("bulk032h", BULK);
    const commit = committedCommit(journal.cancelWork(stewardId, dayAt(1, "08:00")));
    expect(typesOf(commit)).toEqual(
      expect.arrayContaining(["work_canceled", "work_definition_stopped"]),
    );
    expect(stoppedBy(commit)).toEqual(["work_cascade"]);
    expect(journal.definition(definitionId).state).toBe("STOPPED");
  }, 15_000);

  it("Edge: 같은 커밋의 건너뜀은 200,000 회차다 (test_SC032_bulk_cancel_skip_count)", () => {
    const { journal, definitionId, stewardId } = scheduleWithHeld("bulk032e", BULK);
    const commit = committedCommit(journal.cancelWork(stewardId, dayAt(1, "08:00")));
    expect(skips(commit).map((s) => [s["reason"], s["count"]])).toEqual([
      ["definition_stopped", BULK],
    ]);
    expect(journal.definition(definitionId).held).toHaveLength(0);
  }, 15_000);

  it("Error: meta 출처와 다른 취소 출처는 invalid_input 이고 정의는 그대로다 (test_SC032_bulk_mismatched_cancel_rejected)", () => {
    const { journal, definitionId, stewardId } = scheduleWithHeld("bulk032r", BULK);
    const before = journal.definition(definitionId);
    const outcome = journal.onWork(
      stewardId,
      { kind: "cancel_work", origin: vaultOrigin(journal.deps) },
      dayAt(1, "08:00"),
      { actorSource: "unknown" },
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.rejection.reason).toBe("invalid_input");
    expect(journal.definition(definitionId)).toBe(before);
  }, 15_000);
});

describe("SC-033: 보류 20만 개의 계열 소진 중지", () => {
  it("Happy: 상한에 닿는 보류 해제는 series_exhausted 중지로 수용되고 남은 보류를 건너뛴다 (test_SC033_bulk_series_exhausted_stop)", () => {
    const { journal, definitionId } = signalWithHeld("bulk033h", 2, BULK);
    const commit = committedCommit(journal.release(definitionId, dayAt(0, "10:00")));
    expect(typesOf(commit)).toContain("trigger_fired");
    expect(stoppedBy(commit)).toEqual(["series_exhausted"]);
    expect(skips(commit).map((s) => [s["reason"], s["count"]])).toEqual([
      ["definition_stopped", BULK - 1],
    ]);
    expect(journal.definition(definitionId).state).toBe("STOPPED");
    expect(journal.definition(definitionId).held).toHaveLength(0);
  }, 15_000);

  it("Edge: 상한 전 해제는 중지 없이 보류 하나만 줄인다 (test_SC033_bulk_before_exhaustion_no_stop)", () => {
    const { journal, definitionId } = signalWithHeld("bulk033e", 3, BULK);
    const commit = committedCommit(journal.release(definitionId, dayAt(0, "10:00")));
    expect(stoppedBy(commit)).toEqual([]);
    expect(journal.definition(definitionId).state).toBe("ACTIVE");
    expect(journal.definition(definitionId).held).toHaveLength(BULK - 1);
  }, 15_000);

  it("Error: 대조 — 보류가 하나뿐인 같은 정의도 같은 소진 중지다 (test_SC033_no_held_same_exhaustion)", () => {
    const { journal, definitionId } = signalWithHeld("bulk033r", 2, 1);
    const commit = committedCommit(journal.release(definitionId, dayAt(0, "10:00")));
    expect(stoppedBy(commit)).toEqual(["series_exhausted"]);
    expect(skips(commit)).toEqual([]);
    expect(journal.definition(definitionId).state).toBe("STOPPED");
  }, 15_000);
});

describe("SC-034: 만기 20만 개의 해소", () => {
  it("Happy: skip 정책은 199,999 회차를 건너뛰고 마지막 회차를 materialize 한다 (test_SC034_bulk_due_skip_resolution_commits)", () => {
    const { journal, definitionId } = secondsDefinition(
      "bulk034h",
      { kind: "skip" },
      secondsRecurrence(),
    );
    const commit = committedCommit(journal.resolveDue(definitionId, dueAfter(BULK)));
    expect(skips(commit).map((s) => s["count"])).toEqual([BULK - 1]);
    expect(payloadsOf(commit, "trigger_fired").map((f) => f["recurrenceIndex"])).toEqual([BULK]);
  }, 15_000);

  it("Edge: catch_up_bounded(1) 도 커밋되고 건너뜀은 199,999 회차다 (test_SC034_bulk_due_catch_up_bounded_commits)", () => {
    const { journal, definitionId } = secondsDefinition(
      "bulk034e",
      { kind: "catch_up_bounded", maxCatchUp: 1 },
      secondsRecurrence(),
    );
    const commit = committedCommit(journal.resolveDue(definitionId, dueAfter(BULK)));
    expect(skips(commit).map((s) => s["count"])).toEqual([BULK - 1]);
    expect(payloadsOf(commit, "trigger_fired")).toHaveLength(1);
  }, 15_000);

  it("Error: 질의 시각보다 이른 회차를 내는 포트는 불변식 예외다 (test_SC034_early_port_output_invariant)", () => {
    const { journal, definitionId } = secondsDefinition(
      "bulk034r",
      { kind: "skip" },
      secondsRecurrence(3),
    );
    let thrown: unknown;
    try {
      journal.resolveDue(definitionId, dueAfter(5));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainInvariantError);
    expect(thrown).not.toBeInstanceOf(RangeError);
    expect(thrown).not.toBeInstanceOf(TypeError);
  }, 15_000);
});
