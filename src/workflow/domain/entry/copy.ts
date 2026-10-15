/**
 * 공개 진입의 사본 — 명령·신호·결정 적용 입력을 정규 JSON 동결 사본 하나로 뜬다. 사본을 뜬 뒤에는 호출자
 * 원본을 다시 읽지 않는다(접근자·Proxy 의 값은 여기서 한 번만 관측된다). 실패 사유는 싣지 않는다 — 진입은
 * 상세 없는 invalid_input 으로 거절한다.
 */
import { canonicalJsonFrozenCopyWithRules } from "../derivation/canonical-json.js";
import type { CopyPathRule, IsolatedCopyFailure } from "../derivation/canonical-json.js";

export type EntryCopy<T> =
  | { readonly ok: true; readonly value: T; readonly isolated: readonly IsolatedCopyFailure[] }
  | { readonly ok: false };

/**
 * 명령 진입의 경로 규칙. 이미 깊이를 따로 검사하던 자리(계획·완료 보고 출력)와 evidence 는 그 자리를 깊이
 * 루트로 다시 세어 수용 경계를 유지하고, 완료 보고의 출력·evidence 는 격리한다 — 그 아래 실패는 명령 거절이
 * 아니라 출력 위반 실패 attempt 가 된다.
 */
export const COMMAND_COPY_RULES: readonly CopyPathRule[] = Object.freeze([
  Object.freeze({ path: Object.freeze(["plan"]), isolate: false }),
  Object.freeze({ path: Object.freeze(["outcome", "outputs"]), isolate: true }),
  Object.freeze({ path: Object.freeze(["outcome", "evidence"]), isolate: true }),
]);

/** 외부 신호 진입의 경로 규칙 — 페이로드를 깊이 루트로 센다. */
export const EXTERNAL_SIGNAL_COPY_RULES: readonly CopyPathRule[] = Object.freeze([
  Object.freeze({ path: Object.freeze(["payload"]), isolate: false }),
]);

const NO_RULES: readonly CopyPathRule[] = Object.freeze([]);

/**
 * 받은 값의 정규 JSON 동결 사본. 격리 규칙 아래 실패는 isolated 에 모인다. 정규 JSON 실패가 아닌 예외
 * (호출자 접근자가 던진 예외)는 그대로 전파한다.
 */
export function copyEntry<T>(received: T, rules: readonly CopyPathRule[] = NO_RULES): EntryCopy<T> {
  const copied = canonicalJsonFrozenCopyWithRules(received, rules);
  if (!copied.ok) return { ok: false };
  return { ok: true, value: copied.value.value as T, isolated: copied.value.isolated };
}
