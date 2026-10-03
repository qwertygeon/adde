/**
 * 승인 채널 판정 — the workflow contract "TaskPolicy" "Approval surface" 규칙 2·3. 입력은 TaskType
 * descriptor·정책·선언 반응 descriptor 셋뿐이라 그래프·Work 문맥이 결과를 바꾸지 않는다. 거절 사유는
 * 전사된 순서에서 먼저 성립하는 하나다.
 */
import { APPROVAL_SURFACE_REFUSAL_REASONS } from "../contract/index.js";
import type { TaskPolicy } from "../task-policy.js";
import type { TaskTypeDescriptor, ReactionDescriptor } from "../registry/descriptors.js";

export type ApprovalSurfaceRefusalReason = (typeof APPROVAL_SURFACE_REFUSAL_REASONS)[number];

export type ApprovalSurfaceVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: ApprovalSurfaceRefusalReason };

const [EFFECT_RECORDS_ONLY, NO_PRE_EXECUTION_APPROVAL] = APPROVAL_SURFACE_REFUSAL_REASONS;

export function judgeApprovalSurface(input: {
  readonly taskType: Pick<TaskTypeDescriptor, "executionEffect" | "approvalGatesQuestionOnly">;
  readonly policy: Pick<TaskPolicy, "approvalSurface" | "approvalRequiredBeforeExecute">;
  readonly declaredReactions: readonly Pick<
    ReactionDescriptor,
    "declaredAs" | "usesAddeCredentials"
  >[];
}): ApprovalSurfaceVerdict {
  if (input.policy.approvalSurface !== "out_of_band") return { accepted: true };
  const effectQualifies =
    input.taskType.executionEffect === "adde_credentialed" ||
    input.taskType.executionEffect === "agent_dispatch";
  const reactionQualifies = input.declaredReactions.some(
    (reaction) => reaction.declaredAs === "transition_reaction" && reaction.usesAddeCredentials,
  );
  const qualifies =
    !input.taskType.approvalGatesQuestionOnly && (effectQualifies || reactionQualifies);
  if (!qualifies) return { accepted: false, reason: EFFECT_RECORDS_ONLY };
  if (!input.policy.approvalRequiredBeforeExecute) {
    return { accepted: false, reason: NO_PRE_EXECUTION_APPROVAL };
  }
  return { accepted: true };
}
