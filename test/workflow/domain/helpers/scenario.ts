// 재계획·결과 결합 시나리오용 진행 헬퍼 — 명령을 상태별로 진행하고 커밋 이력을 함께 쌓는다.
// 정규 JSON 기대값은 도메인 구현을 쓰지 않는 독립 직렬화기로 계산한다.
import { createHash } from "node:crypto";
import {
  executeCommand,
  judgeSignal,
  nextEntityId,
  deriveOccurrenceId,
} from "../../../../src/workflow/domain/index.js";
import type {
  CommandOutcome,
  DecisionApplication,
  DecisionSignal,
  DomainCommit,
  DomainDeps,
  PlanTaskDraft,
  SignalJudgement,
  TaskCommand,
  TaskId,
  TaskRecord,
  TaskPolicy,
  TriggerSpec,
  UtcInstant,
  WorkAggregate,
} from "../../../../src/workflow/domain/index.js";
import {
  at,
  basePolicy,
  committedChain,
  draft,
  foldCommits,
  meta,
  mustOk,
  plannedWithCommits,
  requireTaskFor,
  taskSubjectPendingDecision,
  RETRYABLE_FIXTURE_CODE,
} from "./fixtures.js";

export const NOW = at("2026-01-01T00:00:00Z");

/** 판정·명령 결과가 상태 변이 커밋을 냈는지 확인하고 커밋·애그리거트를 돌려준다. */
export function committed(outcome: CommandOutcome | SignalJudgement): {
  commit: DomainCommit;
  aggregate: WorkAggregate;
} {
  if (outcome.kind === "committed" || outcome.kind === "accepted")
    return { commit: outcome.commit, aggregate: outcome.aggregate };
  throw new Error(
    `scenario: expected committed/accepted, got ${outcome.kind} ${JSON.stringify(
      "rejection" in outcome ? outcome.rejection : "reason" in outcome ? outcome.reason : "",
    )}`,
  );
}

/** 커밋 이력과 현재 애그리거트를 함께 들고 다니는 진행기 — fold 대조(SC-018)에 쓴다. */
export class Journal {
  readonly deps: DomainDeps;
  aggregate: WorkAggregate;
  readonly commits: DomainCommit[];

  constructor(deps: DomainDeps, aggregate: WorkAggregate, commits: readonly DomainCommit[]) {
    this.deps = deps;
    this.aggregate = aggregate;
    this.commits = [...commits];
  }

  /** 상태 변이 결과면 커밋을 쌓고 애그리거트를 넘긴다. 아니면 던진다. */
  apply(outcome: CommandOutcome | SignalJudgement): DomainCommit {
    const { commit, aggregate } = committed(outcome);
    this.commits.push(commit);
    this.aggregate = aggregate;
    return commit;
  }

  /** 기록 커밋까지 포함해 결과의 커밋 전부를 쌓는다(애그리거트는 바꾸지 않는다). */
  record(outcome: CommandOutcome | SignalJudgement): readonly DomainCommit[] {
    const chain = committedChain(outcome);
    this.commits.push(...chain);
    return chain;
  }

  task(taskId: TaskId): TaskRecord {
    return requireTaskFor(this.aggregate, taskId);
  }

  folded(): WorkAggregate {
    return foldCommits(this.commits);
  }
}

export function startJournal(
  drafts: readonly PlanTaskDraft[],
  deps: DomainDeps,
): { journal: Journal; ids: Record<string, TaskId> } {
  const { aggregate, taskIds, commits } = plannedWithCommits(drafts, deps);
  return { journal: new Journal(deps, aggregate, commits), ids: taskIds };
}

type SimpleTaskCommandKind =
  "begin_validation" | "complete_validation" | "retry_ready" | "unblock" | "expire";

/** Task 명령 — `expectedRevision`·`meta` 를 현재 레코드에서 채운다. */
export function taskCommand(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  taskId: TaskId,
  command:
    | { readonly kind: SimpleTaskCommandKind }
    | DistributiveOmit<TaskCommand, "taskId" | "expectedRevision" | "meta">,
): CommandOutcome {
  return executeCommand(deps, aggregate, {
    ...command,
    taskId,
    expectedRevision: requireTaskFor(aggregate, taskId).revision,
    meta: meta(NOW),
  } as TaskCommand);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** DRAFT·VALIDATING 에서 READY(또는 검증 출구)까지 진행한다. */
export function validate(journal: Journal, taskId: TaskId): void {
  if (journal.task(taskId).state === "DRAFT")
    journal.apply(
      taskCommand(journal.deps, journal.aggregate, taskId, { kind: "begin_validation" }),
    );
  if (journal.task(taskId).state === "VALIDATING")
    journal.apply(
      taskCommand(journal.deps, journal.aggregate, taskId, { kind: "complete_validation" }),
    );
}

export function start(journal: Journal, taskId: TaskId): DomainCommit {
  return journal.apply(
    taskCommand(journal.deps, journal.aggregate, taskId, { kind: "start_attempt" }),
  );
}

function openAttemptId(journal: Journal, taskId: TaskId) {
  const attemptId = journal.task(taskId).openAttempt?.attemptId;
  if (attemptId === undefined) throw new Error(`scenario: ${taskId} has no open attempt`);
  return attemptId;
}

/** 열린 attempt 를 완료로 기록한다. */
export function complete(journal: Journal, taskId: TaskId, outputs?: unknown): DomainCommit {
  return journal.apply(
    taskCommand(journal.deps, journal.aggregate, taskId, {
      kind: "record_attempt_outcome",
      attemptId: openAttemptId(journal, taskId),
      outcome: {
        kind: "completed",
        evidence: {},
        ...(outputs !== undefined ? { outputs } : {}),
      },
    }),
  );
}

/** 열린 attempt 를 실패로 기록한다(기본 코드는 재시도 가능 코드). */
export function fail(
  journal: Journal,
  taskId: TaskId,
  code = RETRYABLE_FIXTURE_CODE,
): DomainCommit {
  return journal.apply(
    taskCommand(journal.deps, journal.aggregate, taskId, {
      kind: "record_attempt_outcome",
      attemptId: openAttemptId(journal, taskId),
      outcome: { kind: "failed", code },
    }),
  );
}

/** 검증부터 완료까지(즉시 Trigger). */
export function runToCompleted(journal: Journal, taskId: TaskId, outputs?: unknown): DomainCommit {
  validate(journal, taskId);
  start(journal, taskId);
  return complete(journal, taskId, outputs);
}

/** 무인 적격 거절 결정으로 BLOCKED_AWAITING_HUMAN 에 주차한다(READY 에서). */
export function park(journal: Journal, taskId: TaskId): DomainCommit {
  return journal.apply(
    taskCommand(journal.deps, journal.aggregate, taskId, {
      kind: "park_awaiting_human",
      cause: "unattended_eligibility_refused",
      decision: taskSubjectPendingDecision(journal.deps, taskId, NOW),
    }),
  );
}

export function skip(journal: Journal, taskId: TaskId): DomainCommit {
  return journal.apply(
    taskCommand(journal.deps, journal.aggregate, taskId, {
      kind: "skip_task",
      reason: { kind: "misfire_skip" },
    }),
  );
}

/** 확인 대기 진입(READY 에서). */
export function beginConfirmation(journal: Journal, taskId: TaskId): DomainCommit {
  return journal.apply(
    taskCommand(journal.deps, journal.aggregate, taskId, {
      kind: "begin_confirmation_wait",
      confirmationId: nextEntityId(journal.deps.ids, "confirmation"),
    }),
  );
}

/** 확인 Task 결정 신호. */
export function confirmationSignal(
  journal: Journal,
  taskId: TaskId,
  decision: "accept" | "reject" | "cancel",
  receivedAt: UtcInstant = NOW,
): SignalJudgement {
  const task = journal.task(taskId);
  const confirmationId = task.confirmationId;
  if (confirmationId === undefined) throw new Error(`scenario: ${taskId} has no confirmation`);
  const signal: DecisionSignal = {
    type: "confirmation_decision",
    taskId,
    confirmationId,
    decision,
    signalId: nextEntityId(journal.deps.ids, "signal"),
    expectedRevision: task.revision,
    actorSource: "human_local",
    receivedAt,
  };
  return judgeSignal(journal.deps, journal.aggregate, signal, { kind: "none" }, receivedAt);
}

/** Task 주체 대기 결정에 사람 grant(READY 로 재개). */
export function grantTaskDecision(journal: Journal, taskId: TaskId): SignalJudgement {
  const task = journal.task(taskId);
  const decisionId = task.pendingDecision?.id;
  if (decisionId === undefined) throw new Error(`scenario: ${taskId} has no pending decision`);
  const application: DecisionApplication = { kind: "task_grant", resume: { to: "READY" } };
  return judgeSignal(
    journal.deps,
    journal.aggregate,
    {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: nextEntityId(journal.deps.ids, "signal"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    },
    application,
    NOW,
  );
}

/** Work 에 재계획 요청 신호(기본 사람 출처·현재 revision). */
export function replanSignal(
  journal: Journal,
  options: { actorSource?: "human_local" | "adde_self"; expectedRevision?: number } = {},
): SignalJudgement {
  return judgeSignal(
    journal.deps,
    journal.aggregate,
    {
      type: "replan_requested",
      workId: journal.aggregate.work.id,
      signalId: nextEntityId(journal.deps.ids, "signal"),
      expectedRevision: options.expectedRevision ?? journal.aggregate.work.revision,
      actorSource: options.actorSource ?? "human_local",
      receivedAt: NOW,
    },
    { kind: "none" },
    NOW,
  );
}

/** 대기 계획 결정에 grant/deny. */
export function planDecision(
  journal: Journal,
  choice: "grant" | "deny",
  options: { actorSource?: "human_local" | "adde_self"; expectedRevision?: number } = {},
): SignalJudgement {
  const decisionId = journal.aggregate.work.pendingDecision?.id;
  if (decisionId === undefined) throw new Error("scenario: no pending plan decision");
  return judgeSignal(
    journal.deps,
    journal.aggregate,
    {
      type: "human_decision",
      decisionId,
      choice,
      signalId: nextEntityId(journal.deps.ids, "signal"),
      expectedRevision: options.expectedRevision ?? journal.aggregate.work.revision,
      actorSource: options.actorSource ?? "human_local",
      receivedAt: NOW,
    },
    choice === "grant" ? { kind: "plan_grant" } : { kind: "plan_deny" },
    NOW,
  );
}

// ---- 초안 ------------------------------------------------------------------

export const CONFIRMATION_TYPE = { id: "confirmation", version: 1 } as const;
export const AGENT_GOAL_TYPE = { id: "agent_goal", version: 1 } as const;
export const NOTIFICATION_TYPE = { id: "notification", version: 1 } as const;

export const CONFIRMATION_INPUT = {
  prompt: "Proceed?",
  targetActor: { kind: "user", id: "u1" },
  allowedDecisions: ["accept", "reject"],
} as const;

export const AGENT_GOAL_INPUT = {
  goal: "Summarize the findings",
  projectId: "prj_fixture",
  category: "analysis",
  completionEvidence: "A summary is reported",
  sessionSelection: "default",
} as const;

export function confirmationDraft(ref: string, overrides?: Partial<PlanTaskDraft>): PlanTaskDraft {
  return draft(ref, { type: CONFIRMATION_TYPE, input: CONFIRMATION_INPUT, ...overrides });
}

export function agentGoalDraft(
  ref: string,
  input: Record<string, unknown> = {},
  overrides?: Partial<PlanTaskDraft>,
): PlanTaskDraft {
  return draft(ref, {
    type: AGENT_GOAL_TYPE,
    input: { ...AGENT_GOAL_INPUT, ...input },
    ...overrides,
  });
}

export function nonRequiredPolicy(overrides?: Partial<TaskPolicy>): TaskPolicy {
  return basePolicy({ terminalRequired: false, ...overrides });
}

export function dependencyTrigger(ref: string): TriggerSpec {
  return { kind: "dependencies_complete", version: 1, triggerId: ref };
}

export function atTrigger(
  ref: string,
  misfire:
    { kind: "fire_once_now" } | { kind: "skip" } | { kind: "catch_up_bounded"; maxCatchUp: number },
  scheduledForUtc = "2026-01-01T01:00:00Z",
): TriggerSpec {
  return {
    kind: "at",
    version: 1,
    triggerId: ref,
    scheduledForUtc: at(scheduledForUtc),
    timezone: "Asia/Seoul",
    expressionText: `fixture-at-${ref}`,
    misfire,
  } as TriggerSpec;
}

/** 예약 Trigger 의 첫 occurrence 로 SCHEDULED 에 둔다(READY 에서). */
export function scheduleAt(journal: Journal, taskId: TaskId): DomainCommit {
  const task = journal.task(taskId);
  const trigger = task.trigger as unknown as { scheduledForUtc: UtcInstant };
  const occurrenceId = mustOk(
    deriveOccurrenceId({
      kind: "schedule",
      ownerId: taskId,
      triggerId: task.trigger.triggerId,
      scheduledForUtc: trigger.scheduledForUtc,
      recurrenceIndex: 0,
    }),
  );
  return journal.apply(
    taskCommand(journal.deps, journal.aggregate, taskId, {
      kind: "schedule_task",
      occurrenceId,
      cause: "schedule",
    }),
  );
}

// ---- 독립 정규 JSON --------------------------------------------------------

/** 재귀 키 정렬 + JSON.stringify — 객체의 undefined 값 속성은 생략한다(도메인 구현을 쓰지 않는다). */
export function independentCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => independentCanonicalJson(v)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${independentCanonicalJson(record[k])}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function independentDigest(value: unknown): string {
  return sha256Hex(independentCanonicalJson(value));
}

/** 이 커밋에서 해당 Task 를 대상으로 한 이벤트 `type` 목록. */
export function taskEventTypes(commit: DomainCommit, taskId: TaskId): string[] {
  return commit.events.filter((e) => e.taskId === taskId).map((e) => e.type);
}

/** 커밋에서 해당 Task 의 첫 `type` 이벤트 payload. */
export function taskPayload(
  commit: DomainCommit,
  taskId: TaskId,
  type: string,
): Record<string, unknown> {
  const event = commit.events.find((e) => e.type === type && e.taskId === taskId);
  if (event === undefined)
    throw new Error(
      `expected "${type}" for ${taskId}, got [${commit.events.map((e) => `${e.type}@${e.taskId ?? "work"}`).join(", ")}]`,
    );
  return event.payload as unknown as Record<string, unknown>;
}
