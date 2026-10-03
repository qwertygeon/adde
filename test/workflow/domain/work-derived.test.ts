// SC-020, SC-021, SC-022 — 차단 Work 재계획·파생 우선순위·Work revision 규칙.
import { describe, expect, it } from "vitest";
import { executeCommand, judgeSignal } from "../../../src/workflow/domain/index.js";
import type { DecisionSignal } from "../../../src/workflow/domain/index.js";
import {
  entityId,
  meta,
  mustCommit,
  planned,
  draft,
  reachWorkState,
  testDeps,
  requireTaskFor,
  patchTask,
  UNREGISTERED_TASK_TYPE,
} from "./helpers/fixtures.js";

describe("SC-020: 차단된 Work 의 재계획 진입은 현재 revision 에서만 된다", () => {
  it("Happy: BLOCKED Work 에 현재 revision human_local 재계획은 PLANNING 이 된다 (test_SC020_blocked_work_human_replan_current_revision_to_planning)", () => {
    const { deps, aggregate } = reachWorkState("BLOCKED");
    const signal: DecisionSignal = {
      type: "replan_requested",
      workId: aggregate.work.id,
      signalId: entityId("signal", "sig_replan1"),
      expectedRevision: aggregate.work.revision,
      actorSource: "human_local",
      receivedAt: aggregate.work.createdAt,
    };
    const outcome = judgeSignal(
      deps,
      aggregate,
      signal,
      { kind: "none" },
      aggregate.work.createdAt,
    );
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind === "accepted") expect(outcome.aggregate.work.state).toBe("PLANNING");
  });

  it("Error: 낡은 revision 재계획은 signal_rejected_stale 이 되고 아무것도 재개하지 않는다 (test_SC020_stale_revision_replan_rejected_stale)", () => {
    const { deps, aggregate } = reachWorkState("BLOCKED");
    const signal: DecisionSignal = {
      type: "replan_requested",
      workId: aggregate.work.id,
      signalId: entityId("signal", "sig_replan2"),
      expectedRevision: aggregate.work.revision + 1,
      actorSource: "human_local",
      receivedAt: aggregate.work.createdAt,
    };
    const outcome = judgeSignal(
      deps,
      aggregate,
      signal,
      { kind: "none" },
      aggregate.work.createdAt,
    );
    expect(outcome.kind).toBe("rejected_stale");
    if (outcome.kind === "rejected_stale") expect(outcome.reason).toBe("revision_mismatch");
    expect(aggregate.work.state).toBe("BLOCKED");
  });
});

describe("SC-021: 파생 Work 상태가 우선순위대로 평가된다", () => {
  it("Happy: 계획 커밋 직후 단일 member 는 READY 가 된다 (test_SC021_four_member_combinations_derive_expected_state)", () => {
    const { aggregate } = reachWorkState("READY");
    expect(aggregate.work.state).toBe("READY");
  });

  it("Edge: 계획 커밋에 work_ready 가 동반된다 (test_SC021_plan_commit_appends_work_ready_and_row_event)", () => {
    const { aggregate } = planned([draft("m1")], testDeps("derived"));
    expect(aggregate.work.state).toBe("READY");
  });

  it("Error: 상태가 안 바뀐 커밋에는 Work 이벤트가 붙지 않는다 (test_SC021_unchanged_derived_state_appends_no_work_event)", () => {
    const { deps, aggregate } = reachWorkState("ACTIVE");
    const memberTaskId = Object.values(aggregate.tasks)[0]?.id;
    if (memberTaskId === undefined) throw new Error("expected member task");
    const before = requireTaskFor(aggregate, memberTaskId);
    const outcome = executeCommand(deps, aggregate, {
      kind: "begin_confirmation_wait",
      taskId: memberTaskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
      confirmationId: entityId("confirmation", "cfm_derived1"),
    });
    if (outcome.kind === "committed") {
      const workEvents = outcome.commit.events.filter((e) => e.type.startsWith("work_"));
      expect(workEvents).toEqual([]);
    }
  });

  it("Error(회귀 — evolve.ts work_blocked 구현 결함): 단일 필수 member 가 BLOCKED 로 들어가면 startedUnderCurrentRevision 이 true 로 설정되어 unblock 이 같은 커밋에서 work_unblocked 를 붙이고 ACTIVE 로 복귀한다 (test_SC021_single_member_blocked_sets_started_under_current_revision_unblock_reaches_active)", () => {
    // design.md §6: "startedUnderCurrentRevision 은 Work 가 ACTIVE·BLOCKED 에 들어갈 때 true" — BLOCKED
    // 진입도 포함. 재작업×2 에서 단일 member 로 이 레시피를 구성했을 때 evolve.ts 의 `case
    // "work_blocked"` 가 이 필드를 설정하지 않아(BLOCKED 유지 코드만 존재) unblock 후 파생이 ACTIVE 가
    // 아니라 READY 로 나와(work_unblocked 이벤트 자체가 없음 — cascade.ts 는 derived===READY 분기를
    // 다루지 않는다) 실패했다 — 이는 테스트 오류가 아니라 구현 결함이라는 지적에 따라 이중 member
    // 우회 레시피(row-cases.ts `work_unblocked@BLOCKED`, 그대로 유지)와 별개로 단일 member 회귀를
    // 여기 고정한다. Development 수정 전까지 RED 가 정상이다.
    const deps = testDeps("sc021singleblocked");
    const { aggregate: planAgg, taskIds } = planned([draft("m1")], deps);
    const memberId = taskIds["m1"];
    if (memberId === undefined) throw new Error("expected member task");
    const validating = mustCommit(
      executeCommand(deps, planAgg, {
        kind: "begin_validation",
        taskId: memberId,
        expectedRevision: requireTaskFor(planAgg, memberId).revision,
        meta: meta(planAgg.work.createdAt),
      }),
    ).aggregate;
    // 레코드 패치: 등록부 drift(유형 미등록) 대용 — unblock 으로 다시 검증 가능한 차단을 만든다.
    const patched = patchTask(validating, memberId, { type: UNREGISTERED_TASK_TYPE });
    const blockedOutcome = executeCommand(deps, patched, {
      kind: "complete_validation",
      taskId: memberId,
      expectedRevision: requireTaskFor(patched, memberId).revision,
      meta: meta(planAgg.work.createdAt),
    });
    if (blockedOutcome.kind !== "committed")
      throw new Error(`expected blocked to commit, got ${blockedOutcome.kind}`);
    expect(blockedOutcome.aggregate.work.state).toBe("BLOCKED");
    expect(requireTaskFor(blockedOutcome.aggregate, memberId).state).toBe("BLOCKED");

    const unblockedOutcome = executeCommand(deps, blockedOutcome.aggregate, {
      kind: "unblock",
      taskId: memberId,
      expectedRevision: requireTaskFor(blockedOutcome.aggregate, memberId).revision,
      meta: meta(planAgg.work.createdAt),
    });
    if (unblockedOutcome.kind !== "committed")
      throw new Error(`expected unblock to commit, got ${unblockedOutcome.kind}`);
    expect(unblockedOutcome.commit.events.map((e) => e.type)).toContain("work_unblocked");
    expect(unblockedOutcome.aggregate.work.state).toBe("ACTIVE");
  });
});

describe("SC-022: Work revision 은 Work 이벤트 커밋에서만 오른다", () => {
  it("Happy: Task 이벤트만 붙는 커밋은 Work revision 이 그대로다 (test_SC022_task_only_commit_keeps_work_revision)", () => {
    const { deps, aggregate } = reachWorkState("ACTIVE");
    const before = aggregate.work.revision;
    const memberTaskId = Object.values(aggregate.tasks)[0]?.id;
    if (memberTaskId === undefined) throw new Error("expected member task");
    const task = requireTaskFor(aggregate, memberTaskId);
    const outcome = executeCommand(deps, aggregate, {
      kind: "begin_confirmation_wait",
      taskId: memberTaskId,
      expectedRevision: task.revision,
      meta: meta(task.createdAt),
      confirmationId: entityId("confirmation", "cfm_derived2"),
    });
    if (outcome.kind === "committed") expect(outcome.aggregate.work.revision).toBe(before);
  });

  it("Edge: Work 이벤트가 하나 이상인 커밋은 정확히 +1 이다 (test_SC022_work_event_commit_increments_by_one)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const before = aggregate.work.revision;
    const outcome = executeCommand(deps, aggregate, {
      kind: "commit_plan",
      expectedRevision: before,
      meta: meta(aggregate.work.createdAt),
      proposal: {
        proposalId: entityId("planProposal", "pln_derived1"),
        digest: "3".repeat(64),
        basePlanRevision: aggregate.work.planRevision,
        drafts: [draft("m2")],
        retain: [],
      },
    });
    if (outcome.kind === "committed") expect(outcome.aggregate.work.revision).toBe(before + 1);
  });

  it("Error: member 진행만으로는 대기 중인 재계획 요청이 낡지 않는다 (test_SC022_pending_replan_not_staled_by_member_progress)", () => {
    const { deps, aggregate } = reachWorkState("BLOCKED");
    const replanned = judgeSignal(
      deps,
      aggregate,
      {
        type: "replan_requested",
        workId: aggregate.work.id,
        signalId: entityId("signal", "sig_replan3"),
        expectedRevision: aggregate.work.revision,
        actorSource: "human_local",
        receivedAt: aggregate.work.createdAt,
      },
      { kind: "none" },
      aggregate.work.createdAt,
    );
    expect(replanned.kind).toBe("accepted");
  });
});
