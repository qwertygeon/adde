// SC-009~SC-021, SC-053 — 재계획 진입·열린 구간의 실행·발화 금지·닫힘·supersede·탈락·보존·fold·거부·파생 이력.
import { describe, expect, it } from "vitest";
import {
  BUILTIN_REACTIONS,
  BUILTIN_TASK_TYPES,
  BUILTIN_TRIGGERS,
  createDomainRegistries,
  decideReplanCloseFirings,
  decideTaskTriggerMisfire,
  deriveOccurrenceId,
  evolveCommit,
  executeCommand,
  nextEntityId,
  WORK_TRANSITION_ROWS,
} from "../../../src/workflow/domain/index.js";
import type {
  CommandOutcome,
  DomainCommit,
  DomainDeps,
  TaskId,
  TriggerSpec,
  WorkAggregate,
  WorkflowCommand,
} from "../../../src/workflow/domain/index.js";
import {
  applyCommits,
  at,
  basePolicy,
  committedChain,
  draft,
  meta,
  mustOk,
  patchTask,
  planInput,
  requireTaskFor,
  STRUCTURALLY_INVALID_INPUT,
  taskSubjectPendingDecision,
  testDeps,
} from "./helpers/fixtures.js";
import { GENERIC_TASK_TYPE, probeTaskType, testRegistries } from "./helpers/registry-fixtures.js";
import { eventTypes, payloadOf } from "./helpers/commits.js";
import {
  Journal,
  NOW,
  agentGoalDraft,
  atTrigger,
  committed,
  beginConfirmation,
  complete,
  confirmationDraft,
  confirmationSignal,
  dependencyTrigger,
  fail,
  grantTaskDecision,
  nonRequiredPolicy,
  park,
  planDecision,
  replanSignal,
  runToCompleted,
  scheduleAt,
  start,
  startJournal,
  taskCommand,
  taskEventTypes,
  taskPayload,
  validate,
} from "./helpers/scenario.js";

function commitPlan(journal: Journal, plan: ReturnType<typeof planInput>): CommandOutcome {
  return executeCommand(journal.deps, journal.aggregate, {
    kind: "commit_plan",
    expectedRevision: journal.aggregate.work.revision,
    meta: meta(NOW),
    plan,
  });
}

function proposePlanOn(journal: Journal, plan: ReturnType<typeof planInput>): CommandOutcome {
  return executeCommand(journal.deps, journal.aggregate, {
    kind: "propose_plan",
    expectedRevision: journal.aggregate.work.revision,
    meta: meta(NOW),
    plan,
    summary: "replan approval",
  });
}

function replanBase(
  journal: Journal,
  retain: readonly TaskId[],
  tasks = [] as Parameters<typeof planInput>[0],
) {
  return planInput(tasks, { basePlanRevision: journal.aggregate.work.planRevision, retain });
}

/** 한 member(즉시 Trigger)를 READY 로 둔 ACTIVE Work. */
function activeWork(seed: string) {
  const { journal, ids } = startJournal([draft("member")], testDeps(seed));
  validate(journal, ids["member"] as TaskId);
  expect(journal.aggregate.work.state).toBe("ACTIVE");
  return { journal, member: ids["member"] as TaskId };
}

/** 한 필수 member 가 FAILED 로 끝나 BLOCKED 인 Work. */
function blockedWork(seed: string) {
  const { journal, ids } = startJournal([draft("member")], testDeps(seed));
  const member = ids["member"] as TaskId;
  validate(journal, member);
  start(journal, member);
  fail(journal, member, "fixture_fatal");
  expect(journal.task(member).state).toBe("FAILED");
  expect(journal.aggregate.work.state).toBe("BLOCKED");
  return { journal, member };
}

describe("SC-009: 재계획 진입은 ACTIVE·BLOCKED 에서 같고, 사람 아닌 출처·낡은 요청은 아무것도 열지 않는다", () => {
  it("Happy: ACTIVE·BLOCKED 의 사람 요청이 같은 이벤트로 계획 단계에 들어간다 (test_SC009_active_and_blocked_enter_planning_identically)", () => {
    const traces: string[][] = [];
    for (const { journal } of [activeWork("sc009a"), blockedWork("sc009b")]) {
      const before = journal.aggregate.work;
      const commit = journal.apply(replanSignal(journal));
      traces.push(eventTypes(commit));
      expect(journal.aggregate.work.state).toBe("PLANNING");
      expect(journal.aggregate.work.revision).toBe(before.revision + 1);
      expect(journal.aggregate.work.planRevision).toBe(before.planRevision);
      expect(journal.aggregate.work.memberTaskIds).toEqual(before.memberTaskIds);
    }
    expect(traces[0]).toEqual(["signal_accepted", "work_replanning_started"]);
    expect(traces[1]).toEqual(traces[0]);
  });

  it("Edge: 사람 아닌 출처 요청은 거절 기록만 남기고 상태·revision 이 그대로다 (test_SC009_non_human_request_records_rejection_only)", () => {
    for (const { journal } of [activeWork("sc009c"), blockedWork("sc009d")]) {
      const before = journal.aggregate;
      const judged = replanSignal(journal, { actorSource: "adde_self" });
      expect(judged.kind).toBe("rejected");
      const chain = committedChain(judged);
      expect(chain.map(eventTypes)).toEqual([["signal_rejected"]]);
      const after = applyCommits(before, chain);
      expect(after.work.state).toBe(before.work.state);
      expect(after.work.revision).toBe(before.work.revision);
      // 대조: 같은 애그리거트에서 사람 출처면 수용된다.
      expect(replanSignal(new Journal(journal.deps, after, [])).kind).toBe("accepted");
    }
  });

  it("Error: 낡은 revision 요청은 signal_rejected_stale 기록만 남긴다 (test_SC009_stale_request_records_stale_only)", () => {
    for (const { journal } of [activeWork("sc009e"), blockedWork("sc009f")]) {
      const before = journal.aggregate;
      const judged = replanSignal(journal, { expectedRevision: before.work.revision - 1 });
      expect(judged.kind).toBe("rejected_stale");
      const chain = committedChain(judged);
      expect(chain.map(eventTypes)).toEqual([["signal_rejected_stale"]]);
      const after = applyCommits(before, chain);
      expect(after.work.state).toBe(before.work.state);
      expect(after.work.revision).toBe(before.work.revision);
      expect(replanSignal(new Journal(journal.deps, after, [])).kind).toBe("accepted");
    }
  });
});

/**
 * 재계획 게이트 대상 member 들: READY(즉시), SCHEDULED(예약), READY(예약 발화 — 예약 대상), RETRY_WAIT,
 * 확인 Task READY, 그리고 주차·건너뛰기 대상 READY. 재계획 전 애그리거트(ACTIVE)와 열린 뒤 애그리거트를
 * 함께 돌려준다.
 */
function gateFixture() {
  const { journal, ids } = startJournal(
    [
      draft("ready"),
      draft("sched", { trigger: atTrigger("sched", { kind: "skip" }) }),
      draft("slot", { trigger: atTrigger("slot", { kind: "skip" }) }),
      draft("retry"),
      confirmationDraft("confirm"),
      draft("parkable"),
      draft("skippable"),
    ],
    testDeps("gate"),
  );
  const id = (ref: string) => ids[ref] as TaskId;
  for (const ref of ["ready", "sched", "slot", "retry", "confirm", "parkable", "skippable"])
    validate(journal, id(ref));
  scheduleAt(journal, id("sched"));
  start(journal, id("retry"));
  fail(journal, id("retry"));
  expect(journal.task(id("sched")).state).toBe("SCHEDULED");
  expect(journal.task(id("slot")).state).toBe("READY");
  expect(journal.task(id("retry")).state).toBe("RETRY_WAIT");
  expect(journal.aggregate.work.state).toBe("ACTIVE");
  const before = journal.aggregate;
  journal.apply(replanSignal(journal));
  expect(journal.aggregate.work.state).toBe("PLANNING");
  return { journal, before, id };
}

type GatedCase = { readonly name: string; readonly run: (agg: WorkAggregate) => CommandOutcome };

function gatedCases(journal: Journal, id: (ref: string) => TaskId): readonly GatedCase[] {
  const deps = journal.deps;
  const sched = id("sched");
  return [
    {
      name: "begin_confirmation_wait",
      run: (agg) =>
        taskCommand(deps, agg, id("confirm"), {
          kind: "begin_confirmation_wait",
          confirmationId: nextEntityId(deps.ids, "confirmation"),
        }),
    },
    {
      name: "start_attempt@SCHEDULED",
      run: (agg) =>
        taskCommand(deps, agg, sched, {
          kind: "start_attempt",
          ...(requireTaskFor(agg, sched).scheduledOccurrenceId !== undefined
            ? { firedOccurrenceId: requireTaskFor(agg, sched).scheduledOccurrenceId }
            : {}),
        }),
    },
    {
      name: "schedule_task",
      run: (agg) =>
        taskCommand(deps, agg, id("slot"), {
          kind: "schedule_task",
          occurrenceId: mustOk(
            deriveOccurrenceId({
              kind: "schedule",
              ownerId: id("slot"),
              triggerId: requireTaskFor(agg, id("slot")).trigger.triggerId,
              scheduledForUtc: NOW,
              recurrenceIndex: 0,
            }),
          ),
          cause: "schedule",
        }),
    },
    {
      name: "retry_ready",
      run: (agg) => taskCommand(deps, agg, id("retry"), { kind: "retry_ready" }),
    },
    {
      name: "park_awaiting_human",
      run: (agg) =>
        taskCommand(deps, agg, id("parkable"), {
          kind: "park_awaiting_human",
          cause: "unattended_eligibility_refused",
          decision: taskSubjectPendingDecision(deps, id("parkable"), NOW),
        }),
    },
    {
      name: "skip_task",
      run: (agg) =>
        taskCommand(deps, agg, id("skippable"), {
          kind: "skip_task",
          reason: { kind: "misfire_skip" },
        }),
    },
  ];
}

function expectReplanOpenRefusal(outcome: CommandOutcome, name: string): void {
  expect(outcome.kind, name).toBe("rejected");
  if (outcome.kind !== "rejected") return;
  expect(outcome.rejection.reason, name).toBe("replan_open");
  expect(committedChain(outcome), name).toEqual([]);
}

/** Work 단위 명령 — `expectedRevision`·`meta` 를 현재 Work 에서 채운다. */
function workCommand(
  journal: Journal,
  command:
    | { readonly kind: "fail_planning" }
    | { readonly kind: "fail_work" }
    | {
        readonly kind: "propose_plan";
        readonly plan: ReturnType<typeof planInput>;
        readonly summary: string;
        readonly onInvalid: "fail_work";
      },
): CommandOutcome {
  return executeCommand(journal.deps, journal.aggregate, {
    ...command,
    expectedRevision: journal.aggregate.work.revision,
    meta: meta(NOW),
  });
}

/** 외부 신호 Trigger(`signal@1`) — 신호 occurrence 는 원인 이벤트에서 파생된다. */
function signalTrigger(ref: string): TriggerSpec {
  return {
    kind: "signal",
    version: 1,
    triggerId: ref,
    sourceId: "fixture_source",
    signal: "fixture_ready",
  } as TriggerSpec;
}

/** SCHEDULED member 를 예약 occurrence 로 발화(start_attempt{firedOccurrenceId})한다. */
function fireScheduled(journal: Journal, taskId: TaskId): CommandOutcome {
  const occurrenceId = journal.task(taskId).scheduledOccurrenceId;
  if (occurrenceId === undefined) throw new Error(`expected scheduled occurrence for ${taskId}`);
  return taskCommand(journal.deps, journal.aggregate, taskId, {
    kind: "start_attempt",
    firedOccurrenceId: occurrenceId,
  });
}

/** 예약 명령 — 예약 원인은 예약 시각 occurrence, 외부 신호 원인은 원인 이벤트에서 파생한 occurrence. */
function scheduleOn(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  taskId: TaskId,
  cause: "schedule" | "external_signal",
): CommandOutcome {
  const triggerId = requireTaskFor(aggregate, taskId).trigger.triggerId;
  const occurrenceId = mustOk(
    cause === "schedule"
      ? deriveOccurrenceId({
          kind: "schedule",
          ownerId: taskId,
          triggerId,
          scheduledForUtc: NOW,
          recurrenceIndex: 0,
        })
      : deriveOccurrenceId({
          kind: "event_caused",
          ownerId: taskId,
          triggerId,
          causingEvent: { id: nextEntityId(deps.ids, "event"), occurredAt: NOW },
        }),
  );
  return taskCommand(deps, aggregate, taskId, { kind: "schedule_task", occurrenceId, cause });
}

/** 예약 명령 결과 요약 — 예약·주차·거절을 한 문자열로(거절 detail 은 설계 지정 식별자 대조용). */
function scheduleCell(outcome: CommandOutcome, taskId: TaskId, cause: string): string {
  if (outcome.kind === "rejected") {
    if (committedChain(outcome).length > 0)
      return `rejected-with-record:${outcome.rejection.reason}`;
    return `rejected:${outcome.rejection.reason}:${outcome.rejection.detail ?? ""}`;
  }
  const types = taskEventTypes(outcome.commit, taskId);
  const state = requireTaskFor(outcome.aggregate, taskId).state;
  if (types.includes("task_scheduled")) {
    expect(taskPayload(outcome.commit, taskId, "task_scheduled")["cause"]).toBe(cause);
    return `scheduled:${state}`;
  }
  if (types.includes("task_awaiting_human")) {
    const decision = taskPayload(outcome.commit, taskId, "task_awaiting_human")[
      "pendingDecision"
    ] as { readonly kind: string };
    return `parked:${decision.kind}:${state}`;
  }
  return `committed:${types.join(",")}:${state}`;
}

const CLOSE_AT = at("2026-01-01T02:00:00Z");

/** 닫힘 발화 판정 기대값 — 같은 입력의 지연 발화 결정 함수 결과. */
function closeFiring(
  journal: Journal,
  taskId: TaskId,
  occurrence: Parameters<typeof decideTaskTriggerMisfire>[1]["occurrence"],
) {
  const task = journal.task(taskId);
  const decided = decideTaskTriggerMisfire(journal.deps.registries.triggers, {
    taskId,
    trigger: task.trigger,
    occurrence,
    now: CLOSE_AT,
  });
  if (!decided.ok) throw new Error("expected misfire decision");
  return { taskId, kind: "decided", decision: decided.value };
}

/**
 * 최상위 키 하나를 읽을 때마다 값이 바뀔 수 있는 열거 접근자로 둔 명령 — 일반 객체 리터럴 밖의 다른 생성
 * 경로(호출자 객체) 대용. 진입 포착은 자기 열거 속성을 읽으므로 비열거 접근자로는 판별이 공허해진다.
 */
function accessorCommand(
  base: Readonly<Record<string, unknown>>,
  key: string,
  valueAt: (read: number) => unknown,
): { readonly command: WorkflowCommand; readonly reads: () => number } {
  let count = 0;
  const command: Record<string, unknown> = { ...base };
  Object.defineProperty(command, key, {
    enumerable: true,
    configurable: true,
    get: () => {
      count += 1;
      return valueAt(count);
    },
  });
  return { command: command as unknown as WorkflowCommand, reads: () => count };
}

/** 문자열 키별 get 횟수를 세는 Proxy — 호출자 객체 대용. */
function countingProxy<T extends object>(target: T, counts: Map<string, number>): T {
  return new Proxy(target, {
    get(obj, key, receiver) {
      if (typeof key === "string") counts.set(key, (counts.get(key) ?? 0) + 1);
      return Reflect.get(obj, key, receiver) as unknown;
    },
  });
}

/** 외부 신호 원인 occurrence — 원인 이벤트에서 파생한다. */
function signalOccurrenceId(deps: DomainDeps, aggregate: WorkAggregate, taskId: TaskId) {
  return mustOk(
    deriveOccurrenceId({
      kind: "event_caused",
      ownerId: taskId,
      triggerId: requireTaskFor(aggregate, taskId).trigger.triggerId,
      causingEvent: { id: nextEntityId(deps.ids, "event"), occurredAt: NOW },
    }),
  );
}

/** 커밋 이벤트의 종류·payload — 커밋·이벤트 ID 생성 순서와 무관한 부분만. */
function eventContents(outcome: CommandOutcome) {
  return committed(outcome).commit.events.map((e) => ({ type: e.type, payload: e.payload }));
}

/** 초안 정책으로 실행 전 승인을 요구한다(정책 레코드 패치 없음). */
const APPROVAL_POLICY = basePolicy({ approvalRequiredBeforeExecute: true });
const PROBE_TYPE = { id: probeTaskType().id, version: probeTaskType().version };

/** 시험 유형을 뺀 내장 등록부 — 등록부 drift 대용(그 유형 Task 의 검증이 차단 출구로 간다). */
function withoutTestTypes(deps: DomainDeps): DomainDeps {
  return {
    ...deps,
    registries: mustOk(
      createDomainRegistries({
        taskTypes: BUILTIN_TASK_TYPES,
        triggers: BUILTIN_TRIGGERS,
        reactions: BUILTIN_REACTIONS,
      }),
    ),
  };
}

/** 필수 입력 하나(`subject`)를 가진 시험 유형까지 등록한 deps. */
function probeDeps(seed: string): DomainDeps {
  return testDeps(seed, testRegistries({ taskTypes: [probeTaskType()] }));
}

/** 진입 명령을 내고 VALIDATING 에 들어갔는지 확인한다. */
function enterValidation(
  journal: Journal,
  taskId: TaskId,
  kind: "begin_validation" | "receive_input" | "unblock",
): void {
  journal.apply(taskCommand(journal.deps, journal.aggregate, taskId, { kind }));
  expect(journal.task(taskId).state, kind).toBe("VALIDATING");
}

/** 답변의 입력 반영은 이 차수 도메인 밖이라, 채운 입력을 레코드 패치로 둔다(다른 생성 경로 대용). */
function fillProbeInput(journal: Journal, taskId: TaskId): void {
  journal.aggregate = patchTask(journal.aggregate, taskId, { input: { subject: "filled" } });
}

describe("SC-010: 재계획 중 member 는 새 attempt·첫 효과·발화를 시작하지 않는다", () => {
  it("Happy: 재계획 중 READY member 의 start_attempt 는 replan_open 으로 거절되고 아무것도 바뀌지 않는다 (test_SC010_start_attempt_refused_while_replan_open)", () => {
    const { journal, id } = gateFixture();
    const before = journal.task(id("ready"));
    const outcome = taskCommand(journal.deps, journal.aggregate, id("ready"), {
      kind: "start_attempt",
    });
    expectReplanOpenRefusal(outcome, "start_attempt@PLANNING");
    expect(journal.task(id("ready"))).toEqual(before);
    // 입력 대기(WAITING_INPUT)·승인 대기(WAITING_APPROVAL)도 재계획이 열린 구간이다.
    const waitingInput = committed(
      executeCommand(journal.deps, journal.aggregate, {
        kind: "request_work_input",
        expectedRevision: journal.aggregate.work.revision,
        meta: meta(NOW),
        requests: [],
      }),
    ).aggregate;
    expect(waitingInput.work.state).toBe("WAITING_INPUT");
    expectReplanOpenRefusal(
      taskCommand(journal.deps, waitingInput, id("ready"), { kind: "start_attempt" }),
      "start_attempt@WAITING_INPUT",
    );
    const members = journal.aggregate.work.memberTaskIds;
    journal.apply(proposePlanOn(journal, replanBase(journal, members)));
    expect(journal.aggregate.work.state).toBe("WAITING_APPROVAL");
    expectReplanOpenRefusal(
      taskCommand(journal.deps, journal.aggregate, id("ready"), { kind: "start_attempt" }),
      "start_attempt@WAITING_APPROVAL",
    );
  });

  it("Edge: 확인 대기 진입·예약 시작·예약·재시도 준비·주차·건너뛰기가 각각 replan_open 으로 거절된다 (test_SC010_effect_and_firing_commands_refused_while_replan_open)", () => {
    const { journal, id } = gateFixture();
    const revision = journal.aggregate.work.revision;
    for (const c of gatedCases(journal, id))
      expectReplanOpenRefusal(c.run(journal.aggregate), c.name);
    expect(journal.aggregate.work.revision).toBe(revision);
  });

  it("Error: 같은 명령이 재계획 밖(재계획 전 ACTIVE)에서는 수용된다(대조) (test_SC010_same_commands_accepted_outside_replan)", () => {
    const { journal, before, id } = gateFixture();
    expect(taskCommand(journal.deps, before, id("ready"), { kind: "start_attempt" }).kind).toBe(
      "committed",
    );
    for (const c of gatedCases(journal, id)) expect(c.run(before).kind, c.name).toBe("committed");
  });

  it("Edge: 재계획 중 도착한 외부 신호 occurrence 는 예약으로 영속되지만 발화는 막히고, 닫힌 뒤 같은 occurrence 로 발화한다 (test_SC010_external_signal_occurrence_persisted_but_not_fired_during_replan)", () => {
    const { journal, ids } = startJournal(
      [draft("anchor"), draft("listener", { trigger: signalTrigger("listener") })],
      testDeps("sc010s"),
    );
    const listener = ids["listener"] as TaskId;
    validate(journal, ids["anchor"] as TaskId);
    validate(journal, listener);
    expect(journal.task(listener).state).toBe("READY");
    journal.apply(replanSignal(journal));
    expect(journal.aggregate.work.state).toBe("PLANNING");
    // 대조: 같은 READY member 에 원인 이벤트 없는 예약(schedule)은 게이트가 막는다.
    expectReplanOpenRefusal(
      taskCommand(journal.deps, journal.aggregate, listener, {
        kind: "schedule_task",
        occurrenceId: mustOk(
          deriveOccurrenceId({
            kind: "schedule",
            ownerId: listener,
            triggerId: "listener",
            scheduledForUtc: NOW,
            recurrenceIndex: 0,
          }),
        ),
        cause: "schedule",
      }),
      "schedule_task{schedule}",
    );
    const occurrenceId = mustOk(
      deriveOccurrenceId({
        kind: "event_caused",
        ownerId: listener,
        triggerId: "listener",
        causingEvent: { id: nextEntityId(journal.deps.ids, "event"), occurredAt: NOW },
      }),
    );
    const persisted = journal.apply(
      taskCommand(journal.deps, journal.aggregate, listener, {
        kind: "schedule_task",
        occurrenceId,
        cause: "external_signal",
      }),
    );
    expect(taskEventTypes(persisted, listener)).toEqual(["task_scheduled"]);
    expect(taskPayload(persisted, listener, "task_scheduled")).toEqual({
      occurrenceId,
      cause: "external_signal",
    });
    expect(journal.task(listener).state).toBe("SCHEDULED");
    expect(journal.task(listener).scheduledOccurrenceId).toBe(occurrenceId);
    expect(journal.aggregate.work.state).toBe("PLANNING");
    const scheduled = journal.task(listener);
    expectReplanOpenRefusal(fireScheduled(journal, listener), "start_attempt{external_signal}");
    expect(journal.task(listener)).toEqual(scheduled);
    journal.apply(commitPlan(journal, replanBase(journal, journal.aggregate.work.memberTaskIds)));
    const fired = journal.apply(fireScheduled(journal, listener));
    expect(taskPayload(fired, listener, "task_started")["firedOccurrenceId"]).toBe(occurrenceId);
    expect(journal.task(listener).state).toBe("RUNNING");
  });

  it("Error: 재계획 중 실패로 끝난 Work 의 READY·SCHEDULED member 는 시작·발화하지 않고, 재계획 밖에서 실패한 Work 의 member 는 시작한다(대조) (test_SC010_member_start_refused_after_work_failed_during_replan)", () => {
    /** READY member(ready)와 재계획 중 생산자 완료로 의존 occurrence 가 영속된 SCHEDULED member(consumer). */
    function failedDuringReplan(seed: string, failure: (journal: Journal) => CommandOutcome) {
      const { journal, ids } = startJournal(
        [
          draft("ready"),
          draft("producer"),
          draft("consumer", {
            dependsOn: [{ draftRef: "producer" }],
            trigger: dependencyTrigger("consumer"),
          }),
        ],
        testDeps(seed),
      );
      const id = (ref: string) => ids[ref] as TaskId;
      for (const ref of ["ready", "producer", "consumer"]) validate(journal, id(ref));
      start(journal, id("producer"));
      journal.apply(replanSignal(journal));
      complete(journal, id("producer"));
      expect(journal.task(id("consumer")).state).toBe("SCHEDULED");
      const failed = journal.apply(failure(journal));
      expect(payloadOf(failed, "work_failed")["cause"]).toBe("planning_failed");
      expect(journal.aggregate.work.state).toBe("FAILED");
      return { journal, ready: id("ready"), consumer: id("consumer") };
    }

    const paths: readonly [string, (journal: Journal) => CommandOutcome][] = [
      ["fail_planning", (journal) => workCommand(journal, { kind: "fail_planning" })],
      [
        "propose_plan{onInvalid:fail_work}",
        (journal) =>
          workCommand(journal, {
            kind: "propose_plan",
            plan: replanBase(journal, []),
            summary: "invalid replan",
            onInvalid: "fail_work",
          }),
      ],
    ];
    for (const [index, [name, failure]] of paths.entries()) {
      const { journal, ready, consumer } = failedDuringReplan(`sc010f${index}`, failure);
      const readyBefore = journal.task(ready);
      const consumerBefore = journal.task(consumer);
      expectReplanOpenRefusal(
        taskCommand(journal.deps, journal.aggregate, ready, { kind: "start_attempt" }),
        `${name}: start_attempt@READY`,
      );
      expectReplanOpenRefusal(fireScheduled(journal, consumer), `${name}: start_attempt@SCHEDULED`);
      expect(journal.task(ready), name).toEqual(readyBefore);
      expect(journal.task(consumer), name).toEqual(consumerBefore);
    }

    // 대조: 재계획을 거치지 않고 선언 실패 정책으로 실패한 Work 의 같은 member 들은 시작한다.
    const { journal, ids } = startJournal(
      [
        draft("ready"),
        draft("producer"),
        draft("consumer", {
          dependsOn: [{ draftRef: "producer" }],
          trigger: dependencyTrigger("consumer"),
        }),
      ],
      testDeps("sc010fctl"),
    );
    const id = (ref: string) => ids[ref] as TaskId;
    for (const ref of ["ready", "producer", "consumer"]) validate(journal, id(ref));
    runToCompleted(journal, id("producer"));
    expect(journal.task(id("consumer")).state).toBe("SCHEDULED");
    const failed = journal.apply(workCommand(journal, { kind: "fail_work" }));
    expect(payloadOf(failed, "work_failed")["cause"]).toBe("declared_failure_policy");
    expect(journal.aggregate.work.state).toBe("FAILED");
    expect(
      taskCommand(journal.deps, journal.aggregate, id("ready"), { kind: "start_attempt" }).kind,
    ).toBe("committed");
    expect(fireScheduled(journal, id("consumer")).kind).toBe("committed");
  });

  it("Edge: 재계획 중 즉시·예약 발화 member 에 외부 신호 원인을 붙인 예약은 replan_open 이고, 거부로 닫힌 뒤에도 두 member 에 사건 원인 발화 판정이 없다 (test_SC010_mislabeled_signal_schedule_refused_during_replan)", () => {
    const { journal, ids } = startJournal(
      [
        draft("instant"),
        draft("timed", { trigger: atTrigger("timed", { kind: "fire_once_now" }) }),
        draft("listener", { trigger: signalTrigger("listener") }),
      ],
      testDeps("sc010g2"),
    );
    const id = (ref: string) => ids[ref] as TaskId;
    for (const ref of ["instant", "timed", "listener"]) validate(journal, id(ref));
    journal.apply(replanSignal(journal));
    expect(journal.aggregate.work.state).toBe("PLANNING");
    for (const ref of ["instant", "timed"]) {
      expect(journal.task(id(ref)).state, ref).toBe("READY");
      expectReplanOpenRefusal(
        scheduleOn(journal.deps, journal.aggregate, id(ref), "external_signal"),
        `${ref}: schedule_task{external_signal}`,
      );
    }
    // 대조: 같은 구간에서 외부 신호 발화로 선언된 member 의 같은 명령은 커밋된다.
    const persisted = journal.apply(
      scheduleOn(journal.deps, journal.aggregate, id("listener"), "external_signal"),
    );
    expect(taskEventTypes(persisted, id("listener"))).toEqual(["task_scheduled"]);
    expect(journal.task(id("listener")).state).toBe("SCHEDULED");

    journal.apply(
      proposePlanOn(journal, replanBase(journal, journal.aggregate.work.memberTaskIds)),
    );
    journal.apply(planDecision(journal, "deny"));
    expect(journal.aggregate.work.state).toBe("ACTIVE");
    expect(journal.task(id("instant")).state).toBe("READY");
    expect(journal.task(id("timed")).state).toBe("READY");
    const firings = decideReplanCloseFirings(journal.deps.registries, journal.aggregate, CLOSE_AT);
    expect(firings.ok).toBe(true);
    if (!firings.ok) return;
    const forTask = (ref: string) => firings.value.filter((f) => f.taskId === id(ref));
    expect(forTask("instant")).toEqual([]);
    expect(forTask("timed")).toEqual([closeFiring(journal, id("timed"), { kind: "schedule" })]);
    const listenerOccurrence = journal.task(id("listener")).scheduledOccurrenceId;
    if (listenerOccurrence === undefined) throw new Error("expected listener occurrence");
    expect(forTask("listener")).toEqual([
      closeFiring(journal, id("listener"), {
        kind: "event_caused",
        occurrenceId: listenerOccurrence,
      }),
    ]);
  });

  it("Error: 재계획 밖에서도 예약 원인은 Trigger 발화 선언과 맞아야 한다 — 네 Trigger × 두 원인 중 예약 발화×schedule·외부 신호×external_signal 만 예약되고, 미등록 Trigger·승인 필요 member 의 맞지 않는 원인도 거절된다 (test_SC010_schedule_cause_must_match_trigger_firing)", () => {
    const { journal, ids } = startJournal(
      [
        draft("instant"),
        draft("timed", { trigger: atTrigger("timed", { kind: "skip" }) }),
        draft("producer"),
        draft("follower", {
          dependsOn: [{ draftRef: "producer" }],
          trigger: dependencyTrigger("follower"),
        }),
        draft("listener", { trigger: signalTrigger("listener") }),
      ],
      testDeps("sc010t"),
    );
    const id = (ref: string) => ids[ref] as TaskId;
    for (const ref of ["instant", "timed", "producer", "follower", "listener"])
      validate(journal, id(ref));
    for (const ref of ["instant", "timed", "follower", "listener"])
      expect(journal.task(id(ref)).state, ref).toBe("READY");
    expect(journal.aggregate.work.state).toBe("ACTIVE");
    const before = journal.aggregate;

    const ACCEPTED = "scheduled:SCHEDULED";
    const MISMATCH = "rejected:condition_not_met:trigger_cause_mismatch";
    const cells: readonly [string, "schedule" | "external_signal", string][] = [
      ["instant", "schedule", MISMATCH],
      ["instant", "external_signal", MISMATCH],
      ["timed", "schedule", ACCEPTED],
      ["timed", "external_signal", MISMATCH],
      ["follower", "schedule", MISMATCH],
      ["follower", "external_signal", MISMATCH],
      ["listener", "schedule", MISMATCH],
      ["listener", "external_signal", ACCEPTED],
    ];
    const observed = cells.map(
      ([ref, cause]) =>
        `${ref}×${cause} → ${scheduleCell(scheduleOn(journal.deps, before, id(ref), cause), id(ref), cause)}`,
    );
    expect(observed).toEqual(cells.map(([ref, cause, want]) => `${ref}×${cause} → ${want}`));

    // 미등록 Trigger: 예약 발화 Trigger 를 뺀 등록부(등록부 drift — 다른 생성 경로 대용).
    const driftDeps: DomainDeps = {
      ...journal.deps,
      registries: mustOk(
        createDomainRegistries({
          taskTypes: [...BUILTIN_TASK_TYPES, GENERIC_TASK_TYPE],
          triggers: BUILTIN_TRIGGERS.filter((t) => t.kind !== "at"),
          reactions: BUILTIN_REACTIONS,
        }),
      ),
    };
    const unknownTrigger = scheduleOn(driftDeps, before, id("timed"), "schedule");
    expect(unknownTrigger.kind).toBe("rejected");
    if (unknownTrigger.kind === "rejected")
      expect(unknownTrigger.rejection.reason).toBe("condition_not_met");
    expect(committedChain(unknownTrigger)).toEqual([]);

    // 승인 필요 member: 레코드 패치로 실행 전 승인 요구만 켠다(검증 차단 → unblock 경로 대용).
    const awaitingApproval = (ref: string) =>
      patchTask(before, id(ref), {
        policy: { ...requireTaskFor(before, id(ref)).policy, approvalRequiredBeforeExecute: true },
        preExecutionApproved: false,
      });
    const mismatchedParked = scheduleOn(
      journal.deps,
      awaitingApproval("instant"),
      id("instant"),
      "schedule",
    );
    expect(scheduleCell(mismatchedParked, id("instant"), "schedule")).toBe(MISMATCH);
    // 대조: 원인이 맞는 승인 필요 member 는 예약 대신 실행 전 승인으로 주차된다.
    const matchedParked = scheduleOn(
      journal.deps,
      awaitingApproval("timed"),
      id("timed"),
      "schedule",
    );
    expect(scheduleCell(matchedParked, id("timed"), "schedule")).toBe(
      "parked:pre_execution_approval:BLOCKED_AWAITING_HUMAN",
    );
  });

  it("Edge: 재계획 중 실행 전 승인이 필요한 외부 신호 member 의 신호 원인 예약은 replan_open 이고 대기 결정을 만들지 않는다 (test_SC010_signal_schedule_on_approval_pending_member_refused_during_replan)", () => {
    const { journal, ids } = startJournal(
      [
        draft("anchor"),
        draft("gated", { trigger: signalTrigger("gated") }),
        draft("open", { trigger: signalTrigger("open") }),
      ],
      testDeps("sc010g3"),
    );
    const id = (ref: string) => ids[ref] as TaskId;
    for (const ref of ["anchor", "gated", "open"]) validate(journal, id(ref));
    // 레코드 패치: READY 이면서 실행 전 승인이 필요한 Task(검증 차단 → unblock 경로 대용).
    journal.aggregate = patchTask(journal.aggregate, id("gated"), {
      policy: { ...journal.task(id("gated")).policy, approvalRequiredBeforeExecute: true },
      preExecutionApproved: false,
    });
    const outside = journal.aggregate;
    journal.apply(replanSignal(journal));
    expect(journal.aggregate.work.state).toBe("PLANNING");
    const refused = scheduleOn(journal.deps, journal.aggregate, id("gated"), "external_signal");
    expectReplanOpenRefusal(refused, "gated: schedule_task{external_signal}");
    expect(journal.task(id("gated")).pendingDecision).toBeUndefined();
    expect(journal.task(id("gated")).state).toBe("READY");

    // 대조 (a): 재계획 밖의 같은 명령은 실행 전 승인으로 주차된다.
    expect(
      scheduleCell(
        scheduleOn(journal.deps, outside, id("gated"), "external_signal"),
        id("gated"),
        "external_signal",
      ),
    ).toBe("parked:pre_execution_approval:BLOCKED_AWAITING_HUMAN");
    // 대조 (b): 승인이 필요 없는 같은 종류 member 는 재계획 중에도 예약된다.
    expect(
      scheduleCell(
        scheduleOn(journal.deps, journal.aggregate, id("open"), "external_signal"),
        id("open"),
        "external_signal",
      ),
    ).toBe("scheduled:SCHEDULED");
  });

  it("Edge: 신호 원인 예약 명령의 cause 는 한 번 읽혀 게이트·판정·기록이 같은 값을 본다 (test_SC010_command_cause_read_once_for_gate_decision_and_record)", () => {
    const { journal, ids } = startJournal(
      [draft("listener", { trigger: signalTrigger("listener") })],
      testDeps("sc010h1c"),
    );
    const listener = ids["listener"] as TaskId;
    validate(journal, listener);
    journal.apply(replanSignal(journal));
    expect(journal.aggregate.work.state).toBe("PLANNING");
    expect(journal.task(listener).state).toBe("READY");
    const base = {
      kind: "schedule_task",
      taskId: listener,
      expectedRevision: journal.task(listener).revision,
      meta: meta(NOW),
      occurrenceId: signalOccurrenceId(journal.deps, journal.aggregate, listener),
    };
    const plain = executeCommand(journal.deps, journal.aggregate, {
      ...base,
      cause: "external_signal",
    } as WorkflowCommand);
    expect(taskEventTypes(committed(plain).commit, listener)).toEqual(["task_scheduled"]);

    const cases: readonly [string, (read: number) => string][] = [
      ["first read only", (n) => (n === 1 ? "external_signal" : "schedule")],
      ["first five reads", (n) => (n <= 5 ? "external_signal" : "schedule")],
    ];
    for (const [name, valueAt] of cases) {
      const accessor = accessorCommand(base, "cause", valueAt);
      const outcome = executeCommand(journal.deps, journal.aggregate, accessor.command);
      expect(outcome.kind, name).toBe("committed");
      expect(accessor.reads(), name).toBe(1);
      expect(
        taskPayload(committed(outcome).commit, listener, "task_scheduled")["cause"],
        name,
      ).toBe("external_signal");
      expect(eventContents(outcome), name).toEqual(eventContents(plain));
    }
  });

  it("Edge: 명령 kind 는 한 번 읽혀 게이트가 본 명령과 판정하는 명령이 같다 (test_SC010_command_kind_read_once_so_gate_cannot_be_bypassed)", () => {
    const { journal, member } = activeWork("sc010h1k");
    const outside = journal.aggregate;
    journal.apply(replanSignal(journal));
    expect(journal.aggregate.work.state).toBe("PLANNING");
    const before = journal.task(member);
    const base = { taskId: member, expectedRevision: before.revision, meta: meta(NOW) };
    const gateMissKind = (n: number) => (n === 2 ? "receive_input" : "start_attempt");

    const during = accessorCommand(base, "kind", gateMissKind);
    expectReplanOpenRefusal(
      executeCommand(journal.deps, journal.aggregate, during.command),
      "kind accessor during replan",
    );
    expect(during.reads()).toBe(1);
    expect(journal.task(member)).toEqual(before);

    // 대조: 재계획 밖의 같은 접근자 명령은 첫 읽기 값(start_attempt)으로 판정된다.
    const outsideAccessor = accessorCommand(
      { ...base, expectedRevision: requireTaskFor(outside, member).revision },
      "kind",
      gateMissKind,
    );
    const started = executeCommand(journal.deps, outside, outsideAccessor.command);
    expect(taskEventTypes(committed(started).commit, member)).toEqual(["task_started"]);
    expect(outsideAccessor.reads()).toBe(1);

    // 키별 get 횟수 — 최상위 키와 meta 키가 각각 한 번씩 읽힌다.
    const topReads = new Map<string, number>();
    const metaReads = new Map<string, number>();
    const proxied = countingProxy(
      { kind: "start_attempt", ...base, meta: countingProxy(meta(NOW), metaReads) },
      topReads,
    );
    expectReplanOpenRefusal(
      executeCommand(journal.deps, journal.aggregate, proxied as WorkflowCommand),
      "proxy command during replan",
    );
    expect(Object.fromEntries(topReads)).toEqual({
      kind: 1,
      taskId: 1,
      expectedRevision: 1,
      meta: 1,
    });
    expect(Object.fromEntries(metaReads)).toEqual({ now: 1, actorSource: 1 });
  });

  it("Edge: 재계획 중 실행 전 승인이 필요한 VALIDATING member 의 검증 통과는 세 진입 경로 모두 replan_open 이고 승인 결정을 열지 않는다 (test_SC010_validation_pass_of_approval_pending_member_refused_during_replan)", () => {
    const deps = probeDeps("sc010h2");
    const drift = withoutTestTypes(deps);
    const { journal, ids } = startJournal(
      [
        draft("anchor"),
        draft("drafted", { policy: APPROVAL_POLICY }),
        draft("asked", { type: PROBE_TYPE, policy: APPROVAL_POLICY }),
        draft("stalled", { policy: APPROVAL_POLICY }),
        draft("free"),
      ],
      deps,
    );
    const id = (ref: string) => ids[ref] as TaskId;
    validate(journal, id("anchor"));
    validate(journal, id("asked"));
    expect(journal.task(id("asked")).state).toBe("WAITING_INPUT");
    journal.apply(
      taskCommand(deps, journal.aggregate, id("stalled"), { kind: "begin_validation" }),
    );
    journal.apply(
      taskCommand(drift, journal.aggregate, id("stalled"), { kind: "complete_validation" }),
    );
    expect(journal.task(id("stalled")).state).toBe("BLOCKED");
    const outside = journal.aggregate;
    journal.apply(replanSignal(journal));
    expect(journal.aggregate.work.state).toBe("PLANNING");

    enterValidation(journal, id("drafted"), "begin_validation");
    enterValidation(journal, id("asked"), "receive_input");
    fillProbeInput(journal, id("asked"));
    enterValidation(journal, id("stalled"), "unblock");
    const pending = ["drafted", "asked", "stalled"];
    for (const ref of pending) {
      const refused = taskCommand(journal.deps, journal.aggregate, id(ref), {
        kind: "complete_validation",
      });
      expectReplanOpenRefusal(refused, `${ref}: complete_validation during replan`);
      expect(journal.task(id(ref)).state, ref).toBe("VALIDATING");
      expect(journal.task(id(ref)).pendingDecision, ref).toBeUndefined();
    }

    // 대조 (a): 재계획 밖에서는 검증 통과와 실행 전 승인 주차가 한 커밋이다.
    const begun = committed(
      taskCommand(deps, outside, id("drafted"), { kind: "begin_validation" }),
    ).aggregate;
    const parkedOutside = committed(
      taskCommand(deps, begun, id("drafted"), { kind: "complete_validation" }),
    );
    expect(taskEventTypes(parkedOutside.commit, id("drafted"))).toEqual([
      "task_validated",
      "task_awaiting_human",
    ]);
    expect(requireTaskFor(parkedOutside.aggregate, id("drafted")).pendingDecision?.kind).toBe(
      "pre_execution_approval",
    );

    // 대조 (b): 승인이 필요 없는 member 는 재계획 중에도 검증 통과가 커밋된다.
    enterValidation(journal, id("free"), "begin_validation");
    const validated = journal.apply(
      taskCommand(journal.deps, journal.aggregate, id("free"), { kind: "complete_validation" }),
    );
    expect(taskEventTypes(validated, id("free"))).toEqual(["task_validated"]);
    expect(journal.task(id("free")).state).toBe("READY");

    // 대조 (c): 거부로 닫힌 뒤 같은 Task 에 다시 내면 검증 통과와 주차가 한 커밋이다.
    journal.apply(
      proposePlanOn(journal, replanBase(journal, journal.aggregate.work.memberTaskIds)),
    );
    journal.apply(planDecision(journal, "deny"));
    expect(["ACTIVE", "BLOCKED"]).toContain(journal.aggregate.work.state);
    for (const ref of pending) {
      const commit = journal.apply(
        taskCommand(journal.deps, journal.aggregate, id(ref), { kind: "complete_validation" }),
      );
      expect(taskEventTypes(commit, id(ref)), ref).toEqual([
        "task_validated",
        "task_awaiting_human",
      ]);
      expect(journal.task(id(ref)).pendingDecision?.kind, ref).toBe("pre_execution_approval");
    }
  });

  it("Error: 재계획 중 승인 필요 member 의 통과가 아닌 검증 출구(입력 요청·검증 실패·차단)는 그대로 커밋된다 (test_SC010_non_passing_validation_of_approval_pending_member_processed_during_replan)", () => {
    const deps = probeDeps("sc010h2e");
    const drift = withoutTestTypes(deps);
    const { journal, ids } = startJournal(
      [
        draft("anchor"),
        draft("asked", { type: PROBE_TYPE, policy: APPROVAL_POLICY }),
        draft("broken", { policy: APPROVAL_POLICY }),
        draft("stalled", { policy: APPROVAL_POLICY }),
      ],
      deps,
    );
    const id = (ref: string) => ids[ref] as TaskId;
    validate(journal, id("anchor"));
    journal.apply(replanSignal(journal));
    expect(journal.aggregate.work.state).toBe("PLANNING");
    for (const ref of ["asked", "broken", "stalled"])
      enterValidation(journal, id(ref), "begin_validation");

    const requested = journal.apply(
      taskCommand(deps, journal.aggregate, id("asked"), { kind: "complete_validation" }),
    );
    expect(taskEventTypes(requested, id("asked"))).toEqual(["task_input_requested"]);
    expect(journal.task(id("asked")).state).toBe("WAITING_INPUT");

    // 계획 커밋이 막는 구조 무효 입력 — 레코드 패치(다른 생성 경로 대용).
    journal.aggregate = patchTask(journal.aggregate, id("broken"), {
      input: STRUCTURALLY_INVALID_INPUT,
    });
    const failed = journal.apply(
      taskCommand(deps, journal.aggregate, id("broken"), { kind: "complete_validation" }),
    );
    expect(taskEventTypes(failed, id("broken"))).toEqual(["task_validation_failed"]);
    expect(journal.task(id("broken")).state).toBe("FAILED");

    const blocked = journal.apply(
      taskCommand(drift, journal.aggregate, id("stalled"), { kind: "complete_validation" }),
    );
    expect(taskEventTypes(blocked, id("stalled"))).toEqual(["task_blocked"]);
    expect(journal.task(id("stalled")).state).toBe("BLOCKED");
    for (const ref of ["asked", "broken", "stalled"])
      expect(journal.task(id(ref)).pendingDecision, ref).toBeUndefined();
    expect(journal.aggregate.work.state).toBe("PLANNING");

    // 대조: 같은 member 가 채운 입력으로 다시 검증을 통과하려 하면 replan_open 이다.
    enterValidation(journal, id("asked"), "receive_input");
    fillProbeInput(journal, id("asked"));
    expectReplanOpenRefusal(
      taskCommand(deps, journal.aggregate, id("asked"), { kind: "complete_validation" }),
      "asked: passing input during replan",
    );
  });
});

describe("SC-011: 재계획 중에도 열린 attempt 의 결과와 대기 결정 응답은 처리된다", () => {
  function fixture(seed: string) {
    const { journal, ids } = startJournal([draft("run"), draft("waiter")], testDeps(seed));
    const run = ids["run"] as TaskId;
    const waiter = ids["waiter"] as TaskId;
    validate(journal, run);
    validate(journal, waiter);
    start(journal, run);
    park(journal, waiter);
    journal.apply(replanSignal(journal));
    expect(journal.aggregate.work.state).toBe("PLANNING");
    return { journal, run, waiter };
  }

  it("Happy: 열린 attempt 의 완료 결과가 기록되고 member 가 COMPLETED 다 (test_SC011_open_attempt_result_recorded_during_replan)", () => {
    const { journal, run } = fixture("sc011a");
    const attemptId = journal.task(run).openAttempt?.attemptId;
    const commit = complete(journal, run);
    expect(taskEventTypes(commit, run)).toEqual(["task_completed"]);
    expect(journal.task(run).state).toBe("COMPLETED");
    expect(journal.task(run).result?.attemptId).toBe(attemptId);
    expect(journal.aggregate.work.state).toBe("PLANNING");
  });

  it("Edge: 재시도 가능한 실패는 RETRY_WAIT 로 간다 (test_SC011_retryable_failure_enters_retry_wait_during_replan)", () => {
    const { journal, run } = fixture("sc011b");
    const commit = fail(journal, run);
    expect(taskEventTypes(commit, run)).toEqual(["task_retry_wait"]);
    expect(journal.task(run).state).toBe("RETRY_WAIT");
  });

  it("Error: 주차 member 의 사람 grant 는 수용되지만 이어진 start_attempt 는 replan_open 이다 (test_SC011_member_decision_grant_accepted_but_no_new_attempt)", () => {
    const { journal, waiter } = fixture("sc011c");
    const granted = grantTaskDecision(journal, waiter);
    expect(granted.kind).toBe("accepted");
    journal.apply(granted);
    expect(journal.task(waiter).state).toBe("READY");
    const lastAttemptNo = journal.task(waiter).lastAttemptNo;
    expectReplanOpenRefusal(
      taskCommand(journal.deps, journal.aggregate, waiter, { kind: "start_attempt" }),
      "start_attempt after grant",
    );
    expect(journal.task(waiter).lastAttemptNo).toBe(lastAttemptNo);
  });
});

describe("SC-012: 재계획 중 성립한 의존 충족 occurrence 는 원인 커밋에 영속되고, 재계획이 닫힌 뒤 발화한다", () => {
  function fixture(seed: string) {
    const { journal, ids } = startJournal(
      [
        draft("producer"),
        draft("consumer", {
          dependsOn: [{ draftRef: "producer" }],
          trigger: dependencyTrigger("consumer"),
        }),
      ],
      testDeps(seed),
    );
    const producer = ids["producer"] as TaskId;
    const consumer = ids["consumer"] as TaskId;
    validate(journal, producer);
    validate(journal, consumer);
    start(journal, producer);
    expect(journal.task(consumer).state).toBe("READY");
    return { journal, producer, consumer };
  }

  /** 생산자 완료 커밋이 소비자 의존 occurrence 를 영속했는지 확인하고 그 occurrence ID 를 돌려준다. */
  function expectPersistedOccurrence(journal: Journal, completion: DomainCommit, consumer: TaskId) {
    expect(taskEventTypes(completion, consumer)).toEqual(["task_scheduled"]);
    const payload = taskPayload(completion, consumer, "task_scheduled");
    expect(payload["cause"]).toBe("dependency_satisfaction");
    expect(journal.task(consumer).state).toBe("SCHEDULED");
    expect(journal.task(consumer).scheduledOccurrenceId).toBe(payload["occurrenceId"]);
    return payload["occurrenceId"];
  }

  it("Happy: 재계획 중 생산자 완료 커밋에 소비자 task_scheduled{dependency_satisfaction} 가 있고, 발화는 replan_open 이며 보존 커밋으로 닫힌 뒤 같은 발화가 수용된다 (test_SC012_dependency_occurrence_persisted_during_replan_fires_after_commit_close)", () => {
    const { journal, producer, consumer } = fixture("sc012a");
    journal.apply(replanSignal(journal));
    const completion = complete(journal, producer);
    const occurrenceId = expectPersistedOccurrence(journal, completion, consumer);
    expect(journal.aggregate.work.state).toBe("PLANNING");
    const scheduled = journal.task(consumer);
    expectReplanOpenRefusal(fireScheduled(journal, consumer), "fire while replan open");
    expect(journal.task(consumer)).toEqual(scheduled);
    const closing = journal.apply(commitPlan(journal, replanBase(journal, [producer, consumer])));
    expect(eventTypes(closing)).toContain("work_plan_committed");
    expect(taskEventTypes(closing, consumer)).toEqual([]);
    const fired = journal.apply(fireScheduled(journal, consumer));
    expect(taskPayload(fired, consumer, "task_started")["firedOccurrenceId"]).toBe(occurrenceId);
    expect(journal.task(consumer).state).toBe("RUNNING");
  });

  it("Edge: 거부로 닫힌 뒤에도 구간 중 영속된 같은 occurrence 로 발화하고, 닫는 커밋은 새 task_scheduled 를 내지 않는다 (test_SC012_dependency_occurrence_fires_after_reject_close)", () => {
    const { journal, producer, consumer } = fixture("sc012b");
    journal.apply(replanSignal(journal));
    const occurrenceId = expectPersistedOccurrence(journal, complete(journal, producer), consumer);
    journal.apply(proposePlanOn(journal, replanBase(journal, [producer, consumer])));
    expect(journal.aggregate.work.state).toBe("WAITING_APPROVAL");
    expectReplanOpenRefusal(fireScheduled(journal, consumer), "fire while waiting approval");
    const closing = journal.apply(planDecision(journal, "deny"));
    expect(eventTypes(closing)).toEqual(
      expect.arrayContaining(["work_plan_rejected", "work_ready"]),
    );
    expect(eventTypes(closing)).not.toContain("task_scheduled");
    expect(journal.task(consumer).scheduledOccurrenceId).toBe(occurrenceId);
    const fired = journal.apply(fireScheduled(journal, consumer));
    expect(taskPayload(fired, consumer, "task_started")["firedOccurrenceId"]).toBe(occurrenceId);
  });

  it("Error: 재계획 밖의 같은 완료도 그 커밋에 occurrence 를 영속하고 바로 발화가 수용된다(대조) (test_SC012_same_completion_persists_and_fires_outside_replan)", () => {
    const { journal, producer, consumer } = fixture("sc012c");
    const occurrenceId = expectPersistedOccurrence(journal, complete(journal, producer), consumer);
    const fired = journal.apply(fireScheduled(journal, consumer));
    expect(taskPayload(fired, consumer, "task_started")["firedOccurrenceId"]).toBe(occurrenceId);
  });
});

describe("SC-013: 재계획 중 지난 예약 시각 발화는 지연 발화 정책으로 정해진다", () => {
  const LATER = at("2026-01-01T02:00:00Z");

  function fixture(
    seed: string,
    misfires: readonly Parameters<typeof atTrigger>[1][],
    withEventCaused = false,
  ) {
    const drafts = misfires.map((m, i) => draft(`at${i}`, { trigger: atTrigger(`at${i}`, m) }));
    // 사건 원인 SCHEDULED member: 생산자(src) 완료로 의존 활성화된 dep.
    const eventCaused = withEventCaused
      ? [
          draft("src"),
          draft("dep", { dependsOn: [{ draftRef: "src" }], trigger: dependencyTrigger("dep") }),
        ]
      : [];
    const all = [...drafts, draft("plain"), ...eventCaused];
    const { journal, ids } = startJournal(all, testDeps(seed));
    for (const d of all) validate(journal, ids[d.draftRef] as TaskId);
    if (withEventCaused) {
      runToCompleted(journal, ids["src"] as TaskId);
      expect(journal.task(ids["dep"] as TaskId).state).toBe("SCHEDULED");
    }
    journal.apply(replanSignal(journal));
    return { journal, ids };
  }

  function expectedEventCausedFiring(journal: Journal, taskId: TaskId) {
    const task = journal.task(taskId);
    const occurrenceId = task.scheduledOccurrenceId;
    if (occurrenceId === undefined) throw new Error("expected scheduled occurrence");
    const decided = decideTaskTriggerMisfire(journal.deps.registries.triggers, {
      taskId,
      trigger: task.trigger,
      occurrence: { kind: "event_caused", occurrenceId },
      now: LATER,
    });
    if (!decided.ok) throw new Error("expected event-caused decision");
    return { taskId, kind: "decided", decision: decided.value };
  }

  function expectedFiring(journal: Journal, taskId: TaskId) {
    const task = journal.task(taskId);
    const decided = decideTaskTriggerMisfire(journal.deps.registries.triggers, {
      taskId,
      trigger: task.trigger,
      occurrence: { kind: "schedule" },
      now: LATER,
    });
    if (!decided.ok) throw new Error("expected misfire decision");
    return { taskId, kind: "decided", decision: decided.value };
  }

  it("Happy: fire_once_now 의 닫힘 판정이 지연 발화 결정 함수의 같은 입력 결과와 같다 (test_SC013_close_firing_equals_misfire_decision_fire_once_now)", () => {
    const { journal, ids } = fixture("sc013a", [{ kind: "fire_once_now" }]);
    const at0 = ids["at0"] as TaskId;
    journal.apply(commitPlan(journal, replanBase(journal, journal.aggregate.work.memberTaskIds)));
    const firings = decideReplanCloseFirings(journal.deps.registries, journal.aggregate, LATER);
    expect(firings.ok).toBe(true);
    if (!firings.ok) return;
    expect(firings.value).toEqual([expectedFiring(journal, at0)]);
    const only = firings.value[0];
    expect(only?.kind === "decided" ? only.decision.kind : undefined).toBe("fire");
    expect(
      only?.kind === "decided" && only.decision.kind === "fire"
        ? only.decision.scheduledForUtc
        : undefined,
    ).toBe(at("2026-01-01T01:00:00Z"));
  });

  it("Edge: skip·catch_up_bounded 도 같은 입력 결과와 같고 사건 원인 SCHEDULED 는 event_caused 판정, 그 밖 member 는 항목이 없다 (test_SC013_close_firing_skip_and_catch_up)", () => {
    const { journal, ids } = fixture(
      "sc013b",
      [
        { kind: "skip" },
        { kind: "catch_up_bounded", maxCatchUp: 2 },
        { kind: "catch_up_bounded", maxCatchUp: 0 },
      ],
      true,
    );
    journal.apply(commitPlan(journal, replanBase(journal, journal.aggregate.work.memberTaskIds)));
    const firings = decideReplanCloseFirings(journal.deps.registries, journal.aggregate, LATER);
    expect(firings.ok).toBe(true);
    if (!firings.ok) return;
    expect(firings.value).toEqual([
      ...["at0", "at1", "at2"].map((ref) => expectedFiring(journal, ids[ref] as TaskId)),
      expectedEventCausedFiring(journal, ids["dep"] as TaskId),
    ]);
    expect(firings.value.map((f) => (f.kind === "decided" ? f.decision.kind : f.kind))).toEqual([
      "skip",
      "fire",
      "skip",
      "fire",
    ]);
  });

  it("Error: 재계획이 열려 있는 동안 호출하면 replan_still_open 이다 (test_SC013_close_firings_refused_while_open)", () => {
    const { journal } = fixture("sc013c", [{ kind: "fire_once_now" }]);
    expect(decideReplanCloseFirings(journal.deps.registries, journal.aggregate, LATER)).toEqual({
      ok: false,
      error: { kind: "replan_still_open" },
    });
    journal.apply(commitPlan(journal, replanBase(journal, journal.aggregate.work.memberTaskIds)));
    expect(decideReplanCloseFirings(journal.deps.registries, journal.aggregate, LATER).ok).toBe(
      true,
    );
  });

  it("Error: 재계획 중 실패로 끝난 Work 는 닫히지 않았으므로 replan_still_open 이고, 거부로 닫힌 Work 는 판정한다(대조) (test_SC013_close_firings_refused_after_work_failed_during_replan)", () => {
    const failed = fixture("sc013d", [{ kind: "fire_once_now" }]);
    failed.journal.apply(workCommand(failed.journal, { kind: "fail_planning" }));
    expect(failed.journal.aggregate.work.state).toBe("FAILED");
    expect(
      decideReplanCloseFirings(failed.journal.deps.registries, failed.journal.aggregate, LATER),
    ).toEqual({ ok: false, error: { kind: "replan_still_open" } });
    const denied = fixture("sc013e", [{ kind: "fire_once_now" }]);
    denied.journal.apply(
      proposePlanOn(
        denied.journal,
        replanBase(denied.journal, denied.journal.aggregate.work.memberTaskIds),
      ),
    );
    denied.journal.apply(planDecision(denied.journal, "deny"));
    expect(denied.journal.aggregate.work.state).not.toBe("WAITING_APPROVAL");
    const firings = decideReplanCloseFirings(
      denied.journal.deps.registries,
      denied.journal.aggregate,
      LATER,
    );
    expect(firings.ok).toBe(true);
    if (firings.ok)
      expect(firings.value).toEqual([expectedFiring(denied.journal, denied.ids["at0"] as TaskId)]);
  });
});

/**
 * SC-014·SC-016·SC-018 공용: 완료 member(done)·보존할 비종결(keep)·탈락할 비종결(drop)·진행 중 attempt(run)
 * 를 가진 ACTIVE Work 에서 재계획 → 제안(keep 보존 + 새 초안) → 사람 grant 커밋까지.
 */
function membershipReplan(seed: string) {
  const { journal, ids } = startJournal(
    [draft("done"), draft("keep"), draft("drop"), draft("run")],
    testDeps(seed),
  );
  const id = (ref: string) => ids[ref] as TaskId;
  for (const ref of ["done", "keep", "drop", "run"]) validate(journal, id(ref));
  start(journal, id("done"));
  complete(journal, id("done"));
  start(journal, id("run"));
  expect(journal.aggregate.work.state).toBe("ACTIVE");
  journal.apply(replanSignal(journal));
  const beforeCommit = journal.aggregate;
  const proposed = journal.apply(
    proposePlanOn(journal, replanBase(journal, [id("keep")], [draft("fresh")])),
  );
  const commit = journal.apply(planDecision(journal, "grant"));
  return { journal, id, beforeCommit, proposed, commit };
}

describe("SC-014: 재계획은 완료된 Task 를 다시 열지 않는다", () => {
  it("Happy: 보존하지 않은 완료 member 는 superseded 에 있고 상태·revision·식별이 그대로다 (test_SC014_completed_member_superseded_not_reopened)", () => {
    const { journal, id, beforeCommit, commit } = membershipReplan("sc014a");
    const done = id("done");
    expect(payloadOf(commit, "work_plan_committed")["superseded"]).toEqual([done]);
    const before = requireTaskFor(beforeCommit, done);
    const after = journal.task(done);
    expect(after.id).toBe(before.id);
    expect(after.state).toBe("COMPLETED");
    expect(after.revision).toBe(before.revision);
    expect(after.result).toEqual(before.result);
  });

  it("Edge: fold 결과에서 완료 member 는 현재 member 가 아니다 (test_SC014_superseded_member_not_in_fold_membership)", () => {
    const { journal, id } = membershipReplan("sc014b");
    const folded = journal.folded();
    expect(folded.work.memberTaskIds).not.toContain(id("done"));
    expect(folded.work.memberTaskIds).toContain(id("keep"));
    expect(folded.work.taskIds).toContain(id("done"));
  });

  it("Error: 커밋에 완료 Task 를 대상으로 한 이벤트가 없다 (test_SC014_no_reopening_event_for_terminal_member)", () => {
    const { id, commit } = membershipReplan("sc014c");
    expect(taskEventTypes(commit, id("done"))).toEqual([]);
  });
});

describe("SC-015: 탈락 비종결 member 는 같은 커밋에서 replan_dropped 로 취소된다", () => {
  function fixture(seed: string) {
    const { journal, ids } = startJournal(
      [confirmationDraft("confirm"), draft("other"), draft("keep")],
      testDeps(seed),
    );
    const id = (ref: string) => ids[ref] as TaskId;
    for (const ref of ["confirm", "other", "keep"]) validate(journal, id(ref));
    beginConfirmation(journal, id("confirm"));
    expect(journal.task(id("confirm")).state).toBe("WAITING_CONFIRMATION");
    journal.apply(replanSignal(journal));
    journal.apply(proposePlanOn(journal, replanBase(journal, [id("keep")])));
    const commit = journal.apply(planDecision(journal, "grant"));
    const committedEvent = commit.events.find((e) => e.type === "work_plan_committed");
    if (committedEvent === undefined) throw new Error("expected work_plan_committed");
    return { journal, id, commit, committedEventId: committedEvent.id };
  }

  it("Happy: 확인 대기 탈락 member 는 confirmation_cancelled{replan_dropped, workEventId=커밋 이벤트} 다 (test_SC015_dropped_waiting_confirmation_cancelled_with_replan_dropped)", () => {
    const { journal, id, commit, committedEventId } = fixture("sc015a");
    const confirm = id("confirm");
    expect(taskEventTypes(commit, confirm)).toEqual(["confirmation_cancelled"]);
    expect(taskPayload(commit, confirm, "confirmation_cancelled")["origin"]).toEqual({
      kind: "replan_dropped",
      actorSource: "human_local",
      workEventId: committedEventId,
    });
    expect(journal.task(confirm).state).toBe("CANCELED");
    expect(payloadOf(commit, "work_plan_committed")["dropped"]).toEqual([confirm, id("other")]);
  });

  it("Edge: 그 밖 상태의 탈락 member 는 task_canceled{replan_dropped} 다 (test_SC015_dropped_other_state_task_canceled_with_replan_dropped)", () => {
    const { journal, id, commit, committedEventId } = fixture("sc015b");
    const other = id("other");
    expect(taskEventTypes(commit, other)).toEqual(["task_canceled"]);
    expect(taskPayload(commit, other, "task_canceled")["origin"]).toEqual({
      kind: "replan_dropped",
      actorSource: "human_local",
      workEventId: committedEventId,
    });
    expect(journal.task(other).state).toBe("CANCELED");
  });

  it("Error: 보존 member 에는 취소 이벤트가 없다 (test_SC015_retained_member_not_cancelled)", () => {
    const { journal, id, commit } = fixture("sc015c");
    expect(taskEventTypes(commit, id("keep"))).toEqual([]);
    expect(journal.task(id("keep")).state).toBe("READY");
    expect(journal.aggregate.work.memberTaskIds).toEqual([id("keep")]);
  });
});

describe("SC-016: 탈락 Task 의 늦은 결과는 기록되고 적용되지 않는다", () => {
  function lateResult(seed: string) {
    const scenario = membershipReplan(seed);
    const run = scenario.id("run");
    const attemptId = requireTaskFor(scenario.beforeCommit, run).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt before drop");
    const outcome = taskCommand(scenario.journal.deps, scenario.journal.aggregate, run, {
      kind: "record_attempt_outcome",
      attemptId,
      outcome: { kind: "completed", evidence: {} },
    });
    return { ...scenario, run, attemptId, outcome };
  }

  it("Happy: 탈락된 RUNNING 의 attempt 결과는 stale_transition_rejected 로 기록되고 상태·revision 이 그대로다 (test_SC016_late_result_of_dropped_task_recorded_stale)", () => {
    const { journal, run, outcome, beforeCommit, attemptId } = lateResult("sc016a");
    expect(journal.task(run).state).toBe("CANCELED");
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.rejection.reason).toBe("terminal_subject");
    const chain = committedChain(outcome);
    expect(chain.map(eventTypes)).toEqual([["stale_transition_rejected"]]);
    const after = applyCommits(journal.aggregate, chain);
    expect(requireTaskFor(after, run).state).toBe("CANCELED");
    expect(requireTaskFor(after, run).revision).toBe(journal.task(run).revision);
    // 대조: 탈락 전(같은 attempt 가 열려 있을 때)에는 같은 결과가 완료로 기록된다.
    const live = taskCommand(journal.deps, beforeCommit, run, {
      kind: "record_attempt_outcome",
      attemptId,
      outcome: { kind: "completed", evidence: {} },
    });
    expect(live.kind).toBe("committed");
  });

  it("Edge: 탈락 Task 에 결과가 없다 (test_SC016_dropped_task_has_no_result)", () => {
    const { journal, run, outcome } = lateResult("sc016b");
    const after = applyCommits(journal.aggregate, committedChain(outcome));
    expect(requireTaskFor(after, run).result).toBeUndefined();
  });

  it("Error: 탈락 Task 가 다시 member 가 되지 않는다 (test_SC016_dropped_task_stays_non_member)", () => {
    const { journal, run, outcome } = lateResult("sc016c");
    const after = applyCommits(journal.aggregate, committedChain(outcome));
    expect(after.work.memberTaskIds).not.toContain(run);
    expect(journal.aggregate.work.memberTaskIds).not.toContain(run);
  });
});

describe("SC-017: 보존 member 는 식별·revision·attempt 수·대기 결정을 유지한다", () => {
  function fixture(seed: string) {
    const { journal, ids } = startJournal([draft("held")], testDeps(seed));
    const held = ids["held"] as TaskId;
    validate(journal, held);
    start(journal, held);
    fail(journal, held);
    journal.apply(taskCommand(journal.deps, journal.aggregate, held, { kind: "retry_ready" }));
    park(journal, held);
    expect(journal.task(held).state).toBe("BLOCKED_AWAITING_HUMAN");
    expect(journal.task(held).lastAttemptNo).toBe(1);
    journal.apply(replanSignal(journal));
    const before = journal.task(held);
    const commit = journal.apply(
      commitPlan(journal, replanBase(journal, [held], [draft("added")])),
    );
    return { journal, held, before, commit };
  }

  it("Happy: 보존 비종결 member 의 ID·revision·lastAttemptNo·대기 결정이 커밋 전과 같다 (test_SC017_retained_member_keeps_identity_revision_attempts_decision)", () => {
    const { journal, held, before } = fixture("sc017a");
    const after = journal.task(held);
    expect(after.id).toBe(before.id);
    expect(after.revision).toBe(before.revision);
    expect(after.lastAttemptNo).toBe(before.lastAttemptNo);
    expect(after.pendingDecision).toEqual(before.pendingDecision);
    expect(after.state).toBe("BLOCKED_AWAITING_HUMAN");
  });

  it("Edge: 같은 커밋에 보존 member 이벤트가 없다 (test_SC017_retained_member_gets_no_event_in_commit)", () => {
    const { held, commit } = fixture("sc017b");
    expect(eventTypes(commit)).toContain("work_plan_committed");
    expect(taskEventTypes(commit, held)).toEqual([]);
  });

  it("Error: 보존 BLOCKED_AWAITING_HUMAN member 의 결정이 커밋 뒤에도 응답 가능하다 (test_SC017_retained_member_decision_still_answerable)", () => {
    const { journal, held } = fixture("sc017c");
    const granted = grantTaskDecision(journal, held);
    expect(granted.kind).toBe("accepted");
    journal.apply(granted);
    expect(journal.task(held).state).toBe("READY");
  });
});

describe("SC-018: 커밋 이벤트가 membership 을 fold 로 결정한다", () => {
  it("Happy: work_plan_committed 가 제안 ID·digest·n+1·draftRef 대응·세 목록을 싣는다 (test_SC018_commit_event_carries_membership_lists)", () => {
    const { journal, id, beforeCommit, proposed, commit } = membershipReplan("sc018a");
    const proposedPayload = payloadOf(proposed, "work_plan_proposed");
    const committedPayload = payloadOf(commit, "work_plan_committed");
    const fresh = Object.values(journal.aggregate.tasks).find((t) => t.draftRef === "fresh");
    if (fresh === undefined) throw new Error("expected new task");
    expect(committedPayload["proposalId"]).toBe(proposedPayload["proposalId"]);
    expect(String(committedPayload["proposalId"])).toMatch(/^pln_/);
    expect(committedPayload["digest"]).toBe(proposedPayload["digest"]);
    expect(committedPayload["planRevision"]).toBe(beforeCommit.work.planRevision + 1);
    expect(committedPayload["draftRefMap"]).toEqual([{ draftRef: "fresh", taskId: fresh.id }]);
    expect(committedPayload["retained"]).toEqual([id("keep")]);
    expect(committedPayload["superseded"]).toEqual([id("done")]);
    expect(committedPayload["dropped"]).toEqual([id("drop"), id("run")]);
  });

  it("Edge: 이벤트 로그만으로 fold 한 member 집합이 보존 ∪ 새 Task 다 (test_SC018_fold_membership_equals_retained_plus_new)", () => {
    const { journal, id } = membershipReplan("sc018b");
    const fresh = Object.values(journal.aggregate.tasks).find((t) => t.draftRef === "fresh");
    if (fresh === undefined) throw new Error("expected new task");
    expect(journal.folded().work.memberTaskIds).toEqual([id("keep"), fresh.id]);
  });

  it("Error: 라이브 애그리거트와 fold 결과가 같다 (test_SC018_live_and_folded_aggregates_equal)", () => {
    const { journal } = membershipReplan("sc018c");
    expect(journal.folded()).toEqual(journal.aggregate);
  });
});

/**
 * SC-019·SC-020 공용: 완료 member(done)·사람이 거절한 필수 확인 Task(rejected)·실패한 필수 에이전트
 * Task(agent)·비필수 주차 member(waiter) 때문에 BLOCKED 인 Work.
 */
function blockedByRequirements(seed: string) {
  const { journal, ids } = startJournal(
    [
      draft("done"),
      confirmationDraft("rejected"),
      agentGoalDraft("agent"),
      draft("waiter", { policy: nonRequiredPolicy() }),
    ],
    testDeps(seed),
  );
  const id = (ref: string) => ids[ref] as TaskId;
  for (const ref of ["done", "rejected", "agent", "waiter"]) validate(journal, id(ref));
  runToCompleted(journal, id("done"));
  beginConfirmation(journal, id("rejected"));
  journal.apply(confirmationSignal(journal, id("rejected"), "reject"));
  start(journal, id("agent"));
  fail(journal, id("agent"), "fixture_fatal");
  park(journal, id("waiter"));
  expect(journal.task(id("rejected")).state).toBe("REJECTED");
  expect(journal.task(id("agent")).state).toBe("FAILED");
  expect(journal.aggregate.work.state).toBe("BLOCKED");
  return { journal, id };
}

describe("SC-019: 승인된 재계획이 불만족 필수 요구를 대체해 Work 가 완료된다", () => {
  function proposed(seed: string) {
    const { journal, id } = blockedByRequirements(seed);
    const snapshot = { rejected: journal.task(id("rejected")), agent: journal.task(id("agent")) };
    journal.apply(replanSignal(journal));
    journal.apply(
      proposePlanOn(
        journal,
        replanBase(journal, [id("done"), id("waiter")], [draft("replacement")]),
      ),
    );
    expect(journal.aggregate.work.state).toBe("WAITING_APPROVAL");
    return { journal, id, snapshot };
  }

  it("Happy: BLOCKED → 재계획 → 제안 → 사람 grant → 대체 Task 완료 커밋에서 COMPLETED 다 (test_SC019_blocked_work_completes_after_approved_replan)", () => {
    const { journal } = proposed("sc019a");
    const granted = journal.apply(planDecision(journal, "grant"));
    expect(eventTypes(granted)).toContain("work_plan_committed");
    const replacement = Object.values(journal.aggregate.tasks).find(
      (t) => t.draftRef === "replacement",
    );
    if (replacement === undefined) throw new Error("expected replacement task");
    const completion = runToCompleted(journal, replacement.id);
    expect(eventTypes(completion)).toContain("work_completed");
    expect(journal.aggregate.work.state).toBe("COMPLETED");
  });

  it("Edge: 승인 전에는 member 가 새 attempt 를 시작하지 않는다 (test_SC019_no_attempt_before_approval)", () => {
    const { journal, id } = proposed("sc019b");
    journal.apply(grantTaskDecision(journal, id("waiter")));
    expect(journal.task(id("waiter")).state).toBe("READY");
    expectReplanOpenRefusal(
      taskCommand(journal.deps, journal.aggregate, id("waiter"), { kind: "start_attempt" }),
      "start_attempt before approval",
    );
  });

  it("Error: supersede 된 두 Task 의 상태·revision·이력이 그대로다 (test_SC019_superseded_tasks_unchanged)", () => {
    const { journal, id, snapshot } = proposed("sc019c");
    const granted = journal.apply(planDecision(journal, "grant"));
    expect(payloadOf(granted, "work_plan_committed")["superseded"]).toEqual([
      id("rejected"),
      id("agent"),
    ]);
    expect(journal.task(id("rejected"))).toEqual(snapshot.rejected);
    expect(journal.task(id("agent"))).toEqual(snapshot.agent);
    expect(taskEventTypes(granted, id("rejected"))).toEqual([]);
    expect(taskEventTypes(granted, id("agent"))).toEqual([]);
  });
});

describe("SC-020: 재계획 거부는 현재 revision 으로 돌아가 파생 상태를 평가한다", () => {
  it("Happy: BLOCKED 출발 deny 는 [signal_accepted, work_plan_rejected, work_ready, work_blocked] 이고 BLOCKED 다 (test_SC020_reject_from_blocked_returns_blocked_with_row_event)", () => {
    const { journal, id } = blockedByRequirements("sc020a");
    journal.apply(replanSignal(journal));
    journal.apply(
      proposePlanOn(journal, replanBase(journal, [id("done"), id("waiter")], [draft("x")])),
    );
    const denied = journal.apply(planDecision(journal, "deny"));
    expect(eventTypes(denied)).toEqual([
      "signal_accepted",
      "work_plan_rejected",
      "work_ready",
      "work_blocked",
    ]);
    expect(journal.aggregate.work.state).toBe("BLOCKED");
  });

  it("Edge: ACTIVE 출발 deny 는 work_activated 로 ACTIVE 다 (test_SC020_reject_from_active_returns_active_with_row_event)", () => {
    const { journal, member } = activeWork("sc020b");
    journal.apply(replanSignal(journal));
    journal.apply(proposePlanOn(journal, replanBase(journal, [member], [draft("x")])));
    const denied = journal.apply(planDecision(journal, "deny"));
    expect(eventTypes(denied)).toEqual([
      "signal_accepted",
      "work_plan_rejected",
      "work_ready",
      "work_activated",
    ]);
    expect(journal.aggregate.work.state).toBe("ACTIVE");
  });

  it("Error: 거부는 plan revision·member 를 바꾸지 않고 Task 를 만들지 않는다 (test_SC020_reject_keeps_plan_revision_and_members)", () => {
    const { journal, member } = activeWork("sc020c");
    const before = journal.aggregate.work;
    const taskCount = Object.keys(journal.aggregate.tasks).length;
    journal.apply(replanSignal(journal));
    journal.apply(proposePlanOn(journal, replanBase(journal, [member], [draft("x")])));
    const denied = journal.apply(planDecision(journal, "deny"));
    expect(eventTypes(denied)).not.toContain("task_created");
    expect(journal.aggregate.work.planRevision).toBe(before.planRevision);
    expect(journal.aggregate.work.memberTaskIds).toEqual(before.memberTaskIds);
    expect(Object.keys(journal.aggregate.tasks)).toHaveLength(taskCount);
  });
});

describe("SC-021: 새 revision 커밋 뒤 파생 상태 이력이 다시 시작된다", () => {
  function freshOnly(seed: string) {
    const { journal } = activeWork(seed);
    journal.apply(replanSignal(journal));
    journal.apply(proposePlanOn(journal, replanBase(journal, [], [draft("fresh")])));
    const commit = journal.apply(planDecision(journal, "grant"));
    const fresh = Object.values(journal.aggregate.tasks).find((t) => t.draftRef === "fresh");
    if (fresh === undefined) throw new Error("expected fresh task");
    return { journal, commit, fresh: fresh.id };
  }

  it("Happy: 보존 ∅ 커밋 직후 READY 이고, 새 member 가 검증을 벗어나는 커밋에서 ACTIVE 다 (test_SC021_new_revision_ready_then_active_on_member_start)", () => {
    const { journal, fresh } = freshOnly("sc021a");
    expect(journal.aggregate.work.state).toBe("READY");
    journal.apply(
      taskCommand(journal.deps, journal.aggregate, fresh, { kind: "begin_validation" }),
    );
    expect(journal.aggregate.work.state).toBe("READY");
    const validated = journal.apply(
      taskCommand(journal.deps, journal.aggregate, fresh, { kind: "complete_validation" }),
    );
    expect(eventTypes(validated)).toContain("work_activated");
    expect(journal.aggregate.work.state).toBe("ACTIVE");
  });

  it("Edge: 만족 종결 member 를 보존한 커밋 직후 파생 상태는 ACTIVE 다 (test_SC021_retaining_satisfied_member_derives_active_at_commit)", () => {
    const { journal, ids } = startJournal([draft("done"), draft("other")], testDeps("sc021b"));
    const done = ids["done"] as TaskId;
    validate(journal, ids["other"] as TaskId);
    runToCompleted(journal, done);
    journal.apply(replanSignal(journal));
    journal.apply(proposePlanOn(journal, replanBase(journal, [done], [draft("fresh")])));
    const commit = journal.apply(planDecision(journal, "grant"));
    expect(eventTypes(commit)).toContain("work_activated");
    expect(journal.aggregate.work.state).toBe("ACTIVE");
  });

  it("Error: 재계획 전 과정에서 도메인 불변식 오류가 없고 fold 가 라이브와 같다 (test_SC021_no_invariant_error_through_replan)", () => {
    expect(() => {
      const { journal, fresh } = freshOnly("sc021c");
      runToCompleted(journal, fresh);
      expect(journal.aggregate.work.state).toBe("COMPLETED");
      expect(journal.folded()).toEqual(journal.aggregate);
    }).not.toThrow();
  });
});

/** 커밋 하나가 만든 Work 전이 행 ID(`출발>도착:이벤트`). */
function workRowsOf(before: WorkAggregate, commit: DomainCommit): string[] {
  const rows: string[] = [];
  let current = before;
  for (let i = 0; i < commit.events.length; i += 1) {
    const event = commit.events[i];
    if (event === undefined || event.taskId !== undefined) continue;
    const next = evolveCommit(before, commit.events.slice(0, i + 1));
    if (next.work.state !== current.work.state)
      rows.push(`${current.work.state}>${next.work.state}:${event.type}`);
    current = next;
  }
  return rows;
}

describe("SC-053: 재계획 두 진입과 승인 대기 출구가 테스트로 생성된다", () => {
  const TABLE_IDS = new Set<string>(WORK_TRANSITION_ROWS.map((r) => r.id));

  function generatedEntries(): string[] {
    const rows: string[] = [];
    for (const { journal } of [activeWork("sc053a"), blockedWork("sc053b")]) {
      const before = journal.aggregate;
      rows.push(...workRowsOf(before, journal.apply(replanSignal(journal))));
    }
    return rows;
  }

  function generatedExits(): string[] {
    const rows: string[] = [];
    const proposedFrom = (seed: string) => {
      const { journal, member } = activeWork(seed);
      journal.apply(replanSignal(journal));
      journal.apply(proposePlanOn(journal, replanBase(journal, [member], [draft("x")])));
      return journal;
    };
    for (const choice of ["grant", "deny"] as const) {
      const journal = proposedFrom(`sc053${choice}`);
      const before = journal.aggregate;
      rows.push(...workRowsOf(before, journal.apply(planDecision(journal, choice))));
    }
    const withdrawn = proposedFrom("sc053withdraw");
    const before = withdrawn.aggregate;
    rows.push(
      ...workRowsOf(
        before,
        withdrawn.apply(
          executeCommand(withdrawn.deps, withdrawn.aggregate, {
            kind: "withdraw_plan_proposal",
            expectedRevision: withdrawn.aggregate.work.revision,
            meta: meta(NOW),
            cause: "source_changed",
          }),
        ),
      ),
    );
    return rows;
  }

  it("Happy: 생성 전이가 ACTIVE>PLANNING·BLOCKED>PLANNING 재계획 진입을 포함한다 (test_SC053_replan_entries_generated_from_active_and_blocked)", () => {
    expect(generatedEntries()).toEqual([
      "ACTIVE>PLANNING:work_replanning_started",
      "BLOCKED>PLANNING:work_replanning_started",
    ]);
  });

  it("Edge: 재계획 뒤 WAITING_APPROVAL 출구 셋(커밋·거부·철회)이 생성된다 (test_SC053_waiting_approval_exits_after_replan_generated)", () => {
    const exits = generatedExits();
    expect(exits).toEqual(
      expect.arrayContaining([
        "WAITING_APPROVAL>READY:work_plan_committed",
        "WAITING_APPROVAL>READY:work_plan_rejected",
        "WAITING_APPROVAL>PLANNING:work_plan_withdrawn",
      ]),
    );
  });

  it("Error: 생성된 각 행이 Work 전이 표 전사 데이터에 있다 (test_SC053_generated_transitions_in_transcribed_table)", () => {
    const rows = [...generatedEntries(), ...generatedExits()];
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.filter((r) => !TABLE_IDS.has(r))).toEqual([]);
    expect(TABLE_IDS.has("ACTIVE>PLANNING:work_replanning_started")).toBe(true);
  });
});
