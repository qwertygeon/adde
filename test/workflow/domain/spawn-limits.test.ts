// SC-049, SC-050 — 생성 한도 초과는 대기 결정이 되고, 한도 안 생성은 통과한다.
import { describe, expect, it } from "vitest";
import {
  evaluateSpawnLimits,
  evaluateFanOutConcurrency,
} from "../../../src/workflow/domain/index.js";
import type { SpawnLimitInput } from "../../../src/workflow/domain/index.js";
import { entityId } from "./helpers/fixtures.js";

const SPAWNING = entityId("task", "tsk_spawner0001");
const LIMITS = { maxSpawnDepth: 2, maxTasksPerWork: 50, maxWorksPerChain: 10 } as const;

function input(overrides: Partial<SpawnLimitInput> = {}): SpawnLimitInput {
  return {
    spawningTaskId: SPAWNING,
    limits: LIMITS,
    spawningTaskDepth: 0,
    targetWorkTaskCount: 10,
    chainAutoWorkCount: 0,
    request: { addsTasks: 1, addsWorks: 0, proposal: { title: "child" } },
    ...overrides,
  };
}

describe("SC-049: 생성 한도 초과는 버리거나 실패하지 않고 대기 결정이 된다", () => {
  it("Happy: 깊이 초과는 사람 대기 결정과 주차 대상을 내고 요청을 보존한다 (test_SC049_depth_exceeded_decision_and_park)", () => {
    const proposal = { title: "deep child" };
    const verdict = evaluateSpawnLimits(
      input({ spawningTaskDepth: 2, request: { addsTasks: 1, addsWorks: 0, proposal } }),
    );
    expect(verdict.kind).toBe("exceeded");
    if (verdict.kind !== "exceeded") return;
    const breaches = [{ limit: "maxSpawnDepth", max: 2, attempted: 3 }];
    expect(verdict.breaches).toEqual(breaches);
    expect(verdict.event).toEqual({
      type: "spawn_limit_exceeded",
      payload: { spawningTaskId: SPAWNING, breaches },
    });
    expect(verdict.decision.kind).toBe("spawn_limit_exceeded");
    expect(verdict.decision.taskId).toBe(SPAWNING);
    expect(verdict.parkTo).toBe("BLOCKED_AWAITING_HUMAN");
    expect(verdict.preservedRequest).toBe(proposal);
  });

  it("Edge: Work 당 Task 수 초과 (test_SC049_tasks_per_work_exceeded)", () => {
    const verdict = evaluateSpawnLimits(
      input({ targetWorkTaskCount: 49, request: { addsTasks: 2, addsWorks: 0, proposal: {} } }),
    );
    expect(verdict.kind === "exceeded" ? verdict.breaches : []).toEqual([
      { limit: "maxTasksPerWork", max: 50, attempted: 51 },
    ]);
  });

  it("Error: 사슬 당 Work 수 초과도 보존·주차이고 위반은 정해진 순서로 전부 나온다 (test_SC049_works_per_chain_exceeded_preserved)", () => {
    const proposal = { objective: "more work" };
    const verdict = evaluateSpawnLimits(
      input({ chainAutoWorkCount: 10, request: { addsTasks: 0, addsWorks: 1, proposal } }),
    );
    expect(verdict.kind).toBe("exceeded");
    if (verdict.kind !== "exceeded") return;
    expect(verdict.breaches).toEqual([{ limit: "maxWorksPerChain", max: 10, attempted: 11 }]);
    expect(verdict.preservedRequest).toBe(proposal);
    expect(Object.keys(verdict).sort()).toEqual([
      "breaches",
      "decision",
      "event",
      "kind",
      "parkTo",
      "preservedRequest",
    ]);

    const all = evaluateSpawnLimits(
      input({
        spawningTaskDepth: 2,
        targetWorkTaskCount: 50,
        chainAutoWorkCount: 10,
        request: { addsTasks: 1, addsWorks: 1, proposal },
      }),
    );
    expect(all.kind === "exceeded" ? all.breaches.map((b) => b.limit) : []).toEqual([
      "maxSpawnDepth",
      "maxTasksPerWork",
      "maxWorksPerChain",
    ]);
  });
});

describe("SC-050: 한도 안 생성은 통과하고 fan-out 동시 실행 한도는 생성 한도가 아니다", () => {
  it("Happy: 세 한도 안쪽이면 통과한다 (test_SC050_within_limits_passes)", () => {
    expect(evaluateSpawnLimits(input())).toEqual({ kind: "within_limits" });
  });

  it("Edge: 결과가 한도와 같으면 통과한다 (test_SC050_boundary_equal_max_passes)", () => {
    expect(
      evaluateSpawnLimits(
        input({
          spawningTaskDepth: 1,
          targetWorkTaskCount: 49,
          chainAutoWorkCount: 9,
          request: { addsTasks: 1, addsWorks: 1, proposal: {} },
        }),
      ),
    ).toEqual({ kind: "within_limits" });
  });

  it("Error: fan-out 한도에 닿은 상황에서도 생성 한도 판정은 통과다 (test_SC050_fan_out_reached_not_spawn_limit)", () => {
    const fanOut = evaluateFanOutConcurrency(1, [
      {
        taskId: entityId("task", "tsk_running0001"),
        hasOpenAttempt: true,
        liveDispatchAfterCancel: false,
        awaitingDispatch: false,
      },
      {
        taskId: entityId("task", "tsk_waiting0001"),
        hasOpenAttempt: false,
        liveDispatchAfterCancel: false,
        awaitingDispatch: true,
      },
    ]);
    expect(fanOut.dispatchable).toEqual([]);
    const limitsWithFanOut = { ...LIMITS, fanOutMaxConcurrent: 1 };
    expect(evaluateSpawnLimits(input({ limits: limitsWithFanOut }))).toEqual({
      kind: "within_limits",
    });
  });
});
