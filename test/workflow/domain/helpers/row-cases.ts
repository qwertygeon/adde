// 전이 행별 테스트 케이스 생성기.
//
// 설계: `TASK_ROW_CASES`·`WORK_ROW_CASES` 는 **전사 데이터(`TASK_TRANSITION_ROWS`·`WORK_TRANSITION_ROWS`,
// Development T003 산출)를 런타임에 순회**하며 케이스를 생성한다 — 행 ID 문자열을 이 파일에 하드코딩하지
// 않는다. 레시피는 (이벤트 이름, 출발 상태, 도착 상태) 3중으로 색인한다 — 같은 (event, from) 이 서로 다른
// to 를 갖는 행이 실제로 존재하므로(예: `human_decision_granted@BLOCKED_AWAITING_HUMAN`→READY/SCHEDULED,
// `work_plan_rejected@WAITING_APPROVAL`→PLANNING/READY) to 까지 포함해야 행을 안전하게 구분한다.
//
// 레시피가 없는 (event, fromState, to) 조합은 `apply()` 가 명확한 오류로 실패하는 케이스를 생성한다 —
// census(SC-004·SC-017·SC-042)는 "케이스 존재"를 구조적으로 만족시키되, 실행 결과(구현/레시피 갭)는
// test(EXECUTION) 이 실패 원인 분류로 드러낸다. 미비 레시피 목록은 SPEC_ROOT/test/test-cases.md
// "미커버 항목"을 참조.
import {
  executeCommand,
  judgeSignal,
  createWork,
  nextEntityId,
  deriveOccurrenceId,
  parsePendingDecision,
  parseProjectId,
  parseCancelOrigin,
} from "../../../../src/workflow/domain/index.js";
import type {
  DomainDeps,
  WorkAggregate,
  TaskId,
  TaskStateName,
  WorkStateName,
  CommandOutcome,
  SignalJudgement,
  TransitionRowData,
  DecisionSignal,
  DecisionApplication,
  WorkSource,
  PlanCommitInput,
} from "../../../../src/workflow/domain/index.js";
import {
  TASK_TRANSITION_ROWS,
  WORK_TRANSITION_ROWS,
} from "../../../../src/workflow/domain/index.js";
import {
  at,
  meta,
  mustOk,
  mustCommit,
  draft,
  basePolicy,
  reachDeadLetterParked,
  reachTaskState,
  reachWorkState,
  requireTaskFor,
  controlRequestCancelOrigin,
  taskSubjectPendingDecision,
  testDeps,
  planned,
  patchTask,
  RETRYABLE_FIXTURE_CODE,
  STRUCTURALLY_INVALID_INPUT,
  UNREGISTERED_TASK_TYPE,
} from "./fixtures.js";
import { fixtureRegistries, probeTaskType } from "./registry-fixtures.js";

const MISSING_INPUT_TYPE = { id: probeTaskType().id, version: probeTaskType().version };

function completeValidation(
  deps: DomainDeps,
  before: WorkAggregate,
  taskId: TaskId,
): CommandOutcome {
  return executeCommand(deps, before, {
    kind: "complete_validation",
    taskId,
    expectedRevision: requireTaskFor(before, taskId).revision,
    meta: meta(NOW),
  });
}

export interface RowCase {
  readonly row: TransitionRowData<string>;
  readonly fromState: string;
  build(): { deps: DomainDeps; before: WorkAggregate; targetTaskId?: TaskId };
  apply(deps: DomainDeps, before: WorkAggregate): CommandOutcome | SignalJudgement;
}

const NOW = at("2026-01-01T00:00:00Z");
const LATER = at("2026-01-01T00:10:00Z");
const PAST = at("2025-12-31T00:00:00Z");
/** NOW(reach 시점) 이후·LATER(expire 평가 시점) 이전 — RETRY_WAIT 도달 시엔 유효기한 미경과, expire 평가 시엔 경과. */
const BETWEEN = at("2026-01-01T00:05:00Z");

function missingRecipe(row: TransitionRowData<string>, fromState: string): CommandOutcome {
  throw new Error(
    `row-cases: no test recipe for event="${row.event}" fromState="${fromState}" to="${row.to}" (row id="${row.id}") — AUTHORING gap, see SPEC_ROOT/test/test-cases.md "미커버 항목"`,
  );
}

// ---- Task 레시피 -----------------------------------------------------------

interface TaskRecipe {
  reachBefore(): { deps: DomainDeps; aggregate: WorkAggregate; taskId: TaskId };
  apply(deps: DomainDeps, before: WorkAggregate, taskId: TaskId): CommandOutcome | SignalJudgement;
}

const taskRecipes = new Map<string, TaskRecipe>();
function put(event: string, fromState: string, to: string, recipe: TaskRecipe): void {
  taskRecipes.set(`${event}@${fromState}@${to}`, recipe);
}

put("task_validation_started", "DRAFT", "VALIDATING", {
  reachBefore: () => reachTaskState("DRAFT"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "begin_validation",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
    }),
});

// 아래 세 레시피의 레코드 패치는 같은 등록부로 계획 커밋이 막는 출구를 다른 생성 경로·등록부 drift
// 대용으로 Task 수준에서 재현한다.
put("task_input_requested", "VALIDATING", "WAITING_INPUT", {
  reachBefore: () => {
    const reached = reachTaskState("VALIDATING");
    return {
      ...reached,
      aggregate: patchTask(reached.aggregate, reached.taskId, { type: MISSING_INPUT_TYPE }),
    };
  },
  apply: completeValidation,
});

put("task_validated", "VALIDATING", "READY", {
  reachBefore: () => reachTaskState("VALIDATING"),
  apply: completeValidation,
});

put("task_blocked", "VALIDATING", "BLOCKED", {
  reachBefore: () => {
    const reached = reachTaskState("VALIDATING");
    return {
      ...reached,
      aggregate: patchTask(reached.aggregate, reached.taskId, { type: UNREGISTERED_TASK_TYPE }),
    };
  },
  apply: completeValidation,
});

put("task_validation_failed", "VALIDATING", "FAILED", {
  reachBefore: () => {
    const reached = reachTaskState("VALIDATING");
    return {
      ...reached,
      aggregate: patchTask(reached.aggregate, reached.taskId, {
        input: STRUCTURALLY_INVALID_INPUT,
      }),
    };
  },
  apply: completeValidation,
});

put("task_input_received", "WAITING_INPUT", "VALIDATING", {
  reachBefore: () => reachTaskState("WAITING_INPUT"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "receive_input",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
    }),
});

put("task_scheduled", "READY", "SCHEDULED", {
  reachBefore: () => reachTaskState("READY"),
  apply: (deps, before, taskId) => {
    const task = requireTaskFor(before, taskId);
    const occ = mustOk(
      deriveOccurrenceId({
        kind: "schedule",
        ownerId: taskId,
        triggerId: task.trigger.triggerId,
        scheduledForUtc: NOW,
        recurrenceIndex: 0,
      }),
    );
    return executeCommand(deps, before, {
      kind: "schedule_task",
      taskId,
      expectedRevision: task.revision,
      meta: meta(NOW),
      occurrenceId: occ,
      cause: "schedule",
    });
  },
});

put("task_scheduled", "RETRY_WAIT", "SCHEDULED", {
  reachBefore: () => reachTaskState("RETRY_WAIT"),
  apply: (deps, before, taskId) => {
    const task = requireTaskFor(before, taskId);
    const occ = mustOk(
      deriveOccurrenceId({
        kind: "schedule",
        ownerId: taskId,
        triggerId: task.trigger.triggerId,
        scheduledForUtc: NOW,
        recurrenceIndex: 0,
      }),
    );
    return executeCommand(deps, before, {
      kind: "schedule_task",
      taskId,
      expectedRevision: task.revision,
      meta: meta(NOW),
      occurrenceId: occ,
      cause: "retry",
    });
  },
});

put("task_unscheduled", "SCHEDULED", "READY", {
  reachBefore: () => reachTaskState("SCHEDULED"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "unschedule_task",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
    }),
});

put("task_started", "READY", "RUNNING", {
  reachBefore: () => reachTaskState("READY"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "start_attempt",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
    }),
});

put("task_started", "SCHEDULED", "RUNNING", {
  reachBefore: () => reachTaskState("SCHEDULED"),
  apply: (deps, before, taskId) => {
    const task = requireTaskFor(before, taskId);
    return executeCommand(deps, before, {
      kind: "start_attempt",
      taskId,
      expectedRevision: task.revision,
      meta: meta(NOW),
      ...(task.scheduledOccurrenceId !== undefined
        ? { firedOccurrenceId: task.scheduledOccurrenceId }
        : {}),
    });
  },
});

put("task_waiting_confirmation", "READY", "WAITING_CONFIRMATION", {
  reachBefore: () => reachTaskState("READY"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "begin_confirmation_wait",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
      confirmationId: nextEntityId(deps.ids, "confirmation"),
    }),
});

put("task_waiting_confirmation", "SCHEDULED", "WAITING_CONFIRMATION", {
  reachBefore: () => reachTaskState("SCHEDULED"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "begin_confirmation_wait",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
      confirmationId: nextEntityId(deps.ids, "confirmation"),
    }),
});

put("task_awaiting_human", "READY", "BLOCKED_AWAITING_HUMAN", {
  reachBefore: () => reachTaskState("READY"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "park_awaiting_human",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
      cause: "unattended_eligibility_refused",
      decision: taskSubjectPendingDecision(deps, taskId, NOW),
    }),
});

put("task_awaiting_human", "SCHEDULED", "BLOCKED_AWAITING_HUMAN", {
  reachBefore: () => reachTaskState("SCHEDULED"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "park_awaiting_human",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
      cause: "unattended_eligibility_refused",
      decision: taskSubjectPendingDecision(deps, taskId, NOW),
    }),
});

// 연쇄(cascade) — dependent 의 상태 변화가 자신의 명령이 아니라 의존(dep) 의 종결로 유발된다.
// `reachBefore` 의 targetTaskId 는 census 가 검사할 dependent 다 — apply 는 draftRef 로 dep 를 찾아
// 조작한다(둘 다 같은 aggregate 안에 있으므로 targetTaskId 하나로도 apply 내부에서 상대를 찾을 수 있다).
function findByDraftRef(aggregate: WorkAggregate, draftRef: string): TaskId {
  const record = Object.values(aggregate.tasks).find((t) => t.draftRef === draftRef);
  if (record === undefined)
    throw new Error(`row-cases: no task with draftRef="${draftRef}" in aggregate`);
  return record.id;
}

function dependencyCascadeReachBefore(
  seed: string,
  onDependencyUnsatisfied: "block" | "skip" | "fail",
  bringDependentTo: (
    deps: DomainDeps,
    aggregate: WorkAggregate,
    dependentId: TaskId,
  ) => WorkAggregate,
): { deps: DomainDeps; aggregate: WorkAggregate; taskId: TaskId } {
  const deps = testDeps(seed, fixtureRegistries());
  const policy = basePolicy({ onDependencyUnsatisfied });
  const { aggregate: planAgg, taskIds } = planned(
    [
      draft("dep", { policy }),
      draft("dependent", {
        dependsOn: [{ draftRef: "dep" }],
        policy,
        trigger: { kind: "immediate", version: 1, triggerId: "dependent" },
      }),
    ],
    deps,
  );
  const dependentId = taskIds["dependent"];
  if (dependentId === undefined)
    throw new Error("row-cases: dependency-cascade fixture missing dependent task");
  const aggregate = bringDependentTo(deps, planAgg, dependentId);
  return { deps, aggregate, taskId: dependentId };
}

function failDependency(
  deps: DomainDeps,
  before: WorkAggregate,
  dependentId: TaskId,
): CommandOutcome {
  void dependentId;
  const depId = findByDraftRef(before, "dep");
  const validating = mustCommit(
    executeCommand(deps, before, {
      kind: "begin_validation",
      taskId: depId,
      expectedRevision: requireTaskFor(before, depId).revision,
      meta: meta(NOW),
    }),
  );
  // 레코드 패치: 의존 Task 를 구조 무효로 종결시키는 다른 생성 경로 대용.
  const patched = patchTask(validating.aggregate, depId, { input: STRUCTURALLY_INVALID_INPUT });
  return completeValidation(deps, patched, depId);
}

function bringToValidating(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  dependentId: TaskId,
): WorkAggregate {
  return mustCommit(
    executeCommand(deps, aggregate, {
      kind: "begin_validation",
      taskId: dependentId,
      expectedRevision: requireTaskFor(aggregate, dependentId).revision,
      meta: meta(NOW),
    }),
  ).aggregate;
}

function bringToWaitingInput(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  dependentId: TaskId,
): WorkAggregate {
  const validating = bringToValidating(deps, aggregate, dependentId);
  // 레코드 패치: 필수 입력이 빠진 유형으로 바꿔 WAITING_INPUT 출구를 재현한다.
  const patched = patchTask(validating, dependentId, { type: MISSING_INPUT_TYPE });
  return mustCommit(completeValidation(deps, patched, dependentId)).aggregate;
}

function bringToReady(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  dependentId: TaskId,
): WorkAggregate {
  const validating = bringToValidating(deps, aggregate, dependentId);
  return mustCommit(completeValidation(deps, validating, dependentId)).aggregate;
}

function bringToScheduled(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  dependentId: TaskId,
): WorkAggregate {
  const ready = bringToReady(deps, aggregate, dependentId);
  const task = requireTaskFor(ready, dependentId);
  const occ = mustOk(
    deriveOccurrenceId({
      kind: "schedule",
      ownerId: dependentId,
      triggerId: task.trigger.triggerId,
      scheduledForUtc: NOW,
      recurrenceIndex: 0,
    }),
  );
  return mustCommit(
    executeCommand(deps, ready, {
      kind: "schedule_task",
      taskId: dependentId,
      expectedRevision: task.revision,
      meta: meta(NOW),
      occurrenceId: occ,
      cause: "schedule",
    }),
  ).aggregate;
}

function bringToBlocked(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  dependentId: TaskId,
): WorkAggregate {
  const validating = bringToValidating(deps, aggregate, dependentId);
  // 레코드 패치: 등록부 drift(유형 미등록) 대용.
  const patched = patchTask(validating, dependentId, { type: UNREGISTERED_TASK_TYPE });
  return mustCommit(completeValidation(deps, patched, dependentId)).aggregate;
}

put("task_blocked", "READY", "BLOCKED", {
  reachBefore: () => dependencyCascadeReachBefore("depblock", "block", bringToReady),
  apply: failDependency,
});

put("task_failed", "VALIDATING", "FAILED", {
  reachBefore: () => dependencyCascadeReachBefore("depfailvalidating", "fail", bringToValidating),
  apply: failDependency,
});

put("task_failed", "WAITING_INPUT", "FAILED", {
  reachBefore: () =>
    dependencyCascadeReachBefore("depfailwaitinginput", "fail", bringToWaitingInput),
  apply: failDependency,
});

put("task_failed", "READY", "FAILED", {
  reachBefore: () => dependencyCascadeReachBefore("depfailready", "fail", bringToReady),
  apply: failDependency,
});

put("task_failed", "SCHEDULED", "FAILED", {
  reachBefore: () => dependencyCascadeReachBefore("depfailscheduled", "fail", bringToScheduled),
  apply: failDependency,
});

put("task_failed", "BLOCKED", "FAILED", {
  reachBefore: () => dependencyCascadeReachBefore("depfailblocked", "fail", bringToBlocked),
  apply: failDependency,
});

put("task_completed", "RUNNING", "COMPLETED", {
  reachBefore: () => reachTaskState("RUNNING"),
  apply: (deps, before, taskId) => {
    const attemptId = requireTaskFor(before, taskId).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("row-cases: RUNNING task missing openAttempt");
    return executeCommand(deps, before, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
      attemptId,
      outcome: { kind: "completed", evidence: {} },
    });
  },
});

put("task_expired", "RUNNING", "EXPIRED", {
  reachBefore: () => reachTaskState("RUNNING", { policy: { expiresAt: PAST } }),
  apply: (deps, before, taskId) => {
    const attemptId = requireTaskFor(before, taskId).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("row-cases: RUNNING task missing openAttempt");
    return executeCommand(deps, before, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(LATER),
      attemptId,
      outcome: { kind: "attempt_timeout" },
    });
  },
});

put("task_awaiting_human", "RUNNING", "BLOCKED_AWAITING_HUMAN", {
  reachBefore: () => reachTaskState("RUNNING"),
  apply: (deps, before, taskId) => {
    const attemptId = requireTaskFor(before, taskId).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("row-cases: RUNNING task missing openAttempt");
    return executeCommand(deps, before, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
      attemptId,
      outcome: {
        kind: "blocked",
        cause: "gate_denied",
        decision: taskSubjectPendingDecision(deps, taskId, NOW),
      },
    });
  },
});

put("task_retry_wait", "RUNNING", "RETRY_WAIT", {
  reachBefore: () => reachTaskState("RUNNING"),
  apply: (deps, before, taskId) => {
    const attemptId = requireTaskFor(before, taskId).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("row-cases: RUNNING task missing openAttempt");
    return executeCommand(deps, before, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
      attemptId,
      outcome: { kind: "failed", code: RETRYABLE_FIXTURE_CODE },
    });
  },
});

put("task_failed", "RUNNING", "FAILED", {
  reachBefore: () =>
    reachTaskState("RUNNING", {
      policy: {
        retry: { maxAttempts: 1, initialDelayMs: 1_000, maxDelayMs: 1_000, backoff: "fixed" },
      },
    }),
  apply: (deps, before, taskId) => {
    const attemptId = requireTaskFor(before, taskId).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("row-cases: RUNNING task missing openAttempt");
    return executeCommand(deps, before, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
      attemptId,
      outcome: { kind: "failed", code: "fixture_nonretryable" },
    });
  },
});

put("task_retry_ready", "RETRY_WAIT", "READY", {
  reachBefore: () => reachTaskState("RETRY_WAIT"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "retry_ready",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
    }),
});

put("task_failed", "RETRY_WAIT", "FAILED", {
  reachBefore: () => reachTaskState("RETRY_WAIT"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "abandon_retries",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
      cause: "retry_budget_exhausted",
    }),
});

for (const state of [
  "READY",
  "SCHEDULED",
  "WAITING_INPUT",
  "BLOCKED",
  "BLOCKED_AWAITING_HUMAN",
] as const) {
  put("task_expired", state, "EXPIRED", {
    reachBefore: () => reachTaskState(state, { policy: { expiresAt: PAST } }),
    apply: (deps, before, taskId) =>
      executeCommand(deps, before, {
        kind: "expire",
        taskId,
        expectedRevision: requireTaskFor(before, taskId).revision,
        meta: meta(LATER),
      }),
  });
}
// RETRY_WAIT 는 `PAST` expiresAt 을 쓰면 RUNNING 에서 record_attempt_outcome 을 기록하는 시점(NOW)에
// 이미 유효기한이 지나 있어 routeAttemptOutcome 순위 3(유효기한 경과)이 순위 7(재시도)보다 먼저 걸려
// RETRY_WAIT 에 도달하지 못한다(test-report.md 실패 #2/#3). reach 시점(NOW) 이후·expire 평가 시점
// (LATER) 이전인 `BETWEEN` 을 써서 "RETRY_WAIT 도달 시점엔 유효, expire 평가 시점엔 경과"를 분리한다.
put("task_expired", "RETRY_WAIT", "EXPIRED", {
  reachBefore: () => reachTaskState("RETRY_WAIT", { policy: { expiresAt: BETWEEN } }),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "expire",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(LATER),
    }),
});
put("confirmation_expired", "WAITING_CONFIRMATION", "EXPIRED", {
  reachBefore: () => reachTaskState("WAITING_CONFIRMATION", { policy: { expiresAt: PAST } }),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "expire",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(LATER),
    }),
});

put("reminder_occurrence_emitted", "WAITING_CONFIRMATION", "WAITING_CONFIRMATION", {
  reachBefore: () => reachTaskState("WAITING_CONFIRMATION"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "emit_reminder",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
      occurrenceId: mustOk(
        deriveOccurrenceId({
          kind: "schedule",
          ownerId: taskId,
          triggerId: "reminder",
          scheduledForUtc: NOW,
          recurrenceIndex: 0,
        }),
      ),
    }),
});

put("task_unblocked", "BLOCKED", "VALIDATING", {
  reachBefore: () => reachTaskState("BLOCKED"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "unblock",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
    }),
});

put("confirmation_cancelled", "WAITING_CONFIRMATION", "CANCELED", {
  reachBefore: () => reachTaskState("WAITING_CONFIRMATION"),
  apply: (deps, before, taskId) =>
    executeCommand(deps, before, {
      kind: "cancel_task",
      taskId,
      expectedRevision: requireTaskFor(before, taskId).revision,
      meta: meta(NOW),
      origin: controlRequestCancelOrigin(deps),
    }),
});

for (const state of [
  "DRAFT",
  "VALIDATING",
  "WAITING_INPUT",
  "READY",
  "SCHEDULED",
  "RUNNING",
  "RETRY_WAIT",
  "BLOCKED",
  "BLOCKED_AWAITING_HUMAN",
] as const) {
  put("task_canceled", state, "CANCELED", {
    reachBefore: () => reachTaskState(state),
    apply: (deps, before, taskId) =>
      executeCommand(deps, before, {
        kind: "cancel_task",
        taskId,
        expectedRevision: requireTaskFor(before, taskId).revision,
        meta: meta(NOW),
        origin: controlRequestCancelOrigin(deps),
      }),
  });
}

for (const state of [
  "DRAFT",
  "VALIDATING",
  "WAITING_INPUT",
  "READY",
  "SCHEDULED",
  "RUNNING",
  "RETRY_WAIT",
  "WAITING_CONFIRMATION",
  "BLOCKED",
  "BLOCKED_AWAITING_HUMAN",
] as const) {
  put("task_skipped", state, "SKIPPED", {
    reachBefore: () => reachTaskState(state),
    apply: (deps, before, taskId) =>
      executeCommand(deps, before, {
        kind: "skip_task",
        taskId,
        expectedRevision: requireTaskFor(before, taskId).revision,
        meta: meta(NOW),
        reason: { kind: "misfire_skip" },
      }),
  });
}

// 신호 경로(Task 주체) — judgeSignal 로 유발.
put("confirmation_accepted", "WAITING_CONFIRMATION", "COMPLETED", {
  reachBefore: () => reachTaskState("WAITING_CONFIRMATION"),
  apply: (deps, before, taskId) => {
    const task = requireTaskFor(before, taskId);
    const confirmationId = task.confirmationId;
    if (confirmationId === undefined)
      throw new Error("row-cases: WAITING_CONFIRMATION task missing confirmationId");
    const signal: DecisionSignal = {
      type: "confirmation_decision",
      taskId,
      confirmationId,
      decision: "accept",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    };
    return judgeSignal(deps, before, signal, { kind: "none" }, NOW);
  },
});

put("confirmation_rejected", "WAITING_CONFIRMATION", "REJECTED", {
  reachBefore: () => reachTaskState("WAITING_CONFIRMATION"),
  apply: (deps, before, taskId) => {
    const task = requireTaskFor(before, taskId);
    const confirmationId = task.confirmationId;
    if (confirmationId === undefined)
      throw new Error("row-cases: WAITING_CONFIRMATION task missing confirmationId");
    const signal: DecisionSignal = {
      type: "confirmation_decision",
      taskId,
      confirmationId,
      decision: "reject",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    };
    return judgeSignal(deps, before, signal, { kind: "none" }, NOW);
  },
});

put("human_decision_granted", "BLOCKED_AWAITING_HUMAN", "READY", {
  reachBefore: () => reachTaskState("BLOCKED_AWAITING_HUMAN"),
  apply: (deps, before, taskId) => {
    const task = requireTaskFor(before, taskId);
    const decisionId = task.pendingDecision?.id;
    if (decisionId === undefined)
      throw new Error("row-cases: BLOCKED_AWAITING_HUMAN task missing pendingDecision");
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    };
    const application: DecisionApplication = { kind: "task_grant", resume: { to: "READY" } };
    return judgeSignal(deps, before, signal, application, NOW);
  },
});

put("human_decision_granted", "BLOCKED_AWAITING_HUMAN", "SCHEDULED", {
  reachBefore: () => reachTaskState("BLOCKED_AWAITING_HUMAN"),
  apply: (deps, before, taskId) => {
    const task = requireTaskFor(before, taskId);
    const decisionId = task.pendingDecision?.id;
    if (decisionId === undefined)
      throw new Error("row-cases: BLOCKED_AWAITING_HUMAN task missing pendingDecision");
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    };
    const application: DecisionApplication = {
      kind: "task_grant",
      resume: { to: "SCHEDULED", occurrence: { kind: "dead_letter_retry" } },
    };
    return judgeSignal(deps, before, signal, application, NOW);
  },
});

put("human_decision_denied", "BLOCKED_AWAITING_HUMAN", "REJECTED", {
  reachBefore: () => reachTaskState("BLOCKED_AWAITING_HUMAN"),
  apply: (deps, before, taskId) => {
    const task = requireTaskFor(before, taskId);
    const decisionId = task.pendingDecision?.id;
    if (decisionId === undefined)
      throw new Error("row-cases: BLOCKED_AWAITING_HUMAN task missing pendingDecision");
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "deny",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    };
    const application: DecisionApplication = { kind: "task_deny", resolution: "declined" };
    return judgeSignal(deps, before, signal, application, NOW);
  },
});

put("task_failed", "BLOCKED_AWAITING_HUMAN", "FAILED", {
  reachBefore: () => {
    const { deps, aggregate, taskId } = reachDeadLetterParked();
    return { deps, aggregate, taskId };
  },
  apply: (deps, before, taskId) => {
    const task = requireTaskFor(before, taskId);
    const decisionId = task.pendingDecision?.id;
    if (decisionId === undefined)
      throw new Error("row-cases: BLOCKED_AWAITING_HUMAN task missing pendingDecision");
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "deny",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    };
    const application: DecisionApplication = {
      kind: "task_deny",
      resolution: "discarded_only_effect",
    };
    return judgeSignal(deps, before, signal, application, NOW);
  },
});

export function buildTaskRowCases(): Record<string, RowCase> {
  const out: Record<string, RowCase> = {};
  for (const row of TASK_TRANSITION_ROWS as readonly TransitionRowData<string>[]) {
    const fromStates: readonly string[] = row.from.length > 0 ? row.from : ["NONE"];
    for (const fromState of fromStates) {
      const key = `${row.id}@${fromState}`;
      if (fromState === "NONE") {
        out[key] = {
          row,
          fromState,
          build: () => {
            const reached = reachWorkState("PLANNING");
            return { deps: reached.deps, before: reached.aggregate };
          },
          apply: (deps, before) => {
            const proposalId = nextEntityId(deps.ids, "planProposal");
            return executeCommand(deps, before, {
              kind: "commit_plan",
              expectedRevision: before.work.revision,
              meta: meta(NOW),
              proposal: {
                proposalId,
                digest: "0".repeat(64),
                basePlanRevision: before.work.planRevision,
                drafts: [draft("gen")],
                retain: [],
              },
            });
          },
        };
        continue;
      }
      const recipe = taskRecipes.get(`${row.event}@${fromState}@${row.to}`);
      // build()·apply() 가 같은 targetTaskId 를 공유하도록 클로저 변수에 보존한다(다중-Task 애그리거트에서도
      // apply 가 임의로 첫 Task 를 고르지 않게 함 — 연쇄 레시피는 조작 대상이 대상 Task 와 다를 수 있다).
      let lastTaskId: TaskId | undefined;
      out[key] = {
        row,
        fromState,
        build: () => {
          const reached =
            recipe === undefined
              ? reachTaskState(fromState as TaskStateName)
              : recipe.reachBefore();
          lastTaskId = reached.taskId;
          return { deps: reached.deps, before: reached.aggregate, targetTaskId: reached.taskId };
        },
        apply: (deps, before) => {
          if (recipe === undefined) return missingRecipe(row, fromState);
          const taskId = lastTaskId ?? Object.values(before.tasks)[0]?.id;
          if (taskId === undefined) throw new Error(`row-cases: no task in aggregate for ${key}`);
          return recipe.apply(deps, before, taskId);
        },
      };
    }
  }
  return out;
}

// ---- Work 레시피 ------------------------------------------------------------

interface WorkRecipe {
  reachBefore(): { deps: DomainDeps; aggregate: WorkAggregate };
  apply(deps: DomainDeps, before: WorkAggregate): CommandOutcome | SignalJudgement;
}

const workRecipes = new Map<string, WorkRecipe>();
function putWork(event: string, fromState: string, to: string, recipe: WorkRecipe): void {
  workRecipes.set(`${event}@${fromState}@${to}`, recipe);
}

putWork("work_planning_started", "DRAFT", "PLANNING", {
  reachBefore: () => reachWorkState("DRAFT"),
  apply: (deps, before) =>
    executeCommand(deps, before, {
      kind: "start_planning",
      expectedRevision: before.work.revision,
      meta: meta(NOW),
    }),
});

putWork("work_input_requested", "PLANNING", "WAITING_INPUT", {
  reachBefore: () => reachWorkState("PLANNING"),
  apply: (deps, before) =>
    executeCommand(deps, before, {
      kind: "request_work_input",
      expectedRevision: before.work.revision,
      meta: meta(NOW),
      requests: [],
    }),
});

putWork("work_input_received", "WAITING_INPUT", "PLANNING", {
  reachBefore: () => reachWorkState("WAITING_INPUT"),
  apply: (deps, before) =>
    executeCommand(deps, before, {
      kind: "receive_work_input",
      expectedRevision: before.work.revision,
      meta: meta(NOW),
    }),
});

putWork("work_plan_proposed", "PLANNING", "WAITING_APPROVAL", {
  reachBefore: () => reachWorkState("PLANNING"),
  apply: (deps, before) => {
    const proposalId = nextEntityId(deps.ids, "planProposal");
    const decision = mustOk(
      parsePendingDecision({
        id: nextEntityId(deps.ids, "decision"),
        kind: "plan_approval_required",
        workId: before.work.id,
        planProposalId: proposalId,
        requestedAt: NOW,
        summary: "row-case plan approval",
        surfaceDeliveries: [],
      }),
    );
    return executeCommand(deps, before, {
      kind: "propose_plan",
      expectedRevision: before.work.revision,
      meta: meta(NOW),
      proposalId,
      digest: "1".repeat(64),
      decision,
    });
  },
});

putWork("work_plan_committed", "PLANNING", "READY", {
  reachBefore: () => reachWorkState("PLANNING"),
  apply: (deps, before) => {
    const proposalId = nextEntityId(deps.ids, "planProposal");
    return executeCommand(deps, before, {
      kind: "commit_plan",
      expectedRevision: before.work.revision,
      meta: meta(NOW),
      proposal: {
        proposalId,
        digest: "2".repeat(64),
        basePlanRevision: before.work.planRevision,
        drafts: [draft("member")],
        retain: [],
      },
    });
  },
});

putWork("work_failed", "PLANNING", "FAILED", {
  reachBefore: () => reachWorkState("PLANNING"),
  apply: (deps, before) =>
    executeCommand(deps, before, {
      kind: "fail_planning",
      expectedRevision: before.work.revision,
      meta: meta(NOW),
    }),
});

putWork("work_plan_withdrawn", "WAITING_APPROVAL", "PLANNING", {
  reachBefore: () => reachWorkState("WAITING_APPROVAL"),
  apply: (deps, before) =>
    executeCommand(deps, before, {
      kind: "withdraw_plan_proposal",
      expectedRevision: before.work.revision,
      meta: meta(NOW),
      cause: "source_changed",
    }),
});

putWork("work_plan_committed", "WAITING_APPROVAL", "READY", {
  reachBefore: () => reachWorkState("WAITING_APPROVAL"),
  apply: (deps, before) => {
    const decisionId = before.work.pendingDecision?.id;
    if (decisionId === undefined)
      throw new Error("row-cases: WAITING_APPROVAL work missing pendingDecision");
    const proposal: PlanCommitInput = {
      proposalId: before.work.pendingProposalId ?? nextEntityId(deps.ids, "planProposal"),
      digest: before.work.pendingProposalDigest ?? "3".repeat(64),
      basePlanRevision: before.work.planRevision,
      drafts: [draft("member")],
      retain: [],
    };
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: before.work.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    };
    return judgeSignal(deps, before, signal, { kind: "plan_grant", proposal }, NOW);
  },
});

putWork("work_plan_rejected", "WAITING_APPROVAL", "PLANNING", {
  reachBefore: () => reachWorkState("WAITING_APPROVAL"),
  apply: (deps, before) => {
    const decisionId = before.work.pendingDecision?.id;
    if (decisionId === undefined)
      throw new Error("row-cases: WAITING_APPROVAL work missing pendingDecision");
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "deny",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: before.work.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    };
    return judgeSignal(deps, before, signal, { kind: "plan_deny" }, NOW);
  },
});

putWork("work_plan_rejected", "WAITING_APPROVAL", "READY", {
  reachBefore: () => {
    // planRevision >= 1 이 되도록 먼저 첫 계획을 커밋(READY)한 뒤 재계획을 열어 WAITING_APPROVAL 로 되돌린다.
    const { deps, aggregate: activeAgg } = reachWorkState("ACTIVE");
    const replanned = mustCommit(
      judgeSignal(
        deps,
        activeAgg,
        {
          type: "replan_requested",
          workId: activeAgg.work.id,
          signalId: nextEntityId(deps.ids, "signal"),
          expectedRevision: activeAgg.work.revision,
          actorSource: "human_local",
          receivedAt: NOW,
        },
        { kind: "none" },
        NOW,
      ),
    ).aggregate;
    const proposalId = nextEntityId(deps.ids, "planProposal");
    const decision = mustOk(
      parsePendingDecision({
        id: nextEntityId(deps.ids, "decision"),
        kind: "plan_approval_required",
        workId: replanned.work.id,
        planProposalId: proposalId,
        requestedAt: NOW,
        summary: "row-case replan approval",
        surfaceDeliveries: [],
      }),
    );
    const proposed = mustCommit(
      executeCommand(deps, replanned, {
        kind: "propose_plan",
        expectedRevision: replanned.work.revision,
        meta: meta(NOW),
        proposalId,
        digest: "4".repeat(64),
        decision,
      }),
    ).aggregate;
    return { deps, aggregate: proposed };
  },
  apply: (deps, before) => {
    const decisionId = before.work.pendingDecision?.id;
    if (decisionId === undefined)
      throw new Error("row-cases: replan WAITING_APPROVAL work missing pendingDecision");
    const signal: DecisionSignal = {
      type: "human_decision",
      decisionId,
      choice: "deny",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: before.work.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    };
    return judgeSignal(deps, before, signal, { kind: "plan_deny" }, NOW);
  },
});

putWork("work_failed", "ACTIVE", "FAILED", {
  reachBefore: () => reachWorkState("ACTIVE"),
  apply: (deps, before) =>
    executeCommand(deps, before, {
      kind: "fail_work",
      expectedRevision: before.work.revision,
      meta: meta(NOW),
    }),
});

// 파생(§3 단계 5) — member Task 명령이 유발한다(엔진이 같은 커밋에 파생 이벤트를 붙임).
putWork("work_activated", "READY", "ACTIVE", {
  reachBefore: () => {
    const { deps, aggregate } = planned([draft("member")], testDeps("workderived1"));
    const memberId = Object.values(aggregate.tasks)[0]?.id;
    if (memberId === undefined) throw new Error("row-cases: expected member task");
    const validating = mustCommit(
      executeCommand(deps, aggregate, {
        kind: "begin_validation",
        taskId: memberId,
        expectedRevision: requireTaskFor(aggregate, memberId).revision,
        meta: meta(NOW),
      }),
    ).aggregate;
    return { deps, aggregate: validating };
  },
  apply: (deps, before) => {
    const memberId = Object.values(before.tasks)[0]?.id;
    if (memberId === undefined) throw new Error("row-cases: expected member task");
    return completeValidation(deps, before, memberId);
  },
});

putWork("work_completed", "READY", "COMPLETED", {
  reachBefore: () => planned([draft("member")], testDeps("workderived2")),
  apply: (deps, before) => {
    const memberId = Object.values(before.tasks)[0]?.id;
    if (memberId === undefined) throw new Error("row-cases: expected member task");
    return executeCommand(deps, before, {
      kind: "skip_task",
      taskId: memberId,
      expectedRevision: requireTaskFor(before, memberId).revision,
      meta: meta(NOW),
      reason: { kind: "misfire_skip" },
    });
  },
});

putWork("work_blocked", "READY", "BLOCKED", {
  reachBefore: () => {
    const { deps, aggregate } = planned([draft("member")], testDeps("workderived3"));
    const memberId = Object.values(aggregate.tasks)[0]?.id;
    if (memberId === undefined) throw new Error("row-cases: expected member task");
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, aggregate, {
          kind: "begin_validation",
          taskId: memberId,
          expectedRevision: requireTaskFor(aggregate, memberId).revision,
          meta: meta(NOW),
        }),
      ).aggregate,
    };
  },
  apply: (deps, before) => {
    const memberId = Object.values(before.tasks)[0]?.id;
    if (memberId === undefined) throw new Error("row-cases: expected member task");
    // 레코드 패치: 구조 무효 입력으로 member 를 종결시키는 다른 생성 경로 대용.
    const patched = patchTask(before, memberId, { input: STRUCTURALLY_INVALID_INPUT });
    return completeValidation(deps, patched, memberId);
  },
});

putWork("work_blocked", "ACTIVE", "BLOCKED", {
  reachBefore: () => reachWorkState("ACTIVE"),
  apply: (deps, before) => {
    const memberId = Object.values(before.tasks)[0]?.id;
    if (memberId === undefined) throw new Error("row-cases: expected member task");
    return executeCommand(deps, before, {
      kind: "cancel_task",
      taskId: memberId,
      expectedRevision: requireTaskFor(before, memberId).revision,
      meta: meta(NOW),
      origin: controlRequestCancelOrigin(deps),
    });
  },
});

putWork("work_completed", "ACTIVE", "COMPLETED", {
  reachBefore: () => {
    const { deps, aggregate } = reachWorkState("ACTIVE");
    const memberId = Object.values(aggregate.tasks)[0]?.id;
    if (memberId === undefined) throw new Error("row-cases: expected member task");
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, aggregate, {
          kind: "start_attempt",
          taskId: memberId,
          expectedRevision: requireTaskFor(aggregate, memberId).revision,
          meta: meta(NOW),
        }),
      ).aggregate,
    };
  },
  apply: (deps, before) => {
    const memberId = Object.values(before.tasks)[0]?.id;
    if (memberId === undefined) throw new Error("row-cases: expected member task");
    const attemptId = requireTaskFor(before, memberId).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("row-cases: expected open attempt");
    return executeCommand(deps, before, {
      kind: "record_attempt_outcome",
      taskId: memberId,
      expectedRevision: requireTaskFor(before, memberId).revision,
      meta: meta(NOW),
      attemptId,
      outcome: { kind: "completed", evidence: {} },
    });
  },
});

// BLOCKED→COMPLETED — 차단 필수 member 가 vault_signal(human_local) 취소로 철회되어 완료 정책이
// 충족된다(design.md §6, SC-023(d)). 재계획 불요 — 첫 계획 커밋만으로 재현(팀리드 지시 반영).
putWork("work_completed", "BLOCKED", "COMPLETED", {
  reachBefore: () => {
    const deps = testDeps("workcompletedblocked");
    const { aggregate: planAgg, taskIds } = planned([draft("t1"), draft("t2")], deps);
    const t1 = taskIds["t1"];
    const t2 = taskIds["t2"];
    if (t1 === undefined || t2 === undefined)
      throw new Error("row-cases: expected t1·t2 member tasks");
    // t1 → COMPLETED (진행 가능하지 않은 충족 종결 member)
    const t1Validating = mustCommit(
      executeCommand(deps, planAgg, {
        kind: "begin_validation",
        taskId: t1,
        expectedRevision: requireTaskFor(planAgg, t1).revision,
        meta: meta(NOW),
      }),
    ).aggregate;
    const t1Ready = mustCommit(
      executeCommand(deps, t1Validating, {
        kind: "complete_validation",
        taskId: t1,
        expectedRevision: requireTaskFor(t1Validating, t1).revision,
        meta: meta(NOW),
      }),
    ).aggregate;
    const t1Running = mustCommit(
      executeCommand(deps, t1Ready, {
        kind: "start_attempt",
        taskId: t1,
        expectedRevision: requireTaskFor(t1Ready, t1).revision,
        meta: meta(NOW),
      }),
    ).aggregate;
    const t1Attempt = requireTaskFor(t1Running, t1).openAttempt?.attemptId;
    if (t1Attempt === undefined) throw new Error("row-cases: expected t1 open attempt");
    const t1Completed = mustCommit(
      executeCommand(deps, t1Running, {
        kind: "record_attempt_outcome",
        taskId: t1,
        expectedRevision: requireTaskFor(t1Running, t1).revision,
        meta: meta(NOW),
        attemptId: t1Attempt,
        outcome: { kind: "completed", evidence: {} },
      }),
    ).aggregate;
    // t2 → BLOCKED_AWAITING_HUMAN (진행 불가·불충족 필수 member) — 이 커밋에서 Work 는 BLOCKED 로 파생된다.
    const t2Validating = mustCommit(
      executeCommand(deps, t1Completed, {
        kind: "begin_validation",
        taskId: t2,
        expectedRevision: requireTaskFor(t1Completed, t2).revision,
        meta: meta(NOW),
      }),
    ).aggregate;
    const t2Ready = mustCommit(
      executeCommand(deps, t2Validating, {
        kind: "complete_validation",
        taskId: t2,
        expectedRevision: requireTaskFor(t2Validating, t2).revision,
        meta: meta(NOW),
      }),
    ).aggregate;
    const t2BlockedAwaitingHuman = mustCommit(
      executeCommand(deps, t2Ready, {
        kind: "park_awaiting_human",
        taskId: t2,
        expectedRevision: requireTaskFor(t2Ready, t2).revision,
        meta: meta(NOW),
        cause: "unattended_eligibility_refused",
        decision: taskSubjectPendingDecision(deps, t2, NOW),
      }),
    ).aggregate;
    if (t2BlockedAwaitingHuman.work.state !== "BLOCKED") {
      throw new Error(
        `row-cases: expected Work BLOCKED before withdrawal, got "${t2BlockedAwaitingHuman.work.state}"`,
      );
    }
    return { deps, aggregate: t2BlockedAwaitingHuman };
  },
  apply: (deps, before) => {
    const t2 = findByDraftRef(before, "t2");
    const origin = mustOk(
      parseCancelOrigin({
        kind: "vault_signal",
        actorSource: "human_local",
        signalId: nextEntityId(deps.ids, "signal"),
      }),
    );
    return executeCommand(deps, before, {
      kind: "cancel_task",
      taskId: t2,
      expectedRevision: requireTaskFor(before, t2).revision,
      meta: meta(NOW),
      origin,
    });
  },
});

// `reachWorkState("BLOCKED")` 는 member 가 FAILED(구조 무효)로 종결되어 파생되므로(fixtures.ts 계약),
// `unblock`(Task-state 문자 그대로 BLOCKED 에서만 유효 — 비종결 복구 가능 차단) 은 적용할 수 없다
// (test-report.md 실패 #10). 단일 member 로 Task-state BLOCKED 를 직접 구성해도 `unblock` 적용 후
// member 가 VALIDATING 으로만 돌아가 `deriveWorkState` 가 ACTIVE 가 아니라 READY 로 평가돼(생성
// event 자체가 없음 — cascade.ts `decideDerivedWorkStateEvent` 는 derived===READY 분기를 다루지
// 않는다) work_unblocked 가 발생하지 않는다. `work_completed@BLOCKED` 레시피와 같은 t1·t2 이중
// member 구성으로, t1 을 먼저 COMPLETED(과-검증 상태) 로 만들어 두면 t2 가 unblock 으로 VALIDATING에
// 돌아가도 t1 이 "past-validating" 이라 파생이 ACTIVE 로 나온다(디버그 재현 확인 완료).
putWork("work_unblocked", "BLOCKED", "ACTIVE", {
  reachBefore: () => {
    const deps = testDeps("workunblocked");
    const { aggregate: planAgg, taskIds } = planned([draft("t1"), draft("t2")], deps);
    const t1 = taskIds["t1"];
    const t2 = taskIds["t2"];
    if (t1 === undefined || t2 === undefined)
      throw new Error("row-cases: expected t1·t2 member tasks");
    const t1Validating = mustCommit(
      executeCommand(deps, planAgg, {
        kind: "begin_validation",
        taskId: t1,
        expectedRevision: requireTaskFor(planAgg, t1).revision,
        meta: meta(NOW),
      }),
    ).aggregate;
    const t1Ready = mustCommit(
      executeCommand(deps, t1Validating, {
        kind: "complete_validation",
        taskId: t1,
        expectedRevision: requireTaskFor(t1Validating, t1).revision,
        meta: meta(NOW),
      }),
    ).aggregate;
    const t1Running = mustCommit(
      executeCommand(deps, t1Ready, {
        kind: "start_attempt",
        taskId: t1,
        expectedRevision: requireTaskFor(t1Ready, t1).revision,
        meta: meta(NOW),
      }),
    ).aggregate;
    const t1Attempt = requireTaskFor(t1Running, t1).openAttempt?.attemptId;
    if (t1Attempt === undefined) throw new Error("row-cases: expected t1 open attempt");
    const t1Completed = mustCommit(
      executeCommand(deps, t1Running, {
        kind: "record_attempt_outcome",
        taskId: t1,
        expectedRevision: requireTaskFor(t1Running, t1).revision,
        meta: meta(NOW),
        attemptId: t1Attempt,
        outcome: { kind: "completed", evidence: {} },
      }),
    ).aggregate;
    const t2Validating = mustCommit(
      executeCommand(deps, t1Completed, {
        kind: "begin_validation",
        taskId: t2,
        expectedRevision: requireTaskFor(t1Completed, t2).revision,
        meta: meta(NOW),
      }),
    ).aggregate;
    // 레코드 패치: 등록부 drift(유형 미등록) 대용 — unblock 으로 다시 검증 가능한 차단이다.
    const t2Patched = patchTask(t2Validating, t2, { type: UNREGISTERED_TASK_TYPE });
    const t2Blocked = mustCommit(completeValidation(deps, t2Patched, t2)).aggregate;
    if (t2Blocked.work.state !== "BLOCKED") {
      throw new Error(
        `row-cases: expected Work BLOCKED via t2 Task-state BLOCKED, got "${t2Blocked.work.state}"`,
      );
    }
    if (requireTaskFor(t2Blocked, t2).state !== "BLOCKED") {
      throw new Error("row-cases: expected t2 in Task-state BLOCKED");
    }
    return { deps, aggregate: t2Blocked };
  },
  apply: (deps, before) => {
    const t2 = findByDraftRef(before, "t2");
    return executeCommand(deps, before, {
      kind: "unblock",
      taskId: t2,
      expectedRevision: requireTaskFor(before, t2).revision,
      meta: meta(NOW),
    });
  },
});

putWork("work_replanning_started", "ACTIVE", "PLANNING", {
  reachBefore: () => reachWorkState("ACTIVE"),
  apply: (deps, before) =>
    judgeSignal(
      deps,
      before,
      {
        type: "replan_requested",
        workId: before.work.id,
        signalId: nextEntityId(deps.ids, "signal"),
        expectedRevision: before.work.revision,
        actorSource: "human_local",
        receivedAt: NOW,
      },
      { kind: "none" },
      NOW,
    ),
});

putWork("work_replanning_started", "BLOCKED", "PLANNING", {
  reachBefore: () => reachWorkState("BLOCKED"),
  apply: (deps, before) =>
    judgeSignal(
      deps,
      before,
      {
        type: "replan_requested",
        workId: before.work.id,
        signalId: nextEntityId(deps.ids, "signal"),
        expectedRevision: before.work.revision,
        actorSource: "human_local",
        receivedAt: NOW,
      },
      { kind: "none" },
      NOW,
    ),
});

for (const state of [
  "DRAFT",
  "PLANNING",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "READY",
  "ACTIVE",
  "BLOCKED",
] as const) {
  putWork("work_canceled", state, "CANCELED", {
    reachBefore: () => reachWorkState(state),
    apply: (deps, before) =>
      executeCommand(deps, before, {
        kind: "cancel_work",
        expectedRevision: before.work.revision,
        meta: meta(NOW),
        origin: controlRequestCancelOrigin(deps),
      }),
  });
}

export function buildWorkRowCases(): Record<string, RowCase> {
  const out: Record<string, RowCase> = {};
  for (const row of WORK_TRANSITION_ROWS as readonly TransitionRowData<string>[]) {
    const fromStates: readonly string[] = row.from.length > 0 ? row.from : ["NONE"];
    for (const fromState of fromStates) {
      const key = `${row.id}@${fromState}`;
      if (fromState === "NONE") {
        out[key] = {
          row,
          fromState,
          build: () => {
            const reached = reachWorkState("DRAFT");
            return { deps: reached.deps, before: reached.aggregate };
          },
          apply: (deps) => {
            const source = { kind: "cli" } as unknown as WorkSource;
            return createWork(deps, {
              kind: "create_work",
              meta: meta(NOW),
              projectId: mustOk(parseProjectId("prj_rowcase0000001")),
              title: "row-case work",
              objective: "row-case objective",
              source,
            });
          },
        };
        continue;
      }
      const recipe = workRecipes.get(`${row.event}@${fromState}@${row.to}`);
      out[key] = {
        row,
        fromState,
        build: () => {
          const reached =
            recipe === undefined
              ? reachWorkState(fromState as WorkStateName)
              : recipe.reachBefore();
          return { deps: reached.deps, before: reached.aggregate };
        },
        apply: (deps, before) =>
          recipe === undefined ? missingRecipe(row, fromState) : recipe.apply(deps, before),
      };
    }
  }
  return out;
}

export const TASK_ROW_CASES: Record<string, RowCase> = buildTaskRowCases();
export const WORK_ROW_CASES: Record<string, RowCase> = buildWorkRowCases();
