/**
 * 재시도 결정 — 정책 값과 주입된 지터만 읽는 순수 함수(시계·난수 없음). 재시도할 수 없는 코드 →
 * 예산 소진 → 재시도 순으로 판정한다. 지수 백오프는 곱하기 전에 상한 도달로 끊어 큰 시도 번호에서도
 * 유한하다. 지터는 기본 지연에 더하고 상한으로 다시 자르지 않는다.
 */
import { type Result, ok, err } from "../result.js";
import type { RetryPolicy } from "../task-policy.js";

export type RetryFailure =
  | { readonly kind: "error_code"; readonly code: string }
  | { readonly kind: "retryable_by_definition" };

export interface RetryDecisionInput {
  readonly policy: RetryPolicy;
  /** 방금 실패한 시도 번호(1부터). */
  readonly attemptNo: number;
  readonly failure: RetryFailure;
  readonly jitterDrawMs?: number;
}

export type RetryDecision =
  | {
      readonly kind: "retry";
      readonly delayMs: number;
      readonly baseDelayMs: number;
      readonly jitterDrawMs: number;
    }
  | { readonly kind: "fail"; readonly cause: "non_retryable_error" | "retry_budget_exhausted" };

export interface RetryInputError {
  readonly kind: "retry_input";
  readonly field: "attemptNo" | "jitterDrawMs";
  readonly reason: string;
}

function hasJitter(policy: RetryPolicy): boolean {
  return policy.jitterMs !== undefined && policy.jitterMs > 0;
}

function baseDelay(policy: RetryPolicy, attemptNo: number): number {
  if (policy.backoff === "fixed") return policy.initialDelayMs;
  let delay = policy.initialDelayMs;
  for (let n = 1; n < attemptNo && delay > 0 && delay < policy.maxDelayMs; n += 1) {
    delay *= 2;
  }
  return Math.min(delay, policy.maxDelayMs);
}

export function decideRetry(input: RetryDecisionInput): Result<RetryDecision, RetryInputError> {
  const { policy, attemptNo, failure, jitterDrawMs } = input;
  if (!Number.isSafeInteger(attemptNo) || attemptNo < 1) {
    return err({ kind: "retry_input", field: "attemptNo", reason: "not_positive_integer" });
  }
  if (hasJitter(policy)) {
    if (jitterDrawMs === undefined) {
      return err({ kind: "retry_input", field: "jitterDrawMs", reason: "required_by_policy" });
    }
    if (
      !Number.isSafeInteger(jitterDrawMs) ||
      jitterDrawMs < 0 ||
      jitterDrawMs > (policy.jitterMs as number)
    ) {
      return err({ kind: "retry_input", field: "jitterDrawMs", reason: "out_of_range" });
    }
  } else if (jitterDrawMs !== undefined) {
    return err({ kind: "retry_input", field: "jitterDrawMs", reason: "policy_has_no_jitter" });
  }

  const retryable =
    failure.kind === "retryable_by_definition" ||
    (policy.retryableErrors !== undefined && policy.retryableErrors.includes(failure.code));
  if (!retryable) return ok({ kind: "fail", cause: "non_retryable_error" });
  if (attemptNo >= policy.maxAttempts) return ok({ kind: "fail", cause: "retry_budget_exhausted" });

  const base = baseDelay(policy, attemptNo);
  const jitter = jitterDrawMs ?? 0;
  return ok({ kind: "retry", delayMs: base + jitter, baseDelayMs: base, jitterDrawMs: jitter });
}
