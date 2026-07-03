import type { AcpBackend } from "../../src/backend/acp/client.js";

/**
 * fake ACP 백엔드 공용 caps — 실제 어댑터(claude-code-acp) 프로필과 동일 형태.
 * 백엔드 더블 자체는 테스트별 계약(launch 가드·session.id 기록 등)이 달라 파일별 정의 유지.
 */
export const FAKE_ACP_CAPS: ReturnType<AcpBackend["caps"]> = {
  plane: "acp",
  perm_tier: "acp",
  supports_attachments: false,
  acp_version: "v1",
};
