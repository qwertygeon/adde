// SC-002~SC-006, SC-009 — 계약 이름·revision 규칙·비인간 거절·타임존 정규화 정렬.
import { describe, expect, it } from "vitest";
import {
  parseTaskPolicy,
  PENDING_DECISION_KINDS,
  EVENT_CATALOG,
  TASK_POLICY_FIELD_SHAPES,
  executeCommand,
  judgeSignal,
  nextEntityId,
  deriveOccurrenceId,
  deriveSignalDedupKey,
  parsePendingDecision,
  foldEvents,
  evolveCommit,
  contentHashOf,
  normalizeTimeZoneIdentifier,
  IANA_TIME_ZONE_NAMES,
  validateTask,
} from "../../../src/workflow/domain/index.js";
import type {
  DomainDeps,
  DomainCommit,
  WorkAggregate,
  TaskId,
  DecisionSignal,
  PendingDecision,
  TriggerSpec,
  ActorSource,
  CancelOrigin,
  DecisionApplication,
} from "../../../src/workflow/domain/index.js";
import {
  at,
  meta,
  mustOk,
  mustCommit,
  entityId,
  basePolicy,
  draft,
  planned,
  plannedWithCommits,
  patchTask,
  reachTaskState,
  reachWorkState,
  reachDeadLetterParked,
  deadLetterDecision,
  requireTaskFor,
  testDeps,
} from "./helpers/fixtures.js";
import { testRegistries } from "./helpers/registry-fixtures.js";
import { eventTypes, payloadOf } from "./helpers/commits.js";

const NOW = at("2026-01-01T00:00:00Z");

function rawPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policyVersion: 1,
    terminalRequired: true,
    onDependencyUnsatisfied: "block",
    approvalRequiredBeforeExecute: false,
    approvalSurface: "markdown",
    fanOutMaxConcurrent: 1,
    unattended: { eligible: false, onGateDenied: "block_awaiting_human" },
    retry: { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 60_000, backoff: "fixed" },
    timezone: "Asia/Seoul",
    maxSpawnDepth: 1,
    maxTasksPerWork: 50,
    maxWorksPerChain: 10,
    ...overrides,
  };
}

function shapeFields(shape: string): readonly string[] {
  const found = TASK_POLICY_FIELD_SHAPES.find((s) => s.shape === shape);
  if (found === undefined) throw new Error(`no transcribed shape ${shape}`);
  return found.fields.map((f) => f.name);
}

function reminderOccurrence(taskId: TaskId) {
  return mustOk(
    deriveOccurrenceId({
      kind: "schedule",
      ownerId: taskId,
      triggerId: "reminder",
      scheduledForUtc: NOW,
      recurrenceIndex: 0,
    }),
  );
}

function confirmationSignal(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  taskId: TaskId,
  overrides: Partial<DecisionSignal> = {},
): DecisionSignal {
  const task = requireTaskFor(aggregate, taskId);
  const confirmationId = task.confirmationId;
  if (confirmationId === undefined) throw new Error("expected confirmationId");
  return {
    type: "confirmation_decision",
    taskId,
    confirmationId,
    decision: "accept",
    signalId: nextEntityId(deps.ids, "signal"),
    expectedRevision: task.revision,
    actorSource: "human_local",
    receivedAt: NOW,
    ...overrides,
  } as DecisionSignal;
}

function humanDecisionSignal(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  taskId: TaskId,
  actorSource: DecisionSignal["actorSource"],
): Extract<DecisionSignal, { type: "human_decision" }> {
  const task = requireTaskFor(aggregate, taskId);
  const decisionId = task.pendingDecision?.id;
  if (decisionId === undefined) throw new Error("expected pending decision");
  return {
    type: "human_decision",
    decisionId,
    choice: "grant",
    signalId: nextEntityId(deps.ids, "signal"),
    expectedRevision: task.revision,
    actorSource,
    receivedAt: NOW,
  };
}

function cancelSignal(
  deps: DomainDeps,
  subject: { readonly taskId: TaskId } | { readonly workId: WorkAggregate["work"]["id"] },
  expectedRevision: number,
  actorSource: DecisionSignal["actorSource"],
): DecisionSignal {
  return {
    type: "cancel_requested",
    subject,
    signalId: nextEntityId(deps.ids, "signal"),
    expectedRevision,
    actorSource,
    receivedAt: NOW,
  };
}

describe("SC-002: 정책 필드·이벤트·결정 종류가 현재 계약 이름을 쓴다", () => {
  it("Happy: 계약 필드 이름으로 정책이 파싱되고 결정 종류·이벤트 이름이 계약과 같다 (test_SC002_policy_parses_contract_field_names)", () => {
    const parsed = parseTaskPolicy(rawPolicy());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.approvalSurface).toBe("markdown");
    expect(PENDING_DECISION_KINDS).toContain("pre_execution_approval");
    const names = EVENT_CATALOG.map((e) => e.name as string);
    expect(names).toContain("approval_surface_refused");
    expect(names).toContain("approval_refused_off_surface");
  });

  it("Edge: 선택 필드를 모두 실은 정책의 키가 층위마다 전사 필드 안에 있다 (test_SC002_parsed_policy_keys_within_transcribed_fields)", () => {
    const parsed = parseTaskPolicy(
      rawPolicy({
        unattended: {
          eligible: true,
          onGateDenied: "block_awaiting_human",
          toolScope: {
            id: "scope_1",
            configRef: "cfg_1",
            approvedAt: "2026-01-01T00:00:00Z",
            approvedBy: { kind: "user", id: "u1" },
          },
          window: { fromLocal: "09:00", toLocal: "18:00", timezone: "Asia/Seoul" },
        },
        retry: {
          maxAttempts: 3,
          initialDelayMs: 1_000,
          maxDelayMs: 60_000,
          backoff: "exponential",
          retryableErrors: ["transient"],
          jitterMs: 100,
        },
        reminder: {
          intervalMs: 60_000,
          maxOccurrences: 3,
          quietHours: { fromLocal: "22:00", toLocal: "07:00", timezone: "Asia/Seoul" },
        },
        targetDueAt: "2026-02-01T00:00:00Z",
        expiresAt: "2026-03-01T00:00:00Z",
        attemptTimeoutMs: 1_000,
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const policy = parsed.value;
    const within = (value: object, shape: string) => {
      const allowed = shapeFields(shape);
      for (const key of Object.keys(value)) expect(allowed, `${shape}.${key}`).toContain(key);
    };
    within(policy, "TaskPolicy");
    within(policy.unattended, "UnattendedPolicy");
    if (policy.unattended.window !== undefined)
      within(policy.unattended.window, "UnattendedPolicy.window");
    if (policy.unattended.toolScope !== undefined)
      within(policy.unattended.toolScope, "ToolScopeRef");
    within(policy.retry, "RetryPolicy");
    if (policy.reminder !== undefined) {
      within(policy.reminder, "ReminderPolicy");
      if (policy.reminder.quietHours !== undefined)
        within(policy.reminder.quietHours, "ReminderPolicy.quietHours");
    }
  });

  it("Error: 옛 필드 이름은 거절되고 카탈로그에 옛 이벤트 이름이 없다 (test_SC002_old_field_and_event_names_refused)", () => {
    const { approvalSurface: _dropped, ...withoutNew } = rawPolicy();
    void _dropped;
    const oldOnly = parseTaskPolicy({ ...withoutNew, confirmationSurface: "markdown" });
    expect(oldOnly.ok).toBe(false);
    if (!oldOnly.ok) expect(oldOnly.error.field).toBe("approvalSurface");

    const both = parseTaskPolicy(rawPolicy({ confirmationSurface: "markdown" }));
    expect(both.ok).toBe(false);
    if (!both.ok) {
      expect(both.error.field).toBe("confirmationSurface");
      expect(both.error.reason).toBe("unknown_field");
    }

    const nested = parseTaskPolicy(
      rawPolicy({
        unattended: { eligible: false, onGateDenied: "block_awaiting_human", extra: true },
      }),
    );
    expect(nested.ok).toBe(false);
    if (!nested.ok) {
      expect(nested.error.field).toBe("unattended.extra");
      expect(nested.error.reason).toBe("unknown_field");
    }

    const names = EVENT_CATALOG.map((e) => e.name as string);
    expect(names).not.toContain("confirmation_surface_refused");
    expect(names).not.toContain("confirmation_refused_off_surface");
  });
});

describe("SC-003: 리마인더는 Task revision 을 바꾸지 않는다", () => {
  it("Happy: 확인 대기 리마인더 뒤 같은 revision 의 확인 결정이 수용된다 (test_SC003_confirmation_reminder_keeps_revision_then_decision_accepted)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const revision = requireTaskFor(aggregate, taskId).revision;
    const reminded = executeCommand(deps, aggregate, {
      kind: "emit_reminder",
      taskId,
      expectedRevision: revision,
      meta: meta(NOW),
      occurrenceId: reminderOccurrence(taskId),
    });
    expect(reminded.kind).toBe("committed");
    if (reminded.kind !== "committed") return;
    expect(
      eventTypes(reminded.commit).filter((t) => t === "reminder_occurrence_emitted"),
    ).toHaveLength(1);
    expect(requireTaskFor(reminded.aggregate, taskId).revision).toBe(revision);

    const decided = judgeSignal(
      deps,
      reminded.aggregate,
      confirmationSignal(deps, reminded.aggregate, taskId, { expectedRevision: revision }),
      { kind: "none" },
      NOW,
    );
    expect(decided.kind).toBe("accepted");
  });

  it("Edge: 결정 만료 리마인더는 결정 id 를 싣고 revision 을 유지해 grant 가 수용된다 (test_SC003_decision_expiry_reminder_keeps_revision_then_grant_accepted)", () => {
    const { deps, aggregate: ready, taskId } = reachTaskState("READY");
    const decision: PendingDecision = mustOk(
      parsePendingDecision({
        id: nextEntityId(deps.ids, "decision"),
        kind: "tool_permission_denied_unattended",
        taskId,
        requestedAt: NOW,
        summary: "expiring decision",
        surfaceDeliveries: [],
        expiresAt: "2026-01-02T00:00:00Z",
      }),
    );
    const parked = mustCommit(
      executeCommand(deps, ready, {
        kind: "park_awaiting_human",
        taskId,
        expectedRevision: requireTaskFor(ready, taskId).revision,
        meta: meta(NOW),
        cause: "unattended_eligibility_refused",
        decision,
      }),
    ).aggregate;
    const revision = requireTaskFor(parked, taskId).revision;
    const reminded = executeCommand(deps, parked, {
      kind: "emit_reminder",
      taskId,
      expectedRevision: revision,
      meta: meta(NOW),
      occurrenceId: reminderOccurrence(taskId),
    });
    expect(reminded.kind).toBe("committed");
    if (reminded.kind !== "committed") return;
    expect(payloadOf(reminded.commit, "reminder_occurrence_emitted")["decisionId"]).toBe(
      decision.id,
    );
    expect(requireTaskFor(reminded.aggregate, taskId).revision).toBe(revision);

    const granted = judgeSignal(
      deps,
      reminded.aggregate,
      humanDecisionSignal(deps, reminded.aggregate, taskId, "human_local"),
      { kind: "task_grant", resume: { to: "READY" } },
      NOW,
    );
    expect(granted.kind).toBe("accepted");
  });

  it("Error: 만료 없는 결정의 리마인더는 condition_not_met 으로 거절된다 (test_SC003_reminder_without_decision_expiry_rejected)", () => {
    const { deps, aggregate, taskId } = reachTaskState("BLOCKED_AWAITING_HUMAN");
    const before = requireTaskFor(aggregate, taskId);
    expect(before.pendingDecision).toBeDefined();
    expect(
      before.pendingDecision !== undefined && "expiresAt" in before.pendingDecision
        ? before.pendingDecision.expiresAt
        : undefined,
    ).toBeUndefined();
    const outcome = executeCommand(deps, aggregate, {
      kind: "emit_reminder",
      taskId,
      expectedRevision: before.revision,
      meta: meta(NOW),
      occurrenceId: reminderOccurrence(taskId),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.rejection.reason).toBe("condition_not_met");
    expect(requireTaskFor(aggregate, taskId).revision).toBe(before.revision);
  });
});

/** 재시도 예산 1 의 Task 를 dead-letter 주차·늦은 결과 표시까지 진행하며 전체 커밋을 모은다. */
function lateResultHistory(): {
  commits: readonly DomainCommit[];
  final: WorkAggregate;
} {
  const { deps, aggregate, taskIds, commits } = plannedWithCommits(
    [
      draft("late", {
        policy: basePolicy({
          retry: { maxAttempts: 1, initialDelayMs: 1_000, maxDelayMs: 1_000, backoff: "fixed" },
        }),
      }),
    ],
    testDeps("sc004fold"),
  );
  const taskId = taskIds["late"];
  if (taskId === undefined) throw new Error("expected task");
  const all: DomainCommit[] = [...commits];
  let current = aggregate;
  const step = (outcome: ReturnType<typeof executeCommand>) => {
    const done = mustCommit(outcome);
    all.push(done.commit);
    current = done.aggregate;
  };
  const rev = () => requireTaskFor(current, taskId).revision;
  step(
    executeCommand(deps, current, {
      kind: "begin_validation",
      taskId,
      expectedRevision: rev(),
      meta: meta(NOW),
    }),
  );
  step(
    executeCommand(deps, current, {
      kind: "complete_validation",
      taskId,
      expectedRevision: rev(),
      meta: meta(NOW),
    }),
  );
  step(
    executeCommand(deps, current, {
      kind: "start_attempt",
      taskId,
      expectedRevision: rev(),
      meta: meta(NOW),
    }),
  );
  const attemptId = requireTaskFor(current, taskId).openAttempt?.attemptId;
  if (attemptId === undefined) throw new Error("expected open attempt");
  step(
    executeCommand(deps, current, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: rev(),
      meta: meta(NOW),
      attemptId,
      outcome: {
        kind: "dispatch_orphaned",
        deadLetterDecision: deadLetterDecision(deps, taskId, NOW),
      },
    }),
  );
  step(
    executeCommand(deps, current, {
      kind: "present_late_result",
      taskId,
      expectedRevision: rev(),
      meta: meta(NOW),
      attemptId,
      resultContentHash: contentHashOf("late result"),
    }),
  );
  return { commits: all, final: current };
}

describe("SC-004: 열린 dead-letter 결정에 늦은 결과를 반영하는 커밋은 revision 을 1 올린다", () => {
  it("Happy: 늦은 결과 표시가 agent_result_unmatched 를 남기고 revision +1·상태 유지 (test_SC004_late_result_presentation_increments_revision_state_unchanged)", () => {
    const { deps, aggregate, taskId, attemptId } = reachDeadLetterParked();
    const before = requireTaskFor(aggregate, taskId);
    const decisionId = before.pendingDecision?.id;
    expect(decisionId).toBeDefined();
    const hash = contentHashOf("late result");
    const outcome = executeCommand(deps, aggregate, {
      kind: "present_late_result",
      taskId,
      expectedRevision: before.revision,
      meta: meta(NOW),
      attemptId,
      resultContentHash: hash,
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(payloadOf(outcome.commit, "agent_result_unmatched")).toMatchObject({
      attemptId,
      reason: "attempt_ended",
      resultContentHash: hash,
      presentedInDecisionId: decisionId,
    });
    const after = requireTaskFor(outcome.aggregate, taskId);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.state).toBe("BLOCKED_AWAITING_HUMAN");
    expect(after.lateResults).toHaveLength(1);
  });

  it("Edge: fold 재구성이 표시 커밋의 revision 까지 직접 적용과 같다 (test_SC004_fold_reproduces_presentation_revision)", () => {
    const { commits, final } = lateResultHistory();
    const folded = foldEvents(commits.flatMap((c) => c.events));
    expect(folded.ok).toBe(true);
    if (folded.ok) expect(folded.value).toEqual(final);
  });

  it("Error: 다른 attempt 나 dead-letter 가 아닌 결정에는 거절되고 revision 이 그대로다 (test_SC004_mismatched_attempt_or_decision_rejected)", () => {
    const { deps, aggregate, taskId } = reachDeadLetterParked();
    const before = requireTaskFor(aggregate, taskId);
    const wrongAttempt = executeCommand(deps, aggregate, {
      kind: "present_late_result",
      taskId,
      expectedRevision: before.revision,
      meta: meta(NOW),
      attemptId: entityId("attempt", "att_otherattempt1"),
      resultContentHash: contentHashOf("late result"),
    });
    expect(wrongAttempt.kind).toBe("rejected");
    if (wrongAttempt.kind === "rejected")
      expect(wrongAttempt.rejection.reason).toBe("condition_not_met");

    const other = reachTaskState("BLOCKED_AWAITING_HUMAN");
    const otherBefore = requireTaskFor(other.aggregate, other.taskId);
    const notDeadLetter = executeCommand(other.deps, other.aggregate, {
      kind: "present_late_result",
      taskId: other.taskId,
      expectedRevision: otherBefore.revision,
      meta: meta(NOW),
      attemptId: entityId("attempt", "att_otherattempt2"),
      resultContentHash: contentHashOf("late result"),
    });
    expect(notDeadLetter.kind).toBe("rejected");
    if (notDeadLetter.kind === "rejected")
      expect(notDeadLetter.rejection.reason).toBe("condition_not_met");
    expect(requireTaskFor(aggregate, taskId).revision).toBe(before.revision);
  });
});

describe("SC-005: 거절·중복 기록과 한 커밋 여러 행은 계약대로 revision 을 다룬다", () => {
  it("Happy: 실행 전 승인이 필요한 Task 의 검증 커밋은 두 행이어도 revision +1 이다 (test_SC005_two_row_commit_increments_once)", () => {
    const { deps, aggregate, taskId } = reachTaskState("VALIDATING", {
      policy: { approvalRequiredBeforeExecute: true },
    });
    const before = requireTaskFor(aggregate, taskId).revision;
    const outcome = executeCommand(deps, aggregate, {
      kind: "complete_validation",
      taskId,
      expectedRevision: before,
      meta: meta(NOW),
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    const types = eventTypes(outcome.commit);
    expect(types).toContain("task_validated");
    expect(types).toContain("task_awaiting_human");
    expect(requireTaskFor(outcome.aggregate, taskId).revision).toBe(before + 1);
  });

  it("Edge: 수용된 키를 다시 판정하면 중복 기록만 남고 revision 이 그대로다 (test_SC005_duplicate_signal_keeps_revision)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const signal = confirmationSignal(deps, aggregate, taskId);
    const first = judgeSignal(deps, aggregate, signal, { kind: "none" }, NOW);
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") return;
    const revision = requireTaskFor(first.aggregate, taskId).revision;
    const again = judgeSignal(deps, first.aggregate, signal, { kind: "none" }, NOW);
    expect(again.kind).toBe("duplicate");
    if (again.kind === "duplicate")
      expect(eventTypes(again.commit)).toEqual(["signal_ignored_duplicate"]);
    expect(requireTaskFor(first.aggregate, taskId).revision).toBe(revision);
  });

  it("Error: stale 신호 거절은 revision 을 바꾸지 않고 승인 채널 거절 차단 커밋은 +1 이다 (test_SC005_rejected_signal_keeps_revision)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const revision = requireTaskFor(aggregate, taskId).revision;
    const stale = judgeSignal(
      deps,
      aggregate,
      confirmationSignal(deps, aggregate, taskId, { expectedRevision: revision + 1 }),
      { kind: "none" },
      NOW,
    );
    expect(stale.kind).toBe("rejected_stale");
    expect(requireTaskFor(aggregate, taskId).revision).toBe(revision);

    const validating = reachTaskState("VALIDATING");
    // 레코드 패치: 같은 등록부로는 계획 커밋이 막는 범위 밖 채널 선언을 다른 생성 경로 대용으로 재현.
    const patched = patchTask(validating.aggregate, validating.taskId, {
      policy: basePolicy({ approvalSurface: "out_of_band", approvalRequiredBeforeExecute: true }),
    });
    const before = requireTaskFor(patched, validating.taskId).revision;
    const refused = executeCommand(validating.deps, patched, {
      kind: "complete_validation",
      taskId: validating.taskId,
      expectedRevision: before,
      meta: meta(NOW),
    });
    expect(refused.kind).toBe("committed");
    if (refused.kind !== "committed") return;
    expect(eventTypes(refused.commit)).toEqual(
      expect.arrayContaining(["approval_surface_refused", "task_blocked"]),
    );
    expect(requireTaskFor(refused.aggregate, validating.taskId).revision).toBe(before + 1);
  });
});

describe("SC-006: 비인간 거절은 신호 종류로 갈리고 거절 기록이 파생 후보 키를 싣는다", () => {
  it("Happy: 확인 대기 Task 의 비인간 확인 결정은 위조 이벤트이고 후보 키가 계약 파생값이다 (test_SC006_non_human_confirmation_decision_forged_event_with_derived_candidate_key)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const before = requireTaskFor(aggregate, taskId);
    const signal = confirmationSignal(deps, aggregate, taskId, { actorSource: "agent_session" });
    if (signal.type !== "confirmation_decision") throw new Error("unexpected signal type");
    const expectedKey = mustOk(
      deriveSignalDedupKey({
        signalType: "confirmation_decision",
        confirmationId: signal.confirmationId,
        expectedRevision: signal.expectedRevision,
        decision: signal.decision,
      }),
    );
    const judged = judgeSignal(deps, aggregate, signal, { kind: "none" }, NOW);
    expect(judged.kind).toBe("forged_provenance");
    if (judged.kind !== "forged_provenance") return;
    expect(eventTypes(judged.commit)).toEqual(["confirmation_rejected_forged_provenance"]);
    const candidateKey = payloadOf(judged.commit, "confirmation_rejected_forged_provenance")[
      "candidateKey"
    ];
    expect(candidateKey).toBe(expectedKey);
    expect(candidateKey).not.toBe("");
    expect(before.state).toBe("WAITING_CONFIRMATION");
  });

  it("Edge: 확인 대기 Task 의 비인간 취소는 위조 이벤트가 아니라 signal_rejected 이고 후보 키가 파생값이다 (test_SC006_non_human_cancel_on_waiting_confirmation_signal_rejected_with_derived_candidate_key)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const revision = requireTaskFor(aggregate, taskId).revision;
    const expectedKey = mustOk(
      deriveSignalDedupKey({
        signalType: "cancel_requested",
        subjectId: taskId,
        expectedRevision: revision,
      }),
    );
    const judged = judgeSignal(
      deps,
      aggregate,
      cancelSignal(deps, { taskId }, revision, "agent_session"),
      { kind: "none" },
      NOW,
    );
    expect(judged.kind).toBe("rejected");
    if (judged.kind !== "rejected") return;
    expect(judged.reason).toBe("provenance_not_human");
    expect(eventTypes(judged.commit)).toEqual(["signal_rejected"]);
    const payload = payloadOf(judged.commit, "signal_rejected");
    expect(payload["reason"]).toBe("provenance_not_human");
    expect(payload["candidateKey"]).toBe(expectedKey);
  });

  it("Error: 다른 상태·Work 주체 취소와 비인간 사람 결정도 파생 키로 거절되고 거절은 키를 선점하지 않는다 (test_SC006_non_human_other_signal_types_rejected_with_derived_key_and_key_not_reserved)", () => {
    const ready = reachTaskState("READY");
    const readyRevision = requireTaskFor(ready.aggregate, ready.taskId).revision;
    const taskCancel = judgeSignal(
      ready.deps,
      ready.aggregate,
      cancelSignal(ready.deps, { taskId: ready.taskId }, readyRevision, "unknown"),
      { kind: "none" },
      NOW,
    );
    expect(taskCancel.kind).toBe("rejected");
    if (taskCancel.kind === "rejected") {
      expect(taskCancel.reason).toBe("provenance_not_human");
      expect(payloadOf(taskCancel.commit, "signal_rejected")["candidateKey"]).toBe(
        mustOk(
          deriveSignalDedupKey({
            signalType: "cancel_requested",
            subjectId: ready.taskId,
            expectedRevision: readyRevision,
          }),
        ),
      );
    }

    const workId = ready.aggregate.work.id;
    const workRevision = ready.aggregate.work.revision;
    const workCancel = judgeSignal(
      ready.deps,
      ready.aggregate,
      cancelSignal(ready.deps, { workId }, workRevision, "unknown"),
      { kind: "none" },
      NOW,
    );
    expect(workCancel.kind).toBe("rejected");
    if (workCancel.kind === "rejected") {
      expect(workCancel.reason).toBe("provenance_not_human");
      expect(payloadOf(workCancel.commit, "signal_rejected")["candidateKey"]).toBe(
        mustOk(
          deriveSignalDedupKey({
            signalType: "cancel_requested",
            subjectId: workId,
            expectedRevision: workRevision,
          }),
        ),
      );
    }

    const parked = reachTaskState("BLOCKED_AWAITING_HUMAN");
    const forged = humanDecisionSignal(
      parked.deps,
      parked.aggregate,
      parked.taskId,
      "agent_session",
    );
    const expectedKey = mustOk(
      deriveSignalDedupKey({
        signalType: "human_decision",
        decisionId: forged.decisionId,
        expectedRevision: forged.expectedRevision,
        choice: forged.choice,
      }),
    );
    const application = { kind: "task_grant", resume: { to: "READY" } } as const;
    const refused = judgeSignal(parked.deps, parked.aggregate, forged, application, NOW);
    expect(refused.kind).toBe("rejected");
    if (refused.kind !== "rejected") return;
    expect(refused.reason).toBe("provenance_not_human");
    expect(payloadOf(refused.commit, "signal_rejected")["candidateKey"]).toBe(expectedKey);

    // 거절 기록 커밋을 적용한 애그리거트에서 같은 키의 사람 신호를 판정해야 선점 여부가 드러난다.
    const afterRefusal = evolveCommit(parked.aggregate, refused.commit.events);
    const human = { ...forged, actorSource: "human_local" as const };
    const accepted = judgeSignal(parked.deps, afterRefusal, human, application, NOW);
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind === "accepted") expect(accepted.dedupKey).toBe(expectedKey);
  });
});

describe("SC-005·SC-006: 기록 전용 커밋은 후보 키를 선점하지 않는다", () => {
  it("Edge: 비인간 거절·위조·stale 기록 커밋을 적용한 뒤 같은 키의 사람 신호가 중복이 아니라 수용된다 (test_SC006_record_only_commits_never_reserve_candidate_key)", () => {
    const outcomes: Record<string, string> = {};

    // 비인간 거절(signal_rejected provenance_not_human)
    {
      const { deps, aggregate, taskId } = reachTaskState("BLOCKED_AWAITING_HUMAN");
      const forged = humanDecisionSignal(deps, aggregate, taskId, "agent_session");
      const application = { kind: "task_grant", resume: { to: "READY" } } as const;
      const refused = judgeSignal(deps, aggregate, forged, application, NOW);
      if (refused.kind !== "rejected") throw new Error(`expected rejected, got ${refused.kind}`);
      expect(eventTypes(refused.commit)).toEqual(["signal_rejected"]);
      const after = evolveCommit(aggregate, refused.commit.events);
      outcomes["refusal"] = judgeSignal(
        deps,
        after,
        { ...forged, actorSource: "human_local" },
        application,
        NOW,
      ).kind;
    }

    // 위조 기록(confirmation_rejected_forged_provenance)
    {
      const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
      const forged = confirmationSignal(deps, aggregate, taskId, { actorSource: "agent_session" });
      const judged = judgeSignal(deps, aggregate, forged, { kind: "none" }, NOW);
      if (judged.kind !== "forged_provenance")
        throw new Error(`expected forged_provenance, got ${judged.kind}`);
      const after = evolveCommit(aggregate, judged.commit.events);
      outcomes["forged"] = judgeSignal(
        deps,
        after,
        { ...forged, actorSource: "human_local" } as DecisionSignal,
        { kind: "none" },
        NOW,
      ).kind;
    }

    // stale 기록(signal_rejected_stale) — 앞선 revision 을 지목한 취소가 stale 로 기록된 뒤
    // Task 가 그 revision 에 도달하면 같은 키의 취소가 수용돼야 한다.
    {
      const { deps, aggregate, taskId } = reachTaskState("READY");
      const revision = requireTaskFor(aggregate, taskId).revision;
      const early = cancelSignal(deps, { taskId }, revision + 1, "human_local");
      const stale = judgeSignal(deps, aggregate, early, { kind: "none" }, NOW);
      if (stale.kind !== "rejected_stale") throw new Error(`expected stale, got ${stale.kind}`);
      expect(payloadOf(stale.commit, "signal_rejected_stale")["candidateKey"]).toBe(
        mustOk(
          deriveSignalDedupKey({
            signalType: "cancel_requested",
            subjectId: taskId,
            expectedRevision: revision + 1,
          }),
        ),
      );
      const afterStale = evolveCommit(aggregate, stale.commit.events);
      const running = mustCommit(
        executeCommand(deps, afterStale, {
          kind: "start_attempt",
          taskId,
          expectedRevision: revision,
          meta: meta(NOW),
        }),
      ).aggregate;
      expect(requireTaskFor(running, taskId).revision).toBe(revision + 1);
      outcomes["stale"] = judgeSignal(deps, running, early, { kind: "none" }, NOW).kind;
    }

    expect(outcomes).toEqual({ refusal: "accepted", forged: "accepted", stale: "accepted" });
  });
});

describe("SC-009: 타임존 식별자는 대소문자만 정규화되고 링크는 보존된다", () => {
  const atTrigger = (timezone: string): TriggerSpec => ({
    kind: "at",
    version: 1,
    triggerId: "tz",
    scheduledForUtc: at("2026-01-02T00:00:00Z"),
    timezone,
    expressionText: "tomorrow",
    misfire: { kind: "skip" },
  });

  it("Happy: 정책 세 곳과 at Trigger 의 소문자 이름이 IANA 철자로 저장된다 (test_SC009_case_normalized_policy_and_at_trigger)", () => {
    expect(normalizeTimeZoneIdentifier("asia/seoul")).toEqual({ ok: true, value: "Asia/Seoul" });
    const policy = mustOk(
      parseTaskPolicy(
        rawPolicy({
          timezone: "asia/seoul",
          unattended: {
            eligible: false,
            onGateDenied: "block_awaiting_human",
            window: { fromLocal: "09:00", toLocal: "18:00", timezone: "asia/seoul" },
          },
          reminder: {
            intervalMs: 60_000,
            maxOccurrences: 1,
            quietHours: { fromLocal: "22:00", toLocal: "07:00", timezone: "asia/seoul" },
          },
        }),
      ),
    );
    expect(policy.timezone).toBe("Asia/Seoul");
    expect(policy.unattended.window?.timezone).toBe("Asia/Seoul");
    expect(policy.reminder?.quietHours?.timezone).toBe("Asia/Seoul");

    const lowerPolicy = { ...basePolicy(), timezone: "asia/seoul" };
    const result = validateTask(testRegistries(), {
      type: { id: "generic_task", version: 1 },
      input: {},
      trigger: atTrigger("asia/seoul"),
      policy: lowerPolicy,
    });
    expect(result.exit).toBe("valid");
    if (result.exit === "valid") {
      expect(result.normalized.policy.timezone).toBe("Asia/Seoul");
      const trigger = result.normalized.trigger;
      expect(trigger.kind === "at" ? trigger.timezone : undefined).toBe("Asia/Seoul");
    }

    const { aggregate, taskIds } = planned(
      [draft("tz", { trigger: atTrigger("asia/seoul"), policy: lowerPolicy })],
      testDeps("sc009"),
    );
    const taskId = taskIds["tz"];
    if (taskId === undefined) throw new Error("expected task");
    const task = requireTaskFor(aggregate, taskId);
    expect(task.policy.timezone).toBe("Asia/Seoul");
    expect(task.trigger.kind === "at" ? task.trigger.timezone : undefined).toBe("Asia/Seoul");
  });

  it("Edge: 링크 이름은 대상으로 바뀌지 않고 소문자 링크도 링크 철자로 정규화된다 (test_SC009_link_identifier_preserved)", () => {
    expect(normalizeTimeZoneIdentifier("US/Pacific")).toEqual({ ok: true, value: "US/Pacific" });
    expect(normalizeTimeZoneIdentifier("us/pacific")).toEqual({ ok: true, value: "US/Pacific" });
    expect(normalizeTimeZoneIdentifier("Asia/Kolkata")).toEqual({
      ok: true,
      value: "Asia/Kolkata",
    });
    expect(mustOk(parseTaskPolicy(rawPolicy({ timezone: "us/pacific" }))).timezone).toBe(
      "US/Pacific",
    );
    // 이름 목록 드리프트: 런타임 tz 판이 바뀌면 여기서 드러난다(Factory 는 런타임이 거절하는 유일한 이름).
    expect(IANA_TIME_ZONE_NAMES).toHaveLength(598);
    const drifted = IANA_TIME_ZONE_NAMES.filter((name) => name !== "Factory").filter((name) => {
      const normalized = normalizeTimeZoneIdentifier(name.toLowerCase());
      return !normalized.ok || normalized.value !== name;
    });
    expect(drifted).toEqual([]);
  });

  it("Error: 런타임이 받지 않거나 오프셋·빈 값이면 정책·Trigger 모두 거절된다 (test_SC009_unaccepted_identifier_refused)", () => {
    const cases: readonly [string, string][] = [
      ["Mars/Olympus", "not_accepted_by_runtime"],
      ["Factory", "not_accepted_by_runtime"],
      ["+09:00", "offset_not_allowed"],
      ["", "empty"],
    ];
    for (const [raw, reason] of cases) {
      const normalized = normalizeTimeZoneIdentifier(raw);
      expect(normalized.ok, raw).toBe(false);
      if (!normalized.ok) expect(normalized.error.reason, raw).toBe(reason);
      const policy = parseTaskPolicy(rawPolicy({ timezone: raw }));
      expect(policy.ok, raw).toBe(false);
      if (!policy.ok) {
        expect(policy.error.field).toBe("timezone");
        expect(policy.error.reason).toBe("not_iana_timezone");
      }
    }
    const result = validateTask(testRegistries(), {
      type: { id: "generic_task", version: 1 },
      input: {},
      trigger: atTrigger("Mars/Olympus"),
      policy: basePolicy(),
    });
    expect(result.exit).toBe("validation_failed");
    if (result.exit === "validation_failed") {
      expect(result.issues.map((i) => [i.area, i.code])).toContainEqual([
        "trigger",
        "trigger_invalid",
      ]);
    }
  });
});

const NON_HUMAN_AND_HUMAN: readonly ActorSource[] = ["human_local", "agent_session"];

function vaultCancelOrigin(deps: DomainDeps, actorSource: ActorSource): CancelOrigin {
  return {
    kind: "vault_signal",
    actorSource,
    signalId: nextEntityId(deps.ids, "signal"),
  } as CancelOrigin;
}

describe("SC-006: 런타임 결정 값은 계약 집합 밖이면 provenance 판정 전에 거절된다", () => {
  it("Error: 확인 결정 값이 세 값 밖이면 출처와 무관하게 invalid_input 이고 cancel 은 수용된다 (test_SC006_confirmation_decision_value_outside_three_refused)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    for (const actorSource of NON_HUMAN_AND_HUMAN) {
      // 런타임 방어 시험: 타입이 막는 결정 값을 우회해 넣는다.
      const signal = confirmationSignal(deps, aggregate, taskId, {
        actorSource,
        decision: "approve",
      } as unknown as Partial<DecisionSignal>);
      const judged = judgeSignal(deps, aggregate, signal, { kind: "none" }, NOW);
      expect(judged.kind).toBe("not_applicable");
      if (judged.kind !== "not_applicable") continue;
      expect(judged.rejection.reason).toBe("invalid_input");
      expect("commit" in judged).toBe(false);
    }
    const cancel = judgeSignal(
      deps,
      aggregate,
      confirmationSignal(deps, aggregate, taskId, {
        decision: "cancel",
      } as Partial<DecisionSignal>),
      { kind: "none" },
      NOW,
    );
    expect(cancel.kind).toBe("accepted");
    if (cancel.kind === "accepted")
      expect(eventTypes(cancel.commit)).toContain("confirmation_cancelled");
  });

  it("Error: 사람 결정 choice 가 grant·deny 밖이면 Task·Work 주체 모두 출처와 무관하게 invalid_input 이고 deny 는 수용된다 (test_SC006_human_decision_choice_outside_two_refused)", () => {
    const parkedTask = reachTaskState("BLOCKED_AWAITING_HUMAN");
    const approvalWork = reachWorkState("WAITING_APPROVAL");
    const taskDecision = requireTaskFor(parkedTask.aggregate, parkedTask.taskId).pendingDecision;
    const workDecision = approvalWork.aggregate.work.pendingDecision;
    if (taskDecision === undefined || workDecision === undefined)
      throw new Error("expected open decisions");
    const subjects: readonly {
      deps: DomainDeps;
      aggregate: WorkAggregate;
      decisionId: string;
      expectedRevision: number;
      application: DecisionApplication;
      deniedState: (after: WorkAggregate) => string;
    }[] = [
      {
        deps: parkedTask.deps,
        aggregate: parkedTask.aggregate,
        decisionId: taskDecision.id,
        expectedRevision: requireTaskFor(parkedTask.aggregate, parkedTask.taskId).revision,
        application: { kind: "task_deny", resolution: "declined" },
        deniedState: (after) => requireTaskFor(after, parkedTask.taskId).state,
      },
      {
        deps: approvalWork.deps,
        aggregate: approvalWork.aggregate,
        decisionId: workDecision.id,
        expectedRevision: approvalWork.aggregate.work.revision,
        application: { kind: "plan_deny" },
        deniedState: (after) => after.work.state,
      },
    ];
    for (const subject of subjects) {
      const signalWith = (choice: string, actorSource: ActorSource) =>
        // 런타임 방어 시험: 타입이 막는 choice 값을 우회해 넣는다.
        ({
          type: "human_decision",
          decisionId: subject.decisionId,
          choice,
          signalId: nextEntityId(subject.deps.ids, "signal"),
          expectedRevision: subject.expectedRevision,
          actorSource,
          receivedAt: NOW,
        }) as unknown as DecisionSignal;
      for (const actorSource of NON_HUMAN_AND_HUMAN) {
        const judged = judgeSignal(
          subject.deps,
          subject.aggregate,
          signalWith("approve", actorSource),
          subject.application,
          NOW,
        );
        expect(judged.kind).toBe("not_applicable");
        if (judged.kind !== "not_applicable") continue;
        expect(judged.rejection.reason).toBe("invalid_input");
        expect("commit" in judged).toBe(false);
      }
      const denied = judgeSignal(
        subject.deps,
        subject.aggregate,
        signalWith("deny", "human_local"),
        subject.application,
        NOW,
      );
      expect(denied.kind).toBe("accepted");
      if (denied.kind === "accepted") {
        const workSubject = subject.application.kind === "plan_deny";
        expect(eventTypes(denied.commit)).toContain(
          workSubject ? "work_plan_rejected" : "human_decision_denied",
        );
        expect(subject.deniedState(denied.aggregate)).toBe(workSubject ? "PLANNING" : "REJECTED");
      }
    }
  });
});

describe("SC-006: 취소 명령의 vault 출처는 human_local 이어야 한다", () => {
  it("Error: 비인간 vault 출처의 cancel_work 는 invalid_input 이고 human_local 은 취소되며 종결 Work 는 행 없음이 먼저다 (test_SC006_cancel_work_vault_signal_requires_human_local)", () => {
    const { deps, aggregate } = reachWorkState("ACTIVE");
    const cancelWork = (before: WorkAggregate, actorSource: ActorSource) =>
      executeCommand(deps, before, {
        kind: "cancel_work",
        expectedRevision: before.work.revision,
        meta: meta(NOW),
        origin: vaultCancelOrigin(deps, actorSource),
      });
    const refused = cancelWork(aggregate, "agent_session");
    expect(refused.kind).toBe("rejected");
    if (refused.kind === "rejected") {
      expect(refused.rejection.reason).toBe("invalid_input");
      expect(refused.record).toBeUndefined();
    }
    const canceled = cancelWork(aggregate, "human_local");
    expect(canceled.kind).toBe("committed");
    if (canceled.kind === "committed") {
      expect(eventTypes(canceled.commit)).toContain("work_canceled");
      expect(canceled.aggregate.work.state).toBe("CANCELED");
    }

    const terminal = reachWorkState("CANCELED");
    const terminalOutcome = executeCommand(terminal.deps, terminal.aggregate, {
      kind: "cancel_work",
      expectedRevision: terminal.aggregate.work.revision,
      meta: meta(NOW),
      origin: vaultCancelOrigin(terminal.deps, "agent_session"),
    });
    // 종결 검사가 출처 검사보다 먼저다 — 종결 Work 는 출처와 무관하게 종결 거절이다.
    expect(terminalOutcome.kind).toBe("rejected");
    if (terminalOutcome.kind === "rejected")
      expect(terminalOutcome.rejection.reason).toBe("terminal_subject");
  });

  it("Error: 비인간 vault 출처의 cancel_task 는 invalid_input 이고 human_local 은 취소된다 (test_SC006_cancel_task_vault_signal_requires_human_local)", () => {
    const { deps, aggregate, taskId } = reachTaskState("READY");
    const cancelTask = (actorSource: ActorSource) =>
      executeCommand(deps, aggregate, {
        kind: "cancel_task",
        taskId,
        expectedRevision: requireTaskFor(aggregate, taskId).revision,
        meta: meta(NOW),
        origin: vaultCancelOrigin(deps, actorSource),
      });
    const refused = cancelTask("agent_session");
    expect(refused.kind).toBe("rejected");
    if (refused.kind === "rejected") {
      expect(refused.rejection.reason).toBe("invalid_input");
      expect(refused.record).toBeUndefined();
    }
    const canceled = cancelTask("human_local");
    expect(canceled.kind).toBe("committed");
    if (canceled.kind === "committed") {
      expect(eventTypes(canceled.commit)).toContain("task_canceled");
      expect(requireTaskFor(canceled.aggregate, taskId).state).toBe("CANCELED");
    }
  });
});

describe("SC-006: 비인간 재계획 요청은 provenance_not_human 거절이다", () => {
  it("Error: agent_session 재계획 요청은 파생 키를 실은 signal_rejected 이고 그 기록 뒤 같은 키의 사람 요청은 수용된다 (test_SC006_non_human_replan_requested_rejected)", () => {
    const { deps, aggregate } = reachWorkState("ACTIVE");
    const workId = aggregate.work.id;
    const expectedRevision = aggregate.work.revision;
    const replan = (actorSource: ActorSource): DecisionSignal => ({
      type: "replan_requested",
      workId,
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision,
      actorSource,
      receivedAt: NOW,
    });
    const expectedKey = mustOk(
      deriveSignalDedupKey({ signalType: "replan_requested", workId, expectedRevision }),
    );
    const refused = judgeSignal(deps, aggregate, replan("agent_session"), { kind: "none" }, NOW);
    expect(refused.kind).toBe("rejected");
    if (refused.kind !== "rejected") return;
    expect(refused.reason).toBe("provenance_not_human");
    expect(eventTypes(refused.commit)).toEqual(["signal_rejected"]);
    expect(payloadOf(refused.commit, "signal_rejected")["candidateKey"]).toBe(expectedKey);

    const afterRefusal = evolveCommit(aggregate, refused.commit.events);
    expect(afterRefusal.work.state).toBe("ACTIVE");
    expect(afterRefusal.work.revision).toBe(expectedRevision);
    const accepted = judgeSignal(deps, afterRefusal, replan("human_local"), { kind: "none" }, NOW);
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind === "accepted")
      expect(eventTypes(accepted.commit)).toContain("work_replanning_started");
  });
});
