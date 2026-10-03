// SC-039, SC-041, SC-042 — fan-out 동시 실행 한도는 dispatch 를 늦출 뿐이다.
import { describe, expect, it } from "vitest";
import {
  evaluateFanOutConcurrency,
  fanOutMemberStates,
  executeCommand,
  DomainInvariantError,
} from "../../../src/workflow/domain/index.js";
import type {
  DomainDeps,
  FanOutMemberState,
  TaskId,
  WorkAggregate,
} from "../../../src/workflow/domain/index.js";
import {
  at,
  meta,
  draft,
  entityId,
  planned,
  mustCommit,
  patchTask,
  requireTaskFor,
  taskSubjectPendingDecision,
  controlRequestCancelOrigin,
  testDeps,
  RETRYABLE_FIXTURE_CODE,
  UNREGISTERED_TASK_TYPE,
} from "./helpers/fixtures.js";
import { fixtureRegistries, probeTaskType } from "./helpers/registry-fixtures.js";

const NOW = at("2026-01-01T00:00:00Z");

function member(n: number, overrides: Partial<FanOutMemberState> = {}): FanOutMemberState {
  return {
    taskId: entityId("task", `tsk_member${String(n).padStart(4, "0")}`),
    hasOpenAttempt: false,
    liveDispatchAfterCancel: false,
    awaitingDispatch: true,
    ...overrides,
  };
}

const holding = (n: number) => member(n, { hasOpenAttempt: true, awaitingDispatch: false });

type ChildState =
  | "READY"
  | "RUNNING"
  | "RETRY_WAIT"
  | "BLOCKED"
  | "WAITING_INPUT"
  | "BLOCKED_AWAITING_HUMAN"
  | "CANCELED";

/** 소유 Task 와 그를 부모로 가리키는 자식들을 실제 명령으로 각 상태까지 진행한다. */
function ownerWithChildren(
  seed: string,
  children: Readonly<Record<string, ChildState>>,
): { deps: DomainDeps; aggregate: WorkAggregate; ownerId: TaskId; ids: Record<string, TaskId> } {
  const deps = testDeps(seed, fixtureRegistries());
  const labels = Object.keys(children);
  const { aggregate, taskIds } = planned(
    [draft("owner"), ...labels.map((l) => draft(l, { parent: { draftRef: "owner" } }))],
    deps,
  );
  const ownerId = taskIds["owner"];
  if (ownerId === undefined) throw new Error("expected owner task");
  let current = aggregate;
  const command = (taskId: TaskId, body: Record<string, unknown> & { kind: string }): void => {
    current = mustCommit(
      executeCommand(deps, current, {
        taskId,
        expectedRevision: requireTaskFor(current, taskId).revision,
        meta: meta(NOW),
        ...body,
      } as Parameters<typeof executeCommand>[2]),
    ).aggregate;
  };
  const attempt = (taskId: TaskId) => {
    const id = requireTaskFor(current, taskId).openAttempt?.attemptId;
    if (id === undefined) throw new Error("expected open attempt");
    return id;
  };
  for (const label of labels) {
    const taskId = taskIds[label];
    if (taskId === undefined) throw new Error(`expected ${label}`);
    const target = children[label];
    command(taskId, { kind: "begin_validation" });
    // 레코드 패치: 입력 대기·차단 출구를 다른 생성 경로·등록부 drift 대용으로 재현.
    if (target === "WAITING_INPUT")
      current = patchTask(current, taskId, {
        type: { id: probeTaskType().id, version: probeTaskType().version },
      });
    if (target === "BLOCKED")
      current = patchTask(current, taskId, { type: UNREGISTERED_TASK_TYPE });
    command(taskId, { kind: "complete_validation" });
    if (target === "READY" || target === "WAITING_INPUT" || target === "BLOCKED") continue;
    command(taskId, { kind: "start_attempt" });
    if (target === "RETRY_WAIT")
      command(taskId, {
        kind: "record_attempt_outcome",
        attemptId: attempt(taskId),
        outcome: { kind: "failed", code: RETRYABLE_FIXTURE_CODE },
      });
    if (target === "BLOCKED_AWAITING_HUMAN")
      command(taskId, {
        kind: "record_attempt_outcome",
        attemptId: attempt(taskId),
        outcome: {
          kind: "blocked",
          cause: "gate_denied",
          decision: taskSubjectPendingDecision(deps, taskId, NOW),
        },
      });
    if (target === "CANCELED")
      command(taskId, { kind: "cancel_task", origin: controlRequestCancelOrigin(deps) });
    if (requireTaskFor(current, taskId).state !== target)
      throw new Error(`fixture: ${label} reached ${requireTaskFor(current, taskId).state}`);
  }
  const ids: Record<string, TaskId> = {};
  for (const label of labels) {
    const id = taskIds[label];
    if (id !== undefined) ids[label] = id;
  }
  return { deps, aggregate: current, ownerId, ids };
}

describe("SC-039: fan-out 한도에 닿으면 dispatch 가 늦춰질 뿐이다", () => {
  it("Happy: 한도 2·보유 2 이면 대기 다섯이 모두 지연된다 (test_SC039_limit_reached_zero_dispatch)", () => {
    const waiting = [3, 4, 5, 6, 7].map((n) => member(n));
    const result = evaluateFanOutConcurrency(2, [holding(1), holding(2), ...waiting]);
    expect(result).toEqual({
      held: 2,
      available: 0,
      dispatchable: [],
      delayed: waiting.map((m) => m.taskId),
    });
  });

  it("Edge: 슬롯 하나가 비면 구성원 순서로 하나만 dispatch 된다 (test_SC039_slot_frees_one_dispatch)", () => {
    const waiting = [3, 4, 5, 6, 7].map((n) => member(n));
    const result = evaluateFanOutConcurrency(2, [holding(1), ...waiting]);
    expect(result.held).toBe(1);
    expect(result.dispatchable).toEqual([waiting[0]?.taskId]);
    expect(result.delayed).toEqual(waiting.slice(1).map((m) => m.taskId));
  });

  it("Error: 결과에 이벤트·결정이 없고 입력이 바뀌지 않는다 (test_SC039_no_events_inputs_unchanged)", () => {
    const members = Object.freeze([holding(1), member(2), member(3)].map((m) => Object.freeze(m)));
    const snapshot = structuredClone(members);
    const result = evaluateFanOutConcurrency(1, members);
    expect(Object.keys(result).sort()).toEqual(["available", "delayed", "dispatchable", "held"]);
    expect(members).toEqual(snapshot);
  });
});

describe("SC-041: 한도를 낮춰도 진행 중인 것은 끝나지 않는다", () => {
  it("Happy: 보유 4 에서 한도를 2 로 낮추면 새 dispatch 가 0 이다 (test_SC041_lowered_limit_no_new_dispatch)", () => {
    const result = evaluateFanOutConcurrency(2, [
      holding(1),
      holding(2),
      holding(3),
      holding(4),
      member(5),
    ]);
    expect(result.held).toBe(4);
    expect(result.dispatchable).toEqual([]);
    expect(result.delayed).toEqual([member(5).taskId]);
  });

  it("Edge: 경계 — 보유 2 는 0, 보유 1 은 1 허용이다 (test_SC041_boundary_held_counts)", () => {
    expect(
      evaluateFanOutConcurrency(2, [holding(1), holding(2), member(3)]).dispatchable,
    ).toHaveLength(0);
    expect(
      evaluateFanOutConcurrency(2, [holding(1), member(2), member(3)]).dispatchable,
    ).toHaveLength(1);
  });

  it("Error: 허용 수는 음수가 되지 않고 양의 정수가 아닌 한도는 불변식 위반이다 (test_SC041_available_never_negative)", () => {
    const result = evaluateFanOutConcurrency(1, [holding(1), holding(2), holding(3), holding(4)]);
    expect(result.available).toBe(0);
    expect(() => evaluateFanOutConcurrency(0, [member(1)])).toThrow(DomainInvariantError);
    expect(() => evaluateFanOutConcurrency(1.5, [member(1)])).toThrow(DomainInvariantError);
  });
});

describe("SC-042: 사람·재시도·차단·입력 대기 Task 는 슬롯을 쥐지 않는다", () => {
  it("Happy: 대기 상태 넷은 보유하지 않아 적격 하나가 dispatch 된다 (test_SC042_waiting_states_hold_no_slot)", () => {
    const { aggregate, ownerId, ids } = ownerWithChildren("sc042a", {
      human: "BLOCKED_AWAITING_HUMAN",
      retry: "RETRY_WAIT",
      blocked: "BLOCKED",
      input: "WAITING_INPUT",
      eligible: "READY",
    });
    const eligible = ids["eligible"];
    if (eligible === undefined) throw new Error("expected eligible");
    const members = fanOutMemberStates(aggregate, ownerId, {
      awaitingDispatch: new Set([eligible]),
      liveDispatchAfterCancel: new Set(),
    });
    expect(members.map((m) => m.taskId)).toEqual(
      ["human", "retry", "blocked", "input", "eligible"].map((l) => ids[l]),
    );
    const result = evaluateFanOutConcurrency(1, members);
    expect(result.held).toBe(0);
    expect(result.dispatchable).toEqual([eligible]);
  });

  it("Edge: 취소 뒤 dispatch 가 살아 있으면 슬롯을 쥔다 (test_SC042_canceled_live_dispatch_holds_slot)", () => {
    const { aggregate, ownerId, ids } = ownerWithChildren("sc042b", { canceled: "CANCELED" });
    const canceled = ids["canceled"];
    if (canceled === undefined) throw new Error("expected canceled");
    const members = fanOutMemberStates(aggregate, ownerId, {
      awaitingDispatch: new Set(),
      liveDispatchAfterCancel: new Set([canceled]),
    });
    expect(evaluateFanOutConcurrency(1, members).held).toBe(1);
  });

  it("Error: 취소되고 dispatch 도 끝났으면 슬롯을 쥐지 않는다 (test_SC042_canceled_without_live_dispatch_holds_none)", () => {
    const { aggregate, ownerId } = ownerWithChildren("sc042c", { canceled: "CANCELED" });
    const members = fanOutMemberStates(aggregate, ownerId, {
      awaitingDispatch: new Set(),
      liveDispatchAfterCancel: new Set(),
    });
    expect(members).toHaveLength(1);
    expect(evaluateFanOutConcurrency(1, members).held).toBe(0);
  });
});
