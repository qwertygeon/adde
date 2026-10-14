// 정의 전이 표 행·표 밖 조합·중지 흡수·정의 revision.
import { describe, expect, it } from "vitest";
import { DEFINITION_TRANSITION_ROWS } from "../../../src/workflow/domain/index.js";
import type { DomainCommit, WorkDefinitionId } from "../../../src/workflow/domain/index.js";
import {
  DEFINITION_EVENT_TYPES,
  dailyActivation,
  dayAt,
  definitionDeps,
  definitionDraft,
  planInvalidIssues,
  definitionInvalidReasons,
  registerAndMaterializeFirst,
  registerDefinition,
  signalDefinitionDraft,
  typesOf,
} from "./helpers/definition-fixtures.js";
import type { WorkflowJournal } from "./helpers/definition-fixtures.js";
import {
  ACTION_AT,
  STEWARD_MEMBER,
  applyDefinitionAction,
  buildDefinitionRowCases,
  offTableCombinations,
  reachDefinitionState,
} from "./helpers/definition-row-cases.js";
import { at } from "./helpers/fixtures.js";

const TRANSITION_EVENTS: ReadonlySet<string> = new Set([
  "work_definition_created",
  "work_definition_revised",
  "work_definition_paused",
  "work_definition_resumed",
  "work_definition_stopped",
]);

/** 표 밖 조합의 기대 결과 — 설계 검사 순서(초안 검증 사유·신호 판정 순서)에서 정한다. */
const OFF_TABLE_EXPECTED: Readonly<Record<string, string>> = {
  "NONE:revise": "plan_invalid:amends_not_steward",
  "NONE:pause": "not_applicable:unknown_subject",
  "NONE:resume": "not_applicable:unknown_subject",
  "NONE:stop": "not_applicable:unknown_subject",
  "ACTIVE:create": "plan_invalid:already_stewards_definition",
  "ACTIVE:resume": "rejected:unexpected_state",
  "PAUSED:create": "plan_invalid:already_stewards_definition",
  "PAUSED:pause": "rejected:unexpected_state",
  "STOPPED:create": "plan_invalid:already_stewards_definition",
  "STOPPED:revise": "plan_invalid:amends_definition_stopped",
  "STOPPED:pause": "rejected_stale:terminal_subject",
  "STOPPED:resume": "rejected_stale:terminal_subject",
  "STOPPED:stop": "rejected_stale:terminal_subject",
};

function revisionOf(journal: WorkflowJournal, definitionId: WorkDefinitionId): number {
  return journal.definition(definitionId).revision;
}

/** 단계마다 정의 revision 차와 커밋 이벤트를 기록한다. */
function stepRevisionDiffs(
  journal: WorkflowJournal,
  definitionId: WorkDefinitionId,
  steps: readonly [string, () => unknown, "prepare"?][],
): { name: string; diff: number; transition: boolean; types: string[] }[] {
  const out: { name: string; diff: number; transition: boolean; types: string[] }[] = [];
  for (const [name, run, prepare] of steps) {
    if (prepare !== undefined) {
      run();
      continue;
    }
    const before = revisionOf(journal, definitionId);
    const start = journal.commits.length;
    run();
    const commits: readonly DomainCommit[] = journal.commits.slice(start);
    expect(commits.length, name).toBe(1);
    const transition = commits.some((c) => c.events.some((e) => TRANSITION_EVENTS.has(e.type)));
    out.push({
      name,
      diff: revisionOf(journal, definitionId) - before,
      transition,
      types: commits.flatMap(typesOf),
    });
  }
  return out;
}

describe("SC-001: 정의 상태는 전이 표 6행만 허용한다", () => {
  it("Happy: 표의 각 행이 그 이벤트와 목표 상태를 커밋한다 (test_SC001_each_table_row_commits_event_and_target)", () => {
    const cases = buildDefinitionRowCases();
    // 표 6행의 출발 상태 전부가 케이스로 생성된다.
    const expectedCount = DEFINITION_TRANSITION_ROWS.reduce(
      (n, row) => n + Math.max(row.from.length, 1),
      0,
    );
    expect(Object.keys(cases).length).toBe(expectedCount);
    expect(DEFINITION_TRANSITION_ROWS.length).toBe(6);
    const observed: string[] = [];
    for (const [key, rowCase] of Object.entries(cases)) {
      const result = rowCase.apply(rowCase.build());
      const types = result.commits.flatMap(typesOf);
      observed.push(
        `${key} → ${result.outcome}:${String(result.after?.state)}:${String(types.includes(rowCase.row.event))}`,
      );
    }
    expect(observed).toEqual(
      Object.entries(cases).map(([key, rowCase]) => `${key} → accepted:${rowCase.row.to}:true`),
    );
  });

  it("Edge: 같은 상태 개정 행은 상태를 유지하고 revision 을 1 올린다 (test_SC001_same_state_revise_rows_bump_revision)", () => {
    for (const from of ["ACTIVE", "PAUSED"] as const) {
      const fixture = reachDefinitionState(from, `samerev${from.toLowerCase()}`);
      const result = applyDefinitionAction(fixture, "revise");
      expect(result.outcome, from).toBe("accepted");
      expect(result.after?.state, from).toBe(from);
      expect(result.after?.revision, from).toBe((result.before?.revision ?? -1) + 1);
      expect(result.after?.title, from).toBe("revised title");
    }
  });

  it("Error: 표 밖 (상태, 동작) 조합은 모두 거절되고 정의 상태·revision 이 그대로다 (test_SC001_non_table_combinations_rejected_unchanged)", () => {
    const combos = offTableCombinations();
    expect(combos.map((c) => `${c.state}:${c.action}`).sort()).toEqual(
      Object.keys(OFF_TABLE_EXPECTED).sort(),
    );
    for (const { state, action } of combos) {
      const label = `${state}:${action}`;
      const fixture = reachDefinitionState(state, `offtable${state.toLowerCase()}${action}`);
      const otherBefore = fixture.journal.definition(fixture.definitionId);
      const result = applyDefinitionAction(fixture, action);
      expect(result.outcome, label).toBe(OFF_TABLE_EXPECTED[label]);
      expect(result.after?.state, label).toBe(result.before?.state);
      expect(result.after?.revision, label).toBe(result.before?.revision);
      // 정의를 관리하지 않는 Work 의 동작은 다른 Work 가 관리하는 정의도 바꾸지 않는다.
      expect(fixture.journal.definition(fixture.definitionId), label).toEqual(otherBefore);
      for (const commit of result.commits) {
        expect(
          commit.events.filter((e) => TRANSITION_EVENTS.has(e.type)).map((e) => e.type),
          label,
        ).toEqual([]);
      }
    }
  });
});

describe("SC-002: STOPPED 는 흡수 상태다", () => {
  it("Happy: 중지 정의의 제어 신호 셋은 terminal_subject 낡음이고 정의가 그대로다 (test_SC002_stopped_control_signals_terminal_subject)", () => {
    for (const action of ["pause", "resume", "stop"] as const) {
      const { journal, definitionId } = reachDefinitionState("STOPPED", `stopctl${action}`);
      const before = journal.definition(definitionId);
      const judged = journal.control(definitionId, action, ACTION_AT);
      expect(judged.kind, action).toBe("rejected_stale");
      if (judged.kind === "rejected_stale") {
        expect(judged.reason, action).toBe("terminal_subject");
        expect(typesOf(judged.commit), action).toEqual(["signal_rejected_stale"]);
      }
      expect(journal.definition(definitionId), action).toEqual(before);
    }
  });

  it("Edge: 중지 정의의 외부 신호·도래 회차·해제는 terminal_subject 다 (test_SC002_stopped_external_signal_and_occurrence_commands_refused)", () => {
    const onSignal = registerDefinition(definitionDeps("stopext"), {
      draft: signalDefinitionDraft(),
    });
    expect(onSignal.journal.control(onSignal.definitionId, "stop", ACTION_AT).kind).toBe(
      "accepted",
    );
    const signalBefore = onSignal.journal.definition(onSignal.definitionId);
    const external = onSignal.journal.external(onSignal.definitionId, "src-1", ACTION_AT);
    expect(external.kind).toBe("rejected_stale");
    if (external.kind === "rejected_stale") expect(external.reason).toBe("terminal_subject");
    expect(onSignal.journal.definition(onSignal.definitionId)).toEqual(signalBefore);

    const scheduled = registerDefinition(definitionDeps("stopocc"), { tasks: STEWARD_MEMBER });
    const pending = scheduled.journal.definition(scheduled.definitionId).pendingSchedule;
    if (pending === undefined) throw new Error("expected pending schedule");
    expect(scheduled.journal.control(scheduled.definitionId, "stop", ACTION_AT).kind).toBe(
      "accepted",
    );
    const commitsBefore = scheduled.journal.commits.length;
    const due = scheduled.journal.resolveDue(scheduled.definitionId, dayAt(0), {
      occurrenceId: pending.occurrenceId,
    });
    expect(due).toEqual({ kind: "rejected", rejection: { reason: "terminal_subject" } });
    const release = scheduled.journal.release(scheduled.definitionId, dayAt(0), {
      occurrenceId: pending.occurrenceId,
    });
    expect(release).toEqual({ kind: "rejected", rejection: { reason: "terminal_subject" } });
    expect(scheduled.journal.commits.length).toBe(commitsBefore);
  });

  it("Error: 중지 정의의 개정 제안은 amends_definition_stopped 계획 무효이고 정의가 그대로다 (test_SC002_stopped_amendment_plan_invalid)", () => {
    const { journal, workId, definitionId } = reachDefinitionState("STOPPED", "stopamend");
    const before = journal.definition(definitionId);
    const proposed = journal.proposeAmendment(definitionId, { title: "late" }, ACTION_AT);
    expect(proposed.kind).toBe("committed");
    if (proposed.kind === "committed") {
      expect(definitionInvalidReasons(planInvalidIssues(proposed.commit))).toEqual([
        "amends_definition_stopped",
      ]);
    }
    expect(journal.work(workId).work.state).toBe("PLANNING");
    expect(journal.definition(definitionId)).toEqual(before);
  });
});

describe("SC-003: 정의 revision 은 전이 커밋에만 1 오른다", () => {
  it("Happy: 섞인 이력에서 전이 커밋은 +1, 회차 커밋은 0 이다 (test_SC003_transition_commits_plus_one_occurrence_commits_zero)", () => {
    const deps = definitionDeps("rev003");
    const registered = registerDefinition(deps);
    const { journal, definitionId } = registered;
    expect(revisionOf(journal, definitionId)).toBe(1);
    const diffs = stepRevisionDiffs(journal, definitionId, [
      ["materialize", () => journal.resolveDue(definitionId, dayAt(0))],
      ["held", () => journal.resolveDue(definitionId, dayAt(1))],
      ["held+skip", () => journal.resolveDue(definitionId, dayAt(2))],
      ["pause", () => journal.control(definitionId, "pause", dayAt(2, "08:00"))],
      ["resume", () => journal.control(definitionId, "resume", dayAt(2, "09:00"))],
      [
        "propose",
        () => journal.proposeAmendment(definitionId, { title: "renamed" }, dayAt(2, "10:00")),
        "prepare",
      ],
      ["revise", () => journal.decidePlan(registered.stewardId, "grant", dayAt(2, "10:00"))],
      ["stop", () => journal.control(definitionId, "stop", dayAt(2, "11:00"))],
    ]);
    // 개정은 재계획 열기·제안 커밋을 준비로 두고 grant 커밋만 센다(그 둘은 정의를 바꾸지 않는다).
    expect(diffs.map((d) => `${d.name}:${d.diff}:${String(d.transition)}`)).toEqual([
      "materialize:0:false",
      "held:0:false",
      "held+skip:0:false",
      "pause:1:true",
      "resume:1:true",
      "revise:1:true",
      "stop:1:true",
    ]);
    expect(diffs[1]?.types).toContain("work_definition_occurrence_held");
    expect(diffs[2]?.types).toContain("work_definition_occurrences_skipped");
    expect(diffs[5]?.types).toContain("work_definition_occurrences_skipped");
  });

  it("Edge: 생성과 계열 소진 중지가 한 커밋이어도 revision 은 1 이다 (test_SC003_create_and_stop_in_one_commit_plus_one)", () => {
    const ended = definitionDraft({
      activation: dailyActivation({
        anchorUtc: at("2026-02-01T07:00:00Z"),
        until: at("2026-02-10T07:00:00Z"),
      }),
    });
    const { journal, definitionId, grant } = registerDefinition(definitionDeps("rev003e"), {
      draft: ended,
      tasks: STEWARD_MEMBER,
    });
    const definitionTypes = typesOf(grant).filter((t) =>
      DEFINITION_EVENT_TYPES.includes(t as never),
    );
    expect(definitionTypes).toEqual(["work_definition_created", "work_definition_stopped"]);
    expect(journal.definition(definitionId).state).toBe("STOPPED");
    expect(journal.definition(definitionId).revision).toBe(1);
    // 대조: until 이 미래면 생성만 있고 revision 은 같다.
    const live = registerDefinition(definitionDeps("rev003f"), {
      draft: definitionDraft({ activation: dailyActivation({ until: dayAt(5) }) }),
    });
    expect(live.journal.definition(live.definitionId).state).toBe("ACTIVE");
    expect(live.journal.definition(live.definitionId).revision).toBe(1);
  });

  it("Error: 거절·중복 기록 커밋은 revision 을 바꾸지 않는다 (test_SC003_refusal_and_duplicate_records_zero)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("rev003r"));
    const stale = journal.control(definitionId, "pause", ACTION_AT, { expectedRevision: 0 });
    expect(stale.kind).toBe("rejected_stale");
    expect(revisionOf(journal, definitionId)).toBe(1);
    const accepted = journal.control(definitionId, "pause", ACTION_AT, { expectedRevision: 1 });
    expect(accepted.kind).toBe("accepted");
    expect(revisionOf(journal, definitionId)).toBe(2);
    const duplicate = journal.control(definitionId, "pause", ACTION_AT, { expectedRevision: 1 });
    expect(duplicate.kind).toBe("duplicate");
    if (duplicate.kind === "duplicate")
      expect(typesOf(duplicate.commit)).toEqual(["signal_ignored_duplicate"]);
    expect(revisionOf(journal, definitionId)).toBe(2);
    const materialized = registerAndMaterializeFirst(definitionDeps("rev003m"));
    expect(materialized.journal.definition(materialized.definitionId).revision).toBe(1);
  });
});
