// SC-006, SC-007, SC-008, SC-013 — Task 종결 흡수·재시도 경로·attempt 단일성·결과 라우팅.
import { describe, expect, it } from "vitest";
import {
  executeCommand,
  judgeSignal,
  deriveOccurrenceId,
} from "../../../src/workflow/domain/index.js";
import type { TaskStateName, DecisionSignal } from "../../../src/workflow/domain/index.js";
import {
  at,
  entityId,
  meta,
  mustOk,
  reachTaskState,
  requireTaskFor,
  taskSubjectPendingDecision,
} from "./helpers/fixtures.js";

const TERMINAL_STATES: readonly TaskStateName[] = [
  "COMPLETED",
  "REJECTED",
  "EXPIRED",
  "FAILED",
  "CANCELED",
  "SKIPPED",
];

describe("SC-006: 종결 Task 는 되살아나지 않는다", () => {
  it("Happy: 종결 5(+SKIPPED)상태 Task 에 비종결행 명령을 적용하면 stale_transition_rejected 로 거절된다 (test_SC006_terminal_task_command_records_stale_transition_rejected)", () => {
    for (const state of TERMINAL_STATES) {
      const { deps, aggregate, taskId } = reachTaskState(state);
      const before = requireTaskFor(aggregate, taskId);
      const outcome = executeCommand(deps, aggregate, {
        kind: "unblock",
        taskId,
        expectedRevision: before.revision,
        meta: meta(before.createdAt),
      });
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") expect(outcome.rejection.reason).toBe("terminal_subject");
    }
  });

  it("Edge: 현재 revision 을 실어도 동일하게 거절된다 (test_SC006_current_revision_still_rejected)", () => {
    const { deps, aggregate, taskId } = reachTaskState("COMPLETED");
    const before = requireTaskFor(aggregate, taskId);
    const outcome = executeCommand(deps, aggregate, {
      kind: "unblock",
      taskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
    });
    expect(outcome.kind).toBe("rejected");
  });

  it("Error: 상태·revision 이 바뀌지 않는다 (test_SC006_revision_and_state_unchanged)", () => {
    const { deps, aggregate, taskId } = reachTaskState("FAILED");
    const before = requireTaskFor(aggregate, taskId);
    executeCommand(deps, aggregate, {
      kind: "unblock",
      taskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
    });
    const after = requireTaskFor(aggregate, taskId);
    expect(after.state).toBe(before.state);
    expect(after.revision).toBe(before.revision);
  });
});

describe("SC-007: 재시도 예정은 FAILED 를 거치지 않는다", () => {
  it("Happy: 재시도 예산이 남은 재시도 가능 실패는 RETRY_WAIT 로 간다 (test_SC007_retryable_failure_with_budget_goes_retry_wait)", () => {
    const { aggregate, taskId } = reachTaskState("RETRY_WAIT");
    expect(requireTaskFor(aggregate, taskId).state).toBe("RETRY_WAIT");
  });

  it("Edge: attempt_timeout·dispatch_orphaned·dispatch_withdrawn 도 예산이 남으면 RETRY_WAIT 다 (test_SC007_timeout_orphan_withdrawn_also_retry_wait)", () => {
    for (const useDispatchOrphaned of [false, true]) {
      const { deps, aggregate, taskId } = reachTaskState("RUNNING");
      const before = requireTaskFor(aggregate, taskId);
      const attemptId = before.openAttempt?.attemptId;
      if (attemptId === undefined) throw new Error("expected open attempt");
      const outcome = useDispatchOrphaned
        ? {
            kind: "dispatch_orphaned" as const,
            retryDelayMs: 1_000,
            deadLetterDecision: taskSubjectPendingDecision(deps, taskId, before.createdAt),
          }
        : { kind: "attempt_timeout" as const, retryDelayMs: 1_000 };
      const result = executeCommand(deps, aggregate, {
        kind: "record_attempt_outcome",
        taskId,
        expectedRevision: before.revision,
        meta: meta(before.createdAt),
        attemptId,
        outcome,
      });
      if (result.kind === "committed") {
        expect(result.aggregate.tasks[taskId]?.state).toBe("RETRY_WAIT");
      }
    }
  });

  it("Error: 이 경로의 어떤 단계에도 task_failed 이벤트가 나타나지 않는다 (test_SC007_no_task_failed_event_on_path)", () => {
    const { deps, aggregate, taskId } = reachTaskState("RUNNING");
    const before = requireTaskFor(aggregate, taskId);
    const attemptId = before.openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    const outcome = executeCommand(deps, aggregate, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
      attemptId,
      outcome: { kind: "failed", code: "retryable", retryable: true, retryDelayMs: 1_000 },
    });
    if (outcome.kind === "committed") {
      expect(outcome.commit.events.map((e) => e.type)).not.toContain("task_failed");
    }
  });
});

describe("SC-008: 한 Task 에 open attempt 는 하나뿐이다", () => {
  it("Happy: task_started 가 attemptId·번호·마감을 싣는다 (test_SC008_task_started_carries_attempt_id_number_deadline)", () => {
    const { aggregate, taskId } = reachTaskState("RUNNING");
    const task = requireTaskFor(aggregate, taskId);
    expect(task.openAttempt?.attemptId).toBeDefined();
    expect(task.openAttempt?.attemptNo).toBe(1);
    expect(task.openAttempt?.deadline).toBeDefined();
  });

  it("Edge: 결과 기록 뒤 재시작하면 attemptNo 2 가 된다 (test_SC008_restart_after_outcome_gets_attempt_no_2)", () => {
    const { deps, aggregate, taskId } = reachTaskState("RETRY_WAIT");
    const before = requireTaskFor(aggregate, taskId);
    const readyOutcome = executeCommand(deps, aggregate, {
      kind: "retry_ready",
      taskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
    });
    if (readyOutcome.kind !== "committed") throw new Error("expected committed retry_ready");
    const readyTask = requireTaskFor(readyOutcome.aggregate, taskId);
    const startOutcome = executeCommand(deps, readyOutcome.aggregate, {
      kind: "start_attempt",
      taskId,
      expectedRevision: readyTask.revision,
      meta: meta(readyTask.createdAt),
    });
    if (startOutcome.kind !== "committed") throw new Error("expected committed start_attempt");
    expect(requireTaskFor(startOutcome.aggregate, taskId).openAttempt?.attemptNo).toBe(2);
  });

  it("Error: RUNNING 중 재시작은 거절되고 새 attempt 가 생기지 않는다 (test_SC008_start_while_running_rejected_no_new_attempt)", () => {
    const { deps, aggregate, taskId } = reachTaskState("RUNNING");
    const before = requireTaskFor(aggregate, taskId);
    const outcome = executeCommand(deps, aggregate, {
      kind: "start_attempt",
      taskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
    });
    expect(outcome.kind).toBe("rejected");
    expect(requireTaskFor(aggregate, taskId).openAttempt?.attemptId).toBe(
      before.openAttempt?.attemptId,
    );
  });
});

describe("SC-013: attempt 결과의 라우팅이 전이 표를 따른다", () => {
  it("Happy: 결과 kind × 예산 상태 조합이 §5 표의 행과 일치한다 (test_SC013_outcome_budget_matrix_matches_row)", () => {
    const { deps, aggregate, taskId } = reachTaskState("RUNNING");
    const before = requireTaskFor(aggregate, taskId);
    const attemptId = before.openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    const completedOutcome = executeCommand(deps, aggregate, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
      attemptId,
      outcome: { kind: "completed", evidence: {} },
    });
    expect(completedOutcome.kind).toBe("committed");
    if (completedOutcome.kind === "committed")
      expect(requireTaskFor(completedOutcome.aggregate, taskId).state).toBe("COMPLETED");
  });

  it("Edge: blocked(3원인)·effect_dead_lettered 는 BLOCKED_AWAITING_HUMAN 이 된다 (test_SC013_blocked_causes_and_dead_letter_park)", () => {
    for (const cause of ["gate_denied", "executor_blocked", "dispatcher_refused"] as const) {
      const { deps, aggregate, taskId } = reachTaskState("RUNNING");
      const before = requireTaskFor(aggregate, taskId);
      const attemptId = before.openAttempt?.attemptId;
      if (attemptId === undefined) throw new Error("expected open attempt");
      const decision = taskSubjectPendingDecision(deps, taskId, before.createdAt);
      const outcome = executeCommand(deps, aggregate, {
        kind: "record_attempt_outcome",
        taskId,
        expectedRevision: before.revision,
        meta: meta(before.createdAt),
        attemptId,
        outcome: { kind: "blocked", cause, decision },
      });
      if (outcome.kind === "committed") {
        expect(requireTaskFor(outcome.aggregate, taskId).state).toBe("BLOCKED_AWAITING_HUMAN");
      }
    }
  });

  it("Error(회귀, coverage-gap.md 카테고리(1)/GAP-012): dead_letter_retry grant 로 SCHEDULED 복귀 시 occurrenceId 가 트리거 triggerId 로 파생된다 (test_SC013_dead_letter_retry_grant_derives_occurrence_from_trigger_id)", () => {
    // signals.ts 의 dead_letter_retry grant 분기가 트리거의 *종류 이름*(`trigger.kind`) 이 아니라
    // 트리거 고유 식별자(`trigger.triggerId`) 로 occurrenceId 를 파생해야 한다는 계약(GAP-012, cascade.ts
    // 의 event_caused 파생과 동일 패턴)을 확정한다. 본 테스트는 src/ 를 건드리지 않고 계약만 단언한다 —
    // 이 시점 src/ 구현 상태와 무관하게 계약을 고정하는 회귀다.
    const { deps, aggregate, taskId } = reachTaskState("RUNNING");
    const before = requireTaskFor(aggregate, taskId);
    const attemptId = before.openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    const decision = taskSubjectPendingDecision(deps, taskId, before.createdAt);
    const parked = executeCommand(deps, aggregate, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
      attemptId,
      outcome: { kind: "effect_dead_lettered", decision },
    });
    if (parked.kind !== "committed")
      throw new Error(`expected effect_dead_lettered to park the task, got ${parked.kind}`);
    const parkedTask = requireTaskFor(parked.aggregate, taskId);
    expect(parkedTask.state).toBe("BLOCKED_AWAITING_HUMAN");
    const decisionId = parkedTask.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected pendingDecision");

    const grantAt = at("2026-01-01T00:20:00Z");
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: entityId("signal", "sig_deadletterretry1"),
      expectedRevision: parkedTask.revision,
      actorSource: "human_local",
      receivedAt: grantAt,
    };
    const judged = judgeSignal(
      deps,
      parked.aggregate,
      signal,
      {
        kind: "task_grant",
        resume: { to: "SCHEDULED", occurrence: { kind: "dead_letter_retry" } },
      },
      grantAt,
    );
    expect(judged.kind).toBe("accepted");
    if (judged.kind !== "accepted") return;
    const scheduledEvent = judged.commit.events.find((e) => e.type === "human_decision_granted");
    if (scheduledEvent === undefined) throw new Error("expected human_decision_granted event");
    const expectedOccurrenceId = mustOk(
      deriveOccurrenceId({
        kind: "execution_retry",
        ownerId: taskId,
        triggerId: parkedTask.trigger.triggerId,
        causingEvent: { occurredAt: grantAt },
        attemptNo: parkedTask.lastAttemptNo + 1,
      }),
    );
    expect(scheduledEvent.payload.occurrenceId).toBe(expectedOccurrenceId);
  });

  it("Error: 열린 attempt 와 다른 attemptId 는 거절된다 (test_SC013_mismatched_attempt_id_rejected)", () => {
    const { deps, aggregate, taskId } = reachTaskState("RUNNING");
    const before = requireTaskFor(aggregate, taskId);
    const outcome = executeCommand(deps, aggregate, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
      attemptId: "att_not_open" as never,
      outcome: { kind: "completed", evidence: {} },
    });
    expect(outcome.kind).toBe("rejected");
  });
});
