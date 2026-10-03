// SC-040 — property: fan-out 한도는 대기 구성원을 버리거나 건너뛰지 않는다.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { evaluateFanOutConcurrency } from "../../../../src/workflow/domain/index.js";
import type { FanOutMemberState } from "../../../../src/workflow/domain/index.js";
import { entityId } from "../helpers/fixtures.js";

const members = fc
  .array(
    fc.record({
      hasOpenAttempt: fc.boolean(),
      liveDispatchAfterCancel: fc.boolean(),
      awaitingDispatch: fc.boolean(),
    }),
    { maxLength: 12 },
  )
  .map((flags) =>
    flags.map((f, i): FanOutMemberState => ({
      taskId: entityId("task", `tsk_prop${String(i).padStart(4, "0")}`),
      ...f,
    })),
  );

const bound = fc.integer({ min: 1, max: 6 });

describe("SC-040: property — 허용 dispatch 는 한도 − 보유 이하다", () => {
  it("test_SC040_property_allowed_within_bound_minus_held", () => {
    fc.assert(
      fc.property(bound, members, (limit, list) => {
        const held = list.filter((m) => m.hasOpenAttempt || m.liveDispatchAfterCancel).length;
        const result = evaluateFanOutConcurrency(limit, list);
        expect(result.held).toBe(held);
        expect(result.available).toBe(Math.max(0, limit - held));
        expect(result.dispatchable.length).toBeLessThanOrEqual(Math.max(0, limit - held));
        expect(evaluateFanOutConcurrency(limit, list)).toEqual(result);
      }),
    );
  });
});

describe("SC-040: property — 대기 구성원은 하나도 사라지지 않는다", () => {
  it("test_SC040_property_no_member_dropped", () => {
    fc.assert(
      fc.property(bound, members, (limit, list) => {
        const result = evaluateFanOutConcurrency(limit, list);
        const waiting = list
          .filter((m) => m.awaitingDispatch && !m.hasOpenAttempt && !m.liveDispatchAfterCancel)
          .map((m) => m.taskId);
        expect([...result.dispatchable, ...result.delayed]).toEqual(waiting);
        const overlap = result.dispatchable.filter((id) => result.delayed.includes(id));
        expect(overlap).toEqual([]);
        expect(Object.keys(result).sort()).toEqual([
          "available",
          "delayed",
          "dispatchable",
          "held",
        ]);
      }),
    );
  });
});
