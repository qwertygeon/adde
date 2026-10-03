// SC-045 — property: 재시도 결정은 결정적이고 지터는 기본 지연에 더해진다.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decideRetry } from "../../../../src/workflow/domain/index.js";
import type { RetryPolicy } from "../../../../src/workflow/domain/index.js";

const retryPolicy = fc
  .record({
    maxAttempts: fc.integer({ min: 2, max: 50 }),
    initialDelayMs: fc.integer({ min: 0, max: 10_000 }),
    extraMaxDelayMs: fc.integer({ min: 0, max: 100_000 }),
    backoff: fc.constantFrom<"fixed" | "exponential">("fixed", "exponential"),
    jitterMs: fc.integer({ min: 1, max: 5_000 }),
  })
  .map((p): RetryPolicy => ({
    maxAttempts: p.maxAttempts,
    initialDelayMs: p.initialDelayMs,
    maxDelayMs: p.initialDelayMs + p.extraMaxDelayMs,
    backoff: p.backoff,
    jitterMs: p.jitterMs,
  }));

describe("SC-045: property — 같은 입력은 같은 결정이고 지터는 가산이다", () => {
  it("test_SC045_property_deterministic_and_jitter_additive", () => {
    fc.assert(
      fc.property(
        retryPolicy.chain((policy) =>
          fc.tuple(
            fc.constant(policy),
            fc.integer({ min: 1, max: policy.maxAttempts - 1 }),
            fc.integer({ min: 0, max: policy.jitterMs ?? 0 }),
            fc.integer({ min: 0, max: policy.jitterMs ?? 0 }),
          ),
        ),
        ([policy, attemptNo, drawA, drawB]) => {
          const failure = { kind: "retryable_by_definition" } as const;
          const a = decideRetry({ policy, attemptNo, failure, jitterDrawMs: drawA });
          expect(decideRetry({ policy, attemptNo, failure, jitterDrawMs: drawA })).toEqual(a);
          const b = decideRetry({ policy, attemptNo, failure, jitterDrawMs: drawB });
          if (!a.ok || !b.ok || a.value.kind !== "retry" || b.value.kind !== "retry")
            throw new Error("expected retry decisions within budget");
          expect(a.value.baseDelayMs).toBe(b.value.baseDelayMs);
          expect(a.value.baseDelayMs).toBeLessThanOrEqual(policy.maxDelayMs);
          expect(a.value.delayMs).toBe(a.value.baseDelayMs + drawA);
          expect(a.value.delayMs - b.value.delayMs).toBe(drawA - drawB);
        },
      ),
    );
  });
});
