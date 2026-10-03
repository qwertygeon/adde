// SC-016, SC-033~SC-035, SC-037, SC-038 — 승인 채널 판정·거절 차단·실행 전 승인.
import { describe, expect, it } from "vitest";
import {
  judgeApprovalSurface,
  validateTask,
  executeCommand,
  judgeSignal,
  nextEntityId,
  deriveOccurrenceId,
  decideDependencyCascadeRound,
  parsePendingDecision,
  BUILTIN_REACTIONS,
} from "../../../src/workflow/domain/index.js";
import type {
  DomainDeps,
  WorkAggregate,
  TaskId,
  TaskPolicy,
  PlanTaskDraft,
  CommandOutcome,
  DecisionApplication,
  TaskTypeDescriptor,
  TaskStateName,
  PendingDecision,
  PendingDecisionKind,
  ActorSource,
  AttemptOutcome,
} from "../../../src/workflow/domain/index.js";
import {
  at,
  meta,
  basePolicy,
  draft,
  planned,
  patchTask,
  reachTaskState,
  requireTaskFor,
  mustCommit,
  controlRequestCancelOrigin,
  testDeps,
  mustOk,
  taskSubjectPendingDecision,
  deadLetterDecision,
  rowSubjectDeadLetterDecision,
  reachDeadLetterParked,
  entityId,
} from "./helpers/fixtures.js";
import {
  testRegistries,
  fixtureRegistries,
  probeQuestionOnlyTaskType,
  COMPLETION_NOTIFY_REACTION,
} from "./helpers/registry-fixtures.js";
import { eventTypes, payloadOf } from "./helpers/commits.js";

const NOW = at("2026-01-01T00:00:00Z");
const ACTOR = { kind: "user", id: "u1" };
const IMMEDIATE = { kind: "immediate", version: 1, triggerId: "t" } as const;

const OUT_OF_BAND_APPROVED = {
  approvalSurface: "out_of_band",
  approvalRequiredBeforeExecute: true,
} as const;
const OUT_OF_BAND_UNAPPROVED = {
  approvalSurface: "out_of_band",
  approvalRequiredBeforeExecute: false,
} as const;

const INPUTS: Readonly<Record<string, Record<string, unknown>>> = {
  confirmation: { prompt: "Ship?", targetActor: ACTOR, allowedDecisions: ["accept", "reject"] },
  agent_goal: {
    goal: "Summarize",
    projectId: "prj_demo",
    category: "analysis",
    completionEvidence: "summary",
    sessionSelection: "default",
  },
  notification: { target: "owner", message: "Done", importance: "normal" },
  probe_records_notify: {},
  probe_question_only: { subject: "x" },
};

function typed(id: string, policy: Partial<TaskPolicy>) {
  return {
    type: { id, version: 1 },
    input: INPUTS[id] ?? {},
    policy: basePolicy(policy),
  };
}

/** 단일 초안을 계획 커밋하고 검증을 완료한다(같은 등록부가 받아들이는 선언만). */
function plannedThenValidated(
  seed: string,
  overrides: Partial<PlanTaskDraft>,
): { deps: DomainDeps; taskId: TaskId; outcome: CommandOutcome } {
  const deps = testDeps(seed, fixtureRegistries());
  const { aggregate, taskIds } = planned(
    [draft("subject", { trigger: IMMEDIATE, ...overrides })],
    deps,
  );
  const taskId = taskIds["subject"];
  if (taskId === undefined) throw new Error("expected task");
  const validating = mustCommit(
    executeCommand(deps, aggregate, {
      kind: "begin_validation",
      taskId,
      expectedRevision: requireTaskFor(aggregate, taskId).revision,
      meta: meta(NOW),
    }),
  ).aggregate;
  const outcome = executeCommand(deps, validating, {
    kind: "complete_validation",
    taskId,
    expectedRevision: requireTaskFor(validating, taskId).revision,
    meta: meta(NOW),
  });
  return { deps, taskId, outcome };
}

/** 검증 중 Task 를 레코드 패치로 범위 밖 선언으로 바꾸고 검증을 완료한다. */
function patchedThenValidated(patch: Parameters<typeof patchTask>[2]) {
  const { deps, aggregate, taskId } = reachTaskState("VALIDATING");
  // 레코드 패치: 계획 커밋이 막는 범위 밖 채널 선언을 다른 생성 경로 대용으로 재현.
  const before = patchTask(aggregate, taskId, patch);
  const outcome = executeCommand(deps, before, {
    kind: "complete_validation",
    taskId,
    expectedRevision: requireTaskFor(before, taskId).revision,
    meta: meta(NOW),
  });
  return { deps, taskId, outcome };
}

function expectPreExecutionPark(outcome: CommandOutcome, taskId: TaskId) {
  expect(outcome.kind).toBe("committed");
  if (outcome.kind !== "committed") return;
  expect(eventTypes(outcome.commit)).toEqual(
    expect.arrayContaining(["task_validated", "task_awaiting_human"]),
  );
  const types = eventTypes(outcome.commit);
  expect(types.indexOf("task_validated")).toBeLessThan(types.indexOf("task_awaiting_human"));
  const parked = payloadOf(outcome.commit, "task_awaiting_human");
  expect(parked["cause"]).toBe("approval_required_before_execute");
  expect((parked["pendingDecision"] as { kind: string }).kind).toBe("pre_execution_approval");
  expect(requireTaskFor(outcome.aggregate, taskId).state).toBe("BLOCKED_AWAITING_HUMAN");
}

function notifyDescriptor() {
  const found = BUILTIN_REACTIONS.find((r) => r.kind === "notify");
  if (found === undefined) throw new Error("builtin notify missing");
  return found;
}

/** 미승인 READY Task — 레코드 패치로 실행 전 승인 요구만 켠다(향후 생성 경로 대용). */
function unapprovedReady(): { deps: DomainDeps; aggregate: WorkAggregate; taskId: TaskId } {
  const { deps, aggregate, taskId } = reachTaskState("READY");
  const patched = patchTask(aggregate, taskId, {
    policy: basePolicy({ approvalRequiredBeforeExecute: true }),
    preExecutionApproved: false,
  });
  return { deps, aggregate: patched, taskId };
}

function grant(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  taskId: TaskId,
  application: DecisionApplication,
) {
  const task = requireTaskFor(aggregate, taskId);
  const decisionId = task.pendingDecision?.id;
  if (decisionId === undefined) throw new Error("expected pending decision");
  return judgeSignal(
    deps,
    aggregate,
    {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    },
    application,
    NOW,
  );
}

describe("SC-016: 선언 (a) 를 가진 시험 유형은 식별자와 무관하게 확인 유형처럼 판정된다", () => {
  const declarationFor = (descriptor: TaskTypeDescriptor) =>
    validateTask(testRegistries({ taskTypes: [descriptor] }), {
      type: { id: descriptor.id, version: descriptor.version },
      input: { subject: "x" },
      trigger: IMMEDIATE,
      policy: basePolicy(OUT_OF_BAND_APPROVED),
      reactions: [COMPLETION_NOTIFY_REACTION],
    });

  it("Happy: (a) 를 선언한 자격증명 효과 유형은 effect_records_only 로 거절된다 (test_SC016_declaration_a_probe_refused_effect_records_only)", () => {
    expect(declarationFor(probeQuestionOnlyTaskType())).toEqual({
      exit: "blocked",
      blockReason: {
        kind: "approval_surface_refused",
        reason: "effect_records_only",
        declaredSurface: "out_of_band",
      },
      normalized: expect.anything(),
    });
  });

  it("Edge: 같은 유형에서 (a) 만 거짓이면 수용된다 (test_SC016_same_probe_without_a_accepted)", () => {
    expect(
      judgeApprovalSurface({
        taskType: probeQuestionOnlyTaskType({ approvalGatesQuestionOnly: false }),
        policy: OUT_OF_BAND_APPROVED,
        declaredReactions: [notifyDescriptor()],
      }),
    ).toEqual({ accepted: true });
    expect(
      declarationFor(probeQuestionOnlyTaskType({ approvalGatesQuestionOnly: false })).exit,
    ).toBe("valid");
  });

  it("Error: 식별자만 다른 두 (a) 유형의 판정이 같다 (test_SC016_identifier_irrelevant)", () => {
    const original = declarationFor(probeQuestionOnlyTaskType());
    const renamed = declarationFor(probeQuestionOnlyTaskType({ id: "probe_question_alias" }));
    expect(renamed.exit).toBe("blocked");
    if (original.exit === "blocked" && renamed.exit === "blocked")
      expect(renamed.blockReason).toEqual(original.blockReason);
  });
});

describe("SC-033: 범위 안 외부 승인 채널 셋은 통과하고 Task 가 실행 전 승인 결정에 걸린다", () => {
  it("Happy: 알림 Task 는 검증 커밋에서 실행 전 승인 결정에 주차된다 (test_SC033_notification_parks_on_pre_execution_approval)", () => {
    const { taskId, outcome } = plannedThenValidated(
      "sc033a",
      typed("notification", OUT_OF_BAND_APPROVED),
    );
    expectPreExecutionPark(outcome, taskId);
  });

  it("Edge: 에이전트 목표 Task 도 같다 (test_SC033_agent_goal_parks_on_pre_execution_approval)", () => {
    const { taskId, outcome } = plannedThenValidated(
      "sc033b",
      typed("agent_goal", OUT_OF_BAND_APPROVED),
    );
    expectPreExecutionPark(outcome, taskId);
  });

  it("Error: 기록 유형 + 자격증명 전이 반응도 주차되고 미승인 READY 의 시작은 주차로 개입된다 (test_SC033_records_only_with_notify_parks_and_ready_start_interposed)", () => {
    const { taskId, outcome } = plannedThenValidated("sc033c", {
      ...typed("probe_records_notify", OUT_OF_BAND_APPROVED),
      reactions: [COMPLETION_NOTIFY_REACTION],
    });
    expectPreExecutionPark(outcome, taskId);

    const ready = unapprovedReady();
    const started = executeCommand(ready.deps, ready.aggregate, {
      kind: "start_attempt",
      taskId: ready.taskId,
      expectedRevision: requireTaskFor(ready.aggregate, ready.taskId).revision,
      meta: meta(NOW),
    });
    expect(started.kind).toBe("committed");
    if (started.kind !== "committed") return;
    expect(eventTypes(started.commit)).toContain("task_awaiting_human");
    expect(eventTypes(started.commit)).not.toContain("task_started");
    expect(requireTaskFor(started.aggregate, ready.taskId).state).toBe("BLOCKED_AWAITING_HUMAN");
  });
});

describe("SC-034: 범위 밖 외부 승인 채널 둘은 거절되고 내려쓰기되지 않는다", () => {
  it("Happy: 확인 Task 의 외부 채널은 effect_records_only 거절과 차단이다 (test_SC034_confirmation_out_of_band_refused_effect_records_only)", () => {
    const { taskId, outcome } = patchedThenValidated(typed("confirmation", OUT_OF_BAND_APPROVED));
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(payloadOf(outcome.commit, "approval_surface_refused")).toEqual({
      declaredSurface: "out_of_band",
      reason: "effect_records_only",
    });
    expect(eventTypes(outcome.commit)).toContain("task_blocked");
    const after = requireTaskFor(outcome.aggregate, taskId);
    expect(after.state).toBe("BLOCKED");
    expect(after.policy.approvalSurface).toBe("out_of_band");
  });

  it("Edge: 실행 전 승인 없는 알림 Task 는 no_pre_execution_approval 거절이다 (test_SC034_notification_without_approval_refused)", () => {
    const { outcome } = patchedThenValidated(typed("notification", OUT_OF_BAND_UNAPPROVED));
    expect(outcome.kind).toBe("committed");
    if (outcome.kind === "committed")
      expect(payloadOf(outcome.commit, "approval_surface_refused")["reason"]).toBe(
        "no_pre_execution_approval",
      );
  });

  it("Error: 두 경우 모두 거절 이벤트가 정확히 하나이고 VALIDATING 에 머물지 않는다 (test_SC034_exactly_one_refusal_not_left_validating)", () => {
    for (const patch of [
      typed("confirmation", OUT_OF_BAND_APPROVED),
      typed("notification", OUT_OF_BAND_UNAPPROVED),
    ]) {
      const { taskId, outcome } = patchedThenValidated(patch);
      expect(outcome.kind).toBe("committed");
      if (outcome.kind !== "committed") continue;
      expect(
        eventTypes(outcome.commit).filter((t) => t === "approval_surface_refused"),
      ).toHaveLength(1);
      expect(requireTaskFor(outcome.aggregate, taskId).state).not.toBe("VALIDATING");
    }
  });
});

describe("SC-035: 승인 채널 거절 차단은 수리 해제되지 않는다", () => {
  function refusedBlocked() {
    const { deps, taskId, outcome } = patchedThenValidated(
      typed("confirmation", OUT_OF_BAND_APPROVED),
    );
    if (outcome.kind !== "committed") throw new Error("expected refusal commit");
    return { deps, aggregate: outcome.aggregate, taskId };
  }

  it("Happy: 거절 차단 Task 의 unblock 은 거절되고 BLOCKED 에 머문다 (test_SC035_unblock_refused_for_surface_block)", () => {
    const { deps, aggregate, taskId } = refusedBlocked();
    const outcome = executeCommand(deps, aggregate, {
      kind: "unblock",
      taskId,
      expectedRevision: requireTaskFor(aggregate, taskId).revision,
      meta: meta(NOW),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.rejection.reason).toBe("condition_not_met");
    expect(requireTaskFor(aggregate, taskId).state).toBe("BLOCKED");
  });

  it("Edge: 취소는 수용되어 CANCELED 다 (test_SC035_cancel_reaches_canceled)", () => {
    const { deps, aggregate, taskId } = refusedBlocked();
    const outcome = executeCommand(deps, aggregate, {
      kind: "cancel_task",
      taskId,
      expectedRevision: requireTaskFor(aggregate, taskId).revision,
      meta: meta(NOW),
      origin: controlRequestCancelOrigin(deps),
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind === "committed")
      expect(requireTaskFor(outcome.aggregate, taskId).state).toBe("CANCELED");
  });

  it("Error: 미등록 descriptor 차단의 unblock 은 수용된다 (test_SC035_descriptor_block_unblock_accepted)", () => {
    const { deps, aggregate, taskId } = reachTaskState("BLOCKED");
    expect(requireTaskFor(aggregate, taskId).blockReason?.kind).toBe("descriptor_unknown");
    const outcome = executeCommand(deps, aggregate, {
      kind: "unblock",
      taskId,
      expectedRevision: requireTaskFor(aggregate, taskId).revision,
      meta: meta(NOW),
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind === "committed")
      expect(requireTaskFor(outcome.aggregate, taskId).state).toBe("VALIDATING");
  });
});

describe("SC-037: 승인 채널 판정은 Task 의 descriptor·정책·선언 반응만 읽는다", () => {
  it("Happy: 같은 선언의 두 Task 는 Work·의존·부모가 달라도 같은 결과다 (test_SC037_same_declarations_different_contexts_same_result)", () => {
    const declared = typed("notification", OUT_OF_BAND_APPROVED);
    const lone = plannedThenValidated("sc037lone", declared);

    const deps = testDeps("sc037nested", fixtureRegistries());
    const { aggregate, taskIds } = planned(
      [
        draft("root"),
        draft("nested", {
          ...declared,
          trigger: IMMEDIATE,
          dependsOn: [{ draftRef: "root" }],
          parent: { draftRef: "root" },
        }),
      ],
      deps,
    );
    const nestedId = taskIds["nested"];
    if (nestedId === undefined) throw new Error("expected nested task");
    const validating = mustCommit(
      executeCommand(deps, aggregate, {
        kind: "begin_validation",
        taskId: nestedId,
        expectedRevision: requireTaskFor(aggregate, nestedId).revision,
        meta: meta(NOW),
      }),
    ).aggregate;
    const nested = executeCommand(deps, validating, {
      kind: "complete_validation",
      taskId: nestedId,
      expectedRevision: requireTaskFor(validating, nestedId).revision,
      meta: meta(NOW),
    });
    expect(lone.outcome.kind).toBe("committed");
    expect(nested.kind).toBe("committed");
    if (lone.outcome.kind === "committed" && nested.kind === "committed") {
      // Work 파생 이벤트는 Work 구성에 따라 다르므로 대상 Task 의 이벤트만 비교한다.
      const taskEvents = (commit: typeof nested.commit, id: TaskId) =>
        commit.events.filter((e) => e.taskId === id).map((e) => e.type);
      expect(taskEvents(nested.commit, nestedId)).toEqual(
        taskEvents(lone.outcome.commit, lone.taskId),
      );
      expect(taskEvents(nested.commit, nestedId)).toEqual([
        "task_validated",
        "task_awaiting_human",
      ]);
      expect(requireTaskFor(nested.aggregate, nestedId).state).toBe(
        requireTaskFor(lone.outcome.aggregate, lone.taskId).state,
      );
    }
  });

  it("Error: 판정이 읽는 키가 세 입력과 그 선언 필드뿐이다 (test_SC037_judgement_reads_only_three_inputs)", () => {
    const reads = new Set<string>();
    const watch = <T extends object>(label: string, target: T): T =>
      new Proxy(target, {
        get(obj, key, receiver) {
          if (typeof key === "string") reads.add(`${label}.${key}`);
          return Reflect.get(obj, key, receiver) as unknown;
        },
      });
    const taskType = watch("taskType", {
      ...probeQuestionOnlyTaskType({ approvalGatesQuestionOnly: false }),
    });
    const policy = watch("policy", { ...basePolicy(OUT_OF_BAND_UNAPPROVED) });
    const reaction = watch("reaction", { ...notifyDescriptor() });
    const input = watch("input", {
      taskType,
      policy,
      declaredReactions: [reaction],
      workId: "wrk_unrelated",
    });
    const verdict = judgeApprovalSurface(input);
    expect(verdict).toEqual({ accepted: false, reason: "no_pre_execution_approval" });
    const allowed = new Set([
      "input.taskType",
      "input.policy",
      "input.declaredReactions",
      "taskType.executionEffect",
      "taskType.approvalGatesQuestionOnly",
      "policy.approvalSurface",
      "policy.approvalRequiredBeforeExecute",
      "reaction.declaredAs",
      "reaction.usesAddeCredentials",
    ]);
    expect([...reads].filter((r) => !allowed.has(r))).toEqual([]);
    expect(reads.has("input.workId")).toBe(false);
  });
});

describe("SC-038: 대기 요청 유형은 요청 enqueue 전에 승인된다", () => {
  function approvedConfirmation() {
    const { deps, taskId, outcome } = plannedThenValidated(
      "sc038",
      typed("confirmation", { approvalRequiredBeforeExecute: true }),
    );
    if (outcome.kind !== "committed") throw new Error("expected validation commit");
    return { deps, taskId, outcome };
  }

  it("Happy: 확인 Task 는 검증 커밋에서 대기 요청 전에 주차되고 grant 로 READY·승인 표식이 된다 (test_SC038_confirmation_parks_before_enqueue_grant_returns_ready)", () => {
    const { deps, taskId, outcome } = approvedConfirmation();
    expectPreExecutionPark(outcome, taskId);
    if (outcome.kind !== "committed") return;
    expect(eventTypes(outcome.commit)).not.toContain("task_waiting_confirmation");
    const granted = grant(deps, outcome.aggregate, taskId, {
      kind: "task_grant",
      resume: { to: "READY" },
    });
    expect(granted.kind).toBe("accepted");
    if (granted.kind !== "accepted") return;
    const after = requireTaskFor(granted.aggregate, taskId);
    expect(after.state).toBe("READY");
    expect(after.preExecutionApproved).toBe(true);
  });

  it("Edge: 미승인 READY 의 대기 요청 명령은 주차로 개입된다 (test_SC038_ready_begin_wait_interposed)", () => {
    const { deps, aggregate, taskId } = unapprovedReady();
    const outcome = executeCommand(deps, aggregate, {
      kind: "begin_confirmation_wait",
      taskId,
      expectedRevision: requireTaskFor(aggregate, taskId).revision,
      meta: meta(NOW),
      confirmationId: nextEntityId(deps.ids, "confirmation"),
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(eventTypes(outcome.commit)).toContain("task_awaiting_human");
    expect(eventTypes(outcome.commit)).not.toContain("task_waiting_confirmation");
    expect(requireTaskFor(outcome.aggregate, taskId).state).toBe("BLOCKED_AWAITING_HUMAN");
  });

  it("Error: 승인 뒤에는 대기에 들어가고 READY 가 아닌 재개 지정 grant 는 invalid_input 이다 (test_SC038_after_approval_waits_and_wrong_resume_rejected)", () => {
    const { deps, taskId, outcome } = approvedConfirmation();
    if (outcome.kind !== "committed") return;
    const wrongResume = grant(deps, outcome.aggregate, taskId, {
      kind: "task_grant",
      resume: { to: "SCHEDULED", occurrence: { kind: "dead_letter_retry" } },
    });
    expect(wrongResume.kind).toBe("not_applicable");
    if (wrongResume.kind === "not_applicable")
      expect(wrongResume.rejection.reason).toBe("invalid_input");

    const granted = grant(deps, outcome.aggregate, taskId, {
      kind: "task_grant",
      resume: { to: "READY" },
    });
    if (granted.kind !== "accepted")
      throw new Error(`expected grant accepted, got ${granted.kind}`);
    const waiting = executeCommand(deps, granted.aggregate, {
      kind: "begin_confirmation_wait",
      taskId,
      expectedRevision: requireTaskFor(granted.aggregate, taskId).revision,
      meta: meta(NOW),
      confirmationId: nextEntityId(deps.ids, "confirmation"),
    });
    expect(waiting.kind).toBe("committed");
    if (waiting.kind === "committed") {
      expect(eventTypes(waiting.commit)).toContain("task_waiting_confirmation");
      expect(requireTaskFor(waiting.aggregate, taskId).state).toBe("WAITING_CONFIRMATION");
    }
  });
});

/** 미승인 Task — 레코드 패치로 실행 전 승인 요구만 켠다(SCHEDULED·RETRY_WAIT 는 설계상 도달 불가 방어 분기). */
function unapprovedIn(state: TaskStateName) {
  const { deps, aggregate, taskId } = reachTaskState(state);
  const patched = patchTask(aggregate, taskId, {
    policy: basePolicy({ approvalRequiredBeforeExecute: true }),
    preExecutionApproved: false,
  });
  return { deps, aggregate: patched, taskId };
}

const EXECUTION_SIDE_EVENTS = ["task_started", "task_scheduled", "task_waiting_confirmation"];

type GuardCommand =
  "start_attempt" | "schedule_task" | "begin_confirmation_wait" | "park_awaiting_human";

function runGuardCell(state: TaskStateName, command: GuardCommand): string {
  const { deps, aggregate, taskId } = unapprovedIn(state);
  const task = requireTaskFor(aggregate, taskId);
  const base = { taskId, expectedRevision: task.revision, meta: meta(NOW) };
  const occurrenceId = mustOk(
    deriveOccurrenceId({
      kind: "schedule",
      ownerId: taskId,
      triggerId: task.trigger.triggerId,
      scheduledForUtc: NOW,
      recurrenceIndex: 0,
    }),
  );
  const outcome =
    command === "start_attempt"
      ? executeCommand(deps, aggregate, {
          ...base,
          kind: "start_attempt",
          ...(task.scheduledOccurrenceId !== undefined
            ? { firedOccurrenceId: task.scheduledOccurrenceId }
            : {}),
        })
      : command === "schedule_task"
        ? executeCommand(deps, aggregate, {
            ...base,
            kind: "schedule_task",
            occurrenceId,
            cause: state === "RETRY_WAIT" ? "retry" : "schedule",
          })
        : command === "begin_confirmation_wait"
          ? executeCommand(deps, aggregate, {
              ...base,
              kind: "begin_confirmation_wait",
              confirmationId: nextEntityId(deps.ids, "confirmation"),
            })
          : executeCommand(deps, aggregate, {
              ...base,
              kind: "park_awaiting_human",
              cause: "unattended_eligibility_refused",
              decision: taskSubjectPendingDecision(deps, taskId, NOW),
            });
  if (outcome.kind === "rejected") return `rejected:${outcome.rejection.reason}`;
  const types = eventTypes(outcome.commit);
  const leaked = types.filter((t) => EXECUTION_SIDE_EVENTS.includes(t));
  if (leaked.length > 0) return `executed:${leaked.join(",")}`;
  const parked = types.includes("task_awaiting_human")
    ? (payloadOf(outcome.commit, "task_awaiting_human")["pendingDecision"] as { kind: string }).kind
    : "none";
  return `committed:${parked}:${requireTaskFor(outcome.aggregate, taskId).state}`;
}

describe("SC-033·SC-038: 미승인 Task 는 어느 진행 경로로도 실행 쪽으로 나가지 않는다", () => {
  it("Edge: 미승인 READY·SCHEDULED·RETRY_WAIT 의 진행 명령과 의존 연쇄는 주차 또는 condition_not_met 이다 (test_SC038_unapproved_progress_paths_never_execute)", () => {
    const park = "committed:pre_execution_approval:BLOCKED_AWAITING_HUMAN";
    const refused = "rejected:condition_not_met";
    const cells: readonly [TaskStateName, GuardCommand, string][] = [
      ["READY", "start_attempt", park],
      ["READY", "schedule_task", park],
      ["READY", "begin_confirmation_wait", park],
      ["READY", "park_awaiting_human", refused],
      ["SCHEDULED", "start_attempt", refused],
      ["SCHEDULED", "begin_confirmation_wait", refused],
      ["SCHEDULED", "park_awaiting_human", refused],
      ["RETRY_WAIT", "schedule_task", refused],
    ];
    const observed = cells.map(
      ([state, command]) => `${state}×${command} → ${runGuardCell(state, command)}`,
    );
    expect(observed).toEqual(
      cells.map(([state, command, want]) => `${state}×${command} → ${want}`),
    );

    // 의존 연쇄: 미승인 의존 발화 Task 는 의존이 충족돼도 활성화되지 않는다.
    const deps = testDeps("sc038cascade", fixtureRegistries());
    const { aggregate, taskIds } = planned(
      [
        draft("dep"),
        draft("gated", {
          dependsOn: [{ draftRef: "dep" }],
          trigger: { kind: "dependencies_complete", version: 1, triggerId: "gated" },
        }),
      ],
      deps,
    );
    const depId = taskIds["dep"];
    const gatedId = taskIds["gated"];
    if (depId === undefined || gatedId === undefined) throw new Error("expected tasks");
    let current = aggregate;
    const step = (
      taskId: TaskId,
      kind: "begin_validation" | "complete_validation" | "start_attempt",
    ) => {
      current = mustCommit(
        executeCommand(deps, current, {
          kind,
          taskId,
          expectedRevision: requireTaskFor(current, taskId).revision,
          meta: meta(NOW),
        }),
      ).aggregate;
    };
    step(gatedId, "begin_validation");
    step(gatedId, "complete_validation");
    // 레코드 패치: READY 진입 뒤 승인 요구가 생긴 Task(향후 생성 경로 대용).
    current = patchTask(current, gatedId, {
      policy: basePolicy({ approvalRequiredBeforeExecute: true }),
      preExecutionApproved: false,
    });
    step(depId, "begin_validation");
    step(depId, "complete_validation");
    step(depId, "start_attempt");
    const attemptId = requireTaskFor(current, depId).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    const completed = executeCommand(deps, current, {
      kind: "record_attempt_outcome",
      taskId: depId,
      expectedRevision: requireTaskFor(current, depId).revision,
      meta: meta(NOW),
      attemptId,
      outcome: { kind: "completed", evidence: {} },
    });
    if (completed.kind !== "committed") throw new Error("expected completion commit");
    expect(completed.commit.events.filter((e) => e.taskId === gatedId).map((e) => e.type)).toEqual(
      [],
    );
    const gated = requireTaskFor(completed.aggregate, gatedId);
    expect([gated.state, gated.dependencyActivated]).toEqual(["READY", false]);
    expect(
      decideDependencyCascadeRound(deps.registries, completed.aggregate).filter(
        (d) => d.event.taskId === gatedId,
      ),
    ).toEqual([]);
  });
});

function decide(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  taskId: TaskId,
  choice: "grant" | "deny",
  application: DecisionApplication,
  actorSource: ActorSource = "human_local",
) {
  const task = requireTaskFor(aggregate, taskId);
  const decisionId = task.pendingDecision?.id;
  if (decisionId === undefined) throw new Error("expected pending decision");
  return judgeSignal(
    deps,
    aggregate,
    {
      type: "human_decision",
      decisionId,
      choice,
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: task.revision,
      actorSource,
      receivedAt: NOW,
    },
    application,
    NOW,
  );
}

/** 승인 필요 확인 Task 가 검증 커밋에서 실행 전 승인 결정에 주차된 상태. */
function parkedOnPreExecutionApproval(seed: string) {
  const { deps, taskId, outcome } = plannedThenValidated(
    seed,
    typed("confirmation", { approvalRequiredBeforeExecute: true }),
  );
  if (outcome.kind !== "committed") throw new Error("expected validation commit");
  const decisionKind = requireTaskFor(outcome.aggregate, taskId).pendingDecision?.kind;
  if (decisionKind !== "pre_execution_approval")
    throw new Error(`expected pre_execution_approval park, got ${String(decisionKind)}`);
  return { deps, aggregate: outcome.aggregate, taskId };
}

describe("SC-038: 폐기 종결 거부는 dead-letter 결정에만 적용된다", () => {
  it("Error: 실행 전 승인·도구 권한 결정의 폐기 거부는 invalid_input 이고 dead-letter 결정의 폐기 거부와 declined 거부는 수용된다 (test_SC038_discarded_deny_only_for_dead_letter_decision)", () => {
    const discarded: DecisionApplication = {
      kind: "task_deny",
      resolution: "discarded_only_effect",
    };
    const preApproval = parkedOnPreExecutionApproval("f2a");
    const permission = reachTaskState("BLOCKED_AWAITING_HUMAN");
    expect(requireTaskFor(permission.aggregate, permission.taskId).pendingDecision?.kind).toBe(
      "tool_permission_denied_unattended",
    );
    for (const parked of [preApproval, permission]) {
      const refused = decide(parked.deps, parked.aggregate, parked.taskId, "deny", discarded);
      expect(refused.kind).toBe("not_applicable");
      if (refused.kind !== "not_applicable") continue;
      expect(refused.rejection.reason).toBe("invalid_input");
      expect("commit" in refused).toBe(false);
    }

    const deadLetter = reachDeadLetterParked();
    const discardedOk = decide(
      deadLetter.deps,
      deadLetter.aggregate,
      deadLetter.taskId,
      "deny",
      discarded,
    );
    expect(discardedOk.kind).toBe("accepted");
    if (discardedOk.kind === "accepted") {
      expect(eventTypes(discardedOk.commit)).toEqual([
        "signal_accepted",
        "task_failed",
        "human_decision_denied",
      ]);
      const failedReason = payloadOf(discardedOk.commit, "task_failed")["reason"] as {
        kind: string;
      };
      expect(failedReason.kind).toBe("decision_discarded");
      expect(payloadOf(discardedOk.commit, "human_decision_denied")["role"]).toBe("companion");
      expect(requireTaskFor(discardedOk.aggregate, deadLetter.taskId).state).toBe("FAILED");
    }

    const declined = decide(preApproval.deps, preApproval.aggregate, preApproval.taskId, "deny", {
      kind: "task_deny",
      resolution: "declined",
    });
    expect(declined.kind).toBe("accepted");
    if (declined.kind === "accepted")
      expect(requireTaskFor(declined.aggregate, preApproval.taskId).state).toBe("REJECTED");
  });
});

describe("SC-038: 시도 결과 주차는 원인에 맞는 자기 Task 주체 결정만 받는다", () => {
  function decisionOf(
    deps: DomainDeps,
    kind: PendingDecisionKind,
    taskId: TaskId,
  ): PendingDecision {
    return mustOk(
      parsePendingDecision({
        id: nextEntityId(deps.ids, "decision"),
        kind,
        taskId,
        requestedAt: NOW,
        summary: "fixture park decision",
        surfaceDeliveries: [],
      }),
    );
  }

  function recordOutcome(build: (deps: DomainDeps, taskId: TaskId) => AttemptOutcome): {
    outcome: CommandOutcome;
    taskId: TaskId;
    input: AttemptOutcome;
  } {
    const { deps, aggregate, taskId } = reachTaskState("RUNNING");
    const before = requireTaskFor(aggregate, taskId);
    const attemptId = before.openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    const input = build(deps, taskId);
    const outcome = executeCommand(deps, aggregate, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: before.revision,
      meta: meta(NOW),
      attemptId,
      outcome: input,
    });
    return { outcome, taskId, input };
  }

  it("Error: 원인과 kind 가 어긋나거나 다른 주체인 결정은 invalid_input 이고 RUNNING 에 머문다 (test_SC038_attempt_outcome_park_requires_cause_kind_and_own_subject)", () => {
    const otherTask = entityId("task", "tsk_othersubject1");
    const refusedCases: readonly ((deps: DomainDeps, taskId: TaskId) => AttemptOutcome)[] = [
      (deps, taskId) => ({
        kind: "blocked",
        cause: "gate_denied",
        decision: decisionOf(deps, "pre_execution_approval", taskId),
      }),
      (deps, taskId) => ({
        kind: "blocked",
        cause: "executor_blocked",
        decision: decisionOf(deps, "dead_letter_resolution_required", taskId),
      }),
      (deps, taskId) => ({
        kind: "effect_dead_lettered",
        decision: decisionOf(deps, "tool_permission_denied_unattended", taskId),
      }),
      (deps) => ({
        kind: "blocked",
        cause: "dispatcher_refused",
        decision: decisionOf(deps, "tool_permission_denied_unattended", otherTask),
      }),
      (deps, taskId) => ({
        kind: "effect_dead_lettered",
        decision: rowSubjectDeadLetterDecision(deps, `reaction-row:${taskId}`, NOW),
      }),
    ];
    for (const build of refusedCases) {
      const { outcome } = recordOutcome(build);
      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") continue;
      expect(outcome.rejection.reason).toBe("invalid_input");
      expect(outcome.record).toBeUndefined();
    }

    const acceptedCases: readonly ((deps: DomainDeps, taskId: TaskId) => AttemptOutcome)[] = [
      (deps, taskId) => ({
        kind: "blocked",
        cause: "gate_denied",
        decision: taskSubjectPendingDecision(deps, taskId, NOW),
      }),
      (deps, taskId) => ({
        kind: "effect_dead_lettered",
        decision: deadLetterDecision(deps, taskId, NOW),
      }),
    ];
    for (const build of acceptedCases) {
      const { outcome, taskId, input } = recordOutcome(build);
      expect(outcome.kind).toBe("committed");
      if (outcome.kind !== "committed") continue;
      const parked = requireTaskFor(outcome.aggregate, taskId);
      expect(parked.state).toBe("BLOCKED_AWAITING_HUMAN");
      expect(parked.pendingDecision?.kind).toBe("decision" in input ? input.decision.kind : "");
    }
    const orphaned = reachDeadLetterParked();
    expect(requireTaskFor(orphaned.aggregate, orphaned.taskId).pendingDecision?.kind).toBe(
      "dead_letter_resolution_required",
    );
  });
});

describe("SC-034: 반응 자격은 전이 반응이면서 ADDE 자격증명을 쓸 때만 성립한다", () => {
  it("Error: 실행 효과 반응·비자격증명 전이 반응은 effect_records_only 이고 자격증명 전이 반응은 수용된다 (test_SC034_reaction_qualification_needs_transition_and_credentials)", () => {
    const reaction = (kind: string) => {
      const found = BUILTIN_REACTIONS.find((r) => r.kind === kind && r.version === 1);
      if (found === undefined) throw new Error(`builtin reaction ${kind} missing`);
      return found;
    };
    const confirm = reaction("request_confirmation");
    const spawn = reaction("spawn_task");
    const notify = reaction("notify");
    expect([confirm.declaredAs, confirm.usesAddeCredentials]).toEqual(["execution_effect", true]);
    expect([spawn.declaredAs, spawn.usesAddeCredentials]).toEqual(["transition_reaction", false]);
    expect([notify.declaredAs, notify.usesAddeCredentials]).toEqual(["transition_reaction", true]);

    const judge = (declared: typeof confirm) =>
      judgeApprovalSurface({
        taskType: { executionEffect: "records_only", approvalGatesQuestionOnly: false },
        policy: OUT_OF_BAND_APPROVED,
        declaredReactions: [declared],
      });
    expect(judge(confirm)).toEqual({ accepted: false, reason: "effect_records_only" });
    expect(judge(spawn)).toEqual({ accepted: false, reason: "effect_records_only" });
    expect(judge(notify)).toEqual({ accepted: true });
  });
});

describe("SC-038: 결정 거부는 declined 와 dead-letter 폐기 두 형태만 받는다", () => {
  it("Error: resolution 이 없거나 임의 문자열인 거부는 결정 종류와 무관하게 invalid_input 이고 declined 는 수용된다 (test_SC038_untyped_deny_resolution_refused_never_failed)", () => {
    // 런타임 방어 시험: 타입이 막는 resolution 누락·임의 값을 우회해 넣는다.
    const untyped: readonly DecisionApplication[] = [
      { kind: "task_deny" } as unknown as DecisionApplication,
      { kind: "task_deny", resolution: "abandon" } as unknown as DecisionApplication,
      { kind: "task_deny", resolution: undefined } as unknown as DecisionApplication,
    ];
    const preApproval = parkedOnPreExecutionApproval("f2prime");
    const deadLetter = reachDeadLetterParked();
    for (const parked of [preApproval, deadLetter]) {
      for (const application of untyped) {
        const refused = decide(parked.deps, parked.aggregate, parked.taskId, "deny", application);
        expect(refused.kind).toBe("not_applicable");
        if (refused.kind !== "not_applicable") continue;
        expect(refused.rejection.reason).toBe("invalid_input");
        expect("commit" in refused).toBe(false);
      }
    }
    const discardedOnApproval = decide(
      preApproval.deps,
      preApproval.aggregate,
      preApproval.taskId,
      "deny",
      { kind: "task_deny", resolution: "discarded_only_effect" },
    );
    expect(discardedOnApproval.kind).toBe("not_applicable");

    // 거절은 키를 선점하지 않으므로 같은 결정·revision·choice 의 declined 가 이어서 수용된다.
    const declined = decide(preApproval.deps, preApproval.aggregate, preApproval.taskId, "deny", {
      kind: "task_deny",
      resolution: "declined",
    });
    expect(declined.kind).toBe("accepted");
    if (declined.kind === "accepted") {
      expect(eventTypes(declined.commit)).not.toContain("task_failed");
      expect(requireTaskFor(declined.aggregate, preApproval.taskId).state).toBe("REJECTED");
    }
  });
});

describe("SC-038: dispatch 고아·철회의 dead-letter 주차도 원인에 맞는 자기 Task 주체 결정만 받는다", () => {
  it("Error: 예산 소진 dispatch_orphaned·dispatch_withdrawn 에 종류·주체가 어긋난 결정은 invalid_input 이고 맞는 결정은 주차된다 (test_SC038_dispatch_dead_letter_park_requires_kind_and_own_subject)", () => {
    const otherTask = entityId("task", "tsk_othersubject2");
    const decisionWith = (deps: DomainDeps, kind: PendingDecisionKind, taskId: TaskId) =>
      mustOk(
        parsePendingDecision({
          id: nextEntityId(deps.ids, "decision"),
          kind,
          taskId,
          requestedAt: NOW,
          summary: "fixture dispatch dead-letter decision",
          surfaceDeliveries: [],
        }),
      );
    const cases: readonly {
      decision: (deps: DomainDeps, taskId: TaskId) => PendingDecision;
      parks: boolean;
    }[] = [
      {
        decision: (deps, taskId) => decisionWith(deps, "tool_permission_denied_unattended", taskId),
        parks: false,
      },
      {
        decision: (deps) => decisionWith(deps, "dead_letter_resolution_required", otherTask),
        parks: false,
      },
      {
        decision: (deps, taskId) => rowSubjectDeadLetterDecision(deps, `effect:${taskId}`, NOW),
        parks: false,
      },
      { decision: (deps, taskId) => deadLetterDecision(deps, taskId, NOW), parks: true },
    ];
    for (const kind of ["dispatch_orphaned", "dispatch_withdrawn"] as const) {
      for (const { decision, parks } of cases) {
        const { deps, aggregate, taskId } = reachTaskState("RUNNING", {
          policy: {
            retry: { maxAttempts: 1, initialDelayMs: 1_000, maxDelayMs: 1_000, backoff: "fixed" },
          },
        });
        const before = requireTaskFor(aggregate, taskId);
        const attemptId = before.openAttempt?.attemptId;
        if (attemptId === undefined) throw new Error("expected open attempt");
        const deadLetter = decision(deps, taskId);
        const outcome = executeCommand(deps, aggregate, {
          kind: "record_attempt_outcome",
          taskId,
          expectedRevision: before.revision,
          meta: meta(NOW),
          attemptId,
          outcome: { kind, deadLetterDecision: deadLetter },
        });
        if (parks) {
          expect(outcome.kind).toBe("committed");
          if (outcome.kind !== "committed") continue;
          const parked = requireTaskFor(outcome.aggregate, taskId);
          expect(parked.state).toBe("BLOCKED_AWAITING_HUMAN");
          expect(parked.pendingDecision?.id).toBe(deadLetter.id);
        } else {
          expect(outcome.kind).toBe("rejected");
          if (outcome.kind !== "rejected") continue;
          expect(outcome.rejection.reason).toBe("invalid_input");
          expect(outcome.record).toBeUndefined();
        }
      }
    }
  });
});

describe("SC-038: 거부 resolution 은 한 번만 읽힌다", () => {
  it("Error: 읽을 때마다 값이 바뀌는 resolution getter 로도 실행 전 승인 거부는 FAILED 로 끝나지 않는다 (test_SC038_changing_resolution_getter_never_failed)", () => {
    for (const sequence of [
      ["x", "declined", "x"],
      ["declined", "x", "x"],
      ["x", "x", "declined"],
    ]) {
      const parked = parkedOnPreExecutionApproval(`f2second${sequence.indexOf("declined")}`);
      let reads = 0;
      const application: Record<string, unknown> = { kind: "task_deny" };
      // 런타임 방어 시험: 읽기마다 값이 바뀌는 getter 는 타입으로 표현되지 않는다.
      Object.defineProperty(application, "resolution", {
        enumerable: true,
        get: () => sequence[Math.min(reads++, sequence.length - 1)],
      });
      const judged = decide(
        parked.deps,
        parked.aggregate,
        parked.taskId,
        "deny",
        application as unknown as DecisionApplication,
      );
      if (judged.kind === "accepted") {
        // 한 번 읽은 값이 declined 일 때만 수용된다.
        expect(sequence[0]).toBe("declined");
        expect(eventTypes(judged.commit)).not.toContain("task_failed");
        expect(requireTaskFor(judged.aggregate, parked.taskId).state).toBe("REJECTED");
      } else {
        expect(judged.kind).toBe("not_applicable");
        if (judged.kind === "not_applicable") expect(judged.rejection.reason).toBe("invalid_input");
      }
    }
  });
});
