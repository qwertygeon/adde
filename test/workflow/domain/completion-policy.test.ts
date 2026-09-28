// SC-023 — Work 완료 정책 v1 이 member 만 센다.
import { describe, expect, it } from "vitest";
import {
  evaluateCompletion,
  COMPLETION_POLICY_VERSION,
} from "../../../src/workflow/domain/index.js";
import type { MemberSnapshot } from "../../../src/workflow/domain/index.js";

function member(
  overrides: Partial<MemberSnapshot> & Pick<MemberSnapshot, "taskId" | "state">,
): MemberSnapshot {
  return { terminalRequired: true, ...overrides };
}

describe("SC-023: 완료 정책이 member 만 센다", () => {
  it("Happy(a): 종결 필수 member 가 모두 충족이면 COMPLETED 다 (test_SC023_a_all_required_satisfied_completed)", () => {
    const input = {
      ownedTasks: [member({ taskId: "tsk_1" as never, state: "COMPLETED" })],
      memberTaskIds: ["tsk_1" as never],
    };
    const evaluation = evaluateCompletion(input);
    expect(evaluation.completed).toBe(true);
    expect(evaluation.completionPolicyVersion).toBe(COMPLETION_POLICY_VERSION);
  });

  it("Edge(c,d,f): supersede 제외·철회 member 제외·steward 미완료 (test_SC023_c_superseded_excluded_d_withdrawn_excluded_f_steward_open)", () => {
    const withdrawn = member({
      taskId: "tsk_2" as never,
      state: "CANCELED",
      cancelOrigin: {
        kind: "vault_signal",
        actorSource: "human_local",
        signalId: "sig_1" as never,
      } as never,
    });
    const owned = member({ taskId: "tsk_3" as never, state: "COMPLETED" });
    const supersededExcluded = evaluateCompletion({
      ownedTasks: [owned, withdrawn],
      memberTaskIds: ["tsk_3" as never],
    });
    expect(supersededExcluded.withdrawnTaskIds).not.toContain("tsk_2");
    expect(supersededExcluded.completed).toBe(true);

    const steward = evaluateCompletion({
      ownedTasks: [owned],
      memberTaskIds: ["tsk_3" as never],
      stewardedDefinitionState: "ACTIVE",
    });
    expect(steward.completed).toBe(false);
  });

  it("Error(b,e): 불충족 종결 필수와 제어 요청 취소는 BLOCKED 를 낸다 (test_SC023_b_unsatisfied_and_e_control_cancel_blocked)", () => {
    for (const state of ["REJECTED", "EXPIRED", "FAILED"] as const) {
      const evaluation = evaluateCompletion({
        ownedTasks: [member({ taskId: "tsk_4" as never, state })],
        memberTaskIds: ["tsk_4" as never],
      });
      expect(evaluation.completed, `${state} should not complete`).toBe(false);
      expect(evaluation.unsatisfiedRequiredTaskIds).toContain("tsk_4");
    }
    const controlCanceled = evaluateCompletion({
      ownedTasks: [
        member({
          taskId: "tsk_5" as never,
          state: "CANCELED",
          cancelOrigin: {
            kind: "control_request",
            actorSource: "unknown",
            controlRequestId: "ctl_1" as never,
          } as never,
        }),
      ],
      memberTaskIds: ["tsk_5" as never],
    });
    expect(controlCanceled.completed).toBe(false);
  });
});
