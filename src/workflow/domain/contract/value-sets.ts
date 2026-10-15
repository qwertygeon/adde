/**
 * 값 집합 전사(FR-023) — the workflow contract "Actor provenance contract"·"Confirmation lifecycle
 * contract"·"Task state set" 의 열거 원문. 도메인의 ActorSource·CancelOriginKind·PendingDecisionKind
 * 타입은 이 데이터에서 `typeof` 로 파생한다. 진입 검사가 이 표를 읽으므로 로드 시점에 동결한다.
 */

export const ACTOR_SOURCES = Object.freeze([
  "human_local",
  "agent_session",
  "adde_self",
  "unknown",
] as const);

export const CANCEL_ORIGIN_KINDS = Object.freeze([
  "vault_signal",
  "work_cascade",
  "replan_dropped",
  "control_request",
] as const);

export const PENDING_DECISION_KINDS = Object.freeze([
  "tool_permission_denied_unattended",
  "plan_approval_required",
  "spawn_limit_exceeded",
  "high_risk_reaction_approval",
  "pre_execution_approval",
  "dead_letter_resolution_required",
  "destructive_control_operation",
] as const satisfies readonly string[]);
