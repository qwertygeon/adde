/**
 * 권한 게이트 — ACP 권한요청을 채널 승인으로 라우팅하고 allow/deny 를 반환한다.
 * fail-closed: 타임아웃·오류·채널 도달 실패의 기본값은 deny.
 */
export { gateRequestDecision, DEFAULT_GATE_TIMEOUT_MS } from "./gate.js";
export type { PermRequest, PermResponse, SendPermPrompt, GateOptions } from "./gate.js";
