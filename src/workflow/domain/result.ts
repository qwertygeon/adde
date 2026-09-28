/**
 * 도메인 전역 결과 타입 — 입력 거절은 예외가 아니라 값으로 돌아온다(판별 유니온).
 * `DomainInvariantError` 는 호출자가 계약을 어긴 프로그램 오류에만 쓴다(예: 생성기 출력 형식 위반).
 */

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** 호출자가 계약을 어긴 프로그램 오류(생성기 형식 위반 등) — 입력 거절에는 쓰지 않는다. */
export class DomainInvariantError extends Error {}
