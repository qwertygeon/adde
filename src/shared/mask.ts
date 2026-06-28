/**
 * 시크릿 마스킹 필터.
 * NFR-007/FR-007/ADR-008: 봇 토큰 패턴 + 민감 경로를 *** 로 치환하여
 * 트랜스크립트·WARN·로그에 시크릿이 노출되지 않도록 한다.
 */

/** Telegram 봇 토큰 패턴: <bot_id>:<token_part> */
const BOT_TOKEN_PATTERN = /\d{5,}:[A-Za-z0-9_-]{35}/g;

/** 마스킹 대상 민감 키워드 패턴 (state/.env 경로 등) */
const SENSITIVE_PATH_PATTERN = /(?:state\/[^/\s]+\/\.env)[^\s]*/g;

export function maskSecrets(text: string): string {
  return text.replace(BOT_TOKEN_PATTERN, "***").replace(SENSITIVE_PATH_PATTERN, "***");
}
