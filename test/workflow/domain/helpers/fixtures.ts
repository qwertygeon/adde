// 도메인 테스트 공용 픽스처. 공개 배럴만 import 한다 — 개별 모듈 경로는 참조하지 않는다.
import {
  parseUtcInstant,
  parseProjectId,
  parseEntityId,
  parseTaskPolicy,
  parsePendingDecision,
  parseCancelOrigin,
  createWork,
  executeCommand,
  judgeSignal,
  foldEvents,
  evolveCommit,
  nextEntityId,
  deriveOccurrenceId,
  taskOf,
  PENDING_DECISION_KINDS,
  ENTITY_ID_PREFIXES,
} from "../../../../src/workflow/domain/index.js";
import type {
  Result,
  DomainDeps,
  IdGenerator,
  GeneratedIdKind,
  EntityIdKind,
  EntityId,
  ProjectId,
  UtcInstant,
  CommandMeta,
  ActorSource,
  TaskPolicy,
  PlanTaskDraft,
  WorkAggregate,
  TaskId,
  TaskStateName,
  WorkStateName,
  TriggerSpec,
  CommandOutcome,
  SignalJudgement,
  DomainCommit,
  TaskRecord,
  WorkSource,
  PendingDecision,
  PendingDecisionKind,
  DecisionSignal,
  DecisionApplication,
  DomainRegistries,
  AttemptId,
  PlanProposalInput,
  PlanProposalSource,
  WorkRecord,
} from "../../../../src/workflow/domain/index.js";
import { testRegistries, fixtureRegistries, probeTaskType } from "./registry-fixtures.js";

/** Result 언랩 — 실패면 던진다(픽스처 불변식 위반은 프로그램 오류로 취급). */
export function mustOk<T, E>(result: Result<T, E>): T {
  if (!result.ok)
    throw new Error(`fixture: expected ok, got error ${JSON.stringify(result.error)}`);
  return result.value;
}

function requireTask(aggregate: WorkAggregate, taskId: TaskId): TaskRecord {
  const record = taskOf(aggregate, taskId);
  if (record === undefined) throw new Error(`fixture: task ${taskId} not found in aggregate`);
  return record;
}

/** row-cases.ts 등 외부 헬퍼에서 재사용하는 공개 별칭. */
export const requireTaskFor = requireTask;

/**
 * 브랜드 ID 리터럴 구성 — `as` 강제 캐스트 대신 실제 파싱 함수(`parseEntityId`)로 형식을 검증하며 만든다.
 * 고정 테스트 리터럴(`"sig_x1"` 등)에 브랜드를 씌울 때 이 헬퍼를 통해서만 만든다.
 */
export function entityId<K extends EntityIdKind>(kind: K, raw: string): EntityId<K> {
  return mustOk(parseEntityId(kind, raw));
}

/** `control_request` 출처 취소 — `control_request` kind 는 `actorSource` 가 항상 `"unknown"` 이어야 한다(design.md `values.ts` 주석). */
export function controlRequestCancelOrigin(deps: DomainDeps) {
  return mustOk(
    parseCancelOrigin({
      kind: "control_request",
      actorSource: "unknown",
      controlRequestId: nextEntityId(deps.ids, "controlRequest"),
    }),
  );
}

/** `${prefix}${seed}${n 을 6자리 0 채움}` — seed 는 영숫자, n 은 호출마다 1씩 증가하는 전역 카운터. */
export function makeSeqIds(seed: string): IdGenerator {
  const prefixes: Record<GeneratedIdKind, string> = {
    work: "wrk_",
    workDefinition: "wdf_",
    planProposal: "pln_",
    task: "tsk_",
    result: "res_",
    reaction: "rct_",
    signal: "sig_",
    event: "evt_",
    attempt: "att_",
    confirmation: "cfm_",
    decision: "dec_",
    dispatch: "dsp_",
    controlRequest: "ctl_",
    commit: "cmt_",
  };
  let counter = 0;
  return {
    next(kind: GeneratedIdKind): string {
      counter += 1;
      const n = String(counter).padStart(6, "0");
      return `${prefixes[kind]}${seed}${n}`;
    },
  };
}

export function at(iso: string): UtcInstant {
  return mustOk(parseUtcInstant(iso));
}

export function testDeps(seed = "seed", registries?: DomainRegistries): DomainDeps {
  return {
    ids: makeSeqIds(seed),
    operationalDefaults: { agentDispatchDeadlineMs: 600_000, resultInlineMaxBytes: 65_536 },
    registries: registries ?? testRegistries(),
    redactOutputs: (outputs) => outputs,
  };
}

/**
 * 레코드 패치 — 같은 등록부로는 계획 커밋이 막는 출구(미등록 유형·구조 무효 입력)를 Task 수준에서
 * 재현한다. 계약상 다른 생성 경로나 등록부 drift 를 대신하는 테스트 전용 구성이다.
 */
export function patchTask(
  aggregate: WorkAggregate,
  taskId: TaskId,
  patch: Partial<TaskRecord>,
): WorkAggregate {
  const record = requireTask(aggregate, taskId);
  return { ...aggregate, tasks: { ...aggregate.tasks, [taskId]: { ...record, ...patch } } };
}

/** 미등록 TaskType 식별(등록하지 않는 시험 유형). */
export const UNREGISTERED_TASK_TYPE = { id: "probe_missing", version: 1 } as const;

/** 생성 경로가 없는 구조 무효 입력(generic_task 의 strict 스키마 밖). */
export const STRUCTURALLY_INVALID_INPUT = "not-an-object";

export function meta(now: UtcInstant, actorSource: ActorSource = "adde_self"): CommandMeta {
  return { now, actorSource };
}

/** basePolicy 의 `retry.retryableErrors` 에 들어 있는 오류 코드. */
export const RETRYABLE_FIXTURE_CODE = "fixture_retryable";

export function basePolicy(overrides?: Partial<TaskPolicy>): TaskPolicy {
  const raw = {
    policyVersion: 1,
    terminalRequired: true,
    onDependencyUnsatisfied: "block",
    approvalRequiredBeforeExecute: false,
    approvalSurface: "markdown",
    fanOutMaxConcurrent: 1,
    unattended: { eligible: false, onGateDenied: "block_awaiting_human" },
    retry: {
      maxAttempts: 3,
      initialDelayMs: 1_000,
      maxDelayMs: 60_000,
      backoff: "fixed",
      retryableErrors: [RETRYABLE_FIXTURE_CODE],
    },
    timezone: "Asia/Seoul",
    maxSpawnDepth: 1,
    maxTasksPerWork: 50,
    maxWorksPerChain: 10,
    ...overrides,
  };
  return mustOk(parseTaskPolicy(raw));
}

export function draft(ref: string, overrides?: Partial<PlanTaskDraft>): PlanTaskDraft {
  return {
    draftRef: ref,
    type: { id: "generic_task", version: 1 },
    title: ref,
    input: {},
    dependsOn: [],
    trigger: { kind: "immediate", version: 1, triggerId: ref },
    policy: basePolicy(),
    ...overrides,
  };
}

/** 계약이 허용하는 임의의 taskId-subject PendingDecision.kind — 리터럴 추측 대신 전사 데이터에서 고른다. */
function taskSubjectPendingDecisionKind(): PendingDecisionKind {
  const excluded = new Set([
    "plan_approval_required",
    "destructive_control_operation",
    "dead_letter_resolution_required",
  ]);
  const found = (PENDING_DECISION_KINDS as readonly string[]).find((k) => !excluded.has(k));
  if (found === undefined)
    throw new Error("fixture: no task-subject PendingDecision.kind found in contract data");
  return found as PendingDecisionKind;
}

export function taskSubjectPendingDecision(
  deps: DomainDeps,
  taskId: TaskId,
  now: UtcInstant,
): PendingDecision {
  return mustOk(
    parsePendingDecision({
      id: nextEntityId(deps.ids, "decision"),
      kind: taskSubjectPendingDecisionKind(),
      taskId,
      requestedAt: now,
      summary: "fixture pending decision",
      surfaceDeliveries: [],
    }),
  );
}

/** 열린 attempt 효과의 dead-letter 해소 결정 — Task 주체(taskId). */
export function deadLetterDecision(
  deps: DomainDeps,
  taskId: TaskId,
  now: UtcInstant,
): PendingDecision {
  return mustOk(
    parsePendingDecision({
      id: nextEntityId(deps.ids, "decision"),
      kind: "dead_letter_resolution_required",
      taskId,
      requestedAt: now,
      summary: "fixture dead-letter resolution",
      surfaceDeliveries: [],
    }),
  );
}

/** 대기 효과·전이 반응 행을 주체 문자열로 가리키는 dead-letter 해소 결정 — Task 를 주차하지 않는 형태. */
export function rowSubjectDeadLetterDecision(
  deps: DomainDeps,
  subject: string,
  now: UtcInstant,
): PendingDecision {
  return mustOk(
    parsePendingDecision({
      id: nextEntityId(deps.ids, "decision"),
      kind: "dead_letter_resolution_required",
      subject,
      requestedAt: now,
      summary: "fixture row dead-letter resolution",
      surfaceDeliveries: [],
    }),
  );
}

/**
 * 재시도 예산 1 의 실행 중 Task 가 dispatch 고아로 끝나 dead-letter 결정에 주차된 상태 —
 * `parkedAttemptId` 가 그 attempt 다.
 */
export function reachDeadLetterParked(): {
  deps: DomainDeps;
  aggregate: WorkAggregate;
  taskId: TaskId;
  attemptId: AttemptId;
} {
  const { deps, aggregate, taskId } = reachTaskState("RUNNING", {
    policy: {
      retry: { maxAttempts: 1, initialDelayMs: 1_000, maxDelayMs: 1_000, backoff: "fixed" },
    },
  });
  const attemptId = requireTask(aggregate, taskId).openAttempt?.attemptId;
  if (attemptId === undefined) throw new Error("fixture: expected open attempt");
  const parked = mustCommit(
    executeCommand(deps, aggregate, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: requireTask(aggregate, taskId).revision,
      meta: meta(FIXTURE_NOW),
      attemptId,
      outcome: {
        kind: "dispatch_orphaned",
        deadLetterDecision: deadLetterDecision(deps, taskId, FIXTURE_NOW),
      },
    }),
  ).aggregate;
  if (requireTask(parked, taskId).state !== "BLOCKED_AWAITING_HUMAN")
    throw new Error("fixture: expected dead-letter park");
  return { deps, aggregate: parked, taskId, attemptId };
}

export function mustCommit(outcome: CommandOutcome | SignalJudgement): {
  commit: DomainCommit;
  aggregate: WorkAggregate;
} {
  if (outcome.kind === "committed" || outcome.kind === "accepted") {
    return { commit: outcome.commit, aggregate: outcome.aggregate };
  }
  throw new Error(`fixture: expected committed/accepted outcome, got ${outcome.kind}`);
}

export function foldCommits(commits: readonly DomainCommit[]): WorkAggregate {
  const folded = foldEvents(commits.flatMap((c) => c.events));
  if (!folded.ok) throw new Error(`fixture: fold failed — ${JSON.stringify(folded.error)}`);
  return folded.value;
}

const FIXTURE_NOW = at("2026-01-01T00:00:00Z");

/**
 * `deps.ids`(주입된 생성기) 에서 project id 를 파생한다 — 계약 "Identifier scheme" 은 `projectId` 를
 * 생성형 ID 종류에 포함하지 않지만(파일시스템 경로·표시 이름에서 만들지 않을 뿐 별도 포트가 없음),
 * 픽스처는 모듈 전역 카운터 대신 주입된 생성기의 카운터를 재사용해 SC-002 의 "같은 시드 → 같은 결과"를
 * 지킨다(전역 상태를 쓰면 두 번째 `planned()` 호출이 첫 호출의 카운터를 이어받아 어긋난다).
 */
function nextProjectId(deps: DomainDeps): ProjectId {
  const raw = deps.ids.next("work");
  const body = raw.slice(ENTITY_ID_PREFIXES.work.length);
  return mustOk(parseProjectId(`prj_${body}`));
}

function plannedInternal(
  drafts: readonly PlanTaskDraft[],
  deps: DomainDeps,
): {
  deps: DomainDeps;
  aggregate: WorkAggregate;
  taskIds: Record<string, TaskId>;
  commits: readonly DomainCommit[];
} {
  // WorkSource 의 정확한 필드는 계약 "Work definition and occurrence contract" 소관 — cli 변형은
  // design.md 가 kind 판별만 요구한다(정의 occurrence 는 셋째 차수). 픽스처 용도로 최소 형태만 구성.
  const source = { kind: "cli" } as unknown as WorkSource;
  const createdOutcome = mustCommit(
    createWork(deps, {
      kind: "create_work",
      meta: meta(FIXTURE_NOW),
      projectId: nextProjectId(deps),
      title: "fixture work",
      objective: "fixture objective",
      source,
    }),
  );
  const planningOutcome = mustCommit(
    executeCommand(deps, createdOutcome.aggregate, {
      kind: "start_planning",
      expectedRevision: createdOutcome.aggregate.work.revision,
      meta: meta(FIXTURE_NOW),
    }),
  );
  const committedOutcome = mustCommit(
    executeCommand(deps, planningOutcome.aggregate, {
      kind: "commit_plan",
      expectedRevision: planningOutcome.aggregate.work.revision,
      meta: meta(FIXTURE_NOW),
      plan: {
        basePlanRevision: planningOutcome.aggregate.work.planRevision,
        source: "planner",
        tasks: drafts,
        retain: [],
      },
    }),
  );
  const committed = committedOutcome.aggregate;
  const taskIds: Record<string, TaskId> = {};
  for (const d of drafts) {
    const record = Object.values(committed.tasks).find((t) => t.draftRef === d.draftRef);
    if (record === undefined)
      throw new Error(`fixture: draft ${d.draftRef} was not committed as a task`);
    taskIds[d.draftRef] = record.id;
  }
  return {
    deps,
    aggregate: committed,
    taskIds,
    commits: [createdOutcome.commit, planningOutcome.commit, committedOutcome.commit],
  };
}

export function planned(
  drafts: readonly PlanTaskDraft[],
  deps: DomainDeps = testDeps(),
): { deps: DomainDeps; aggregate: WorkAggregate; taskIds: Record<string, TaskId> } {
  const { deps: resultDeps, aggregate, taskIds } = plannedInternal(drafts, deps);
  return { deps: resultDeps, aggregate, taskIds };
}

/**
 * `planned()` 과 동일한 구성이되, 구성에 쓰인 모든 커밋(work_created 부터)도 함께 반환한다 —
 * `foldEvents` 로 전체 스트림 이력을 재현해야 하는 케이스(SC-030·SC-046, `foldEvents` 는 스트림
 * 첫 이벤트가 `work_created` 여야 한다)가 마지막 커밋만으로 fold 해 실패하는 것을 막는다.
 * `planned()` 의 기존 반환 계약(3필드)은 바꾸지 않고 별도 함수로 추가한다.
 */
export function plannedWithCommits(
  drafts: readonly PlanTaskDraft[],
  deps: DomainDeps = testDeps(),
): {
  deps: DomainDeps;
  aggregate: WorkAggregate;
  taskIds: Record<string, TaskId>;
  commits: readonly DomainCommit[];
} {
  return plannedInternal(drafts, deps);
}

export function reachTaskState(
  state: TaskStateName,
  opts: { policy?: Partial<TaskPolicy>; trigger?: TriggerSpec } = {},
): { deps: DomainDeps; aggregate: WorkAggregate; taskId: TaskId } {
  const ref = "fixture_task";
  const policyOverrides: Partial<TaskPolicy> =
    state === "EXPIRED" && opts.policy?.expiresAt === undefined
      ? { ...opts.policy, expiresAt: at("2026-01-01T00:05:00Z") }
      : { ...opts.policy };
  const policy = basePolicy(policyOverrides);
  const trigger: TriggerSpec =
    opts.trigger ??
    (state === "SCHEDULED"
      ? {
          kind: "at",
          version: 1,
          triggerId: ref,
          scheduledForUtc: at("2026-01-01T01:00:00Z"),
          timezone: "Asia/Seoul",
          expressionText: "fixture-at",
          misfire: { kind: "skip" },
        }
      : { kind: "immediate", version: 1, triggerId: ref });

  // WAITING_INPUT 은 필수 입력이 빠진 유형으로 계획한다 — 누락 입력은 계획 무효가 아니다.
  const draftType =
    state === "WAITING_INPUT"
      ? { id: probeTaskType().id, version: probeTaskType().version }
      : undefined;
  const {
    deps,
    aggregate: draftAgg,
    taskIds,
  } = planned(
    [draft(ref, { trigger, policy, ...(draftType !== undefined ? { type: draftType } : {}) })],
    testDeps("seed", fixtureRegistries()),
  );
  const taskId = taskIds[ref];
  if (taskId === undefined) throw new Error("fixture: draft task id missing");
  if (state === "DRAFT") return { deps, aggregate: draftAgg, taskId };

  const now = FIXTURE_NOW;
  const validating = mustCommit(
    executeCommand(deps, draftAgg, {
      kind: "begin_validation",
      taskId,
      expectedRevision: requireTask(draftAgg, taskId).revision,
      meta: meta(now),
    }),
  ).aggregate;
  if (state === "VALIDATING") return { deps, aggregate: validating, taskId };

  const completeValidation = (from: WorkAggregate): WorkAggregate =>
    mustCommit(
      executeCommand(deps, from, {
        kind: "complete_validation",
        taskId,
        expectedRevision: requireTask(from, taskId).revision,
        meta: meta(now),
      }),
    ).aggregate;

  if (state === "WAITING_INPUT") return { deps, aggregate: completeValidation(validating), taskId };
  if (state === "FAILED") {
    // 레코드 패치: 계획 커밋이 막는 구조 무효 입력을 다른 생성 경로 대용으로 재현한다.
    const patched = patchTask(validating, taskId, { input: STRUCTURALLY_INVALID_INPUT });
    return { deps, aggregate: completeValidation(patched), taskId };
  }
  if (state === "BLOCKED") {
    // 레코드 패치: 검증 전 등록부 drift(유형 미등록) 대용.
    const patched = patchTask(validating, taskId, { type: UNREGISTERED_TASK_TYPE });
    return { deps, aggregate: completeValidation(patched), taskId };
  }

  const ready = completeValidation(validating);
  if (state === "READY") return { deps, aggregate: ready, taskId };

  if (state === "SCHEDULED") {
    const scheduledForUtc = trigger.kind === "at" ? trigger.scheduledForUtc : now;
    const occ = mustOk(
      deriveOccurrenceId({
        kind: "schedule",
        ownerId: taskId,
        triggerId: trigger.triggerId,
        scheduledForUtc,
        recurrenceIndex: 0,
      }),
    );
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, ready, {
          kind: "schedule_task",
          taskId,
          expectedRevision: requireTask(ready, taskId).revision,
          meta: meta(now),
          occurrenceId: occ,
          cause: "schedule",
        }),
      ).aggregate,
      taskId,
    };
  }

  if (state === "RUNNING") {
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, ready, {
          kind: "start_attempt",
          taskId,
          expectedRevision: requireTask(ready, taskId).revision,
          meta: meta(now),
        }),
      ).aggregate,
      taskId,
    };
  }

  if (state === "WAITING_CONFIRMATION") {
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, ready, {
          kind: "begin_confirmation_wait",
          taskId,
          expectedRevision: requireTask(ready, taskId).revision,
          meta: meta(now),
          confirmationId: nextEntityId(deps.ids, "confirmation"),
        }),
      ).aggregate,
      taskId,
    };
  }

  if (state === "BLOCKED_AWAITING_HUMAN") {
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, ready, {
          kind: "park_awaiting_human",
          taskId,
          expectedRevision: requireTask(ready, taskId).revision,
          meta: meta(now),
          cause: "unattended_eligibility_refused",
          decision: taskSubjectPendingDecision(deps, taskId, now),
        }),
      ).aggregate,
      taskId,
    };
  }

  if (state === "CANCELED") {
    const origin = mustOk(
      parseCancelOrigin({
        kind: "control_request",
        actorSource: "unknown",
        controlRequestId: nextEntityId(deps.ids, "controlRequest"),
      }),
    );
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, ready, {
          kind: "cancel_task",
          taskId,
          expectedRevision: requireTask(ready, taskId).revision,
          meta: meta(now),
          origin,
        }),
      ).aggregate,
      taskId,
    };
  }

  if (state === "SKIPPED") {
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, ready, {
          kind: "skip_task",
          taskId,
          expectedRevision: requireTask(ready, taskId).revision,
          meta: meta(now),
          reason: { kind: "misfire_skip" },
        }),
      ).aggregate,
      taskId,
    };
  }

  if (state === "EXPIRED") {
    const expiresAt = policy.expiresAt;
    if (expiresAt === undefined) throw new Error("fixture: EXPIRED path requires policy.expiresAt");
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, ready, {
          kind: "expire",
          taskId,
          expectedRevision: requireTask(ready, taskId).revision,
          meta: meta(at("2026-01-01T00:10:00Z")),
        }),
      ).aggregate,
      taskId,
    };
  }

  const running = mustCommit(
    executeCommand(deps, ready, {
      kind: "start_attempt",
      taskId,
      expectedRevision: requireTask(ready, taskId).revision,
      meta: meta(now),
    }),
  ).aggregate;

  if (state === "COMPLETED") {
    const openAttempt = requireTask(running, taskId).openAttempt;
    if (openAttempt === undefined) throw new Error("fixture: expected open attempt");
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, running, {
          kind: "record_attempt_outcome",
          taskId,
          expectedRevision: requireTask(running, taskId).revision,
          meta: meta(now),
          attemptId: openAttempt.attemptId,
          outcome: { kind: "completed", evidence: {} },
        }),
      ).aggregate,
      taskId,
    };
  }

  if (state === "RETRY_WAIT") {
    const openAttempt = requireTask(running, taskId).openAttempt;
    if (openAttempt === undefined) throw new Error("fixture: expected open attempt");
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, running, {
          kind: "record_attempt_outcome",
          taskId,
          expectedRevision: requireTask(running, taskId).revision,
          meta: meta(now),
          attemptId: openAttempt.attemptId,
          outcome: { kind: "failed", code: RETRYABLE_FIXTURE_CODE },
        }),
      ).aggregate,
      taskId,
    };
  }

  if (state === "REJECTED") {
    const confirmationId = nextEntityId(deps.ids, "confirmation");
    const waiting = mustCommit(
      executeCommand(deps, ready, {
        kind: "begin_confirmation_wait",
        taskId,
        expectedRevision: requireTask(ready, taskId).revision,
        meta: meta(now),
        confirmationId,
      }),
    ).aggregate;
    const signal: DecisionSignal = {
      type: "confirmation_decision",
      taskId,
      confirmationId,
      decision: "reject",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: requireTask(waiting, taskId).revision,
      actorSource: "human_local",
      receivedAt: now,
    };
    const application: DecisionApplication = { kind: "none" };
    const judgement = judgeSignal(deps, waiting, signal, application, now);
    return { deps, aggregate: mustCommit(judgement).aggregate, taskId };
  }

  throw new Error(`fixture: unsupported task state ${String(state)}`);
}

export function reachWorkState(state: WorkStateName): {
  deps: DomainDeps;
  aggregate: WorkAggregate;
} {
  const deps = testDeps("work");
  const now = FIXTURE_NOW;
  const source = { kind: "cli" } as unknown as WorkSource;
  const created = mustCommit(
    createWork(deps, {
      kind: "create_work",
      meta: meta(now),
      projectId: nextProjectId(deps),
      title: "fixture work",
      objective: "fixture objective",
      source,
    }),
  ).aggregate;
  if (state === "DRAFT") return { deps, aggregate: created };

  const planningAgg = mustCommit(
    executeCommand(deps, created, {
      kind: "start_planning",
      expectedRevision: created.work.revision,
      meta: meta(now),
    }),
  ).aggregate;
  if (state === "PLANNING") return { deps, aggregate: planningAgg };

  if (state === "WAITING_INPUT") {
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, planningAgg, {
          kind: "request_work_input",
          expectedRevision: planningAgg.work.revision,
          meta: meta(now),
          requests: [],
        }),
      ).aggregate,
    };
  }

  if (state === "WAITING_APPROVAL") {
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, planningAgg, {
          kind: "propose_plan",
          expectedRevision: planningAgg.work.revision,
          meta: meta(now),
          plan: {
            basePlanRevision: planningAgg.work.planRevision,
            source: "planner",
            tasks: [draft("fixture_member")],
            retain: [],
          },
          summary: "fixture plan approval",
        }),
      ).aggregate,
    };
  }

  if (state === "FAILED") {
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, planningAgg, {
          kind: "fail_planning",
          expectedRevision: planningAgg.work.revision,
          meta: meta(now),
        }),
      ).aggregate,
    };
  }

  if (state === "CANCELED") {
    const origin = mustOk(
      parseCancelOrigin({
        kind: "control_request",
        actorSource: "unknown",
        controlRequestId: nextEntityId(deps.ids, "controlRequest"),
      }),
    );
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, planningAgg, {
          kind: "cancel_work",
          expectedRevision: planningAgg.work.revision,
          meta: meta(now),
          origin,
        }),
      ).aggregate,
    };
  }

  const { aggregate: readyAgg } = planned([draft("fixture_member")], deps);
  if (state === "READY") return { deps, aggregate: readyAgg };

  const memberTaskId = (Object.values(readyAgg.tasks)[0] as TaskRecord | undefined)?.id;
  if (memberTaskId === undefined) throw new Error("fixture: no member task committed");

  const validating = mustCommit(
    executeCommand(deps, readyAgg, {
      kind: "begin_validation",
      taskId: memberTaskId,
      expectedRevision: requireTask(readyAgg, memberTaskId).revision,
      meta: meta(now),
    }),
  ).aggregate;

  if (state === "BLOCKED") {
    // 레코드 패치: 구조 무효 입력으로 member 를 FAILED 종결시켜 Work 를 BLOCKED 로 파생한다.
    const patched = patchTask(validating, memberTaskId, { input: STRUCTURALLY_INVALID_INPUT });
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, patched, {
          kind: "complete_validation",
          taskId: memberTaskId,
          expectedRevision: requireTask(patched, memberTaskId).revision,
          meta: meta(now),
        }),
      ).aggregate,
    };
  }

  const memberReady = mustCommit(
    executeCommand(deps, validating, {
      kind: "complete_validation",
      taskId: memberTaskId,
      expectedRevision: requireTask(validating, memberTaskId).revision,
      meta: meta(now),
    }),
  ).aggregate;
  if (state === "ACTIVE") return { deps, aggregate: memberReady };

  if (state === "COMPLETED") {
    const running = mustCommit(
      executeCommand(deps, memberReady, {
        kind: "start_attempt",
        taskId: memberTaskId,
        expectedRevision: requireTask(memberReady, memberTaskId).revision,
        meta: meta(now),
      }),
    ).aggregate;
    const openAttempt = requireTask(running, memberTaskId).openAttempt;
    if (openAttempt === undefined) throw new Error("fixture: expected open attempt");
    return {
      deps,
      aggregate: mustCommit(
        executeCommand(deps, running, {
          kind: "record_attempt_outcome",
          taskId: memberTaskId,
          expectedRevision: requireTask(running, memberTaskId).revision,
          meta: meta(now),
          attemptId: openAttempt.attemptId,
          outcome: { kind: "completed", evidence: {} },
        }),
      ).aggregate,
    };
  }

  throw new Error(`fixture: unsupported work state ${String(state)}`);
}

// ---- 재계획·계획 제안·결과 결합 헬퍼 ----------------------------------------------

/** 계획 출력 — 기본 basePlanRevision 0, retain [], source "planner". */
export function planInput(
  tasks: readonly PlanTaskDraft[],
  options: {
    basePlanRevision?: number;
    retain?: readonly TaskId[];
    source?: PlanProposalSource;
    definition?: unknown;
  } = {},
): PlanProposalInput {
  return {
    basePlanRevision: options.basePlanRevision ?? 0,
    source: options.source ?? "planner",
    tasks,
    retain: options.retain ?? [],
    ...(options.definition !== undefined ? { definition: options.definition } : {}),
  };
}

/** ACTIVE·BLOCKED Work 에 human_local replan_requested 를 수용시킨 애그리거트(재계획 열림). */
export function openReplan(deps: DomainDeps, aggregate: WorkAggregate): WorkAggregate {
  return mustCommit(
    judgeSignal(
      deps,
      aggregate,
      {
        type: "replan_requested",
        workId: aggregate.work.id,
        signalId: nextEntityId(deps.ids, "signal"),
        expectedRevision: aggregate.work.revision,
        actorSource: "human_local",
        receivedAt: FIXTURE_NOW,
      },
      { kind: "none" },
      FIXTURE_NOW,
    ),
  ).aggregate;
}

/** propose_plan 커밋 애그리거트(실패 시 던짐). */
export function proposePlan(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  plan: PlanProposalInput,
  summary = "fixture plan approval",
): WorkAggregate {
  const committed = mustCommit(
    executeCommand(deps, aggregate, {
      kind: "propose_plan",
      expectedRevision: aggregate.work.revision,
      meta: meta(FIXTURE_NOW),
      plan,
      summary,
    }),
  );
  if (committed.aggregate.work.state !== "WAITING_APPROVAL")
    throw new Error(
      `fixture: propose_plan did not reach WAITING_APPROVAL (got ${committed.aggregate.work.state})`,
    );
  return committed.aggregate;
}

/** 대기 계획 결정에 grant/deny 신호 판정. 기본 human_local·현재 Work revision. */
export function decidePlan(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  choice: "grant" | "deny",
  options: { actorSource?: ActorSource; expectedRevision?: number } = {},
): SignalJudgement {
  const decisionId = aggregate.work.pendingDecision?.id;
  if (decisionId === undefined) throw new Error("fixture: no pending plan decision");
  const application: DecisionApplication =
    choice === "grant" ? { kind: "plan_grant" } : { kind: "plan_deny" };
  return judgeSignal(
    deps,
    aggregate,
    {
      type: "human_decision",
      decisionId,
      choice,
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: options.expectedRevision ?? aggregate.work.revision,
      actorSource: options.actorSource ?? "human_local",
      receivedAt: FIXTURE_NOW,
    },
    application,
    FIXTURE_NOW,
  );
}

/** 판정·명령 결과의 커밋을 저장 순서로(preceding 먼저). 없으면 []. */
export function committedChain(outcome: CommandOutcome | SignalJudgement): readonly DomainCommit[] {
  switch (outcome.kind) {
    case "committed":
    case "accepted":
    case "duplicate":
    case "forged_provenance":
      return [outcome.commit];
    case "rejected_stale":
      return outcome.preceding !== undefined
        ? [outcome.preceding.commit, outcome.commit]
        : [outcome.commit];
    case "rejected":
      if ("commit" in outcome) return [outcome.commit];
      return outcome.record !== undefined ? [outcome.record] : [];
    case "not_applicable":
      return [];
  }
}

/** Work 레코드 패치 — patchTask 와 같은 "다른 생성 경로 대용". */
export function patchWork(aggregate: WorkAggregate, patch: Partial<WorkRecord>): WorkAggregate {
  return { ...aggregate, work: { ...aggregate.work, ...patch } };
}

function commandOn(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  taskId: TaskId,
  kind: "begin_validation" | "complete_validation" | "start_attempt",
): WorkAggregate {
  return mustCommit(
    executeCommand(deps, aggregate, {
      kind,
      taskId,
      expectedRevision: requireTask(aggregate, taskId).revision,
      meta: meta(FIXTURE_NOW),
    }),
  ).aggregate;
}

/** member 를 명령으로 진행(begin_validation → complete_validation → start_attempt → record_attempt_outcome). */
export function completeMember(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  taskId: TaskId,
  outputs?: unknown,
): WorkAggregate {
  let current = aggregate;
  if (requireTask(current, taskId).state === "DRAFT")
    current = commandOn(deps, current, taskId, "begin_validation");
  if (requireTask(current, taskId).state === "VALIDATING")
    current = commandOn(deps, current, taskId, "complete_validation");
  if (requireTask(current, taskId).state === "READY")
    current = commandOn(deps, current, taskId, "start_attempt");
  const running = requireTask(current, taskId);
  const attemptId = running.openAttempt?.attemptId;
  if (running.state !== "RUNNING" || attemptId === undefined)
    throw new Error(`fixture: member ${taskId} not RUNNING (got ${running.state})`);
  const completed = mustCommit(
    executeCommand(deps, current, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: running.revision,
      meta: meta(FIXTURE_NOW),
      attemptId,
      outcome: {
        kind: "completed",
        evidence: {},
        ...(outputs !== undefined ? { outputs } : {}),
      },
    }),
  ).aggregate;
  if (requireTask(completed, taskId).state !== "COMPLETED")
    throw new Error(
      `fixture: member ${taskId} not COMPLETED (got ${requireTask(completed, taskId).state})`,
    );
  return completed;
}

/** 커밋을 저장 순서대로 애그리거트에 적용한다(판정 결과에 이어지는 판정은 적용 뒤 애그리거트에서). */
export function applyCommits(
  aggregate: WorkAggregate,
  commits: readonly DomainCommit[],
): WorkAggregate {
  return commits.reduce((current, commit) => evolveCommit(current, commit.events), aggregate);
}
