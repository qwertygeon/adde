// SC-037 — property: 승인 채널 판정이 계약 규칙 오라클과 같다.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { judgeApprovalSurface } from "../../../../src/workflow/domain/index.js";
import type { ApprovalSurfaceVerdict } from "../../../../src/workflow/domain/index.js";

type Effect = "adde_credentialed" | "agent_dispatch" | "records_only";
type DeclaredAs = "execution_effect" | "transition_reaction";

function oracle(
  effect: Effect,
  gatesQuestionOnly: boolean,
  approvalRequired: boolean,
  surface: "markdown" | "out_of_band",
  reactions: readonly { declaredAs: DeclaredAs; usesAddeCredentials: boolean }[],
): ApprovalSurfaceVerdict {
  if (surface !== "out_of_band") return { accepted: true };
  const credentialedReaction = reactions.some(
    (r) => r.declaredAs === "transition_reaction" && r.usesAddeCredentials,
  );
  const qualifies =
    !gatesQuestionOnly &&
    (effect === "adde_credentialed" || effect === "agent_dispatch" || credentialedReaction);
  if (!qualifies) return { accepted: false, reason: "effect_records_only" };
  if (!approvalRequired) return { accepted: false, reason: "no_pre_execution_approval" };
  return { accepted: true };
}

describe("SC-037: property — 판정이 규칙 오라클과 같다", () => {
  it("test_SC037_property_judgement_equals_rule_oracle", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Effect>("adde_credentialed", "agent_dispatch", "records_only"),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom<"markdown" | "out_of_band">("markdown", "out_of_band"),
        fc.array(
          fc.record({
            declaredAs: fc.constantFrom<DeclaredAs>("execution_effect", "transition_reaction"),
            usesAddeCredentials: fc.boolean(),
          }),
          { maxLength: 4 },
        ),
        (effect, gatesQuestionOnly, approvalRequired, surface, reactions) => {
          const verdict = judgeApprovalSurface({
            taskType: { executionEffect: effect, approvalGatesQuestionOnly: gatesQuestionOnly },
            policy: { approvalSurface: surface, approvalRequiredBeforeExecute: approvalRequired },
            declaredReactions: reactions,
          });
          expect(verdict).toEqual(
            oracle(effect, gatesQuestionOnly, approvalRequired, surface, reactions),
          );
        },
      ),
    );
  });
});
