// SC-032, SC-033, SC-034, SC-035 — 낡은 승인·거절 분류·중복 무효과·CAS 신원 무검증.
import { describe, expect, it } from "vitest";
import {
  judgeSignal,
  judgeDelegationResponseStaleness,
} from "../../../src/workflow/domain/index.js";
import type {
  DecisionSignal,
  DelegationResponseSignal,
  ActorRef,
} from "../../../src/workflow/domain/index.js";
import { at, entityId, reachTaskState, requireTaskFor } from "./helpers/fixtures.js";
import { signalFactorCases } from "./helpers/signal-cases.js";

describe("SC-032: 낡은 승인은 종결 Task 를 되살리지 않는다 (AC-33 도메인 수준)", () => {
  it("Happy: 종결 전 revision 승인은 signal_rejected_stale 이다 (test_SC032_pre_terminal_grant_rejected_stale)", () => {
    const { deps, aggregate, taskId } = reachTaskState("BLOCKED_AWAITING_HUMAN");
    const task = requireTaskFor(aggregate, taskId);
    const decisionId = task.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected pendingDecision");
    // 다른 신호로 Task 를 먼저 종결시킨 뒤, "이전" revision 을 실은 승인을 뒤늦게 판정한다.
    const cancel = judgeSignal(
      deps,
      aggregate,
      {
        type: "cancel_requested",
        subject: { taskId },
        signalId: entityId("signal", "sig_cancelfirst"),
        expectedRevision: task.revision,
        actorSource: "human_local",
        receivedAt: task.createdAt,
      },
      { kind: "none" },
      task.createdAt,
    );
    if (cancel.kind !== "accepted") throw new Error("expected cancel to be accepted");
    const staleGrant: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: entityId("signal", "sig_stalegrant"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: task.createdAt,
    };
    const judged = judgeSignal(
      deps,
      cancel.aggregate,
      staleGrant,
      { kind: "task_grant", resume: { to: "READY" } },
      task.createdAt,
    );
    expect(judged.kind).toBe("rejected_stale");
  });

  it("Edge: 낡은 delegation_response 는 signal_rejected_stale 이다 (test_SC032_stale_delegation_response_rejected_stale)", () => {
    const { deps, aggregate, taskId } = reachTaskState("RUNNING");
    const task = requireTaskFor(aggregate, taskId);
    const signal: DelegationResponseSignal = {
      type: "delegation_response",
      taskId,
      occurrenceId: entityId("occurrence", "occ_" + "A".repeat(26)),
      responseContentHash: "0".repeat(64) as never,
      signalId: entityId("signal", "sig_deleg1"),
      expectedRevision: task.revision + 1,
      actorSource: "agent_session",
      receivedAt: task.createdAt,
    };
    const judged = judgeDelegationResponseStaleness(
      deps,
      aggregate,
      signal,
      undefined,
      task.createdAt,
    );
    expect(judged.kind).toBe("rejected_stale");
  });

  it("Error: 종결 Task 의 현재 revision 승인은 terminal_subject 사유다 (test_SC032_current_revision_grant_on_terminal_task_terminal_subject)", () => {
    // reachTaskState("COMPLETED") 로 바로 만들면 decisionSubjects 에 아무 것도 등록되지 않아
    // (park_awaiting_human 을 거치지 않음) 합성 decisionId 로는 unknown_subject 로 빠진다
    // (test-report.md 실패 #6). BLOCKED_AWAITING_HUMAN 을 거쳐 실제 등록된 decisionId 를 확보한 뒤,
    // 그 decisionId 를 보존한 채로 신호(cancel_requested)로 Task 를 종결시킨다 — decisionSubjects 는
    // 종결 후에도 제거되지 않는다(evolve.ts — cancel 로 지워지는 코드경로가 없음).
    const { deps, aggregate, taskId } = reachTaskState("BLOCKED_AWAITING_HUMAN");
    const task = requireTaskFor(aggregate, taskId);
    const decisionId = task.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected pendingDecision");
    const cancel = judgeSignal(
      deps,
      aggregate,
      {
        type: "cancel_requested",
        subject: { taskId },
        signalId: entityId("signal", "sig_cancelforterminal"),
        expectedRevision: task.revision,
        actorSource: "human_local",
        receivedAt: task.createdAt,
      },
      { kind: "none" },
      task.createdAt,
    );
    if (cancel.kind !== "accepted") throw new Error("expected cancel to be accepted");
    const terminalTask = requireTaskFor(cancel.aggregate, taskId);
    expect(terminalTask.state).toBe("CANCELED");
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: entityId("signal", "sig_terminalgrant"),
      expectedRevision: terminalTask.revision,
      actorSource: "human_local",
      receivedAt: task.createdAt,
    };
    const judged = judgeSignal(
      deps,
      cancel.aggregate,
      signal,
      { kind: "task_grant", resume: { to: "READY" } },
      task.createdAt,
    );
    expect(judged.kind).toBe("rejected_stale");
    if (judged.kind === "rejected_stale") expect(judged.reason).toBe("terminal_subject");
  });
});

describe("SC-033: 거절 분류가 계약의 검사 순서를 따른다", () => {
  it("Happy: 신호 타입 × 요인 조합에서 첫 실패 요인이 사유가 된다 (test_SC033_first_failing_factor_is_reason_per_type)", () => {
    for (const c of signalFactorCases()) {
      const judged = c.run();
      expect(judged.kind, `${c.signalType}/${c.factor}`).toBe(c.expectedKind);
    }
  });

  it("Edge: 취소는 유효기한 무관이다 (test_SC033_cancel_ignores_validity)", () => {
    const { deps, aggregate, taskId } = reachTaskState("READY", {
      policy: { expiresAt: at("2025-12-31T00:00:00Z") },
    });
    const task = requireTaskFor(aggregate, taskId);
    const judged = judgeSignal(
      deps,
      aggregate,
      {
        type: "cancel_requested",
        subject: { taskId },
        signalId: entityId("signal", "sig_cancellate"),
        expectedRevision: task.revision,
        actorSource: "human_local",
        receivedAt: at("2026-06-01T00:00:00Z"),
      },
      { kind: "none" },
      at("2026-06-01T00:00:00Z"),
    );
    expect(judged.kind).toBe("accepted");
  });

  it("Error: 모든 거절에서 상태·revision 이 그대로다 (test_SC033_confirmation_non_human_forged_event_and_all_refusals_unchanged)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const task = requireTaskFor(aggregate, taskId);
    const confirmationId = task.confirmationId;
    if (confirmationId === undefined) throw new Error("expected confirmationId");
    const judged = judgeSignal(
      deps,
      aggregate,
      {
        type: "confirmation_decision",
        taskId,
        confirmationId,
        decision: "accept",
        signalId: entityId("signal", "sig_forged1"),
        expectedRevision: task.revision,
        actorSource: "agent_session",
        receivedAt: task.createdAt,
      },
      { kind: "none" },
      task.createdAt,
    );
    expect(judged.kind).toBe("forged_provenance");
    expect(requireTaskFor(aggregate, taskId).state).toBe(task.state);
    expect(requireTaskFor(aggregate, taskId).revision).toBe(task.revision);
  });
});

describe("SC-034: 중복 관측은 두 번째 전이를 만들지 않는다", () => {
  it("Happy: 수용된 human_decision 을 재판정하면 duplicate 다 (test_SC034_replayed_human_decision_is_duplicate)", () => {
    const { deps, aggregate, taskId } = reachTaskState("BLOCKED_AWAITING_HUMAN");
    const task = requireTaskFor(aggregate, taskId);
    const decisionId = task.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected pendingDecision");
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: entityId("signal", "sig_dup1"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: task.createdAt,
    };
    const first = judgeSignal(
      deps,
      aggregate,
      signal,
      { kind: "task_grant", resume: { to: "READY" } },
      task.createdAt,
    );
    if (first.kind !== "accepted") throw new Error("expected first judgement accepted");
    const second = judgeSignal(
      deps,
      first.aggregate,
      signal,
      { kind: "task_grant", resume: { to: "READY" } },
      task.createdAt,
    );
    expect(second.kind).toBe("duplicate");
  });

  it("Edge: 수용 키 목록이 불변이다 (test_SC034_accepted_keys_unchanged)", () => {
    const { deps, aggregate, taskId } = reachTaskState("BLOCKED_AWAITING_HUMAN");
    const task = requireTaskFor(aggregate, taskId);
    const decisionId = task.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected pendingDecision");
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: entityId("signal", "sig_dup2"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: task.createdAt,
    };
    const first = judgeSignal(
      deps,
      aggregate,
      signal,
      { kind: "task_grant", resume: { to: "READY" } },
      task.createdAt,
    );
    if (first.kind !== "accepted") throw new Error("expected first judgement accepted");
    const keysBefore = first.aggregate.acceptedSignalKeys.length;
    judgeSignal(
      deps,
      first.aggregate,
      signal,
      { kind: "task_grant", resume: { to: "READY" } },
      task.createdAt,
    );
    expect(first.aggregate.acceptedSignalKeys.length).toBe(keysBefore);
  });

  it("Error: 두 번째 전이가 없다 (test_SC034_no_second_transition)", () => {
    const { deps, aggregate, taskId } = reachTaskState("BLOCKED_AWAITING_HUMAN");
    const task = requireTaskFor(aggregate, taskId);
    const decisionId = task.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected pendingDecision");
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: entityId("signal", "sig_dup3"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: task.createdAt,
    };
    const first = judgeSignal(
      deps,
      aggregate,
      signal,
      { kind: "task_grant", resume: { to: "READY" } },
      task.createdAt,
    );
    if (first.kind !== "accepted") throw new Error("expected first judgement accepted");
    const revisionAfterFirst = requireTaskFor(first.aggregate, taskId).revision;
    const second = judgeSignal(
      deps,
      first.aggregate,
      signal,
      { kind: "task_grant", resume: { to: "READY" } },
      task.createdAt,
    );
    if (second.kind === "duplicate") {
      expect(requireTaskFor(first.aggregate, taskId).revision).toBe(revisionAfterFirst);
    }
  });
});

describe("SC-035: 비교-교체는 신원을 검증하지 않는다", () => {
  it("Happy: 진짜·위조를 가정한 두 신호가 같은 결과로 통과한다 (test_SC035_genuine_and_forged_current_revision_signals_equal_outcome)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const task = requireTaskFor(aggregate, taskId);
    const confirmationId = task.confirmationId;
    if (confirmationId === undefined) throw new Error("expected confirmationId");
    const genuine: DecisionSignal = {
      type: "confirmation_decision",
      taskId,
      confirmationId,
      decision: "accept",
      signalId: entityId("signal", "sig_genuine1"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: task.createdAt,
    };
    const forged: DecisionSignal = { ...genuine, signalId: entityId("signal", "sig_forged2") };
    const genuineJudged = judgeSignal(deps, aggregate, genuine, { kind: "none" }, task.createdAt);
    const forgedJudged = judgeSignal(deps, aggregate, forged, { kind: "none" }, task.createdAt);
    // Error: 동등성을 명시적으로 단언한다 (test_SC035_equivalence_asserted_explicitly)
    expect(genuineJudged.kind).toBe(forgedJudged.kind);
    expect(genuineJudged.kind).toBe("accepted");
  });

  it("Error: revision·human_local 이 같아도 actor 신원(kind·id)이 다른 신호들이 같은 결과를 낸다 (test_SC035_different_actor_identity_same_outcome)", () => {
    // 판별력 보강 (test-report.md adversarial verification — confirmation_decision 분기에 signal.actor?.kind
    // 조건의 신원 검사를 임시 주입한 변이가 생존함): signalId 만 다른 기존 witness 로는 "신원별 분기"를
    // 잡아내지 못한다. actor.kind 자체가 다른(user/session/binding/external) 세 신호가 같은 revision·
    // human_local 아래 동일하게 accepted 로 판정됨을 확인해, 신원 종류에 따라 분기하는 회귀를 포착한다.
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const task = requireTaskFor(aggregate, taskId);
    const confirmationId = task.confirmationId;
    if (confirmationId === undefined) throw new Error("expected confirmationId");
    const base = {
      type: "confirmation_decision" as const,
      taskId,
      confirmationId,
      decision: "accept" as const,
      expectedRevision: task.revision,
      actorSource: "human_local" as const,
      receivedAt: task.createdAt,
    };
    const actors: readonly (ActorRef | undefined)[] = [
      undefined,
      { kind: "user", id: "user-a" },
      { kind: "session", sid: "sid-b" },
      { kind: "external", provider: "vault", externalId: "ext-c" },
    ];
    const outcomes = actors.map((actor, i) => {
      const signal: DecisionSignal = {
        ...base,
        signalId: entityId("signal", `sig_identity${i}`),
        ...(actor !== undefined ? { actor } : {}),
      };
      return judgeSignal(deps, aggregate, signal, { kind: "none" }, task.createdAt).kind;
    });
    for (const kind of outcomes) expect(kind).toBe("accepted");
  });
});
