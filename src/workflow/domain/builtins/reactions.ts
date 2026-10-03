/**
 * 내장 Reaction 여섯 종. 명령·스크립트·프로세스를 실행하는 반응은 두지 않는다(코어 엔진 무지). 영구
 * 오류 코드는 전달 계층의 오류 코드 체계가 정해질 때 채운다.
 */
import * as z from "zod";
import type { ReactionDescriptor } from "../registry/descriptors.js";

export const NOTIFY_REACTION: ReactionDescriptor = {
  kind: "notify",
  version: 1,
  title: "Notify",
  reactionLogicalId: { kind: "per_declaration" },
  performsExternalEffect: true,
  usesAddeCredentials: true,
  dispatchesAgent: false,
  retry: { permanentErrorCodes: [], canEndAmbiguous: true },
  declaredAs: "transition_reaction",
  paramsSchema: z.strictObject({ target: z.string().min(1), message: z.string().min(1) }),
};

export const REQUEST_CONFIRMATION_REACTION: ReactionDescriptor = {
  kind: "request_confirmation",
  version: 1,
  title: "Request confirmation",
  reactionLogicalId: { kind: "fixed", value: "confirmation_request" },
  performsExternalEffect: true,
  usesAddeCredentials: true,
  dispatchesAgent: false,
  retry: { permanentErrorCodes: [], canEndAmbiguous: true },
  declaredAs: "execution_effect",
  paramsSchema: z.strictObject({}),
};

export const EXECUTE_AGENT_GOAL_REACTION: ReactionDescriptor = {
  kind: "execute_agent_goal",
  version: 1,
  title: "Execute agent goal",
  reactionLogicalId: { kind: "fixed", value: "agent_dispatch" },
  performsExternalEffect: true,
  usesAddeCredentials: false,
  dispatchesAgent: true,
  retry: { permanentErrorCodes: [], canEndAmbiguous: true },
  declaredAs: "execution_effect",
  paramsSchema: z.strictObject({}),
};

export const DELEGATE_REACTION: ReactionDescriptor = {
  kind: "delegate",
  version: 1,
  title: "Delegate",
  reactionLogicalId: { kind: "fixed", value: "delegation_request" },
  performsExternalEffect: true,
  usesAddeCredentials: true,
  dispatchesAgent: false,
  retry: { permanentErrorCodes: [], canEndAmbiguous: true },
  declaredAs: "execution_effect",
  paramsSchema: z.strictObject({}),
};

export const SPAWN_TASK_REACTION: ReactionDescriptor = {
  kind: "spawn_task",
  version: 1,
  title: "Spawn task",
  reactionLogicalId: { kind: "per_declaration" },
  performsExternalEffect: false,
  usesAddeCredentials: false,
  dispatchesAgent: false,
  retry: { permanentErrorCodes: [], canEndAmbiguous: false },
  declaredAs: "transition_reaction",
  paramsSchema: z.strictObject({ template: z.string().min(1) }),
};

export const SPAWN_WORK_REACTION: ReactionDescriptor = {
  kind: "spawn_work",
  version: 1,
  title: "Spawn work",
  reactionLogicalId: { kind: "per_declaration" },
  performsExternalEffect: false,
  usesAddeCredentials: false,
  dispatchesAgent: false,
  retry: { permanentErrorCodes: [], canEndAmbiguous: false },
  declaredAs: "transition_reaction",
  paramsSchema: z.strictObject({ objective: z.string().min(1), submitForPlanning: z.boolean() }),
};
