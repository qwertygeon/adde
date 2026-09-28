// Test Authoring Contract (tasks.md §헬퍼 계약, T101) 의 signal-cases.ts 구현.
// SC-033 조합 생성기 — 신호 타입 × 실패 요인 × 기대 결과(계약 검사 순서: provenance → 중복 → 종결 →
// 토큰 → revision → 유효기한 → 적격 상태). 각 케이스는 judgeSignal 호출 직전 상태를 재현한다.
import { judgeSignal, nextEntityId } from "../../../../src/workflow/domain/index.js";
import type {
  DomainDeps,
  WorkAggregate,
  TaskId,
  DecisionSignal,
  SignalJudgement,
  UtcInstant,
} from "../../../../src/workflow/domain/index.js";
import { at, reachTaskState, reachWorkState, requireTaskFor } from "./fixtures.js";

export type SignalFactor =
  | "provenance_not_human"
  | "duplicate"
  | "terminal_subject"
  | "token_mismatch"
  | "revision_mismatch"
  | "validity_passed"
  | "unexpected_state";

export interface SignalFactorCase {
  readonly signalType: "confirmation_decision" | "human_decision_task" | "replan_requested";
  readonly factor: SignalFactor;
  readonly expectedKind: SignalJudgement["kind"];
  run(): SignalJudgement;
}

const NOW = at("2026-01-01T00:00:00Z");

function confirmationDecisionCase(
  factor: SignalFactor,
  expectedKind: SignalJudgement["kind"],
  build: () => {
    deps: DomainDeps;
    aggregate: WorkAggregate;
    taskId: TaskId;
    signal: DecisionSignal;
    now: UtcInstant;
  },
): SignalFactorCase {
  return {
    signalType: "confirmation_decision",
    factor,
    expectedKind,
    run: () => {
      const { deps, aggregate, signal, now } = build();
      return judgeSignal(deps, aggregate, signal, { kind: "none" }, now);
    },
  };
}

/** 표준 confirmation_decision(accept) 신호 골격 — WAITING_CONFIRMATION Task 기준. */
function baseConfirmationSignal(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  taskId: TaskId,
): DecisionSignal {
  const task = requireTaskFor(aggregate, taskId);
  const confirmationId = task.confirmationId;
  if (confirmationId === undefined)
    throw new Error("signal-cases: WAITING_CONFIRMATION task missing confirmationId");
  return {
    type: "confirmation_decision",
    taskId,
    confirmationId,
    decision: "accept",
    signalId: nextEntityId(deps.ids, "signal"),
    expectedRevision: task.revision,
    actorSource: "human_local",
    receivedAt: NOW,
  };
}

export function signalFactorCases(): readonly SignalFactorCase[] {
  const cases: SignalFactorCase[] = [];

  cases.push(
    confirmationDecisionCase("provenance_not_human", "forged_provenance", () => {
      const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
      const signal = {
        ...baseConfirmationSignal(deps, aggregate, taskId),
        actorSource: "agent_session" as const,
      };
      return { deps, aggregate, taskId, signal, now: NOW };
    }),
  );

  cases.push(
    confirmationDecisionCase("token_mismatch", "rejected_stale", () => {
      const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
      const signal = {
        ...baseConfirmationSignal(deps, aggregate, taskId),
        confirmationId: nextEntityId(deps.ids, "confirmation"),
      };
      return { deps, aggregate, taskId, signal, now: NOW };
    }),
  );

  cases.push(
    confirmationDecisionCase("revision_mismatch", "rejected_stale", () => {
      const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
      const signal = {
        ...baseConfirmationSignal(deps, aggregate, taskId),
        expectedRevision: requireTaskFor(aggregate, taskId).revision + 1,
      };
      return { deps, aggregate, taskId, signal, now: NOW };
    }),
  );

  cases.push(
    confirmationDecisionCase("validity_passed", "rejected", () => {
      const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION", {
        policy: { expiresAt: at("2025-12-31T00:00:00Z") },
      });
      const signal = baseConfirmationSignal(deps, aggregate, taskId);
      return { deps, aggregate, taskId, signal, now: at("2026-01-01T00:10:00Z") };
    }),
  );

  // `confirmation_decision` 은 WAITING_CONFIRMATION 밖에서 "확인 대상이 없다"는 비종결 우회 출구가
  // 없다(reminder 자기루프만 존재) — 다른 confirmationId 를 합성해도 token_mismatch·rejected_stale 이
  // confirmation_decision 자체의 검사 순서상 unexpected_state 보다 먼저 걸려, 이 신호 타입으로는
  // 비종결·구조적 unexpected_state 를 판별력 있게 재현할 수 없다(test-report.md 실패 #7). `replan_requested`
  // (Work 주체, 토큰 검사 없음, 유효 상태가 ACTIVE·BLOCKED 뿐)로 대체한다 — WAITING_APPROVAL 은 두 상태
  // 모두 아니므로 곧장 unexpected_state 로 거절된다.
  cases.push({
    signalType: "replan_requested",
    factor: "unexpected_state",
    expectedKind: "rejected",
    run: () => {
      const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
      const signal: DecisionSignal = {
        type: "replan_requested",
        workId: aggregate.work.id,
        signalId: nextEntityId(deps.ids, "signal"),
        expectedRevision: aggregate.work.revision,
        actorSource: "human_local",
        receivedAt: NOW,
      };
      return judgeSignal(deps, aggregate, signal, { kind: "none" }, NOW);
    },
  });

  cases.push(
    confirmationDecisionCase("duplicate", "duplicate", () => {
      const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
      const signal = baseConfirmationSignal(deps, aggregate, taskId);
      const first = judgeSignal(deps, aggregate, signal, { kind: "none" }, NOW);
      if (first.kind !== "accepted")
        throw new Error("signal-cases: expected first confirmation judgement to be accepted");
      // 재판정은 run() 안에서 재현 — 여기서는 aggregate 를 first.aggregate 로 교체해 반환하고
      // 같은 signal 객체(같은 신호)를 다시 판정한다(신호 자체는 재사용, 대상 aggregate 만 갱신).
      return { deps, aggregate: first.aggregate, taskId, signal, now: NOW };
    }),
  );

  cases.push(
    confirmationDecisionCase("terminal_subject", "rejected_stale", () => {
      const { deps, aggregate, taskId } = reachTaskState("REJECTED");
      const task = requireTaskFor(aggregate, taskId);
      const confirmationId = task.confirmationId ?? nextEntityId(deps.ids, "confirmation");
      const signal: DecisionSignal = {
        type: "confirmation_decision",
        taskId,
        confirmationId,
        decision: "accept",
        signalId: nextEntityId(deps.ids, "signal"),
        expectedRevision: task.revision,
        actorSource: "human_local",
        receivedAt: NOW,
      };
      return { deps, aggregate, taskId, signal, now: NOW };
    }),
  );

  return cases;
}
