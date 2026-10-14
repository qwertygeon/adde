// Phase 1 종료 자동 집계: 도메인 생산 이벤트 타입·상태 도달/출구·종결 흡수.
import { describe, expect, it } from "vitest";
import {
  DOMAIN_EVENT_PRODUCERS,
  EVENT_CATALOG,
  WORK_TRANSITION_ROWS,
  executeCommand,
} from "../../../src/workflow/domain/index.js";
import type { TaskStateName, WorkStateName } from "../../../src/workflow/domain/index.js";
import {
  STATE_SETS,
  censusGaps,
  collectCoreProducedTypes,
  collectDefinitionProducedTypes,
  observeDefinitionStates,
  observeTaskStates,
  observeWorkStates,
  supersedeUnsatisfiedThenComplete,
  unproducedTypes,
} from "./helpers/event-census.js";
import { ACTION_AT, reachDefinitionState } from "./helpers/definition-row-cases.js";
import { WORK_ROW_CASES } from "./helpers/row-cases.js";
import { meta, reachTaskState, reachWorkState, requireTaskFor } from "./helpers/fixtures.js";

const DOMAIN_PRODUCERS: ReadonlySet<string> = new Set(DOMAIN_EVENT_PRODUCERS);

/** 설계 문서화 예외 — 재계획 거부 닫힘 커밋의 파생 상태는 표의 READY 가 아니라 ACTIVE 다(Work 전이 표 시험과 같다). */
const WORK_DERIVED_EXCEPTIONS: Readonly<Record<string, string>> = {
  "WAITING_APPROVAL>READY:work_plan_rejected@WAITING_APPROVAL": "ACTIVE",
};

function allProduced(): ReadonlySet<string> {
  return new Set([...collectCoreProducedTypes(), ...collectDefinitionProducedTypes()]);
}

describe("SC-057: 도메인 생산 이벤트 타입마다 생산 케이스가 있다", () => {
  it("Happy: 도메인 생산 표기 타입 전부가 핵심·정의 레시피 집합에서 생산된다 (test_SC057_every_domain_type_produced)", () => {
    const names = EVENT_CATALOG.filter((e) => DOMAIN_PRODUCERS.has(e.producedBy)).map(
      (e) => e.name,
    );
    expect(names.length).toBeGreaterThan(0);
    const missing = unproducedTypes(names, allProduced());
    expect(missing, missing.join(", ")).toEqual([]);
  });

  it("Edge: 도메인 생산이 아닌 타입은 모두 phase2~phase9 표기다 (test_SC057_non_domain_types_later_phase)", () => {
    const others = EVENT_CATALOG.filter((e) => !DOMAIN_PRODUCERS.has(e.producedBy));
    expect(others.length).toBeGreaterThan(0);
    for (const entry of others) expect(entry.producedBy, entry.name).toMatch(/^phase[2-9]$/);
  });

  it("Error: 집계는 합성으로 빠뜨린 타입을 누락으로 검출한다 (test_SC057_census_detects_missing_recipe)", () => {
    const names = EVENT_CATALOG.filter((e) => DOMAIN_PRODUCERS.has(e.producedBy)).map(
      (e) => e.name,
    );
    const produced = allProduced();
    for (const victim of ["trigger_canceled", "work_definition_resumed", "task_created"]) {
      const without = new Set([...produced].filter((t) => t !== victim));
      expect(unproducedTypes(names, without), victim).toEqual([victim]);
    }
  });
});

describe("SC-058: 상태마다 도달·출구가 있고 종결 상태는 흡수다", () => {
  it("Happy: Task·Work·정의 상태마다 도달 케이스가 있고 비종결 상태마다 출구가 있다 (test_SC058_every_state_reached_and_exited)", () => {
    const observed = {
      task: observeTaskStates(),
      work: observeWorkStates(WORK_DERIVED_EXCEPTIONS),
      definition: observeDefinitionStates(),
    } as const;
    for (const axis of ["task", "work", "definition"] as const) {
      const census = observed[axis];
      const { states, terminal } = STATE_SETS[axis];
      expect(census.failures, `${axis} failures`).toEqual([]);
      expect(censusGaps(census, states, terminal), axis).toEqual({ unreached: [], unexited: [] });
    }
  });

  it("Edge: ACTIVE→PLANNING·BLOCKED→PLANNING 행과 불만족 필수 member supersede 뒤 완료가 포함된다 (test_SC058_required_replan_and_completion_paths)", () => {
    for (const from of ["ACTIVE", "BLOCKED"] as const) {
      const row = WORK_TRANSITION_ROWS.find(
        (r) => r.to === "PLANNING" && (r.from as readonly string[]).includes(from),
      );
      expect(row, from).toBeDefined();
      const rowCase = row === undefined ? undefined : WORK_ROW_CASES[`${row.id}@${from}`];
      expect(rowCase, from).toBeDefined();
      if (rowCase === undefined) continue;
      const built = rowCase.build();
      const outcome = rowCase.apply(built.deps, built.before);
      expect(outcome.kind === "committed" || outcome.kind === "accepted", from).toBe(true);
      if (outcome.kind === "committed" || outcome.kind === "accepted") {
        expect(outcome.aggregate.work.state, from).toBe("PLANNING");
      }
    }
    const recipe = supersedeUnsatisfiedThenComplete();
    expect(recipe.stateBeforeReplan).toBe("BLOCKED");
    expect(recipe.journal.aggregate.work.memberTaskIds).not.toContain(recipe.failedMember);
    expect(recipe.journal.aggregate.work.state).toBe("COMPLETED");
    expect(recipe.completion.events.map((e) => e.type)).toContain("work_completed");
  });

  it("Error: 종결 상태마다 명령이 상태를 바꾸지 못한다 (test_SC058_terminal_states_absorbing)", () => {
    for (const state of STATE_SETS.task.terminal as readonly TaskStateName[]) {
      const { deps, aggregate, taskId } = reachTaskState(state);
      const before = requireTaskFor(aggregate, taskId);
      const outcome = executeCommand(deps, aggregate, {
        kind: "begin_validation",
        taskId,
        expectedRevision: before.revision,
        meta: meta(before.createdAt),
      });
      expect(outcome.kind, state).toBe("rejected");
      expect(requireTaskFor(aggregate, taskId).state, state).toBe(state);
    }
    for (const state of STATE_SETS.work.terminal as readonly WorkStateName[]) {
      const { deps, aggregate } = reachWorkState(state);
      const outcome = executeCommand(deps, aggregate, {
        kind: "start_planning",
        expectedRevision: aggregate.work.revision,
        meta: meta(aggregate.work.createdAt),
      });
      expect(outcome.kind, state).toBe("rejected");
      expect(aggregate.work.state, state).toBe(state);
    }
    for (const state of STATE_SETS.definition.terminal) {
      const fixture = reachDefinitionState(state as "STOPPED", "census058");
      const before = fixture.journal.definition(fixture.definitionId);
      for (const action of ["pause", "resume", "stop"] as const) {
        expect(fixture.journal.control(fixture.definitionId, action, ACTION_AT).kind, action).toBe(
          "rejected_stale",
        );
      }
      expect(fixture.journal.definition(fixture.definitionId)).toEqual(before);
    }
  });
});
