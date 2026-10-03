/**
 * 생성 한도 평가 — 깊이·Work 당 Task 수·사슬 당 자동 Work 수 중 넘는 것 전부(이 순서). 넘으면 기록할
 * 이벤트·결정 형태와 주차 대상, 보존할 제안을 돌려준다. 커밋 배선은 하지 않는다(계약 전이 표에 생성
 * 한도 주차 행이 아직 없다). fan-out 한도는 입력이 아니다 — 늦추기만 하므로 위반이 아니다.
 */
import type { TaskId } from "../ids.js";
import type { TaskPolicy } from "../task-policy.js";

export interface SpawnLimitInput {
  readonly spawningTaskId: TaskId;
  readonly limits: Pick<TaskPolicy, "maxSpawnDepth" | "maxTasksPerWork" | "maxWorksPerChain">;
  /** 사슬 루트 = 0 */
  readonly spawningTaskDepth: number;
  /** 요청 전 */
  readonly targetWorkTaskCount: number;
  /** 요청 전, 사슬이 자동 생성한 Work 수 */
  readonly chainAutoWorkCount: number;
  readonly request: {
    readonly addsTasks: number;
    readonly addsWorks: number;
    readonly proposal: unknown;
  };
}

export interface SpawnLimitBreach {
  readonly limit: "maxSpawnDepth" | "maxTasksPerWork" | "maxWorksPerChain";
  readonly max: number;
  readonly attempted: number;
}

export type SpawnLimitVerdict =
  | { readonly kind: "within_limits" }
  | {
      readonly kind: "exceeded";
      readonly breaches: readonly SpawnLimitBreach[];
      readonly event: {
        readonly type: "spawn_limit_exceeded";
        readonly payload: {
          readonly spawningTaskId: TaskId;
          readonly breaches: readonly SpawnLimitBreach[];
        };
      };
      readonly decision: {
        readonly kind: "spawn_limit_exceeded";
        readonly taskId: TaskId;
        readonly summary: string;
      };
      readonly parkTo: "BLOCKED_AWAITING_HUMAN";
      /** 입력 proposal 과 같은 참조 */
      readonly preservedRequest: unknown;
    };

export function evaluateSpawnLimits(input: SpawnLimitInput): SpawnLimitVerdict {
  const candidates: SpawnLimitBreach[] = [
    {
      limit: "maxSpawnDepth",
      max: input.limits.maxSpawnDepth,
      attempted: input.spawningTaskDepth + 1,
    },
    {
      limit: "maxTasksPerWork",
      max: input.limits.maxTasksPerWork,
      attempted: input.targetWorkTaskCount + input.request.addsTasks,
    },
    {
      limit: "maxWorksPerChain",
      max: input.limits.maxWorksPerChain,
      attempted: input.chainAutoWorkCount + input.request.addsWorks,
    },
  ];
  const breaches = candidates.filter((c) => c.attempted > c.max);
  if (breaches.length === 0) return { kind: "within_limits" };
  return {
    kind: "exceeded",
    breaches,
    event: {
      type: "spawn_limit_exceeded",
      payload: { spawningTaskId: input.spawningTaskId, breaches },
    },
    decision: {
      kind: "spawn_limit_exceeded",
      taskId: input.spawningTaskId,
      summary: `Spawn limit exceeded: ${breaches.map((b) => b.limit).join(", ")}`,
    },
    parkTo: "BLOCKED_AWAITING_HUMAN",
    preservedRequest: input.request.proposal,
  };
}
