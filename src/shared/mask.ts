/**
 * 시크릿 마스킹 필터.
 * NFR-007/FR-007/ADR-008: 봇 토큰 패턴 + 민감 경로를 *** 로 치환하여
 * 트랜스크립트·WARN·로그에 시크릿이 노출되지 않도록 한다.
 */

/** Telegram 봇 토큰 패턴: <bot_id>:<token_part> */
const BOT_TOKEN_PATTERN = /\d{5,}:[A-Za-z0-9_-]{35}/g;

/** 마스킹 대상 민감 키워드 패턴 (state/.env 경로 등) */
const SENSITIVE_PATH_PATTERN = /(?:state\/[^/\s]+\/\.env)[^\s]*/g;

/** 흔한 API 키 접두(보수적 — 접두가 명확해 과대마스킹 위험 낮음). */
const API_KEY_PATTERN =
  /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
/** Authorization Bearer 토큰. */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._-]{8,}/gi;
/** KEY=값 / KEY: 값 형태의 시크릿 키워드 — 값만 마스킹(키 보존). */
const KV_SECRET_PATTERN = /\b(TOKEN|KEY|SECRET|PASSWORD|PASSWD|API[_-]?KEY)(\s*[=:]\s*)\S+/gi;

export function maskSecrets(text: string): string {
  return text
    .replace(BOT_TOKEN_PATTERN, "***")
    .replace(API_KEY_PATTERN, "***")
    .replace(BEARER_PATTERN, "Bearer ***")
    .replace(KV_SECRET_PATTERN, (_m, key: string, sep: string) => `${key}${sep}***`)
    .replace(SENSITIVE_PATH_PATTERN, "***");
}
