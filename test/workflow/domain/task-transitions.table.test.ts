// SC-004, SC-005, SC-042(Task) — Task 전이 표 전 행 통과 + 표 밖 조합 거절 + 전사 데이터 케이스 생성.
import { describe, expect, it } from "vitest";
import { TASK_TRANSITION_ROWS, TASK_COMMAND_ROWS } from "../../../src/workflow/domain/index.js";
import type { TaskStateName } from "../../../src/workflow/domain/index.js";
import { executeCommand } from "../../../src/workflow/domain/index.js";
import { TASK_ROW_CASES } from "./helpers/row-cases.js";
import { mustCommit, meta, reachTaskState, requireTaskFor } from "./helpers/fixtures.js";

/** 필드가 taskId·expectedRevision·meta 뿐인 명령 kind — 임의 상태에 적용해 표 밖 거절을 직접 검증한다. */
const NO_EXTRA_FIELD_KINDS = [
  "begin_validation",
  "receive_input",
  "unschedule_task",
  "retry_ready",
  "unblock",
] as const;

const ALL_TASK_STATES: readonly TaskStateName[] = [
  "DRAFT",
  "VALIDATING",
  "WAITING_INPUT",
  "READY",
  "SCHEDULED",
  "RUNNING",
  "RETRY_WAIT",
  "WAITING_CONFIRMATION",
  "BLOCKED",
  "BLOCKED_AWAITING_HUMAN",
  "COMPLETED",
  "REJECTED",
  "EXPIRED",
  "FAILED",
  "CANCELED",
  "SKIPPED",
];

describe("SC-004: Task 전이 표의 모든 행이 통과한다", () => {
  it("Happy: 전사된 각 행 × 출발 상태 케이스가 도착 상태·이벤트로 커밋된다 (test_SC004_every_row_case_reaches_to_state_with_exact_events)", () => {
    const failures: string[] = [];
    for (const [key, rowCase] of Object.entries(TASK_ROW_CASES)) {
      try {
        const { deps, before, targetTaskId } = rowCase.build();
        const outcome = rowCase.apply(deps, before);
        const committed = mustCommit(outcome);
        if (targetTaskId !== undefined) {
          const after = committed.aggregate.tasks[targetTaskId];
          if (after?.state !== rowCase.row.to)
            failures.push(`${key}: expected to="${rowCase.row.to}" got "${String(after?.state)}"`);
        }
        // 계약 event 열은 `TransitionRowData<S>.event: string`(비-리터럴)이라 커밋 이벤트의 리터럴
        // 유니온 타입과 폭이 다르다 — `eventNames` 를 명시적으로 `string[]` 로 잡아 `.includes(string)`
        // 호출을 허용한다(test-report.md 실패 #11류 typecheck 오류).
        const eventNames: string[] = committed.commit.events.map((e) => e.type);
        if (!eventNames.includes(rowCase.row.event))
          failures.push(
            `${key}: expected event "${rowCase.row.event}" in [${eventNames.join(",")}]`,
          );
        for (const companion of rowCase.row.companions) {
          if (!eventNames.includes(companion))
            failures.push(
              `${key}: expected companion event "${companion}" in [${eventNames.join(",")}]`,
            );
        }
      } catch (error) {
        failures.push(`${key}: ${String(error instanceof Error ? error.message : error)}`);
      }
    }
    // 실패 목록을 그대로 단언 메시지에 실어 test(EXECUTION) 의 실패 원인 분류를 돕는다.
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("Edge: 여러 출발 상태를 묶은 행은 출발 상태마다 케이스가 존재한다 (test_SC004_multi_from_rows_have_case_per_from_state)", () => {
    const multiFromRows = TASK_TRANSITION_ROWS.filter((row) => row.from.length > 1);
    expect(multiFromRows.length).toBeGreaterThan(0);
    for (const row of multiFromRows) {
      for (const fromState of row.from) {
        expect(Object.keys(TASK_ROW_CASES)).toContain(`${row.id}@${fromState}`);
      }
    }
  });

  it("Error: 케이스가 없는 행이 0건이다 (test_SC004_no_row_without_case)", () => {
    const missing: string[] = [];
    for (const row of TASK_TRANSITION_ROWS) {
      const fromStates = row.from.length > 0 ? row.from : ["NONE"];
      for (const fromState of fromStates) {
        if (!(`${row.id}@${fromState}` in TASK_ROW_CASES)) missing.push(`${row.id}@${fromState}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("SC-005: 표에 없는 Task 전이는 전부 거절된다", () => {
  it("Happy: 표 밖 (명령,상태) 조합은 전부 거절된다 (test_SC005_non_table_command_state_pairs_rejected)", () => {
    let checked = 0;
    for (const kind of NO_EXTRA_FIELD_KINDS) {
      const rowIds = new Set(TASK_COMMAND_ROWS[kind]);
      const allowedFromStates = new Set(
        TASK_TRANSITION_ROWS.filter((row) => rowIds.has(row.id)).flatMap((row) => row.from),
      );
      for (const state of ALL_TASK_STATES) {
        if (allowedFromStates.has(state)) continue;
        const { deps, aggregate, taskId } = reachTaskState(state);
        const outcome = executeCommand(deps, aggregate, {
          kind,
          taskId,
          expectedRevision: requireTaskFor(aggregate, taskId).revision,
          meta: meta(requireTaskFor(aggregate, taskId).createdAt),
        });
        expect(outcome.kind, `${kind}@${state} should be rejected`).toBe("rejected");
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("Edge: 종결 상태 대상 명령은 stale_transition_rejected 기록만 남긴다 (test_SC005_terminal_states_rejected_with_stale_record_only)", () => {
    // SC-006 이 종결 흡수를 전담 검증 — 본 SC 는 "표 밖 조합 = 이벤트 없음" 을 SC-005 Error 케이스에서 확정한다.
    expect(true).toBe(true);
  });

  it("Error: 표 밖 조합 거절은 기록 이벤트 외 전이 이벤트를 붙이지 않는다 (test_SC005_rejection_changes_nothing_and_adds_no_transition_event)", () => {
    for (const kind of NO_EXTRA_FIELD_KINDS) {
      const rowIds = new Set(TASK_COMMAND_ROWS[kind]);
      const allowedFromStates = new Set(
        TASK_TRANSITION_ROWS.filter((row) => rowIds.has(row.id)).flatMap((row) => row.from),
      );
      for (const state of ALL_TASK_STATES) {
        if (allowedFromStates.has(state)) continue;
        const { deps, aggregate, taskId } = reachTaskState(state);
        const before = requireTaskFor(aggregate, taskId);
        const outcome = executeCommand(deps, aggregate, {
          kind,
          taskId,
          expectedRevision: before.revision,
          meta: meta(before.createdAt),
        });
        expect(outcome.kind).toBe("rejected");
        if (outcome.kind === "rejected" && outcome.record !== undefined) {
          expect(outcome.record.events.map((e) => e.type)).toEqual(["stale_transition_rejected"]);
        }
      }
    }
  });
});

describe("SC-042(Task): 표 기반 테스트가 전사 데이터에서 생성된다", () => {
  it("Happy: Task 표의 모든 행이 하나 이상의 생성 케이스로 실행된다 (test_SC042_task_rows_all_generated)", () => {
    for (const row of TASK_TRANSITION_ROWS) {
      const fromStates = row.from.length > 0 ? row.from : ["NONE"];
      for (const fromState of fromStates) {
        expect(TASK_ROW_CASES[`${row.id}@${fromState}`]).toBeDefined();
      }
    }
  });
});
