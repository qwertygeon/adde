// SC-043, SC-044, SC-045 — 재시도 백오프·실패 결정·주입값만 쓰는 결정.
import { describe, expect, it } from "vitest";
import { decideRetry, executeCommand } from "../../../src/workflow/domain/index.js";
import type { RetryPolicy, RetryDecisionInput } from "../../../src/workflow/domain/index.js";
import { at, meta, reachTaskState, requireTaskFor } from "./helpers/fixtures.js";
import { eventTypes } from "./helpers/commits.js";

const BY_DEFINITION = { kind: "retryable_by_definition" } as const;

function policy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return {
    maxAttempts: 10,
    initialDelayMs: 1_000,
    maxDelayMs: 60_000,
    backoff: "fixed",
    ...overrides,
  };
}

function delayOf(input: RetryDecisionInput): number | undefined {
  const result = decideRetry(input);
  if (!result.ok || result.value.kind !== "retry") return undefined;
  return result.value.delayMs;
}

describe("SC-043: 재시도 지연은 백오프 규칙대로이고 상한에서 잘린다", () => {
  it("Happy: 고정 백오프는 시도마다 초기 지연이다 (test_SC043_fixed_initial_delay)", () => {
    for (const attemptNo of [1, 2, 3]) {
      expect(decideRetry({ policy: policy(), attemptNo, failure: BY_DEFINITION })).toEqual({
        ok: true,
        value: { kind: "retry", delayMs: 1_000, baseDelayMs: 1_000, jitterDrawMs: 0 },
      });
    }
  });

  it("Edge: 지수 백오프는 두 배씩 늘고 상한에서 잘린다 (test_SC043_exponential_clamped)", () => {
    const exponential = policy({ backoff: "exponential" });
    expect(
      [1, 2, 3].map((n) => delayOf({ policy: exponential, attemptNo: n, failure: BY_DEFINITION })),
    ).toEqual([1_000, 2_000, 4_000]);
    const capped = policy({ backoff: "exponential", maxDelayMs: 3_000 });
    expect(delayOf({ policy: capped, attemptNo: 3, failure: BY_DEFINITION })).toBe(3_000);
  });

  it("Error: 큰 시도 번호도 상한 값의 유한 지연이다 (test_SC043_large_attempt_no_clamped_finite)", () => {
    const delay = delayOf({
      policy: policy({ backoff: "exponential", maxAttempts: 2_000 }),
      attemptNo: 1_000,
      failure: BY_DEFINITION,
    });
    expect(delay).toBe(60_000);
    expect(Number.isFinite(delay)).toBe(true);
  });
});

describe("SC-044: 예산 소진과 재시도 불가 오류는 실패이고 실패는 재시도를 뜻하지 않는다", () => {
  it("Happy: 시도 번호가 예산에 닿으면 retry_budget_exhausted 실패다 (test_SC044_budget_exhausted_fails)", () => {
    expect(
      decideRetry({ policy: policy({ maxAttempts: 3 }), attemptNo: 3, failure: BY_DEFINITION }),
    ).toEqual({ ok: true, value: { kind: "fail", cause: "retry_budget_exhausted" } });
  });

  it("Edge: 재시도 가능 목록 밖 코드는 예산과 무관하게 non_retryable_error 다 (test_SC044_non_retryable_code_fails)", () => {
    const listed = policy({ retryableErrors: ["transient"] });
    expect(
      decideRetry({
        policy: listed,
        attemptNo: 1,
        failure: { kind: "error_code", code: "permanent" },
      }),
    ).toEqual({ ok: true, value: { kind: "fail", cause: "non_retryable_error" } });
    expect(
      decideRetry({
        policy: policy(),
        attemptNo: 1,
        failure: { kind: "error_code", code: "transient" },
      }),
    ).toEqual({ ok: true, value: { kind: "fail", cause: "non_retryable_error" } });
    expect(
      decideRetry({
        policy: listed,
        attemptNo: 1,
        failure: { kind: "error_code", code: "transient" },
      }).ok,
    ).toBe(true);
  });

  it("Error: 명령 경로의 재시도 불가 실패는 FAILED 이고 재시도 대기 이벤트가 없다 (test_SC044_command_path_failed_no_retry_wait)", () => {
    const { deps, aggregate, taskId } = reachTaskState("RUNNING");
    const before = requireTaskFor(aggregate, taskId);
    expect(before.policy.retry.maxAttempts).toBeGreaterThan(1);
    const attemptId = before.openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    const outcome = executeCommand(deps, aggregate, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: before.revision,
      meta: meta(at("2026-01-01T00:00:00Z")),
      attemptId,
      outcome: { kind: "failed", code: "permanent_error" },
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(eventTypes(outcome.commit)).not.toContain("task_retry_wait");
    expect(requireTaskFor(outcome.aggregate, taskId).state).toBe("FAILED");
  });
});

describe("SC-045: 재시도 결정은 주입값만 쓴다", () => {
  const jittered = policy({ jitterMs: 500 });

  it("Happy: 같은 입력은 같은 결정이다 (test_SC045_same_input_same_decision)", () => {
    const input: RetryDecisionInput = {
      policy: policy({ backoff: "exponential", jitterMs: 500 }),
      attemptNo: 2,
      failure: BY_DEFINITION,
      jitterDrawMs: 123,
    };
    expect(decideRetry(input)).toEqual(decideRetry(input));
  });

  it("Edge: 지터 차이만큼 지연이 다르고 지터는 기본 지연에 더해진다 (test_SC045_jitter_difference_only)", () => {
    const a = decideRetry({
      policy: jittered,
      attemptNo: 1,
      failure: BY_DEFINITION,
      jitterDrawMs: 100,
    });
    const b = decideRetry({
      policy: jittered,
      attemptNo: 1,
      failure: BY_DEFINITION,
      jitterDrawMs: 400,
    });
    expect(a).toEqual({
      ok: true,
      value: { kind: "retry", delayMs: 1_100, baseDelayMs: 1_000, jitterDrawMs: 100 },
    });
    if (a.ok && b.ok && a.value.kind === "retry" && b.value.kind === "retry")
      expect(b.value.delayMs - a.value.delayMs).toBe(300);
  });

  it("Error: 지터 입력이 정책과 맞지 않으면 retry_input 오류다 (test_SC045_invalid_jitter_input_rejected)", () => {
    const rejected = (input: RetryDecisionInput, field: "attemptNo" | "jitterDrawMs") => {
      const result = decideRetry(input);
      expect(result.ok, JSON.stringify(input)).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("retry_input");
        expect(result.error.field).toBe(field);
      }
    };
    rejected({ policy: jittered, attemptNo: 1, failure: BY_DEFINITION }, "jitterDrawMs");
    rejected(
      { policy: jittered, attemptNo: 1, failure: BY_DEFINITION, jitterDrawMs: 501 },
      "jitterDrawMs",
    );
    rejected(
      { policy: jittered, attemptNo: 1, failure: BY_DEFINITION, jitterDrawMs: -1 },
      "jitterDrawMs",
    );
    rejected(
      { policy: jittered, attemptNo: 1, failure: BY_DEFINITION, jitterDrawMs: 1.5 },
      "jitterDrawMs",
    );
    rejected(
      { policy: policy(), attemptNo: 1, failure: BY_DEFINITION, jitterDrawMs: 5 },
      "jitterDrawMs",
    );
    rejected({ policy: policy(), attemptNo: 0, failure: BY_DEFINITION }, "attemptNo");
  });
});
