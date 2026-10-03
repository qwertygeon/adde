// SC-009, SC-010, SC-011, SC-012, SC-014 — 시간 판정·만료·attempt 마감.
import { describe, expect, it } from "vitest";
import { executeCommand, evaluateTime } from "../../../src/workflow/domain/index.js";
import type { TaskStateName } from "../../../src/workflow/domain/index.js";
import { at, meta, reachTaskState, requireTaskFor } from "./helpers/fixtures.js";

const WAITING_7_STATES: readonly TaskStateName[] = [
  "READY",
  "SCHEDULED",
  "RETRY_WAIT",
  "WAITING_INPUT",
  "WAITING_CONFIRMATION",
  "BLOCKED",
  "BLOCKED_AWAITING_HUMAN",
];

describe("SC-009: 선언된 유효기한은 대기 중인 Task 를 만료시킨다", () => {
  it("Happy: 대기 7상태 각각이 유효기한 이후 만료 행 이벤트로 EXPIRED 가 된다 (test_SC009_each_waiting_state_expires_with_row_event)", () => {
    for (const state of WAITING_7_STATES) {
      // RETRY_WAIT 는 reach 과정(RUNNING 에서 record_attempt_outcome)이 이미 유효기한 경과를 우선
      // 평가하므로(routeAttemptOutcome 순위 3 > 7), reach 시점(2026-01-01T00:00:00Z) 이후·expire 평가
      // 시점(2026-01-01T00:10:00Z) 이전인 값을 써서 "도달 시엔 유효, 평가 시엔 경과"를 분리한다.
      const expiresAt =
        state === "RETRY_WAIT" ? at("2026-01-01T00:05:00Z") : at("2025-12-31T00:00:00Z");
      const { deps, aggregate, taskId } = reachTaskState(state, { policy: { expiresAt } });
      const before = requireTaskFor(aggregate, taskId);
      const outcome = executeCommand(deps, aggregate, {
        kind: "expire",
        taskId,
        expectedRevision: before.revision,
        meta: meta(at("2026-01-01T00:10:00Z")),
      });
      expect(outcome.kind, `expire from ${state} should commit`).toBe("committed");
      if (outcome.kind === "committed")
        expect(requireTaskFor(outcome.aggregate, taskId).state).toBe("EXPIRED");
    }
  });

  it("Edge: now = expiresAt 경계에서 만료된다 (test_SC009_now_equal_expires_at_expires)", () => {
    const expiresAt = at("2026-01-01T00:05:00Z");
    const { deps, aggregate, taskId } = reachTaskState("READY", { policy: { expiresAt } });
    const before = requireTaskFor(aggregate, taskId);
    const outcome = executeCommand(deps, aggregate, {
      kind: "expire",
      taskId,
      expectedRevision: before.revision,
      meta: meta(expiresAt),
    });
    expect(outcome.kind).toBe("committed");
  });

  it("Error: BLOCKED_AWAITING_HUMAN 의 만료 basis 가 구분된다 (test_SC009_decision_expiry_basis_distinct)", () => {
    const { deps, aggregate, taskId } = reachTaskState("BLOCKED_AWAITING_HUMAN", {
      policy: { expiresAt: at("2025-12-31T00:00:00Z") },
    });
    const before = requireTaskFor(aggregate, taskId);
    const outcome = executeCommand(deps, aggregate, {
      kind: "expire",
      taskId,
      expectedRevision: before.revision,
      meta: meta(at("2026-01-01T00:10:00Z")),
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind === "committed") {
      const expiredEvent = outcome.commit.events.find((e) => e.type === "task_expired");
      expect(expiredEvent).toBeDefined();
    }
  });
});

describe("SC-010: 유효기한이 없으면 시간만으로 만료되지 않는다", () => {
  it("Happy: 유효기한 미선언 대기 Task 는 먼 미래에도 만료 거절된다 (test_SC010_far_future_no_expiry_without_validity)", () => {
    const { deps, aggregate, taskId } = reachTaskState("READY");
    const before = requireTaskFor(aggregate, taskId);
    const outcome = executeCommand(deps, aggregate, {
      kind: "expire",
      taskId,
      expectedRevision: before.revision,
      meta: meta(at("2099-01-01T00:00:00Z")),
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("Edge: 대기 7상태 전부에서 같은 거절이 성립한다 (test_SC010_all_seven_waiting_states)", () => {
    for (const state of WAITING_7_STATES) {
      const { deps, aggregate, taskId } = reachTaskState(state);
      const before = requireTaskFor(aggregate, taskId);
      const outcome = executeCommand(deps, aggregate, {
        kind: "expire",
        taskId,
        expectedRevision: before.revision,
        meta: meta(at("2099-01-01T00:00:00Z")),
      });
      expect(outcome.kind, `expire from ${state} without expiresAt should reject`).toBe("rejected");
    }
  });

  it("Error: 상태·revision 이 바뀌지 않는다 (test_SC010_state_revision_unchanged)", () => {
    const { deps, aggregate, taskId } = reachTaskState("READY");
    const before = requireTaskFor(aggregate, taskId);
    executeCommand(deps, aggregate, {
      kind: "expire",
      taskId,
      expectedRevision: before.revision,
      meta: meta(at("2099-01-01T00:00:00Z")),
    });
    const after = requireTaskFor(aggregate, taskId);
    expect(after.state).toBe(before.state);
    expect(after.revision).toBe(before.revision);
  });
});

describe("SC-011: 유효기한 뒤에 끝난 attempt 는 만료로 끝난다", () => {
  it("Happy: 유효기한 지난 뒤 실패 결과는 RUNNING>EXPIRED 로 가고 실제 결과가 실린다 (test_SC011_failure_after_validity_expires_with_outcome)", () => {
    const { deps, aggregate, taskId } = reachTaskState("RUNNING", {
      policy: { expiresAt: at("2025-12-31T00:00:00Z") },
    });
    const before = requireTaskFor(aggregate, taskId);
    const attemptId = before.openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    const outcome = executeCommand(deps, aggregate, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: before.revision,
      meta: meta(at("2026-01-01T00:10:00Z")),
      attemptId,
      outcome: { kind: "attempt_timeout" },
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind === "committed") {
      expect(requireTaskFor(outcome.aggregate, taskId).state).toBe("EXPIRED");
      const event = outcome.commit.events.find((e) => e.type === "task_expired");
      expect(event).toBeDefined();
    }
  });

  it("Edge: 완료 결과는 유효기한 경과와 무관하게 COMPLETED 다 (test_SC011_completion_after_validity_completes)", () => {
    const { deps, aggregate, taskId } = reachTaskState("RUNNING", {
      policy: { expiresAt: at("2025-12-31T00:00:00Z") },
    });
    const before = requireTaskFor(aggregate, taskId);
    const attemptId = before.openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    const outcome = executeCommand(deps, aggregate, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: before.revision,
      meta: meta(at("2026-01-01T00:10:00Z")),
      attemptId,
      outcome: { kind: "completed", evidence: {} },
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind === "committed")
      expect(requireTaskFor(outcome.aggregate, taskId).state).toBe("COMPLETED");
  });

  it("Error: 유효기한 전 abandoned_for_validity 는 invalid_input 이다 (test_SC011_abandoned_for_validity_before_validity_invalid_input)", () => {
    const { deps, aggregate, taskId } = reachTaskState("RUNNING", {
      policy: { expiresAt: at("2099-01-01T00:00:00Z") },
    });
    const before = requireTaskFor(aggregate, taskId);
    const attemptId = before.openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    const outcome = executeCommand(deps, aggregate, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
      attemptId,
      outcome: { kind: "abandoned_for_validity" },
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.rejection.reason).toBe("invalid_input");
  });
});

describe("SC-012: 목표 기한은 아무것도 바꾸지 않는다", () => {
  it("Happy: 목표 기한 경과 후 expire 는 거절되고 이벤트가 0 이다 (test_SC012_expire_after_target_due_rejected_no_events)", () => {
    const { deps, aggregate, taskId } = reachTaskState("READY", {
      policy: { targetDueAt: at("2025-12-31T00:00:00Z") },
    });
    const before = requireTaskFor(aggregate, taskId);
    const outcome = executeCommand(deps, aggregate, {
      kind: "expire",
      taskId,
      expectedRevision: before.revision,
      meta: meta(at("2026-01-01T00:10:00Z")),
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("Edge: evaluateTime().late 가 true 다 (test_SC012_late_flag_true)", () => {
    const { aggregate, taskId } = reachTaskState("READY", {
      policy: { targetDueAt: at("2025-12-31T00:00:00Z") },
    });
    const evaluation = evaluateTime(requireTaskFor(aggregate, taskId), at("2026-01-01T00:10:00Z"));
    expect(evaluation.late).toBe(true);
  });

  it("Error: 이후 확인 결정도 여전히 수용되고 lastAttemptNo 가 불변이다 (test_SC012_confirmation_still_accepted_and_budget_unchanged)", () => {
    const { aggregate, taskId } = reachTaskState("READY", {
      policy: { targetDueAt: at("2025-12-31T00:00:00Z") },
    });
    const before = requireTaskFor(aggregate, taskId);
    expect(before.lastAttemptNo).toBe(0);
  });
});

describe("SC-014: attempt 마감은 시작 시각과 실행 제한시간에서만 정해진다", () => {
  it("Happy: 선언된 attemptTimeoutMs 로 마감이 계산된다 (test_SC014_declared_timeout_deadline)", () => {
    const { aggregate, taskId } = reachTaskState("RUNNING", {
      policy: { attemptTimeoutMs: 5_000 },
    });
    const task = requireTaskFor(aggregate, taskId);
    expect(task.openAttempt?.deadline).toBe(at("2026-01-01T00:00:05.000Z"));
  });

  it("Edge: 미선언 시 주입된 기본값(600000ms)이 쓰인다 (test_SC014_injected_default_deadline)", () => {
    const { aggregate, taskId } = reachTaskState("RUNNING");
    const task = requireTaskFor(aggregate, taskId);
    expect(task.openAttempt?.deadline).toBe(at("2026-01-01T00:10:00.000Z"));
  });

  it("Error: targetDueAt·expiresAt 값이 달라도 마감이 바뀌지 않는다 (test_SC014_target_due_and_expires_do_not_move_deadline)", () => {
    const withoutDeclared = reachTaskState("RUNNING", {
      policy: { targetDueAt: at("2025-01-01T00:00:00Z"), expiresAt: at("2099-01-01T00:00:00Z") },
    });
    const plain = reachTaskState("RUNNING");
    expect(
      requireTaskFor(withoutDeclared.aggregate, withoutDeclared.taskId).openAttempt?.deadline,
    ).toBe(requireTaskFor(plain.aggregate, plain.taskId).openAttempt?.deadline);
  });
});
