/**
 * 값 집합 전사(FR-023) — the workflow contract "Actor provenance contract"·"Confirmation lifecycle
 * contract"·"Task state set" 의 열거 원문. 도메인의 ActorSource·CancelOriginKind·PendingDecisionKind
 * 타입은 이 데이터에서 `typeof` 로 파생한다.
 */

export const ACTOR_SOURCES = ["human_local", "agent_session", "adde_self", "unknown"] as const;

export const CANCEL_ORIGIN_KINDS = [
  "vault_signal",
  "work_cascade",
  "replan_dropped",
  "control_request",
] as const;

export const PENDING_DECISION_KINDS = [
  "tool_permission_denied_unattended",
  "plan_approval_required",
  "spawn_limit_exceeded",
  "high_risk_reaction_approval",
  "dead_letter_resolution_required",
  "destructive_control_operation",
] as const satisfies readonly string[];
