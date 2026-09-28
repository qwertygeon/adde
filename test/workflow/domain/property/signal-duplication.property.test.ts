// SC-047 (NFR-003) — property: 임의의 중복·재정렬 신호열에서 두 번째 유효 전이가 만들어지지 않는다.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { judgeSignal } from "../../../../src/workflow/domain/index.js";
import type { DecisionSignal } from "../../../../src/workflow/domain/index.js";
import { entityId, reachTaskState, requireTaskFor } from "../helpers/fixtures.js";

describe("SC-047: property — 중복 신호가 두 번째 효과를 내지 않는다", () => {
  it("Happy: 확인 신호를 임의 횟수 재판정해도 유효 전이는 최대 1회다 (test_SC047_at_most_one_effective_confirmation_transition)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), (replayCount) => {
        const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
        const task = requireTaskFor(aggregate, taskId);
        const confirmationId = task.confirmationId;
        if (confirmationId === undefined) throw new Error("expected confirmationId");
        const signal: DecisionSignal = {
          type: "confirmation_decision",
          taskId,
          confirmationId,
          decision: "accept",
          signalId: entityId("signal", "sig_property1"),
          expectedRevision: task.revision,
          actorSource: "human_local",
          receivedAt: task.createdAt,
        };
        let current = aggregate;
        let acceptedCount = 0;
        for (let i = 0; i < replayCount; i += 1) {
          const judged = judgeSignal(deps, current, signal, { kind: "none" }, task.createdAt);
          if (judged.kind === "accepted") {
            acceptedCount += 1;
            current = judged.aggregate;
          }
        }
        expect(acceptedCount).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100 },
    );
  });

  it("Edge: 같은 subject·revision 에 유효 전이가 둘 이상 생기지 않는다 (test_SC047_at_most_one_effective_transition_per_subject_revision)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const task = requireTaskFor(aggregate, taskId);
    const confirmationId = task.confirmationId;
    if (confirmationId === undefined) throw new Error("expected confirmationId");
    const signal: DecisionSignal = {
      type: "confirmation_decision",
      taskId,
      confirmationId,
      decision: "accept",
      signalId: entityId("signal", "sig_property2"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: task.createdAt,
    };
    const first = judgeSignal(deps, aggregate, signal, { kind: "none" }, task.createdAt);
    const second = judgeSignal(
      deps,
      first.kind === "accepted" ? first.aggregate : aggregate,
      signal,
      { kind: "none" },
      task.createdAt,
    );
    expect(first.kind).toBe("accepted");
    expect(second.kind).not.toBe("accepted");
  });
});
