/**
 * 실행 전 승인 판정과 주차 이벤트 — 명령 판정·검증 출구·연쇄가 같은 조건을 쓰도록 한 곳에 둔다.
 * 승인은 Task 당 한 번이다(재시도에서 다시 묻지 않는다).
 */
import type { TaskRecord } from "../aggregate.js";
import type { UtcInstant } from "../values.js";
import type { DecidedEvent } from "../events.js";
import { mkEvent } from "../events.js";
import { buildPreExecutionApprovalDecision } from "../pending-decision.js";
import type { DomainDeps } from "../engine.js";

export function requiresPreExecutionApproval(
  task: Pick<TaskRecord, "policy" | "preExecutionApproved">,
): boolean {
  return task.policy.approvalRequiredBeforeExecute && !task.preExecutionApproved;
}

export function preExecutionApprovalPark(
  deps: DomainDeps,
  task: Pick<TaskRecord, "id" | "title">,
  now: UtcInstant,
): DecidedEvent {
  return mkEvent(
    "task_awaiting_human",
    {
      pendingDecision: buildPreExecutionApprovalDecision(deps.ids, task, now),
      cause: "approval_required_before_execute",
    },
    { taskId: task.id },
  );
}
