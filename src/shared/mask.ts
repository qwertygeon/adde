/**
 * 시크릿 마스킹 필터.
 * 봇 토큰 패턴 + 민감 경로를 *** 로 치환하여
 * 트랜스크립트·WARN·로그에 시크릿이 노출되지 않도록 한다.
 */

/**
 * Telegram 봇 토큰 패턴: <bot_id>:<token_part>.
 * token_part 길이를 {30,} 로 둔다 — Telegram 이 35자를 계약상 보장하지 않으므로(형식 드리프트)
 * 고정 {35} 는 마지막 방어선으로 취약. 하한만 두어 과소마스킹을 막는다(과대마스킹은 안전한 방향).
 */
const BOT_TOKEN_PATTERN = /\d{5,}:[A-Za-z0-9_-]{30,}/g;

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

/**
 * 엔진(모델) 유래 자유 텍스트(tool 제목 등)를 체크박스/제어구문이 파싱되는 파일(승인 노트 등)이나
 * 사람이 읽는 렌더 표면에 삽입하기 전에 살균한다. 개행·제어문자를 공백으로 접어
 * 위조 체크박스 라인("- [x] allow" 등)을 삽입할 수 없게 하고, maskSecrets 로 시크릿 패턴을 마스킹한
 * 뒤 길이 상한(기본 200)으로 자른다 — 과도한 페이로드로 렌더를 부풀리는 것도 함께 막는다.
 */
export function sanitizeEngineText(text: string, maxLen = 200): string {
  // \p{Cc} = 유니코드 Control 카테고리(C0 제어문자·DEL·C1 제어문자 — 개행 포함) — 리터럴 제어문자를
  // 정규식에 직접 쓰지 않아 no-control-regex 를 우회한다.
  const collapsed = text
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const masked = maskSecrets(collapsed);
  return masked.length > maxLen ? `${masked.slice(0, maxLen)}…` : masked;
}
