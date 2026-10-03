/**
 * fan-out 동시성 — 한도는 dispatch 를 늦추기만 한다(건너뛰기·실패·제거 없음, 이벤트·결정 없음).
 * 슬롯 보유 = 열린 attempt 가 있거나, 취소로 attempt 가 닫힌 뒤 dispatch 가 살아 있음. 사람·재시도·
 * 차단·입력 대기는 슬롯을 갖지 않는다.
 */
import { DomainInvariantError } from "../result.js";
import type { TaskId } from "../ids.js";
import type { WorkAggregate } from "../aggregate.js";

export interface FanOutMemberState {
  readonly taskId: TaskId;
  readonly hasOpenAttempt: boolean;
  readonly liveDispatchAfterCancel: boolean;
  readonly awaitingDispatch: boolean;
}

export interface FanOutEvaluation {
  readonly held: number;
  /** max(0, bound - held) */
  readonly available: number;
  /** 구성원 순서 */
  readonly dispatchable: readonly TaskId[];
  readonly delayed: readonly TaskId[];
}

function holdsSlot(member: FanOutMemberState): boolean {
  return member.hasOpenAttempt || member.liveDispatchAfterCancel;
}

/** bound 는 양의 정수(아니면 DomainInvariantError). 입력을 바꾸지 않는다. */
export function evaluateFanOutConcurrency(
  bound: number,
  members: readonly FanOutMemberState[],
): FanOutEvaluation {
  if (!Number.isSafeInteger(bound) || bound < 1) {
    throw new DomainInvariantError(`fan-out 한도는 양의 정수여야 한다: ${String(bound)}`);
  }
  const held = members.filter(holdsSlot).length;
  const available = Math.max(0, bound - held);
  const dispatchable: TaskId[] = [];
  const delayed: TaskId[] = [];
  for (const member of members) {
    if (!member.awaitingDispatch || holdsSlot(member)) continue;
    if (dispatchable.length < available) dispatchable.push(member.taskId);
    else delayed.push(member.taskId);
  }
  return { held, available, dispatchable, delayed };
}

/** 소유 Task 를 `parentTaskId` 로 가리키는 Task(`Work.taskIds` 순서). */
export function fanOutMemberStates(
  aggregate: WorkAggregate,
  ownerTaskId: TaskId,
  facts: {
    readonly awaitingDispatch: ReadonlySet<TaskId>;
    readonly liveDispatchAfterCancel: ReadonlySet<TaskId>;
  },
): readonly FanOutMemberState[] {
  const out: FanOutMemberState[] = [];
  for (const taskId of aggregate.work.taskIds) {
    const task = aggregate.tasks[taskId];
    if (task === undefined || task.parentTaskId !== ownerTaskId) continue;
    out.push({
      taskId: task.id,
      hasOpenAttempt: task.openAttempt !== undefined,
      liveDispatchAfterCancel:
        task.state === "CANCELED" && facts.liveDispatchAfterCancel.has(task.id),
      awaitingDispatch: facts.awaitingDispatch.has(task.id),
    });
  }
  return out;
}
