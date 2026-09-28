// SC-017, SC-018, SC-019, SC-042(Work) — Work 전이 표 전 행 통과 + 표 밖 조합·종결 거절 + 비취소 출구.
import { describe, expect, it } from "vitest";
import {
  executeCommand,
  judgeSignal,
  WORK_TRANSITION_ROWS,
  WORK_COMMAND_ROWS,
} from "../../../src/workflow/domain/index.js";
import type {
  WorkCommand,
  WorkStateName,
  DecisionSignal,
  PlanCommitInput,
} from "../../../src/workflow/domain/index.js";
import { WORK_ROW_CASES } from "./helpers/row-cases.js";
import { draft, entityId, mustCommit, meta, reachWorkState } from "./helpers/fixtures.js";

/**
 * design.md 문서화 예외 — 재계획이 열려 닫힐 때(거부) `startedUnderCurrentRevision` 이 재설정되지 않으므로
 * 닫힘 커밋의 파생 상태는 계약 표의 문자 그대로의 `to="READY"` 가 아니라 `ACTIVE` 다(test-report.md 실패 #9).
 */
const DERIVED_STATE_EXCEPTIONS: Record<string, WorkStateName> = {
  "WAITING_APPROVAL>READY:work_plan_rejected@WAITING_APPROVAL": "ACTIVE",
};

const ALL_WORK_STATES: readonly WorkStateName[] = [
  "DRAFT",
  "PLANNING",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "READY",
  "ACTIVE",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "CANCELED",
];
const TERMINAL_WORK_STATES: readonly WorkStateName[] = ["COMPLETED", "FAILED", "CANCELED"];
const NONTERMINAL_WORK_STATES: readonly WorkStateName[] = ALL_WORK_STATES.filter(
  (s) => !TERMINAL_WORK_STATES.includes(s),
);

describe("SC-017: Work 전이 표의 모든 행이 통과한다", () => {
  it("Happy: 전사된 각 행 × 출발 상태 케이스가 Work 이벤트와 함께 커밋된다 (test_SC017_every_row_case_reaches_to_state_with_exact_work_events)", () => {
    const failures: string[] = [];
    for (const [key, rowCase] of Object.entries(WORK_ROW_CASES)) {
      try {
        const { deps, before } = rowCase.build();
        const committed = mustCommit(rowCase.apply(deps, before));
        const expectedTo = DERIVED_STATE_EXCEPTIONS[key] ?? rowCase.row.to;
        if (committed.aggregate.work.state !== expectedTo) {
          failures.push(
            `${key}: expected to="${expectedTo}" got "${committed.aggregate.work.state}"`,
          );
        }
        // 계약 event 열은 `TransitionRowData<S>.event: string`(비-리터럴)이라 커밋 이벤트의 리터럴
        // 유니온 타입과 폭이 다르다 — 명시적으로 `string[]` 로 잡아 `.includes(string)` 을 허용한다.
        const eventNames: string[] = committed.commit.events.map((e) => e.type);
        if (!eventNames.includes(rowCase.row.event))
          failures.push(
            `${key}: expected event "${rowCase.row.event}" in [${eventNames.join(",")}]`,
          );
      } catch (error) {
        failures.push(`${key}: ${String(error instanceof Error ? error.message : error)}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("Edge: 파생 행은 member Task 명령으로 유발된다 (test_SC017_derived_rows_triggered_by_member_commands)", () => {
    const { aggregate } = reachWorkState("ACTIVE");
    expect(aggregate.work.state).toBe("ACTIVE");
  });

  it("Error(회귀, GAP 병행수정 확인): plan_grant 는 초안 수만큼 task_created 를 만들고 draftRefMap 을 채운다 (test_SC017_plan_grant_creates_task_per_draft_and_populates_draftRefMap)", () => {
    // Development 병행 수정 대상([A] 실패 #8 — plan_grant 가 draftRefMap: [] 을 하드코딩하고
    // task_created·DAG 검증을 생략하던 결함)을 test/ 쪽에서 계약으로 고정한다. 초안 3건을 승인하면
    // Task 도 정확히 3건 생성되고 draftRefMap 도 3건 채워져야 한다.
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    const decisionId = aggregate.work.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected pendingDecision");
    const drafts = [draft("gd1"), draft("gd2"), draft("gd3")];
    const proposal: PlanCommitInput = {
      proposalId: aggregate.work.pendingProposalId ?? entityId("planProposal", "pln_grantcheck1"),
      digest: aggregate.work.pendingProposalDigest ?? "7".repeat(64),
      basePlanRevision: aggregate.work.planRevision,
      drafts,
      retain: [],
    };
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: entityId("signal", "sig_grantcheck1"),
      expectedRevision: aggregate.work.revision,
      actorSource: "human_local",
      receivedAt: aggregate.work.createdAt,
    };
    const judged = judgeSignal(
      deps,
      aggregate,
      signal,
      { kind: "plan_grant", proposal },
      aggregate.work.createdAt,
    );
    expect(judged.kind).toBe("accepted");
    if (judged.kind !== "accepted") return;
    const taskCreatedCount = judged.commit.events.filter((e) => e.type === "task_created").length;
    expect(taskCreatedCount).toBe(drafts.length);
    const committedEvent = judged.commit.events.find((e) => e.type === "work_plan_committed");
    if (committedEvent === undefined) throw new Error("expected work_plan_committed event");
    expect(committedEvent.payload.draftRefMap.length).toBe(drafts.length);
  });

  it("Error: 케이스가 없는 행이 0건이다 (test_SC017_no_row_without_case)", () => {
    const missing: string[] = [];
    for (const row of WORK_TRANSITION_ROWS) {
      const fromStates = row.from.length > 0 ? row.from : ["NONE"];
      for (const fromState of fromStates) {
        if (!(`${row.id}@${fromState}` in WORK_ROW_CASES)) missing.push(`${row.id}@${fromState}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("SC-018: 표에 없는 Work 조합과 종결 Work 대상 명령은 거절된다", () => {
  it("Happy: WORK_COMMAND_ROWS 밖 (명령,상태) 조합은 거절된다 (test_SC018_non_table_work_command_pairs_rejected)", () => {
    const kinds: readonly WorkCommand["kind"][] = ["start_planning", "fail_work"];
    let checked = 0;
    for (const kind of kinds) {
      const rowIds = new Set(WORK_COMMAND_ROWS[kind]);
      const allowedFromStates = new Set(
        WORK_TRANSITION_ROWS.filter((row) => rowIds.has(row.id)).flatMap((row) => row.from),
      );
      for (const state of ALL_WORK_STATES) {
        if (allowedFromStates.has(state)) continue;
        const { deps, aggregate } = reachWorkState(state);
        const outcome = executeCommand(deps, aggregate, {
          kind,
          expectedRevision: aggregate.work.revision,
          meta: meta(aggregate.work.createdAt),
        } as WorkCommand);
        expect(outcome.kind, `${kind}@${state} should be rejected`).toBe("rejected");
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("Edge: 종결 Work 3상태는 명령 전부 거절된다 (test_SC018_terminal_work_all_commands_rejected)", () => {
    for (const state of TERMINAL_WORK_STATES) {
      const { deps, aggregate } = reachWorkState(state);
      const outcome = executeCommand(deps, aggregate, {
        kind: "start_planning",
        expectedRevision: aggregate.work.revision,
        meta: meta(aggregate.work.createdAt),
      });
      expect(outcome.kind, `terminal ${state} should reject any command`).toBe("rejected");
    }
  });

  it("Error: 거절 시 이벤트 0·revision 불변이다 (test_SC018_no_events_revision_unchanged)", () => {
    const { deps, aggregate } = reachWorkState("COMPLETED");
    const before = aggregate.work.revision;
    executeCommand(deps, aggregate, {
      kind: "start_planning",
      expectedRevision: before,
      meta: meta(aggregate.work.createdAt),
    });
    expect(aggregate.work.revision).toBe(before);
  });
});

describe("SC-019: 비종결 Work 상태는 취소 말고도 출구가 있다", () => {
  it("Happy: 모든 비종결 상태에 취소가 아닌 출구가 하나 이상 있다 (test_SC019_every_nonterminal_has_non_cancel_exit)", () => {
    for (const state of NONTERMINAL_WORK_STATES) {
      const nonCancelRows = WORK_TRANSITION_ROWS.filter((row) => {
        const from: readonly string[] = row.from;
        return from.includes(state) && row.event !== "work_canceled";
      });
      expect(nonCancelRows.length, `${state} should have a non-cancel exit`).toBeGreaterThan(0);
    }
  });

  it("Edge: BLOCKED 에는 work_unblocked·work_replanning_started 출구가 모두 있다 (test_SC019_blocked_has_unblocked_and_replanning)", () => {
    const blockedRows = WORK_TRANSITION_ROWS.filter((row) => {
      const from: readonly string[] = row.from;
      return from.includes("BLOCKED");
    });
    expect(blockedRows.some((row) => row.event === "work_unblocked")).toBe(true);
    expect(blockedRows.some((row) => row.event === "work_replanning_started")).toBe(true);
  });

  it("Error: 취소만 있는 상태가 0건이다 (test_SC019_cancel_only_state_count_zero)", () => {
    const cancelOnly = NONTERMINAL_WORK_STATES.filter((state) => {
      const rows = WORK_TRANSITION_ROWS.filter((row) => {
        const from: readonly string[] = row.from;
        return from.includes(state);
      });
      return rows.length > 0 && rows.every((row) => row.event === "work_canceled");
    });
    expect(cancelOnly).toEqual([]);
  });
});

describe("SC-042(Work): 표 기반 테스트가 전사 데이터에서 생성된다", () => {
  it("Happy: Work 표의 모든 행이 하나 이상의 생성 케이스로 실행된다 (test_SC042_work_rows_all_generated)", () => {
    for (const row of WORK_TRANSITION_ROWS) {
      const fromStates = row.from.length > 0 ? row.from : ["NONE"];
      for (const fromState of fromStates) {
        expect(WORK_ROW_CASES[`${row.id}@${fromState}`]).toBeDefined();
      }
    }
  });
});
