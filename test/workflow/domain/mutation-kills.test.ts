// mutation 판정이 지목한 생존 변이를 잡는 판별 테스트. 각 판별 테스트는 가드 조건만 지웠을 때
// 실패하는 입력과, 같은 입력에서 검사 대상만 바꾼 수용 경로(positive 대조)를 함께 둔다.
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  canonicalJson,
  canonicalJsonDigest,
  canonicalJsonFrozenCopy,
  utf8ByteLength,
  checkDataSchema,
  parseDataSchema,
  proveSchemaSubset,
  shapeOf,
  decideTaskCommand,
  decideWorkCommand,
  executeCommand,
  judgeSignal,
  judgeDelegationResponseStaleness,
  nextEntityId,
  validatePlanProposal,
  planMembershipChange,
  judgeMandatoryPlanApproval,
  planPreconditionRejection,
  planProposalDigest,
  decideReplanDroppedCancellations,
  decidePendingProposalRevalidation,
  decideDependencyCascadeRound,
  isActivationSatisfied,
  resolveBoundInputs,
  bindingUnsatisfiedProducerIds,
  DomainInvariantError,
  OUTPUT_SCHEMA_VIOLATION,
  checkReportedOutputs,
  prepareAcceptanceOutputs,
  createTaskTypeRegistry,
  parsePendingDecision,
  validateTask,
  isReplanOpen,
  isReplanWaitHeld,
  decideReplanCloseFirings,
  decideTaskTriggerMisfire,
  scheduleCauseDeclared,
  createDomainRegistries,
  createBuiltinRegistries,
  BUILTIN_TASK_TYPES,
  BUILTIN_TRIGGERS,
  BUILTIN_REACTIONS,
} from "../../../src/workflow/domain/index.js";
import type {
  SchemaShape,
  PlanTaskDraft,
  PlanProposalInput,
  TaskRecord,
  TaskPolicy,
  TaskTypeDescriptor,
  DecisionSignal,
  DelegationResponseSignal,
  DomainDeps,
  TaskCommand,
  TaskId,
  TaskStateName,
  TriggerSpec,
  WorkAggregate,
  WorkCommand,
  WorkStateName,
} from "../../../src/workflow/domain/index.js";
import {
  applyCommits,
  at,
  committedChain,
  controlRequestCancelOrigin,
  draft,
  entityId,
  meta,
  mustCommit,
  patchTask,
  patchWork,
  decidePlan,
  planInput,
  reachTaskState,
  reachWorkState,
  requireTaskFor,
  taskSubjectPendingDecision,
  basePolicy,
  deadLetterDecision,
  mustOk,
  testDeps,
  UNREGISTERED_TASK_TYPE,
} from "./helpers/fixtures.js";
import {
  GENERIC_TASK_TYPE,
  PROBE_CONSUMER_TASK_TYPE,
  PROBE_PRODUCER_TASK_TYPE,
  probeTaskType,
  testRegistries,
} from "./helpers/registry-fixtures.js";
import { eventTypes, payloadOf } from "./helpers/commits.js";
import {
  CONFIRMATION_INPUT,
  CONFIRMATION_TYPE,
  Journal,
  agentGoalDraft,
  atTrigger,
  beginConfirmation,
  confirmationSignal,
  dependencyTrigger,
  fail,
  independentDigest,
  planDecision,
  replanSignal,
  runToCompleted,
  sha256Hex,
  start,
  startJournal,
  taskCommand,
  validate,
} from "./helpers/scenario.js";

describe("SC-007: 계획 승인 grant 의 revision 불일치 분기", () => {
  it("Edge: 승인 대기 Work 에 낡은 revision 의 grant 는 rejected_stale(revision_mismatch)이고, 현재 revision 이면 커밋된다 (test_SC007_work_plan_grant_stale_revision_rejected_with_positive_control)", () => {
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    expect(aggregate.work.pendingDecision?.kind).toBe("plan_approval_required");
    // 판별 입력: 같은 대기 결정(토큰 일치)·사람 출처·승인 대기 상태에서 revision 만 제안 이전 값.
    const staleRevision = aggregate.work.revision - 1;
    const stale = planDecision(new Journal(deps, aggregate, []), "grant", {
      expectedRevision: staleRevision,
    });
    expect(stale.kind).toBe("rejected_stale");
    if (stale.kind === "rejected_stale") {
      expect(stale.reason).toBe("revision_mismatch");
      expect(stale.preceding).toBeUndefined();
    }
    const chain = committedChain(stale);
    expect(chain.map(eventTypes)).toEqual([["signal_rejected_stale"]]);
    const after = applyCommits(aggregate, chain);
    expect(after.work.state).toBe("WAITING_APPROVAL");
    expect(after.work.revision).toBe(aggregate.work.revision);
    expect(after.acceptedSignalKeys).toEqual(aggregate.acceptedSignalKeys);

    const current = planDecision(new Journal(deps, after, []), "grant");
    expect(current.kind).toBe("accepted");
    expect(committedChain(current).flatMap(eventTypes)).toContain("work_plan_committed");
  });
});

// ---- 고위험 분기(revision·출처·상태 적격) 판별 — 전체 mutation 실행이 생존·미커버로 지목한 조건 ----

const KILL_NOW = at("2026-01-01T00:00:00Z");

type TaskCommandBody = DistributiveOmit<TaskCommand, "taskId" | "expectedRevision" | "meta">;
type WorkCommandBody = DistributiveOmit<WorkCommand, "expectedRevision" | "meta">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function decideOnTaskIn(
  state: TaskStateName,
  body: (deps: DomainDeps, taskId: TaskId) => TaskCommandBody,
  trigger?: TriggerSpec,
) {
  const { deps, aggregate, taskId } = reachTaskState(
    state,
    trigger !== undefined ? { trigger } : {},
  );
  const task = requireTaskFor(aggregate, taskId);
  expect(task.state).toBe(state);
  const command = {
    ...body(deps, taskId),
    taskId,
    expectedRevision: task.revision,
    meta: meta(KILL_NOW),
  } as TaskCommand;
  return decideTaskCommand(deps, task, command, aggregate);
}

function decideOnWorkIn(state: WorkStateName, body: (deps: DomainDeps) => WorkCommandBody) {
  const { deps, aggregate } = reachWorkState(state);
  expect(aggregate.work.state).toBe(state);
  const command = {
    ...body(deps),
    expectedRevision: aggregate.work.revision,
    meta: meta(KILL_NOW),
  } as WorkCommand;
  return decideWorkCommand(deps, aggregate, command);
}

function expectNotInTable(outcome: { readonly kind: string; readonly rejection?: unknown }): void {
  expect(outcome).toEqual({ kind: "rejected", rejection: { reason: "transition_not_in_table" } });
}

describe("SC-007: Task 명령 판정의 상태 적격 검사", () => {
  // 공개 판정 함수를 직접 부른다 — 종결 상태 검사는 엔진 사전 검사 뒤에 있어 엔진 경로로는 닿지 않는다.
  it("Error: 허용 행이 없는 상태의 명령은 transition_not_in_table 이고, 같은 명령이 허용 상태에서는 이벤트를 낸다 (test_SC007_task_command_state_guards_reject_outside_rows_with_positive_control)", () => {
    const cases: readonly {
      readonly label: string;
      readonly wrong: TaskStateName;
      readonly right?: TaskStateName;
      readonly body: (deps: DomainDeps, taskId: TaskId) => TaskCommandBody;
      /** 명령이 Trigger 선언과 맞아야 하는 경우의 Task Trigger(두 상태 모두 같은 Trigger). */
      readonly trigger?: TriggerSpec;
    }[] = [
      {
        label: "complete_validation",
        wrong: "DRAFT",
        right: "VALIDATING",
        body: () => ({ kind: "complete_validation" }),
      },
      {
        label: "schedule_task",
        wrong: "DRAFT",
        right: "READY",
        body: () => ({
          kind: "schedule_task",
          occurrenceId: entityId("occurrence", "occ_" + "B".repeat(26)),
          cause: "schedule",
        }),
        trigger: atTrigger("fixture_task", { kind: "skip" }),
      },
      {
        label: "unschedule_task",
        wrong: "READY",
        right: "SCHEDULED",
        body: () => ({ kind: "unschedule_task" }),
      },
      {
        label: "start_attempt",
        wrong: "DRAFT",
        right: "READY",
        body: () => ({ kind: "start_attempt" }),
      },
      {
        label: "begin_confirmation_wait",
        wrong: "DRAFT",
        right: "READY",
        body: (deps) => ({
          kind: "begin_confirmation_wait",
          confirmationId: nextEntityId(deps.ids, "confirmation"),
        }),
      },
      {
        label: "park_awaiting_human",
        wrong: "DRAFT",
        body: (deps, taskId) => ({
          kind: "park_awaiting_human",
          cause: "unattended_eligibility_refused",
          decision: taskSubjectPendingDecision(deps, taskId, KILL_NOW),
        }),
      },
      {
        label: "abandon_retries",
        wrong: "READY",
        right: "RETRY_WAIT",
        body: () => ({ kind: "abandon_retries", cause: "retries_abandoned" }),
      },
      { label: "expire", wrong: "DRAFT", body: () => ({ kind: "expire" }) },
      {
        label: "emit_reminder",
        wrong: "READY",
        right: "WAITING_CONFIRMATION",
        body: () => ({
          kind: "emit_reminder",
          occurrenceId: entityId("occurrence", "occ_" + "C".repeat(26)),
        }),
      },
      {
        label: "cancel_task",
        wrong: "COMPLETED",
        right: "READY",
        body: (deps) => ({ kind: "cancel_task", origin: controlRequestCancelOrigin(deps) }),
      },
      {
        label: "skip_task",
        wrong: "COMPLETED",
        right: "READY",
        body: () => ({ kind: "skip_task", reason: { kind: "misfire_skip" } }),
      },
      {
        label: "record_attempt_outcome",
        wrong: "READY",
        body: () => ({
          kind: "record_attempt_outcome",
          attemptId: entityId("attempt", "att_" + "F".repeat(26)),
          outcome: { kind: "completed", evidence: {} },
        }),
      },
      {
        label: "present_late_result",
        wrong: "READY",
        body: () => ({
          kind: "present_late_result",
          attemptId: entityId("attempt", "att_" + "D".repeat(26)),
          resultContentHash: "0".repeat(64) as never,
        }),
      },
    ];
    for (const c of cases) {
      expectNotInTable(decideOnTaskIn(c.wrong, c.body, c.trigger));
      if (c.right !== undefined) {
        expect(decideOnTaskIn(c.right, c.body, c.trigger).kind, c.label).toBe("events");
      }
    }
  });
});

describe("SC-007: Work 명령 판정의 상태 적격 검사", () => {
  // 공개 판정 함수를 직접 부른다 — 종결 Work 검사는 엔진 사전 검사 뒤에 있어 엔진 경로로는 닿지 않는다.
  it("Error: 허용 행이 없는 상태의 Work 명령은 transition_not_in_table 이고, 같은 명령이 허용 상태에서는 이벤트를 낸다 (test_SC007_work_command_state_guards_reject_outside_rows_with_positive_control)", () => {
    const cases: readonly {
      readonly label: string;
      readonly wrong: readonly WorkStateName[];
      readonly right: WorkStateName;
      readonly body: (deps: DomainDeps) => WorkCommandBody;
    }[] = [
      {
        label: "request_work_input",
        wrong: ["DRAFT"],
        right: "PLANNING",
        body: () => ({ kind: "request_work_input", requests: [] }),
      },
      {
        label: "receive_work_input",
        wrong: ["PLANNING"],
        right: "WAITING_INPUT",
        body: () => ({ kind: "receive_work_input" }),
      },
      {
        label: "propose_plan",
        wrong: ["DRAFT"],
        right: "PLANNING",
        body: () => ({
          kind: "propose_plan",
          plan: planInput([draft("kill_member")]),
          summary: "kill",
        }),
      },
      {
        label: "commit_plan",
        wrong: ["DRAFT"],
        right: "PLANNING",
        body: () => ({ kind: "commit_plan", plan: planInput([draft("kill_member")]) }),
      },
      {
        label: "fail_planning",
        wrong: ["DRAFT"],
        right: "PLANNING",
        body: () => ({ kind: "fail_planning" }),
      },
      {
        label: "withdraw_plan_proposal",
        wrong: ["PLANNING"],
        right: "WAITING_APPROVAL",
        body: () => ({ kind: "withdraw_plan_proposal", cause: "source_changed" }),
      },
      {
        label: "cancel_work",
        wrong: ["COMPLETED", "FAILED", "CANCELED"],
        right: "ACTIVE",
        body: (deps) => ({ kind: "cancel_work", origin: controlRequestCancelOrigin(deps) }),
      },
    ];
    for (const c of cases) {
      for (const wrong of c.wrong) expectNotInTable(decideOnWorkIn(wrong, c.body));
      expect(decideOnWorkIn(c.right, c.body).kind, c.label).toBe("events");
    }
  });

  it("Edge: 낡은 revision 의 Work 명령은 기록 없이 revision_mismatch 로 거절되고, 현재 revision 이면 커밋된다 (test_SC007_work_command_stale_revision_rejected_with_positive_control)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const stale = executeCommand(deps, aggregate, {
      kind: "fail_planning",
      expectedRevision: aggregate.work.revision - 1,
      meta: meta(KILL_NOW),
    });
    expect(stale).toEqual({ kind: "rejected", rejection: { reason: "revision_mismatch" } });
    const current = executeCommand(deps, aggregate, {
      kind: "fail_planning",
      expectedRevision: aggregate.work.revision,
      meta: meta(KILL_NOW),
    });
    expect(current.kind).toBe("committed");
  });
});

function humanDecision(
  decisionId: NonNullable<WorkAggregate["work"]["pendingDecision"]>["id"],
  expectedRevision: number,
  deps: DomainDeps,
): DecisionSignal {
  return {
    type: "human_decision",
    decisionId,
    choice: "grant",
    signalId: nextEntityId(deps.ids, "signal"),
    expectedRevision,
    actorSource: "human_local",
    receivedAt: KILL_NOW,
  };
}

describe("SC-007: 신호 판정의 revision·상태 적격 검사", () => {
  it("Error: 확인 대기가 아닌 비종결 Task 에 토큰이 맞는 확인 결정은 unexpected_state 로 거절되고, 확인 대기면 수용된다 (test_SC007_confirmation_decision_outside_waiting_rejected_with_positive_control)", () => {
    const { deps, aggregate, taskId } = reachTaskState("WAITING_CONFIRMATION");
    const task = requireTaskFor(aggregate, taskId);
    const signal = (): DecisionSignal => ({
      type: "confirmation_decision",
      taskId,
      confirmationId: task.confirmationId as NonNullable<typeof task.confirmationId>,
      decision: "accept",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: KILL_NOW,
    });
    // 다른 생성 경로 대용: 확인 토큰을 가진 채 확인 대기를 벗어난 비종결 Task 는 전이로 만들 수 없다.
    const moved = patchTask(aggregate, taskId, { state: "READY" });
    const refused = judgeSignal(deps, moved, signal(), { kind: "none" }, KILL_NOW);
    expect(refused.kind).toBe("rejected");
    if (refused.kind === "rejected") expect(refused.reason).toBe("unexpected_state");
    expect(judgeSignal(deps, aggregate, signal(), { kind: "none" }, KILL_NOW).kind).toBe(
      "accepted",
    );
  });

  it("Edge: Task 주체 결정의 낡은 revision grant 는 rejected_stale(revision_mismatch)이고, 대기 결정이 있는 비대기 상태는 unexpected_state, 현재 revision·대기 상태면 수용된다 (test_SC007_task_decision_revision_and_state_guards_with_positive_control)", () => {
    const { deps, aggregate, taskId } = reachTaskState("BLOCKED_AWAITING_HUMAN");
    const task = requireTaskFor(aggregate, taskId);
    const decisionId = task.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected pending decision");
    const grant = (agg: WorkAggregate, revision: number) =>
      judgeSignal(
        deps,
        agg,
        humanDecision(decisionId as never, revision, deps),
        { kind: "task_grant", resume: { to: "READY" } },
        KILL_NOW,
      );
    const stale = grant(aggregate, task.revision - 1);
    expect(stale.kind).toBe("rejected_stale");
    if (stale.kind === "rejected_stale") expect(stale.reason).toBe("revision_mismatch");
    // 다른 생성 경로 대용: 대기 결정을 가진 채 사람 대기를 벗어난 비종결 Task 는 전이로 만들 수 없다.
    const moved = patchTask(aggregate, taskId, { state: "READY" });
    const refused = grant(moved, task.revision);
    expect(refused.kind).toBe("rejected");
    if (refused.kind === "rejected") expect(refused.reason).toBe("unexpected_state");
    expect(grant(aggregate, task.revision).kind).toBe("accepted");
  });

  it("Edge: 종결된 Work 의 계획 grant 는 terminal_subject 낡음이고, 승인 대기가 아닌 비종결 Work 는 unexpected_state, 승인 대기면 수용된다 (test_SC007_work_decision_terminal_and_state_guards_with_positive_control)", () => {
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    const decisionId = aggregate.work.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected pending plan decision");
    const canceled = mustCommit(
      executeCommand(deps, aggregate, {
        kind: "cancel_work",
        expectedRevision: aggregate.work.revision,
        meta: meta(KILL_NOW),
        origin: controlRequestCancelOrigin(deps),
      }),
    ).aggregate;
    expect(canceled.work.state).toBe("CANCELED");
    const grant = (agg: WorkAggregate) =>
      judgeSignal(
        deps,
        agg,
        humanDecision(decisionId, agg.work.revision, deps),
        { kind: "plan_grant" },
        KILL_NOW,
      );
    const terminal = grant(canceled);
    expect(terminal.kind).toBe("rejected_stale");
    if (terminal.kind === "rejected_stale") expect(terminal.reason).toBe("terminal_subject");
    // 다른 생성 경로 대용: 대기 결정을 가진 채 승인 대기를 벗어난 비종결 Work 는 전이로 만들 수 없다.
    const moved = patchWork(aggregate, { state: "PLANNING" });
    const refused = grant(moved);
    expect(refused.kind).toBe("rejected");
    if (refused.kind === "rejected") expect(refused.reason).toBe("unexpected_state");
    expect(grant(aggregate).kind).toBe("accepted");
  });

  it("Error: 종결된 Work 의 현재 revision 재계획 요청은 terminal_subject 낡음이고, ACTIVE Work 면 수용된다 (test_SC007_replan_request_on_terminal_work_stale_with_positive_control)", () => {
    const request = (deps: DomainDeps, agg: WorkAggregate) =>
      judgeSignal(
        deps,
        agg,
        {
          type: "replan_requested",
          workId: agg.work.id,
          signalId: nextEntityId(deps.ids, "signal"),
          expectedRevision: agg.work.revision,
          actorSource: "human_local",
          receivedAt: KILL_NOW,
        },
        { kind: "none" },
        KILL_NOW,
      );
    const completed = reachWorkState("COMPLETED");
    const terminal = request(completed.deps, completed.aggregate);
    expect(terminal.kind).toBe("rejected_stale");
    if (terminal.kind === "rejected_stale") expect(terminal.reason).toBe("terminal_subject");
    const active = reachWorkState("ACTIVE");
    expect(request(active.deps, active.aggregate).kind).toBe("accepted");
  });

  it("Edge: 종결 Task 의 현재 revision 위임 응답은 terminal_subject 낡음이고, 비종결·현재 revision 이면 낡음 검사를 통과한다 (test_SC007_delegation_response_terminal_and_revision_with_positive_control)", () => {
    const judge = (state: TaskStateName) => {
      const { deps, aggregate, taskId } = reachTaskState(state);
      const task = requireTaskFor(aggregate, taskId);
      const signal: DelegationResponseSignal = {
        type: "delegation_response",
        taskId,
        occurrenceId: entityId("occurrence", "occ_" + "E".repeat(26)),
        responseContentHash: "1".repeat(64) as never,
        signalId: nextEntityId(deps.ids, "signal"),
        expectedRevision: task.revision,
        actorSource: "agent_session",
        receivedAt: KILL_NOW,
      };
      return judgeDelegationResponseStaleness(deps, aggregate, signal, undefined, KILL_NOW);
    };
    const terminal = judge("COMPLETED");
    expect(terminal.kind).toBe("rejected_stale");
    if (terminal.kind === "rejected_stale") expect(terminal.reason).toBe("terminal_subject");
    expect(judge("RUNNING").kind).toBe("staleness_passed");
  });
});

// ---- 결과 결합 호환성 증명 — 판독(shapeOf)과 증명 규칙(proveSchemaSubset)의 분기별 판별 ----

/** 런타임 우회: 판독은 zod 정의 표면(`def`·검사 `_zod.def`)만 읽는다 — 그 표면이 어긋난 값을 직접 넘긴다. */
const fakeSchema = (def: unknown): z.ZodType => ({ def }) as unknown as z.ZodType;
const fakeCheck = (def: unknown) => ({ _zod: { def } });

const SH = {
  unknown: { k: "unknown" } as SchemaShape,
  opaque: { k: "opaque" } as SchemaShape,
  str: (min = 0, max?: number): SchemaShape =>
    max === undefined ? { k: "string", min } : { k: "string", min, max },
  num: (int = false, lower?: [number, boolean], upper?: [number, boolean]): SchemaShape => ({
    k: "number",
    int,
    ...(lower !== undefined ? { lower: { value: lower[0], inclusive: lower[1] } } : {}),
    ...(upper !== undefined ? { upper: { value: upper[0], inclusive: upper[1] } } : {}),
  }),
  bool: { k: "boolean" } as SchemaShape,
  nul: { k: "null" } as SchemaShape,
  lit: (...values: (string | number | boolean | null)[]): SchemaShape => ({ k: "literal", values }),
  arr: (item: SchemaShape, min = 0, max?: number): SchemaShape =>
    max === undefined ? { k: "array", item, min } : { k: "array", item, min, max },
  obj: (
    props: Record<string, [SchemaShape, boolean]>,
    extra: SchemaShape | "none" = "none",
  ): SchemaShape => ({
    k: "object",
    props: Object.fromEntries(
      Object.entries(props).map(([key, [shape, optional]]) => [key, { shape, optional }]),
    ),
    extra,
  }),
  union: (...options: SchemaShape[]): SchemaShape => ({ k: "union", options }),
  inter: (...parts: SchemaShape[]): SchemaShape => ({ k: "intersection", parts }),
  opt: (inner: SchemaShape): SchemaShape => ({ k: "optional", inner }),
};

describe("SC-038: 호환성 증명의 스키마 판독", () => {
  it("Edge: 화이트리스트 판독이 형별 검사·경계·형태를 정확히 읽고, 그 밖은 불투명이다 (test_SC038_schema_shape_reading_exact_per_branch)", () => {
    const cases: [string, z.ZodType, "producer" | "consumer", SchemaShape][] = [
      ["unknown", z.unknown(), "producer", SH.unknown],
      ["any", z.any(), "consumer", SH.unknown],
      ["unknown+refine", z.unknown().refine(() => true), "producer", SH.opaque],
      ["string", z.string(), "producer", SH.str(0)],
      ["string min", z.string().min(2), "producer", SH.str(2)],
      ["string max", z.string().max(5), "producer", SH.str(0, 5)],
      ["string length", z.string().length(3), "producer", SH.str(3, 3)],
      ["string min min", z.string().min(4).min(2), "producer", SH.str(4)],
      ["string min min asc", z.string().min(2).min(4), "producer", SH.str(4)],
      ["string max max", z.string().max(3).max(5), "producer", SH.str(0, 3)],
      ["string max max desc", z.string().max(5).max(3), "producer", SH.str(0, 3)],
      ["string min then length", z.string().min(4).length(2), "producer", SH.str(4, 2)],
      ["string length then min", z.string().length(2).min(1), "producer", SH.str(2, 2)],
      ["string max then length", z.string().max(3).length(5), "producer", SH.str(5, 3)],
      ["string length then max", z.string().length(5).max(7), "producer", SH.str(5, 5)],
      ["string regex", z.string().regex(/^a/), "producer", SH.opaque],
      ["string format", z.email(), "producer", SH.opaque],
      ["coerce", z.coerce.string(), "producer", SH.opaque],
      ["number", z.number(), "producer", SH.num()],
      ["int format", z.int(), "producer", SH.num(true)],
      ["int32 format", z.int32(), "producer", SH.opaque],
      ["int check", z.number().int(), "producer", SH.num(true)],
      ["gt", z.number().gt(1), "producer", SH.num(false, [1, false])],
      ["gte", z.number().gte(1), "producer", SH.num(false, [1, true])],
      ["lt", z.number().lt(5), "producer", SH.num(false, undefined, [5, false])],
      ["lte", z.number().lte(5), "producer", SH.num(false, undefined, [5, true])],
      ["gt gt", z.number().gt(3).gt(1), "producer", SH.num(false, [3, false])],
      ["gt gt asc", z.number().gt(1).gt(3), "producer", SH.num(false, [3, false])],
      ["gte gt same", z.number().gte(2).gt(2), "producer", SH.num(false, [2, false])],
      ["gt gte same", z.number().gt(2).gte(2), "producer", SH.num(false, [2, false])],
      ["gte gte same", z.number().gte(2).gte(2), "producer", SH.num(false, [2, true])],
      ["lt lt", z.number().lt(3).lt(5), "producer", SH.num(false, undefined, [3, false])],
      ["lt lt desc", z.number().lt(5).lt(3), "producer", SH.num(false, undefined, [3, false])],
      ["lte lt same", z.number().lte(2).lt(2), "producer", SH.num(false, undefined, [2, false])],
      ["lt lte same", z.number().lt(2).lte(2), "producer", SH.num(false, undefined, [2, false])],
      ["lte lte same", z.number().lte(2).lte(2), "producer", SH.num(false, undefined, [2, true])],
      ["multipleOf", z.number().multipleOf(2), "producer", SH.opaque],
      ["boolean", z.boolean(), "producer", SH.bool],
      ["boolean refine", z.boolean().refine(() => true), "producer", SH.opaque],
      ["null", z.null(), "producer", SH.nul],
      ["null refine", z.null().refine(() => true), "producer", SH.opaque],
      ["literal", z.literal("a"), "producer", SH.lit("a")],
      ["literal multi", z.literal(["a", 1, true, null]), "producer", SH.lit("a", 1, true, null)],
      ["literal NaN", z.literal(Number.NaN), "producer", SH.opaque],
      ["literal undefined", z.literal(undefined), "producer", SH.opaque],
      ["literal refine", z.literal("a").refine(() => true), "producer", SH.opaque],
      ["enum", z.enum(["a", "b"]), "consumer", SH.lit("a", "b")],
      ["enum duplicate values", z.enum({ A: "x", B: "x", C: "y" }), "consumer", SH.lit("x", "y")],
      ["enum numeric", z.enum({ A: 0, B: 1, "0": "A", "1": "B" }), "consumer", SH.lit(0, 1)],
      ["enum refine", z.enum(["a"]).refine(() => true), "consumer", SH.opaque],
      ["array", z.array(z.string()), "producer", SH.arr(SH.str())],
      ["array bounds", z.array(z.null()).min(1).max(3), "producer", SH.arr(SH.nul, 1, 3)],
      ["array refine", z.array(z.null()).refine(() => true), "producer", SH.opaque],
      [
        "strict object",
        z.strictObject({ a: z.string(), b: z.number().optional() }),
        "consumer",
        SH.obj({ a: [SH.str(), false], b: [SH.num(), true] }),
      ],
      ["strip producer", z.object({ a: z.null() }), "producer", SH.obj({ a: [SH.nul, false] })],
      [
        "strip consumer",
        z.object({ a: z.null() }),
        "consumer",
        SH.obj({ a: [SH.nul, false] }, SH.unknown),
      ],
      ["loose", z.looseObject({}), "producer", SH.obj({}, SH.unknown)],
      ["catchall", z.object({}).catchall(z.string()), "producer", SH.obj({}, SH.str())],
      ["object refine", z.object({}).refine(() => true), "producer", SH.opaque],
      ["union", z.union([z.string(), z.null()]), "consumer", SH.union(SH.str(), SH.nul)],
      ["xor producer", z.xor([z.string(), z.null()]), "producer", SH.union(SH.str(), SH.nul)],
      ["xor consumer", z.xor([z.string(), z.null()]), "consumer", SH.opaque],
      ["union refine", z.union([z.string()]).refine(() => true), "consumer", SH.opaque],
      [
        "intersection consumer",
        z.intersection(z.string(), z.string().min(1)),
        "consumer",
        SH.inter(SH.str(), SH.str(1)),
      ],
      ["intersection producer", z.intersection(z.string(), z.string()), "producer", SH.opaque],
      [
        "intersection refine",
        z.intersection(z.string(), z.string()).refine(() => true),
        "consumer",
        SH.opaque,
      ],
      ["optional", z.string().optional(), "producer", SH.opt(SH.str())],
      [
        "optional refine",
        z
          .string()
          .optional()
          .refine(() => true),
        "producer",
        SH.opaque,
      ],
      ["nullable", z.string().nullable(), "producer", SH.union(SH.str(), SH.nul)],
      [
        "nullable refine",
        z
          .string()
          .nullable()
          .refine(() => true),
        "producer",
        SH.opaque,
      ],
      ["default", z.string().default("a"), "producer", SH.opaque],
      ["transform", z.string().transform((s) => s), "producer", SH.opaque],
      ["date", z.date(), "producer", SH.opaque],
    ];
    // 정확 일치 — 값이 undefined 인 키(빠져야 할 경계·상한)가 끼어도 실패한다.
    for (const [name, schema, side, expected] of cases)
      expect(shapeOf(schema, side), name).toStrictEqual(expected);
    // 속성은 선언 순서대로 열거 가능한 키로 남는다.
    const ordered = shapeOf(z.strictObject({ b: z.string(), a: z.null() }), "producer");
    expect(ordered.k === "object" ? Object.keys(ordered.props) : []).toEqual(["b", "a"]);
    // 자기 참조: 판독 중인 스키마를 다시 만나면 그 자리는 불투명이다.
    const Node: z.ZodType = z.strictObject({
      get child() {
        return Node.optional();
      },
    });
    expect(shapeOf(Node, "producer")).toEqual(SH.obj({ child: [SH.opaque, true] }));
    // 같은 스키마를 형제 자리에서 두 번 만나는 것은 순환이 아니다.
    const leaf = z.string();
    expect(shapeOf(z.strictObject({ a: leaf, b: leaf }), "producer")).toEqual(
      SH.obj({ a: [SH.str(), false], b: [SH.str(), false] }),
    );
  });

  it("Error: 정의 표면이 기대 형태가 아니면 판독은 불투명으로 떨어진다 (test_SC038_schema_shape_malformed_definition_opaque)", () => {
    const opaqueCases: [string, unknown][] = [
      ["no def", undefined],
      ["type not string", { type: 1 }],
      ["checks not array", { type: "string", checks: "x" }],
      ["check not record", { type: "string", checks: [null] }],
      ["check without inner def", { type: "string", checks: [{ _zod: {} }] }],
      ["check inner not record", { type: "string", checks: [{ _zod: null }] }],
      [
        "min not integer",
        { type: "string", checks: [fakeCheck({ check: "min_length", minimum: 1.5 })] },
      ],
      [
        "min negative",
        { type: "string", checks: [fakeCheck({ check: "min_length", minimum: -1 })] },
      ],
      [
        "max not integer",
        { type: "string", checks: [fakeCheck({ check: "max_length", maximum: "2" })] },
      ],
      [
        "length not integer",
        {
          type: "array",
          element: fakeSchema({ type: "null" }),
          checks: [fakeCheck({ check: "length_equals", length: 0.5 })],
        },
      ],
      ["format other", { type: "number", format: "float32" }],
      [
        "number check format other",
        { type: "number", checks: [fakeCheck({ check: "number_format", format: "int32" })] },
      ],
      [
        "bound NaN",
        {
          type: "number",
          checks: [fakeCheck({ check: "greater_than", value: Number.NaN, inclusive: true })],
        },
      ],
      [
        "bound value string",
        {
          type: "number",
          checks: [fakeCheck({ check: "less_than", value: "1", inclusive: true })],
        },
      ],
      [
        "bound inclusive missing",
        { type: "number", checks: [fakeCheck({ check: "less_than", value: 1 })] },
      ],
      [
        "lower inclusive missing",
        { type: "number", checks: [fakeCheck({ check: "greater_than", value: 1 })] },
      ],
      ["literal values missing", { type: "literal" }],
      ["literal infinity", { type: "literal", values: [Number.POSITIVE_INFINITY] }],
      ["enum entries missing", { type: "enum" }],
      ["enum boolean value", { type: "enum", entries: { a: true } }],
      ["enum null value", { type: "enum", entries: { a: null } }],
      ["object shape missing", { type: "object" }],
      ["object catchall not schema", { type: "object", shape: {}, catchall: {} }],
      ["union options missing", { type: "union" }],
      ["union options empty", { type: "union", options: [] }],
      ["def null", null],
      ["checks number", { type: "string", checks: 5 }],
      [
        "unknown length check kind",
        { type: "string", checks: [fakeCheck({ check: "length_like", length: 2 })] },
      ],
      [
        "unknown bound check kind",
        { type: "number", checks: [fakeCheck({ check: "bound_like", value: 1, inclusive: true })] },
      ],
      ["literal with undefined", { type: "literal", values: ["a", undefined] }],
      ["enum string and boolean", { type: "enum", entries: { a: "x", b: true } }],
      ["enum NaN and string", { type: "enum", entries: { a: Number.NaN, b: "x" } }],
    ];
    for (const [name, def] of opaqueCases)
      expect(shapeOf(fakeSchema(def), "producer"), name).toEqual(SH.opaque);
    expect(shapeOf({} as unknown as z.ZodType, "producer")).toEqual(SH.opaque);
    expect(shapeOf(null as unknown as z.ZodType, "producer")).toEqual(SH.opaque);
    // 대조: 같은 표면이 기대 형태면 읽힌다.
    expect(
      shapeOf(
        fakeSchema({
          type: "number",
          checks: [
            fakeCheck({ check: "greater_than", value: 1, inclusive: true }),
            fakeCheck({ check: "less_than", value: 2, inclusive: false }),
            fakeCheck({ check: "number_format", format: "safeint" }),
          ],
        }),
        "producer",
      ),
    ).toEqual(SH.num(true, [1, true], [2, false]));
    expect(
      shapeOf(
        fakeSchema({
          type: "string",
          checks: [
            fakeCheck({ check: "min_length", minimum: 0 }),
            fakeCheck({ check: "max_length", maximum: 0 }),
          ],
        }),
        "producer",
      ),
    ).toEqual(SH.str(0, 0));
    // 검사 종류가 판독을 정한다 — 다른 종류의 경계 속성이 함께 있어도 읽지 않는다.
    expect(
      shapeOf(
        fakeSchema({
          type: "string",
          checks: [fakeCheck({ check: "max_length", maximum: 3, minimum: 1 })],
        }),
        "producer",
      ),
    ).toStrictEqual(SH.str(0, 3));
    expect(
      shapeOf(
        fakeSchema({
          type: "string",
          checks: [fakeCheck({ check: "length_equals", length: 2, maximum: 5 })],
        }),
        "producer",
      ),
    ).toStrictEqual(SH.str(2, 2));
    expect(
      shapeOf(
        fakeSchema({ type: "object", shape: {}, catchall: fakeSchema({ type: "never" }) }),
        "consumer",
      ),
    ).toEqual(SH.obj({}));
    expect(
      shapeOf(
        fakeSchema({ type: "object", shape: {}, catchall: fakeSchema({ type: "null" }) }),
        "consumer",
      ),
    ).toEqual(SH.obj({}, SH.nul));
  });
});

describe("SC-038: 호환성 증명 규칙", () => {
  it("Edge: 증명 규칙의 각 분기가 성립·불성립 경계에서 정확하다 (test_SC038_schema_subset_rules_exact_per_branch)", () => {
    const cases: [string, SchemaShape, SchemaShape, boolean][] = [
      // 1
      ["consumer unknown over opaque", SH.opaque, SH.unknown, true],
      ["producer opaque", SH.opaque, SH.str(), false],
      ["consumer opaque", SH.str(), SH.opaque, false],
      ["empty union producer vs opaque", SH.union(), SH.opaque, false],
      ["producer unknown", SH.unknown, SH.str(), false],
      // 2
      ["optional both", SH.opt(SH.str(1)), SH.opt(SH.str()), true],
      ["optional both inner fails", SH.opt(SH.str()), SH.opt(SH.str(1)), false],
      ["optional producer only", SH.opt(SH.str()), SH.str(), false],
      ["optional consumer only", SH.str(1), SH.opt(SH.str()), true],
      ["optional consumer inner fails", SH.str(), SH.opt(SH.str(1)), false],
      // 3
      ["union producer all", SH.union(SH.str(), SH.nul), SH.union(SH.nul, SH.str()), true],
      ["union producer one fails", SH.union(SH.str(), SH.bool), SH.str(), false],
      ["intersection producer", SH.inter(SH.str(), SH.str()), SH.str(), false],
      // 4
      ["intersection consumer all", SH.str(1), SH.inter(SH.str(), SH.str(1)), true],
      ["intersection consumer one fails", SH.str(), SH.inter(SH.str(), SH.str(1)), false],
      ["union consumer some", SH.str(), SH.union(SH.nul, SH.str()), true],
      ["union consumer none", SH.bool, SH.union(SH.nul, SH.str()), false],
      // 5 literal → accepts
      ["literal strings", SH.lit("a", "bc"), SH.str(1), true],
      ["literal short", SH.lit("", "a"), SH.str(1), false],
      ["literal long", SH.lit("abc"), SH.str(0, 2), false],
      ["literal at max", SH.lit("ab"), SH.str(0, 2), true],
      ["literal number vs string", SH.lit(1), SH.str(), false],
      ["literal string vs number", SH.lit("1"), SH.num(), false],
      ["literal int", SH.lit(1, 2), SH.num(true), true],
      ["literal non-int", SH.lit(1.5), SH.num(true), false],
      ["literal non-int ok", SH.lit(1.5), SH.num(false), true],
      ["literal infinity", SH.lit(Number.POSITIVE_INFINITY), SH.num(false), false],
      ["literal lower incl", SH.lit(5), SH.num(false, [5, true]), true],
      ["literal lower excl", SH.lit(5), SH.num(false, [5, false]), false],
      ["literal below lower", SH.lit(4), SH.num(false, [5, true]), false],
      ["literal above lower excl", SH.lit(6), SH.num(false, [5, false]), true],
      ["literal upper incl", SH.lit(5), SH.num(false, undefined, [5, true]), true],
      ["literal upper excl", SH.lit(5), SH.num(false, undefined, [5, false]), false],
      ["literal above upper", SH.lit(6), SH.num(false, undefined, [5, true]), false],
      ["literal below upper excl", SH.lit(4), SH.num(false, undefined, [5, false]), true],
      ["literal boolean", SH.lit(true, false), SH.bool, true],
      ["literal non-boolean", SH.lit("true"), SH.bool, false],
      ["literal null", SH.lit(null), SH.nul, true],
      ["literal non-null", SH.lit(0), SH.nul, false],
      ["literal null vs string", SH.lit(null), SH.str(), false],
      ["literal in literal", SH.lit("a"), SH.lit("a", "b"), true],
      ["literal not in literal", SH.lit("c"), SH.lit("a", "b"), false],
      ["literal vs array", SH.lit("a"), SH.arr(SH.unknown), false],
      ["literal vs object", SH.lit("a"), SH.obj({}, SH.unknown), false],
      // 6 string
      ["string min ok", SH.str(1), SH.str(0), true],
      ["string min short", SH.str(0), SH.str(1), false],
      ["string max unbounded producer", SH.str(0), SH.str(0, 5), false],
      ["string max equal", SH.str(0, 5), SH.str(0, 5), true],
      ["string max over", SH.str(0, 6), SH.str(0, 5), false],
      ["string vs number", SH.str(), SH.num(), false],
      // number
      ["int to non-int", SH.num(true), SH.num(false), true],
      ["non-int to int", SH.num(false), SH.num(true), false],
      ["int to int", SH.num(true), SH.num(true), true],
      ["number vs string", SH.num(), SH.str(), false],
      ["lower missing consumer", SH.num(false, [1, true]), SH.num(), true],
      ["lower missing producer", SH.num(), SH.num(false, [1, true]), false],
      ["lower higher", SH.num(false, [3, true]), SH.num(false, [2, false]), true],
      ["lower lower", SH.num(false, [1, false]), SH.num(false, [2, true]), false],
      ["lower equal consumer incl", SH.num(false, [2, true]), SH.num(false, [2, true]), true],
      [
        "lower equal consumer excl producer incl",
        SH.num(false, [2, true]),
        SH.num(false, [2, false]),
        false,
      ],
      ["lower equal both excl", SH.num(false, [2, false]), SH.num(false, [2, false]), true],
      ["upper missing consumer", SH.num(false, undefined, [1, true]), SH.num(), true],
      ["upper missing producer", SH.num(), SH.num(false, undefined, [1, true]), false],
      [
        "upper lower value",
        SH.num(false, undefined, [1, true]),
        SH.num(false, undefined, [2, false]),
        true,
      ],
      [
        "upper higher value",
        SH.num(false, undefined, [3, false]),
        SH.num(false, undefined, [2, true]),
        false,
      ],
      [
        "upper equal consumer incl",
        SH.num(false, undefined, [2, true]),
        SH.num(false, undefined, [2, true]),
        true,
      ],
      [
        "upper equal consumer excl producer incl",
        SH.num(false, undefined, [2, true]),
        SH.num(false, undefined, [2, false]),
        false,
      ],
      [
        "upper equal both excl",
        SH.num(false, undefined, [2, false]),
        SH.num(false, undefined, [2, false]),
        true,
      ],
      // boolean·null
      ["boolean", SH.bool, SH.bool, true],
      ["boolean to both literals", SH.bool, SH.lit(false, true), true],
      ["boolean to true only", SH.bool, SH.lit(true), false],
      ["boolean to false only", SH.bool, SH.lit(false), false],
      ["boolean to string", SH.bool, SH.str(), false],
      ["null", SH.nul, SH.nul, true],
      ["null to literal null", SH.nul, SH.lit(null), false],
      ["null to string", SH.nul, SH.str(), false],
      // array
      ["array", SH.arr(SH.str(1), 1, 2), SH.arr(SH.str(), 0, 3), true],
      ["array item fails", SH.arr(SH.str()), SH.arr(SH.str(1)), false],
      ["array length fails", SH.arr(SH.str(), 0), SH.arr(SH.str(), 1), false],
      ["array max fails", SH.arr(SH.str(), 0), SH.arr(SH.str(), 0, 3), false],
      ["array vs string", SH.arr(SH.str()), SH.str(), false],
      // object
      ["object same", SH.obj({ a: [SH.str(), false] }), SH.obj({ a: [SH.str(), false] }), true],
      ["object vs string", SH.obj({}), SH.str(), false],
      [
        "object prop optional to required",
        SH.obj({ a: [SH.str(), true] }),
        SH.obj({ a: [SH.str(), false] }),
        false,
      ],
      [
        "object prop optional to optional",
        SH.obj({ a: [SH.str(), true] }),
        SH.obj({ a: [SH.str(), true] }),
        true,
      ],
      [
        "object prop required to optional",
        SH.obj({ a: [SH.str(), false] }),
        SH.obj({ a: [SH.str(), true] }),
        true,
      ],
      [
        "object prop shape fails",
        SH.obj({ a: [SH.str(), false] }),
        SH.obj({ a: [SH.num(), false] }),
        false,
      ],
      ["object consumer required missing", SH.obj({}), SH.obj({ a: [SH.str(), false] }), false],
      ["object consumer optional missing none", SH.obj({}), SH.obj({ a: [SH.str(), true] }), true],
      [
        "object consumer optional missing extra fits",
        SH.obj({}, SH.str(1)),
        SH.obj({ a: [SH.str(), true] }, SH.unknown),
        true,
      ],
      [
        "object consumer optional missing extra fails",
        SH.obj({}, SH.str()),
        SH.obj({ a: [SH.num(), true] }, SH.unknown),
        false,
      ],
      [
        "object producer-only prop consumer none",
        SH.obj({ b: [SH.str(), false] }),
        SH.obj({}),
        false,
      ],
      [
        "object producer-only prop consumer extra fits",
        SH.obj({ b: [SH.str(), false] }),
        SH.obj({}, SH.str()),
        true,
      ],
      [
        "object producer-only prop consumer extra fails",
        SH.obj({ b: [SH.str(), false] }),
        SH.obj({}, SH.num()),
        false,
      ],
      ["object producer extra consumer none", SH.obj({}, SH.str()), SH.obj({}), false],
      [
        "object producer-only literal prop consumer none",
        SH.obj({ a: [SH.str(), false], x: [SH.lit("v"), false] }),
        SH.obj({ a: [SH.str(), false] }),
        false,
      ],
      ["object producer literal extra consumer none", SH.obj({}, SH.lit("v")), SH.obj({}), false],
      ["object producer extra fits", SH.obj({}, SH.str(1)), SH.obj({}, SH.str()), true],
      ["object producer extra fails", SH.obj({}, SH.str()), SH.obj({}, SH.str(1)), false],
      ["object producer none consumer extra", SH.obj({}), SH.obj({}, SH.num()), true],
    ];
    for (const [name, producer, consumer, expected] of cases)
      expect(proveSchemaSubset(producer, consumer), name).toBe(expected);
  });
});

// ---- dataSchema 허용 목록 — 이슈 목록 전체(코드·경로·키워드·순서)를 단언한다 ----

describe("SC-040: dataSchema 허용 목록·구조 규칙의 이슈 목록", () => {
  type Issue = { code: string; path: (string | number)[]; keyword?: string };
  const at = (code: string, path: (string | number)[], keyword?: string): Issue =>
    keyword === undefined ? { code, path } : { code, path, keyword };

  it("Edge: 각 규칙이 정해진 코드·경로·키워드로 이슈를 내고, 허용 형태는 이슈가 없다 (test_SC040_data_schema_issue_list_exact_per_rule)", () => {
    const cases: [string, unknown, Issue[]][] = [
      ["empty object", {}, []],
      ["boolean child allowed", { type: "array", items: true }, []],
      [
        "annotations skipped",
        {
          title: "t",
          description: "d",
          $comment: "c",
          examples: [1],
          default: 1,
          deprecated: true,
          readOnly: true,
          writeOnly: false,
          type: "number",
        },
        [],
      ],
      [
        "unknown keyword",
        { type: "string", format: "email" },
        [at("keyword_not_allowed", [], "format")],
      ],
      ["oneOf", { oneOf: [{ type: "string" }] }, [at("keyword_not_allowed", [], "oneOf")]],
      ["allOf", { allOf: [{ type: "string" }] }, [at("keyword_not_allowed", [], "allOf")]],
      // type
      ["type string", { type: "string" }, []],
      [
        "type all names",
        { type: ["string", "number", "integer", "boolean", "null", "object", "array"] },
        [],
      ],
      ["type unknown name", { type: "date" }, [at("keyword_value_invalid", [], "type")]],
      ["type empty array", { type: [] }, [at("keyword_value_invalid", [], "type")]],
      ["type duplicate", { type: ["string", "string"] }, [at("keyword_value_invalid", [], "type")]],
      ["type non-string entry", { type: ["string", 1] }, [at("keyword_value_invalid", [], "type")]],
      [
        "type unknown entry",
        { type: ["string", "date"] },
        [at("keyword_value_invalid", [], "type")],
      ],
      ["type number value", { type: 1 }, [at("keyword_value_invalid", [], "type")]],
      // enum·const
      ["enum", { enum: ["a", 1, true, null] }, []],
      ["enum empty", { enum: [] }, [at("keyword_value_invalid", [], "enum")]],
      ["enum object entry", { enum: [{}] }, [at("keyword_value_invalid", [], "enum")]],
      [
        "enum primitive then object",
        { enum: ["a", {}] },
        [at("keyword_value_invalid", [], "enum")],
      ],
      ["enum not array", { enum: "a" }, [at("keyword_value_invalid", [], "enum")]],
      ["const", { const: "a" }, []],
      ["const null", { const: null }, []],
      ["const object", { const: {} }, [at("keyword_value_invalid", [], "const")]],
      [
        "enum with type",
        { enum: ["a"], type: "string" },
        [at("enum_const_with_siblings", [], "enum")],
      ],
      [
        "const with type",
        { const: 1, type: "number" },
        [at("enum_const_with_siblings", [], "const")],
      ],
      ["enum with annotation", { enum: ["a"], title: "t" }, []],
      // properties·required·additionalProperties
      [
        "object",
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          additionalProperties: false,
        },
        [],
      ],
      [
        "properties not object",
        { type: "object", properties: [] },
        [at("keyword_value_invalid", [], "properties")],
      ],
      [
        "properties null",
        { type: "object", properties: null },
        [at("keyword_value_invalid", [], "properties")],
      ],
      [
        "required not array",
        { type: "object", required: "a" },
        [at("keyword_value_invalid", [], "required")],
      ],
      [
        "required non-string",
        { type: "object", properties: { a: {} }, required: [1] },
        [at("keyword_value_invalid", [], "required")],
      ],
      [
        "required missing property",
        { type: "object", properties: { a: {} }, required: ["a", "b"] },
        [at("required_not_in_properties", ["required", 1])],
      ],
      [
        "required without properties",
        { type: "object", required: ["a"] },
        [at("required_not_in_properties", ["required", 0])],
      ],
      [
        "required inherited name",
        { type: "object", properties: {}, required: ["toString"] },
        [at("required_not_in_properties", ["required", 0])],
      ],
      [
        "additionalProperties schema",
        { type: "object", additionalProperties: { type: "string" } },
        [],
      ],
      [
        "additionalProperties nested issue",
        { type: "object", additionalProperties: { format: "x" } },
        [at("keyword_not_allowed", ["additionalProperties"], "format")],
      ],
      [
        "additionalProperties invalid",
        { type: "object", additionalProperties: 1 },
        [at("keyword_value_invalid", [], "additionalProperties")],
      ],
      [
        "additionalProperties array",
        { type: "object", additionalProperties: [] },
        [at("keyword_value_invalid", [], "additionalProperties")],
      ],
      [
        "nested property issue",
        { type: "object", properties: { b: { format: "x" }, a: "s" } },
        [
          at("schema_not_object_or_boolean", ["properties", "a"]),
          at("keyword_not_allowed", ["properties", "b"], "format"),
        ],
      ],
      ["property boolean", { type: "object", properties: { a: true, b: false } }, []],
      [
        "property null",
        { type: "object", properties: { a: null } },
        [at("schema_not_object_or_boolean", ["properties", "a"])],
      ],
      [
        "property array",
        { type: "object", properties: { a: [] } },
        [at("schema_not_object_or_boolean", ["properties", "a"])],
      ],
      // 형별 키워드
      ["minLength without type", { minLength: 1 }, [at("keyword_without_type", [], "minLength")]],
      [
        "maxLength wrong type",
        { type: "number", maxLength: 1 },
        [at("keyword_without_type", [], "maxLength")],
      ],
      ["minimum integer", { type: "integer", minimum: 0 }, []],
      ["maximum integer", { type: "integer", maximum: 1 }, []],
      ["exclusiveMinimum number", { type: "number", exclusiveMinimum: 0 }, []],
      ["exclusiveMinimum integer", { type: "integer", exclusiveMinimum: 0 }, []],
      ["exclusiveMaximum integer", { type: "integer", exclusiveMaximum: 1 }, []],
      ["maximum without type", { maximum: 0 }, [at("keyword_without_type", [], "maximum")]],
      [
        "exclusiveMinimum string type",
        { type: "string", exclusiveMinimum: 0 },
        [at("keyword_without_type", [], "exclusiveMinimum")],
      ],
      ["exclusiveMaximum number", { type: "number", exclusiveMaximum: 1.5 }, []],
      [
        "properties without type",
        { properties: {} },
        [at("keyword_without_type", [], "properties")],
      ],
      ["required without type", { required: [] }, [at("keyword_without_type", [], "required")]],
      [
        "additionalProperties without type",
        { additionalProperties: true },
        [at("keyword_without_type", [], "additionalProperties")],
      ],
      ["items without type", { items: true }, [at("keyword_without_type", [], "items")]],
      ["type list includes", { type: ["null", "string"], minLength: 1 }, []],
      // 개수·경계 값
      ["minLength 0", { type: "string", minLength: 0 }, []],
      ["minLength 1", { type: "string", minLength: 1 }, []],
      [
        "minLength 2",
        { type: "string", minLength: 2 },
        [at("keyword_value_invalid", [], "minLength")],
      ],
      [
        "minLength string",
        { type: "string", minLength: "1" },
        [at("keyword_value_invalid", [], "minLength")],
      ],
      ["maxLength 0", { type: "string", maxLength: 0 }, []],
      ["maxLength large", { type: "string", maxLength: 9 }, []],
      [
        "maxLength negative",
        { type: "string", maxLength: -1 },
        [at("keyword_value_invalid", [], "maxLength")],
      ],
      [
        "maxLength fraction",
        { type: "string", maxLength: 1.5 },
        [at("keyword_value_invalid", [], "maxLength")],
      ],
      [
        "maxLength string",
        { type: "string", maxLength: "2" },
        [at("keyword_value_invalid", [], "maxLength")],
      ],
      [
        "maxLength unsafe",
        { type: "string", maxLength: 2 ** 53 },
        [at("keyword_value_invalid", [], "maxLength")],
      ],
      ["minItems with items", { type: "array", items: true, minItems: 0 }, []],
      [
        "maxItems without items",
        { type: "array", maxItems: 2 },
        [at("keyword_without_items", [], "maxItems")],
      ],
      [
        "minItems without items",
        { type: "array", minItems: 2 },
        [at("keyword_without_items", [], "minItems")],
      ],
      [
        "minItems invalid",
        { type: "array", items: true, minItems: -1 },
        [at("keyword_value_invalid", [], "minItems")],
      ],
      [
        "minimum string",
        { type: "number", minimum: "0" },
        [at("keyword_value_invalid", [], "minimum")],
      ],
      [
        "minimum boolean",
        { type: "number", minimum: true },
        [at("keyword_value_invalid", [], "minimum")],
      ],
      ["maximum negative fraction", { type: "number", maximum: -0.5 }, []],
      // items·anyOf
      ["items schema", { type: "array", items: { type: "string" } }, []],
      [
        "items nested issue",
        { type: "array", items: { format: "x" } },
        [at("keyword_not_allowed", ["items"], "format")],
      ],
      ["items invalid", { type: "array", items: 1 }, [at("keyword_value_invalid", [], "items")]],
      ["items array", { type: "array", items: [{}] }, [at("keyword_value_invalid", [], "items")]],
      ["anyOf", { anyOf: [{ type: "string" }, true] }, []],
      ["anyOf with annotation", { anyOf: [{ type: "string" }], description: "d" }, []],
      ["anyOf empty", { anyOf: [] }, [at("keyword_value_invalid", [], "anyOf")]],
      ["anyOf not array", { anyOf: {} }, [at("keyword_value_invalid", [], "anyOf")]],
      [
        "anyOf with type",
        { anyOf: [{}], type: "object" },
        [at("combinator_with_siblings", [], "anyOf")],
      ],
      [
        "anyOf nested issue",
        { anyOf: [{ type: "string" }, { format: "x" }, 3] },
        [
          at("keyword_not_allowed", ["anyOf", 1], "format"),
          at("schema_not_object_or_boolean", ["anyOf", 2]),
        ],
      ],
      // __proto__
      [
        "property named __proto__",
        JSON.parse('{"type":"object","properties":{"__proto__":{},"a":{}}}') as unknown,
        [at("forbidden_property_name", ["properties", "__proto__"])],
      ],
      [
        "schema key __proto__",
        JSON.parse('{"__proto__":{}}') as unknown,
        [at("keyword_not_allowed", [], "__proto__")],
      ],
      // 여러 이슈의 순서(키 정렬 순회)
      [
        "order",
        { type: "string", minLength: 5, format: "x", enum: ["a"] },
        [
          at("enum_const_with_siblings", [], "enum"),
          at("keyword_not_allowed", [], "format"),
          at("keyword_value_invalid", [], "minLength"),
        ],
      ],
    ];
    for (const [name, schema, expected] of cases)
      expect(checkDataSchema(schema), name).toEqual(expected);
  });

  it("Error: 루트·정규 JSON·깊이 검사가 정해진 이슈를 내고 변환 실패는 conversion_failed 다 (test_SC040_data_schema_root_depth_and_conversion)", () => {
    expect(checkDataSchema(true)).toEqual([at("schema_not_object_or_boolean", [])]);
    expect(checkDataSchema([])).toEqual([at("schema_not_object_or_boolean", [])]);
    expect(checkDataSchema(null)).toEqual([at("schema_not_object_or_boolean", [])]);
    expect(checkDataSchema("s")).toEqual([at("schema_not_object_or_boolean", [])]);
    expect(checkDataSchema({ type: "number", minimum: Number.NaN })).toEqual([
      at("schema_not_json", ["minimum"]),
    ]);
    expect(checkDataSchema(undefined)).toEqual([at("schema_not_json", [])]);
    // 깊이: 루트 1 — 깊이 32 까지 허용, 33 은 too_deep.
    const nest = (depth: number): unknown =>
      depth === 1 ? { type: "string" } : { type: "array", items: nest(depth - 1) };
    expect(checkDataSchema(nest(32))).toEqual([]);
    const tooDeepPath = Array.from({ length: 32 }, () => "items");
    expect(checkDataSchema(nest(33))).toEqual([at("too_deep", tooDeepPath)]);
    expect(checkDataSchema({ type: "array", items: true })).toEqual([]);
    // 속성·anyOf 하위도 한 단계씩 깊어진다(그 아래는 items 로 이어 정규 JSON 깊이 안에 둔다).
    const viaProperty = (depth: number): unknown => ({
      type: "object",
      properties: { p: nest(depth - 1) },
    });
    expect(checkDataSchema(viaProperty(32))).toEqual([]);
    expect(checkDataSchema(viaProperty(33))).toEqual([
      at("too_deep", ["properties", "p", ...Array.from({ length: 31 }, () => "items")]),
    ]);
    const viaAnyOf = (depth: number): unknown => ({ anyOf: [nest(depth - 1)] });
    expect(checkDataSchema(viaAnyOf(32))).toEqual([]);
    expect(checkDataSchema(viaAnyOf(33))).toEqual([
      at("too_deep", ["anyOf", 0, ...Array.from({ length: 31 }, () => "items")]),
    ]);
    // 변환: 허용 형태는 변환되고 주석 키워드는 결과 판정에 영향이 없다.
    const parsed = parseDataSchema({
      title: "root",
      type: "object",
      properties: {
        title: { type: "string", description: "a property named title" },
        list: { type: "array", items: { type: "number", default: 3 } },
        either: { anyOf: [{ type: "string", examples: ["x"] }, { type: "null" }] },
        more: { type: "object", additionalProperties: { type: "boolean", $comment: "c" } },
      },
      required: ["title"],
      additionalProperties: false,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.safeParse({ title: "t" }).success).toBe(true);
      expect(parsed.value.safeParse({}).success).toBe(false);
      expect(parsed.value.safeParse({ title: "t", list: [1] }).success).toBe(true);
      expect(parsed.value.safeParse({ title: "t", list: [undefined] }).success).toBe(false);
      expect(parsed.value.safeParse({ title: "t", either: null }).success).toBe(true);
      expect(parsed.value.safeParse({ title: "t", either: 1 }).success).toBe(false);
      expect(parsed.value.safeParse({ title: "t", more: { x: true } }).success).toBe(true);
      expect(parsed.value.safeParse({ title: "t", more: { x: 1 } }).success).toBe(false);
      expect(parsed.value.safeParse({ title: "t", extra: 1 }).success).toBe(false);
    }
    // 주석 키워드를 걷어낸 사본으로 변환한다 — 기본값이 파싱 결과를 바꾸지 않는다.
    const withDefault = parseDataSchema({
      type: "object",
      properties: { n: { type: "number", default: 7 } },
    });
    expect(withDefault.ok && withDefault.value.parse({})).toEqual({});
    // 추가 속성·anyOf 자리의 기본값도 걷어낸다 — 빠진 값이 기본값으로 채워지지 않는다.
    const extraDefault = parseDataSchema({
      type: "object",
      additionalProperties: { type: "string", default: "x" },
    });
    expect(extraDefault.ok && extraDefault.value.safeParse({ a: undefined }).success).toBe(false);
    expect(extraDefault.ok && extraDefault.value.safeParse({ a: "y" }).success).toBe(true);
    const anyOfDefault = parseDataSchema({
      anyOf: [{ type: "string", default: "x" }, { type: "null" }],
    });
    expect(anyOfDefault.ok && anyOfDefault.value.safeParse(undefined).success).toBe(false);
    expect(anyOfDefault.ok && anyOfDefault.value.safeParse(null).success).toBe(true);
  });
});

// ---- 정규 JSON — 직렬화 문자열·실패 사유·경로·UTF-8 길이의 정확 단언 ----

describe("SC-022: 정규 JSON 직렬화", () => {
  it("Edge: 값마다 정규 JSON 문자열이 정확하고, 실패는 사유·경로로 보고된다 (test_SC022_canonical_json_exact_output_and_failures)", () => {
    const ok: [string, unknown, string][] = [
      ["null", null, "null"],
      ["true", true, "true"],
      ["false", false, "false"],
      ["number", 1.5, "1.5"],
      ["negative zero", -0, "0"],
      ["exponent", 1e21, "1e+21"],
      ["string", 'a"b\\c\n', JSON.stringify('a"b\\c\n')],
      ["surrogate pair", "\u{1F600}", JSON.stringify("\u{1F600}")],
      ["private use after surrogates", "\uE000", JSON.stringify("\uE000")],
      ["highest high + lowest low", "\uDBFF\uDC00", JSON.stringify("\uDBFF\uDC00")],
      ["lowest high + lowest low", "\uD800\uDC00", JSON.stringify("\uD800\uDC00")],
      ["lowest high + highest low", "\uD800\uDFFF", JSON.stringify("\uD800\uDFFF")],
      ["array", [1, "a", null, [true]], '[1,"a",null,[true]]'],
      ["empty array", [], "[]"],
      ["empty object", {}, "{}"],
      ["sorted keys", { b: 1, a: { d: 2, c: 3 }, A: 0 }, '{"A":0,"a":{"c":3,"d":2},"b":1}'],
      ["undefined member skipped", { a: undefined, b: 1 }, '{"b":1}'],
      ["null prototype", Object.assign(Object.create(null) as object, { z: 1 }), '{"z":1}'],
      ["shared sibling", ((x: object) => ({ a: x, b: x }))({ v: 1 }), '{"a":{"v":1},"b":{"v":1}}'],
      ["shared array sibling", ((x: unknown[]) => [x, x])([1]), "[[1],[1]]"],
    ];
    for (const [name, value, expected] of ok)
      expect(canonicalJson(value), name).toEqual({ ok: true, value: expected });

    const failures: [string, unknown, string, (string | number)[]][] = [
      ["infinity", { a: [Number.POSITIVE_INFINITY] }, "non_finite_number", ["a", 0]],
      ["NaN", Number.NaN, "non_finite_number", []],
      ["top undefined", undefined, "unsupported_type", []],
      ["function", { f: () => 1 }, "unsupported_type", ["f"]],
      ["symbol", [Symbol("s")], "unsupported_type", [0]],
      ["bigint", { n: 1n }, "unsupported_type", ["n"]],
      ["lone high surrogate", { s: "a\uD800" }, "lone_surrogate", ["s"]],
      ["lone high then other", { s: "\uD800a" }, "lone_surrogate", ["s"]],
      ["lone low surrogate", ["\uDC00"], "lone_surrogate", [0]],
      ["lone surrogate key", { "\uDFFF": 1 }, "lone_surrogate", ["\uDFFF"]],
      ["high then private use", "\uD800\uE000", "lone_surrogate", []],
      ["two low surrogates", "\uDC00\uDC00", "lone_surrogate", []],
      ["failure after sibling key", { a: 1, b: Number.NaN }, "non_finite_number", ["b"]],
      ["undefined in array", [1, undefined], "undefined_in_array", [1]],
      ["date", { d: new Date(0) }, "non_plain_object", ["d"]],
      ["map", new Map(), "non_plain_object", []],
      ["array subclass", { a: new (class extends Array {})() }, "non_plain_object", ["a"]],
      ["typed array", new Uint8Array(1), "non_plain_object", []],
    ];
    for (const [name, value, reason, path] of failures)
      expect(canonicalJson(value), name).toEqual({
        ok: false,
        error: { kind: "canonical_json", reason, path },
      });
    const cyclic: Record<string, unknown> = { a: { b: {} } };
    (cyclic["a"] as Record<string, Record<string, unknown>>)["b"]!["c"] = cyclic;
    expect(canonicalJson(cyclic)).toEqual({
      ok: false,
      error: { kind: "canonical_json", reason: "cycle", path: ["a", "b", "c"] },
    });
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    expect(canonicalJson(cyclicArray)).toEqual({
      ok: false,
      error: { kind: "canonical_json", reason: "cycle", path: [0] },
    });
    // 깊이: 컨테이너 64 단계까지 허용, 65 단계는 too_deep.
    const nest = (depth: number): unknown => (depth === 0 ? 1 : [nest(depth - 1)]);
    expect(canonicalJson(nest(64)).ok).toBe(true);
    expect(canonicalJson(nest(65))).toEqual({
      ok: false,
      error: {
        kind: "canonical_json",
        reason: "too_deep",
        path: Array.from({ length: 64 }, () => 0),
      },
    });
    const nestObject = (depth: number): unknown => (depth === 0 ? 1 : { k: nestObject(depth - 1) });
    expect(canonicalJson(nestObject(64)).ok).toBe(true);
    expect(canonicalJson(nestObject(65)).ok).toBe(false);
    // getter 가 던지는 예외는 정규 JSON 실패가 아니라 그대로 전파된다.
    const throwing = {
      get boom(): never {
        throw new RangeError("getter");
      },
    };
    expect(() => canonicalJson(throwing)).toThrow(RangeError);
  });

  it("Error: digest·동결 사본은 정규 JSON 실패를 그대로 돌려주고 성공이면 같은 문자열에서 만든다 (test_SC022_canonical_digest_and_frozen_copy_follow_canonical_json)", () => {
    const failure = {
      ok: false,
      error: { kind: "canonical_json", reason: "unsupported_type", path: ["f"] },
    };
    expect(canonicalJsonDigest({ f: () => 1 })).toEqual(failure);
    expect(canonicalJsonFrozenCopy({ f: () => 1 })).toEqual(failure);
    expect(canonicalJsonDigest({ b: 1, a: 2 })).toEqual({
      ok: true,
      value: sha256Hex('{"a":2,"b":1}'),
    });
    const copy = canonicalJsonFrozenCopy({ b: [1, { c: null }], a: undefined });
    expect(copy).toEqual({ ok: true, value: { b: [1, { c: null }] } });
    if (copy.ok) {
      const value = copy.value as { b: [number, { c: null }] };
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.b)).toBe(true);
      expect(Object.isFrozen(value.b[1])).toBe(true);
    }
    expect(canonicalJsonFrozenCopy("s")).toEqual({ ok: true, value: "s" });
  });
});

describe("SC-045: UTF-8 바이트 길이", () => {
  it("Edge: 코드 포인트 경계마다 바이트 수가 정확하다 (test_SC045_utf8_byte_length_code_point_boundaries)", () => {
    const cases: [string, number][] = [
      ["", 0],
      ["\u007F", 1],
      ["\u0080", 2],
      ["߿", 2],
      ["ࠀ", 3],
      ["￿", 3],
      ["\u{10000}", 4],
      ["\u{10FFFF}", 4],
      ["aé中\u{1F600}", 1 + 2 + 3 + 4],
    ];
    for (const [text, bytes] of cases)
      expect(utf8ByteLength(text), JSON.stringify(text)).toBe(bytes);
  });
});

// ---- 계획 결합 검사 — 결합 선언 형태·참조·생산자·증명 분기의 판별 ----

const KILL_PRODUCER = {
  id: PROBE_PRODUCER_TASK_TYPE.id,
  version: PROBE_PRODUCER_TASK_TYPE.version,
};
const KILL_CONSUMER = {
  id: PROBE_CONSUMER_TASK_TYPE.id,
  version: PROBE_CONSUMER_TASK_TYPE.version,
};

/** 선택 출력·strip 객체 출력을 내는 생산자 — 판독 측(생산자/소비자)과 선택 출력 풀기를 가른다. */
const SHAPED_PRODUCER_TASK_TYPE: TaskTypeDescriptor = {
  ...PROBE_PRODUCER_TASK_TYPE,
  id: "probe_shaped_producer",
  outputs: { maybe: z.string().min(1).optional(), record: z.object({ a: z.string() }) },
};
/** strict 객체 입력 필드를 가진 소비자. */
const STRICT_CONSUMER_TASK_TYPE: TaskTypeDescriptor = {
  ...PROBE_CONSUMER_TASK_TYPE,
  id: "probe_strict_consumer",
  schema: z.strictObject({
    text: z.string().min(1),
    obj: z.strictObject({ a: z.string() }).optional(),
  }),
};
const SHAPED_PRODUCER = { id: SHAPED_PRODUCER_TASK_TYPE.id, version: 1 };
const STRICT_CONSUMER = { id: STRICT_CONSUMER_TASK_TYPE.id, version: 1 };

function killBindingDeps(seed: string): DomainDeps {
  return testDeps(
    seed,
    testRegistries({
      taskTypes: [
        PROBE_PRODUCER_TASK_TYPE,
        PROBE_CONSUMER_TASK_TYPE,
        SHAPED_PRODUCER_TASK_TYPE,
        STRICT_CONSUMER_TASK_TYPE,
      ],
    }),
  );
}

const optionalPolicy = () => basePolicy({ terminalRequired: false });

function producerDraft(ref: string, overrides?: Partial<PlanTaskDraft>): PlanTaskDraft {
  return draft(ref, { type: KILL_PRODUCER, input: {}, policy: optionalPolicy(), ...overrides });
}

/** 결합 소비자 초안 — 결합 선언은 런타임 우회로 임의 값을 싣는다. */
function consumerDraft(
  ref: string,
  bindings: unknown,
  overrides?: Partial<PlanTaskDraft>,
): PlanTaskDraft {
  return draft(ref, {
    type: KILL_CONSUMER,
    input: {},
    dependsOn: [{ draftRef: "p" }],
    trigger: dependencyTrigger(ref),
    inputBindings: bindings as NonNullable<PlanTaskDraft["inputBindings"]>,
    ...overrides,
  });
}

type KillIssue = { readonly kind: string; readonly [key: string]: unknown };

function proposalIssues(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  drafts: readonly PlanTaskDraft[],
  retain: readonly TaskId[] = [],
): readonly KillIssue[] {
  const check = validatePlanProposal(
    deps,
    aggregate,
    planInput(drafts, { basePlanRevision: aggregate.work.planRevision, retain }),
  );
  return check.valid ? [] : (check.issues as readonly KillIssue[]);
}

const bindingIssuesOf = (issues: readonly KillIssue[]) =>
  issues.filter((issue) => issue.kind.startsWith("binding_"));

function firstPlanBindingIssues(deps: DomainDeps, drafts: readonly PlanTaskDraft[]) {
  return bindingIssuesOf(proposalIssues(deps, reachWorkState("PLANNING").aggregate, drafts));
}

describe("SC-037: 결합 선언 형태 위반은 binding_malformed 다", () => {
  it("Error: 정의된 두 형태 밖의 결합 선언은 결합당 binding_malformed 하나이고, 형태가 맞으면 이슈가 없다 (test_SC037_malformed_binding_forms_named_per_field)", () => {
    const deps = killBindingDeps("killmalformed");
    const p = { draftRef: "p" };
    const forms: [string, unknown][] = [
      ["null", null],
      ["string", "x"],
      ["array", []],
      ["extra key", { from: "task", task: p, output: "text", extra: 1 }],
      ["renamed output key", { from: "task", task: p, outputX: "text" }],
      ["task missing", { from: "task", output: "text" }],
      ["task null", { from: "task", task: null, output: "text" }],
      ["task string", { from: "task", task: "p", output: "text" }],
      ["task draftRef number", { from: "task", task: { draftRef: 1 }, output: "text" }],
      [
        "task both refs",
        { from: "task", task: { draftRef: "p", taskId: "tsk_x" }, output: "text" },
      ],
      ["task taskId number", { from: "task", task: { taskId: 1 }, output: "text" }],
      ["task other key", { from: "task", task: { other: "x" }, output: "text" }],
      ["output number", { from: "task", task: p, output: 1 }],
      ["unknown from with field", { from: "other", field: "timezone" }],
      ["unknown from", { from: "other" }],
      ["occurrence field number", { from: "occurrence", field: 1 }],
      ["occurrence extra key", { from: "occurrence", field: "timezone", extra: 1 }],
    ];
    for (const [name, binding] of forms)
      expect(
        firstPlanBindingIssues(deps, [producerDraft("p"), consumerDraft("c", { text: binding })]),
        name,
      ).toEqual([{ kind: "binding_malformed", draftRef: "c", field: "text" }]);
    // 런타임 우회: 정의 키가 프로토타입에만 있는 선언은 일반 객체가 아니라 입력 포착에서 계획 무효 이슈
    // 하나가 되고 결합 검사에 닿지 않는다.
    const inherited = Object.assign(Object.create({ output: "text" }) as object, {
      from: "task",
      task: p,
      other: 1,
    });
    expect(
      proposalIssues(deps, reachWorkState("PLANNING").aggregate, [
        producerDraft("p"),
        consumerDraft("c", { text: inherited }),
      ]),
    ).toEqual([
      { kind: "proposal_not_canonical_json", path: ["tasks", 1, "inputBindings", "text"] },
    ]);
    // 결합 목록 자체가 객체가 아니면 필드 이름 없이 하나다.
    expect(
      firstPlanBindingIssues(deps, [producerDraft("p"), consumerDraft("c", "bindings")]),
    ).toEqual([{ kind: "binding_malformed", draftRef: "c", field: "" }]);
    // 필드 이름 정렬 순서로 보고한다.
    expect(
      firstPlanBindingIssues(deps, [
        producerDraft("p"),
        consumerDraft("c", { text: null, plain: null }),
      ]),
    ).toEqual([
      { kind: "binding_malformed", draftRef: "c", field: "plain" },
      { kind: "binding_malformed", draftRef: "c", field: "text" },
    ]);
    // 대조: 같은 자리의 정의된 형태.
    expect(
      firstPlanBindingIssues(deps, [
        producerDraft("p"),
        consumerDraft("c", { text: { from: "task", task: p, output: "text" } }),
      ]),
    ).toEqual([]);
  });

  it("Edge: 미등록 소비자 유형의 결합은 검사하지 않는다(초안 검증이 무효로 판정) (test_SC037_unregistered_consumer_bindings_skipped)", () => {
    const deps = killBindingDeps("killunregisteredconsumer");
    const issues = proposalIssues(deps, reachWorkState("PLANNING").aggregate, [
      producerDraft("p"),
      consumerDraft(
        "c",
        { text: { from: "task", task: { draftRef: "p" }, output: "text" } },
        {
          type: UNREGISTERED_TASK_TYPE,
        },
      ),
    ]);
    expect(bindingIssuesOf(issues)).toEqual([]);
    expect(issues.some((issue) => issue.kind === "draft_invalid")).toBe(true);
  });

  it("Error: 결합 참조·필드·생산자 판정이 결합당 정해진 첫 이슈를 낸다 (test_SC037_binding_reference_checks_named)", () => {
    const deps = killBindingDeps("killbindingrefs");
    const bind = (ref: string, output = "text") => ({
      from: "task",
      task: { draftRef: ref },
      output,
    });
    // 의존이 아닌 초안 생산자.
    expect(
      firstPlanBindingIssues(deps, [
        producerDraft("p"),
        producerDraft("q"),
        consumerDraft("c", { text: bind("p") }, { dependsOn: [{ draftRef: "q" }] }),
      ]),
    ).toEqual([
      {
        kind: "binding_producer_not_dependency",
        draftRef: "c",
        field: "text",
        ref: { draftRef: "p" },
      },
    ]);
    // 소비자 스키마에 없는 필드.
    expect(
      firstPlanBindingIssues(deps, [producerDraft("p"), consumerDraft("c", { nope: bind("p") })]),
    ).toEqual([{ kind: "binding_input_field_unknown", draftRef: "c", field: "nope" }]);
    // 입력과 겹침: 값이 undefined 인 입력 키·객체가 아닌 입력은 겹침이 아니다.
    expect(
      firstPlanBindingIssues(deps, [
        producerDraft("p"),
        consumerDraft("c", { text: bind("p") }, { input: { text: undefined } }),
      ]),
    ).toEqual([]);
    expect(
      firstPlanBindingIssues(deps, [
        producerDraft("p"),
        consumerDraft("c", { text: bind("p") }, { input: null }),
      ]),
    ).toEqual([]);
    expect(
      firstPlanBindingIssues(deps, [
        producerDraft("p"),
        consumerDraft("c", { text: bind("p") }, { input: { text: "given" } }),
      ]),
    ).toEqual([{ kind: "binding_overlaps_input", draftRef: "c", field: "text" }]);
    // 없는 초안 생산자.
    expect(
      firstPlanBindingIssues(deps, [
        producerDraft("p"),
        consumerDraft("c", { text: bind("zz") }, { dependsOn: [{ draftRef: "zz" }] }),
      ]),
    ).toEqual([
      {
        kind: "binding_producer_not_member",
        draftRef: "c",
        field: "text",
        ref: { draftRef: "zz" },
      },
    ]);
    // 생산자 유형이 등록부에 없으면 출력 선언도 없다.
    expect(
      firstPlanBindingIssues(deps, [
        producerDraft("p", { type: UNREGISTERED_TASK_TYPE }),
        consumerDraft("c", { text: bind("p") }),
      ]),
    ).toEqual([
      { kind: "binding_output_undeclared", draftRef: "c", field: "text", output: "text" },
    ]);
    // 중복 draftRef 는 첫 초안이 생산자다.
    expect(
      firstPlanBindingIssues(deps, [
        producerDraft("p"),
        draft("p", { policy: optionalPolicy() }),
        consumerDraft("c", { text: bind("p") }),
      ]),
    ).toEqual([]);
    expect(
      firstPlanBindingIssues(deps, [
        draft("p", { policy: optionalPolicy() }),
        producerDraft("p"),
        consumerDraft("c", { text: bind("p") }),
      ]),
    ).toEqual([
      { kind: "binding_output_undeclared", draftRef: "c", field: "text", output: "text" },
    ]);
  });

  it("Edge: 입력 필드가 정하는 출력은 그 스키마를 변환해 증명하고, 허용 밖 스키마는 producer_schema_unsupported 다 (test_SC038_input_field_output_schema_proved_or_unsupported)", () => {
    const deps = killBindingDeps("killdataoutput");
    const consumer = consumerDraft("c", {
      text: { from: "task", task: { draftRef: "p" }, output: "data" },
    });
    expect(
      firstPlanBindingIssues(deps, [
        agentGoalDraft(
          "p",
          { dataSchema: { type: "string", minLength: 1 } },
          { policy: optionalPolicy() },
        ),
        consumer,
      ]),
    ).toEqual([]);
    expect(
      firstPlanBindingIssues(deps, [
        agentGoalDraft("p", { dataSchema: { type: "string" } }, { policy: optionalPolicy() }),
        consumer,
      ]),
    ).toEqual([
      { kind: "binding_schema_incompatible", draftRef: "c", field: "text", reason: "not_provable" },
    ]);
    expect(
      firstPlanBindingIssues(deps, [
        agentGoalDraft(
          "p",
          { dataSchema: { type: "string", format: "email" } },
          { policy: optionalPolicy() },
        ),
        consumer,
      ]),
    ).toEqual([
      {
        kind: "binding_schema_incompatible",
        draftRef: "c",
        field: "text",
        reason: "producer_schema_unsupported",
      },
    ]);
  });

  it("Edge: 생산자 선택 출력은 풀어서 증명하고 생산자 strip 객체는 추가 키 없음으로 읽는다 (test_SC038_producer_optional_unwrapped_and_strip_object_read_as_producer)", () => {
    const deps = killBindingDeps("killshaped");
    const shaped = (bindings: unknown) => [
      draft("p", { type: SHAPED_PRODUCER, input: {}, policy: optionalPolicy() }),
      draft("c", {
        type: STRICT_CONSUMER,
        input: {},
        dependsOn: [{ draftRef: "p" }],
        trigger: dependencyTrigger("c"),
        inputBindings: bindings as NonNullable<PlanTaskDraft["inputBindings"]>,
      }),
    ];
    expect(
      firstPlanBindingIssues(
        deps,
        shaped({ text: { from: "task", task: { draftRef: "p" }, output: "maybe" } }),
      ),
    ).toEqual([]);
    expect(
      firstPlanBindingIssues(
        deps,
        shaped({ obj: { from: "task", task: { draftRef: "p" }, output: "record" } }),
      ),
    ).toEqual([]);
    // 대조: 소비자 필드가 더 좁으면 증명되지 않는다.
    expect(
      firstPlanBindingIssues(
        deps,
        shaped({ text: { from: "task", task: { draftRef: "p" }, output: "record" } }),
      ),
    ).toEqual([
      { kind: "binding_schema_incompatible", draftRef: "c", field: "text", reason: "not_provable" },
    ]);
  });
});

// ---- 재계획 제안 검증 — 보존 member 참조·필수 member·digest·membership 판정 ----

/** 생산자 a·b(비필수)·필수 g·비필수 c 를 member 로 커밋한 Work(계획 revision 1). */
function replanMembers(seed: string) {
  const deps = killBindingDeps(seed);
  const { journal, ids } = startJournal(
    [producerDraft("a"), producerDraft("b"), draft("g"), draft("c", { policy: optionalPolicy() })],
    deps,
  );
  const id = (ref: string) => ids[ref] as TaskId;
  return { deps, journal, a: id("a"), b: id("b"), g: id("g"), c: id("c") };
}

const GHOST_TASK = entityId("task", "tsk_ghostmember0001");

const taskBinding = (taskId: TaskId, output = "text") => ({
  from: "task",
  task: { taskId },
  output,
});

describe("SC-026: 보존 member 참조와 결합 생산자 판정", () => {
  it("Edge: 보존 생산자 결합은 의존 대조·생산자 종결 상태로 판정한다 (test_SC026_retained_producer_binding_dependency_and_output_checks)", () => {
    const { deps, journal, a, b, g } = replanMembers("killretainedproducer");
    const consumer = (dependsOn: TaskId) =>
      consumerDraft("n", { text: taskBinding(a) }, { dependsOn: [{ taskId: dependsOn }] });
    // 의존이 아닌 보존 생산자.
    expect(
      bindingIssuesOf(proposalIssues(deps, journal.aggregate, [consumer(b)], [a, b, g])),
    ).toEqual([
      { kind: "binding_producer_not_dependency", draftRef: "n", field: "text", ref: { taskId: a } },
    ]);
    // 비종결 보존 생산자는 아직 출력 판정 대상이 아니다.
    expect(journal.task(a).state).toBe("DRAFT");
    expect(bindingIssuesOf(proposalIssues(deps, journal.aggregate, [consumer(a)], [a, g]))).toEqual(
      [],
    );
    // 결과 없이 실패한 보존 생산자는 출력 없음이다.
    validate(journal, a);
    start(journal, a);
    fail(journal, a, "fixture_fatal");
    expect(journal.task(a).state).toBe("FAILED");
    expect(bindingIssuesOf(proposalIssues(deps, journal.aggregate, [consumer(a)], [a, g]))).toEqual(
      [
        {
          kind: "binding_producer_without_output",
          draftRef: "n",
          field: "text",
          reason: "output_absent",
        },
      ],
    );
  });

  it("Error: 레코드가 없는 member 는 보존·참조·필수 판정에서 건너뛰고 결합 생산자로는 member 가 아니다 (test_SC026_member_without_record_skipped_without_crash)", () => {
    const { deps, journal, g, c } = replanMembers("killghostmember");
    // 레코드 패치: 레코드 없는 member id 와 그 id 를 결합한 보존 소비자(다른 생성 경로 대용).
    let aggregate = patchWork(journal.aggregate, {
      memberTaskIds: [...journal.aggregate.work.memberTaskIds, GHOST_TASK],
    });
    aggregate = patchTask(aggregate, c, {
      inputBindings: { text: taskBinding(GHOST_TASK) } as unknown as TaskRecord["inputBindings"],
    });
    const issues = proposalIssues(
      deps,
      aggregate,
      [
        consumerDraft(
          "n",
          { text: taskBinding(GHOST_TASK) },
          { dependsOn: [{ taskId: GHOST_TASK }] },
        ),
      ],
      [g, c, GHOST_TASK],
    );
    expect(issues).toEqual([
      {
        kind: "binding_producer_not_member",
        draftRef: "n",
        field: "text",
        ref: { taskId: GHOST_TASK },
      },
    ]);
    // 필수 판정: 레코드 없는 보존 member 만으로는 필수 member 가 없다.
    expect(
      proposalIssues(deps, aggregate, [draft("x", { policy: optionalPolicy() })], [GHOST_TASK]),
    ).toEqual([{ kind: "no_terminal_required_member" }]);
    // membership·필수 승인: 보존하지 않은 레코드 없는 member 는 탈락이고 필수 판정에서 빠진다.
    expect(planMembershipChange(aggregate, [g]).dropped).toContain(GHOST_TASK);
    expect(
      judgeMandatoryPlanApproval(aggregate, { retain: [] }).removedTerminalRequiredTaskIds,
    ).toEqual([g]);
  });

  it("Error: 기준 member 가 아닌 Task 는 보존돼도 결합 생산자가 아니고 새 초안의 의존 이탈로 보지 않는다 (test_SC026_non_member_task_not_treated_as_retained)", () => {
    const { deps, journal, a, g } = replanMembers("killnonmember");
    runToCompleted(journal, a, { text: "done", stamp: "s" });
    expect(journal.task(a).state).toBe("COMPLETED");
    // 레코드 패치: 기준 member 목록에서 빠진 기존 Task(대체된 member 대용).
    const aggregate = patchWork(journal.aggregate, {
      memberTaskIds: journal.aggregate.work.memberTaskIds.filter((taskId) => taskId !== a),
    });
    const issues = proposalIssues(
      deps,
      aggregate,
      [consumerDraft("n", { text: taskBinding(a) }, { dependsOn: [{ taskId: a }] })],
      [a, g],
    );
    expect(issues).toContainEqual({ kind: "retained_not_member", taskId: a });
    expect(bindingIssuesOf(issues)).toEqual([
      { kind: "binding_producer_not_member", draftRef: "n", field: "text", ref: { taskId: a } },
    ]);
    expect(issues.filter((issue) => issue.kind === "dependency_outside_revision")).toEqual([]);
    expect(planMembershipChange(aggregate, [a, g, g]).retained).toEqual([g]);
  });

  it("Edge: 보존 소비자의 결합 참조는 필드 정렬 순으로 TaskId 결합만 판정한다 (test_SC026_retained_consumer_binding_references_sorted)", () => {
    const { deps, journal, a, b, g, c } = replanMembers("killretainedrefs");
    // 레코드 패치: 커밋된 결합 목록에 정의 밖 값과 해석 전 형태를 섞는다(다른 생성 경로 대용).
    const aggregate = patchTask(journal.aggregate, c, {
      inputBindings: {
        zeta: taskBinding(a),
        alpha: taskBinding(b),
        u: undefined,
        o: { from: "occurrence", field: "timezone" },
        d: { from: "task", task: { draftRef: "p" }, output: "text" },
      } as unknown as TaskRecord["inputBindings"],
    });
    const issues = proposalIssues(deps, aggregate, [], [g, c]);
    expect(issues.filter((issue) => issue.kind === "member_reference_outside_revision")).toEqual([
      { kind: "member_reference_outside_revision", taskId: c, edge: "binding", ref: b },
      { kind: "member_reference_outside_revision", taskId: c, edge: "binding", ref: a },
    ]);
    // 대조: 두 생산자를 보존하면 참조 이탈이 없다.
    expect(
      proposalIssues(deps, aggregate, [], [a, b, g, c]).filter(
        (issue) => issue.kind === "member_reference_outside_revision",
      ),
    ).toEqual([]);
  });
});

describe("SC-028: 필수 member 판정의 원천", () => {
  it("Error: 보존 비필수 member 만 있으면 무효이고, 정규화하지 못한 초안은 원래 정책 객체의 필수 값으로 센다 (test_SC028_required_member_from_retained_and_raw_policy)", () => {
    const { deps, journal, c } = replanMembers("killrequired");
    expect(
      proposalIssues(deps, journal.aggregate, [draft("x", { policy: optionalPolicy() })], [c]),
    ).toContainEqual({
      kind: "no_terminal_required_member",
    });
    const planning = reachWorkState("PLANNING").aggregate;
    const requiredIssue = (policy: unknown) =>
      proposalIssues(deps, planning, [
        draft("x", { input: "not-an-object", policy: policy as PlanTaskDraft["policy"] }),
      ]).some((issue) => issue.kind === "no_terminal_required_member");
    expect(requiredIssue(basePolicy())).toBe(false);
    expect(requiredIssue(optionalPolicy())).toBe(true);
    // 런타임 우회: 객체가 아닌 정책 값(배열·함수)에 필수 속성을 붙여도 필수 member 가 아니다.
    expect(requiredIssue(Object.assign([], { terminalRequired: true }))).toBe(true);
    // 함수 값은 정규 JSON 이 될 수 없어 입력 포착에서 그 이슈 하나로 무효다.
    expect(
      proposalIssues(deps, planning, [
        draft("x", {
          input: "not-an-object",
          policy: Object.assign(() => undefined, {
            terminalRequired: true,
          }) as unknown as PlanTaskDraft["policy"],
        }),
      ]),
    ).toEqual([{ kind: "proposal_not_canonical_json", path: ["tasks", 0, "policy"] }]);
  });
});

describe("SC-022: 제안 정규화·digest 의 선택 자리", () => {
  it("Edge: 빈 결합 목록은 정규화 초안·digest 에서 빠지고, 정의 자리는 있을 때만 digest 에 든다 (test_SC022_empty_bindings_omitted_and_definition_in_digest)", () => {
    const deps = killBindingDeps("killdigest");
    const planning = reachWorkState("PLANNING").aggregate;
    const plain = validatePlanProposal(deps, planning, planInput([draft("x")]));
    const empty = validatePlanProposal(
      deps,
      planning,
      planInput([draft("x", { inputBindings: {} })]),
    );
    expect(plain.valid && empty.valid).toBe(true);
    if (!plain.valid || !empty.valid) return;
    expect(Object.hasOwn(empty.tasks[0] as object, "inputBindings")).toBe(false);
    expect(empty.digest).toBe(plain.digest);

    const definition = { title: "slot" };
    const withDefinition = validatePlanProposal(
      deps,
      planning,
      planInput([draft("x")], { definition }),
    );
    expect(withDefinition.valid).toBe(true);
    if (!withDefinition.valid) return;
    expect(withDefinition.digest).not.toBe(plain.digest);
    const content = {
      basePlanRevision: 0,
      source: "planner" as const,
      tasks: plain.tasks,
      retain: [],
    };
    expect(planProposalDigest(planning.work.id, { ...content, definition })).toEqual({
      ok: true,
      value: withDefinition.digest,
    });
    expect(planProposalDigest(planning.work.id, { ...content, definition })).toEqual({
      ok: true,
      value: independentDigest({ workId: planning.work.id, ...content, definition }),
    });
    expect(planProposalDigest(planning.work.id, content)).toEqual({
      ok: true,
      value: plain.digest,
    });
  });
});

describe("SC-035: 계획 출력 사전 거절", () => {
  it("Error: 객체가 아닌 계획·배열이 아닌 tasks·retain 은 invalid_input 이다 (test_SC035_precondition_rejects_non_object_plan_and_non_array_lists)", () => {
    const { aggregate } = reachWorkState("PLANNING");
    const work = aggregate.work;
    const reasonOf = (plan: unknown) =>
      // 런타임 우회: 계획 출력은 외부 값이라 정의 밖 형태도 들어온다.
      planPreconditionRejection(work, plan as PlanProposalInput)?.reason;
    const fields = { basePlanRevision: 0, source: "planner", tasks: [], retain: [] };
    expect(reasonOf(null)).toBe("invalid_input");
    expect(reasonOf(Object.assign(() => undefined, fields))).toBe("invalid_input");
    expect(reasonOf({ ...fields, tasks: "x" })).toBe("invalid_input");
    expect(reasonOf({ ...fields, retain: "x" })).toBe("invalid_input");
    expect(reasonOf(fields)).toBeUndefined();
  });
});

describe("SC-028: 의존 충족 Trigger 초안의 의존 요구", () => {
  it("Error: 의존 충족으로 발화하는 Trigger 인데 의존이 없으면 trigger_requires_dependencies 이고, 식별이 정의 밖이면 판정하지 않는다 (test_SC028_dependency_trigger_without_dependencies_named)", () => {
    const deps = killBindingDeps("killtriggerdeps");
    const planning = reachWorkState("PLANNING").aggregate;
    const triggerIssues = (trigger: unknown) =>
      proposalIssues(deps, planning, [
        // 런타임 우회: Trigger 선언은 외부 값이라 정의 밖 형태도 들어온다.
        draft("x", { trigger: trigger as PlanTaskDraft["trigger"] }),
      ]).filter((issue) => issue.kind === "trigger_requires_dependencies");
    expect(triggerIssues(dependencyTrigger("x"))).toEqual([
      {
        kind: "trigger_requires_dependencies",
        draftRef: "x",
        trigger: { kind: "dependencies_complete", version: 1 },
      },
    ]);
    expect(triggerIssues({ ...dependencyTrigger("x"), version: "1" })).toEqual([]);
    expect(triggerIssues({ ...dependencyTrigger("x"), kind: ["dependencies_complete"] })).toEqual(
      [],
    );
    expect(triggerIssues({ ...dependencyTrigger("x"), kind: "not_registered" })).toEqual([]);
    // 대조: 의존이 있으면 요구를 채운다.
    expect(
      proposalIssues(deps, planning, [
        draft("y"),
        draft("x", { trigger: dependencyTrigger("x"), dependsOn: [{ draftRef: "y" }] }),
      ]).filter((issue) => issue.kind === "trigger_requires_dependencies"),
    ).toEqual([]);
  });
});

// ---- 승인 grant 경로 — 보유 제안 재검증·커밋 조립 ----

const PENDING_KEYS = [
  "pendingDecision",
  "pendingProposalId",
  "pendingProposalDigest",
  "pendingProposal",
];
const pendingKeysOf = (aggregate: WorkAggregate) =>
  PENDING_KEYS.filter((key) => Object.hasOwn(aggregate.work, key));

describe("SC-025: grant 의 보유 제안 재검증과 커밋 내용", () => {
  it("Error: 보유 내용이 정규 JSON 이 아니면 grant 는 경로를 담은 proposal_not_canonical_json 철회 뒤 낡음이다 (test_SC025_held_content_not_canonical_withdraws_with_path)", () => {
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    const pending = aggregate.work.pendingProposal;
    const [first, ...rest] = pending?.tasks ?? [];
    if (pending === undefined || first === undefined) throw new Error("expected held proposal");
    // 레코드 패치: 고립 서러게이트를 담은 보유 내용(다른 생성 경로 대용).
    const patched = patchWork(aggregate, {
      pendingProposal: { ...pending, tasks: [{ ...first, title: "\uD800" }, ...rest] },
    });
    const judged = planDecision(new Journal(deps, patched, []), "grant");
    expect(judged.kind).toBe("rejected_stale");
    const chain = committedChain(judged);
    const [withdrawal] = chain;
    if (withdrawal === undefined) throw new Error("expected withdrawal commit");
    expect(payloadOf(withdrawal, "work_plan_withdrawn")["issues"]).toEqual([
      { kind: "proposal_not_canonical_json", path: ["tasks", 0, "title"] },
    ]);
    expect(pendingKeysOf(applyCommits(patched, [withdrawal]))).toEqual([]);
  });

  it("Edge: 보유 초안의 빈 결합 목록은 task_created 에 싣지 않는다 (test_SC025_held_empty_bindings_not_carried_on_task_created)", () => {
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    const pending = aggregate.work.pendingProposal;
    const [first, ...rest] = pending?.tasks ?? [];
    if (pending === undefined || first === undefined) throw new Error("expected held proposal");
    // 레코드 패치: 빈 결합 목록을 가진 보유 내용과 그 digest(다른 생성 경로 대용).
    const content = { ...pending, tasks: [{ ...first, inputBindings: {} }, ...rest] };
    const digest = planProposalDigest(aggregate.work.id, content);
    if (!digest.ok) throw new Error("expected digest");
    const patched = patchWork(aggregate, {
      pendingProposal: { ...content, digest: digest.value },
      pendingProposalDigest: digest.value,
    });
    const judged = planDecision(new Journal(deps, patched, []), "grant");
    expect(judged.kind).toBe("accepted");
    const created = committedChain(judged)
      .flatMap((commit) => commit.events)
      .filter((event) => event.type === "task_created");
    expect(created.length).toBe(pending.tasks.length);
    for (const event of created)
      expect(Object.hasOwn(event.payload as object, "inputBindings")).toBe(false);
  });

  it("Happy: 거부·커밋은 보유 제안 필드를 모두 지운다 (test_SC025_deny_and_grant_clear_held_fields)", () => {
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    expect(pendingKeysOf(aggregate)).toEqual(PENDING_KEYS);
    for (const choice of ["deny", "grant"] as const) {
      const judged = planDecision(new Journal(deps, aggregate, []), choice);
      expect(judged.kind).toBe("accepted");
      expect(pendingKeysOf(applyCommits(aggregate, committedChain(judged)))).toEqual([]);
    }
  });
});

describe("SC-036: occurrence 결합 커밋", () => {
  it("Edge: 정의 occurrence Work 의 occurrence 결합은 증명 없이 통과하고 task_created 에 그대로 실린다 (test_SC036_occurrence_binding_carried_on_definition_occurrence_work)", () => {
    const deps = killBindingDeps("killoccurrence");
    const planning = reachWorkState("PLANNING").aggregate;
    // 레코드 패치: 정의 occurrence 출처 Work(이 차수에 생성 경로 없음 — 다른 생성 경로 대용).
    const occurrenceWork = patchWork(planning, {
      source: {
        kind: "definition_occurrence",
        definitionId: "wdf_fixture",
        definitionRevision: 1,
        occurrenceId: "occ_fixture",
        input: {},
      } as unknown as WorkAggregate["work"]["source"],
    });
    const consumer = draft("c", {
      type: KILL_CONSUMER,
      input: { text: "given" },
      inputBindings: { plain: { from: "occurrence", field: "timezone" } },
    });
    const outcome = executeCommand(deps, occurrenceWork, {
      kind: "commit_plan",
      expectedRevision: occurrenceWork.work.revision,
      meta: meta(KILL_NOW),
      plan: planInput([consumer]),
    });
    const { commit } = mustCommit(outcome);
    expect(payloadOf(commit, "task_created")["inputBindings"]).toEqual({
      plain: { from: "occurrence", field: "timezone" },
    });
    // 대조: 다른 출처 Work 에서는 occurrence 결합이 무효다.
    expect(firstPlanBindingIssues(deps, [consumer])).toEqual([
      { kind: "binding_occurrence_unavailable", draftRef: "c", field: "plain" },
    ]);
  });
});

describe("SC-015: 탈락 취소의 원인 연결", () => {
  it("Happy: 직접 커밋이 탈락시킨 비종결 member 의 취소는 커밋 이벤트를 원인으로 단다 (test_SC015_dropped_cancellation_caused_by_commit_event)", () => {
    const { journal, ids } = startJournal(
      [draft("g"), draft("n", { policy: optionalPolicy() })],
      testDeps("killdropcause"),
    );
    const g = ids["g"] as TaskId;
    const n = ids["n"] as TaskId;
    validate(journal, g);
    start(journal, g);
    journal.apply(replanSignal(journal));
    const outcome = executeCommand(journal.deps, journal.aggregate, {
      kind: "commit_plan",
      expectedRevision: journal.aggregate.work.revision,
      meta: meta(KILL_NOW),
      plan: planInput([], { basePlanRevision: 1, retain: [g] }),
    });
    const { commit } = mustCommit(outcome);
    const committedEvent = commit.events.find((event) => event.type === "work_plan_committed");
    const canceled = commit.events.find((event) => event.type === "task_canceled");
    expect(canceled?.taskId).toBe(n);
    expect(canceled?.causationId).toBe(committedEvent?.id);
  });

  it("Edge: 탈락 목록의 레코드 없는 id·종결 Task 는 취소하지 않는다 (test_SC015_dropped_cancellation_skips_missing_and_terminal)", () => {
    const { journal, ids } = startJournal([draft("done"), draft("open")], testDeps("killdropskip"));
    const done = ids["done"] as TaskId;
    const open = ids["open"] as TaskId;
    runToCompleted(journal, done);
    const out = decideReplanDroppedCancellations(
      journal.aggregate,
      "evt_dropcommit",
      [GHOST_TASK, done, open],
      "human_local",
    );
    expect(out.map((c) => [c.event.type, c.event.taskId, c.causationEventId])).toEqual([
      ["task_canceled", open, "evt_dropcommit"],
    ]);
  });
});

describe("SC-032: 대기 제안 재검증 철회 판정", () => {
  /** 보존 member g(비종결)를 가진 재계획 승인 대기 — 보유 digest 를 어긋나게 해 재검증이 무효다. */
  function invalidWaiting(seed: string) {
    const { journal, ids } = startJournal([draft("g")], testDeps(seed));
    const g = ids["g"] as TaskId;
    validate(journal, g);
    start(journal, g);
    journal.apply(replanSignal(journal));
    journal.apply(
      executeCommand(journal.deps, journal.aggregate, {
        kind: "propose_plan",
        expectedRevision: journal.aggregate.work.revision,
        meta: meta(KILL_NOW),
        plan: planInput([], { basePlanRevision: 1, retain: [g] }),
        summary: "replan approval",
      }),
    );
    const pending = journal.aggregate.work.pendingProposal;
    if (pending === undefined) throw new Error("expected held proposal");
    // 레코드 패치: 보유 digest 가 내용과 어긋난 상태(다른 생성 경로 대용).
    const before = patchWork(journal.aggregate, {
      pendingProposal: { ...pending, digest: "0".repeat(64) as typeof pending.digest },
    });
    return { deps: journal.deps, before, g, pending };
  }
  const withoutTask = (aggregate: WorkAggregate, taskId: TaskId): WorkAggregate => ({
    ...aggregate,
    tasks: Object.fromEntries(Object.entries(aggregate.tasks).filter(([key]) => key !== taskId)),
  });

  it("Error: 이 커밋이 member 를 종결시키고 보유 제안이 무효면 철회를 내고, 원인·결정 id 는 있을 때만 싣는다 (test_SC032_revalidation_withdrawal_payload_and_causation)", () => {
    const { deps, before, g, pending } = invalidWaiting("killrevalidate");
    const scratch = patchTask(before, g, { state: "FAILED" });
    const withdrawal = decidePendingProposalRevalidation(deps, before, scratch, "evt_cause");
    expect(withdrawal).toStrictEqual({
      event: {
        type: "work_plan_withdrawn",
        payload: {
          proposalId: pending.id,
          decisionId: before.work.pendingDecision?.id,
          cause: "no_longer_validates",
          issues: [{ kind: "proposal_digest_mismatch" }],
        },
        workId: before.work.id,
      },
      causationEventId: "evt_cause",
    });
    const noCause = decidePendingProposalRevalidation(deps, before, scratch, undefined);
    expect(noCause !== undefined && Object.hasOwn(noCause, "causationEventId")).toBe(false);
    const noDecision = decidePendingProposalRevalidation(
      deps,
      before,
      patchWork(scratch, { pendingDecision: undefined } as unknown as Partial<
        WorkAggregate["work"]
      >),
      "evt_cause",
    );
    expect(noDecision?.event.type).toBe("work_plan_withdrawn");
    expect(Object.hasOwn(noDecision?.event.payload as object, "decisionId")).toBe(false);
  });

  it("Edge: 종결이 없거나 대기 제안이 아니거나 레코드가 없으면 철회하지 않는다 (test_SC032_revalidation_requires_termination_in_this_commit)", () => {
    const { deps, before, g } = invalidWaiting("killrevalidateno");
    const failed = patchTask(before, g, { state: "FAILED" });
    expect(decidePendingProposalRevalidation(deps, undefined, failed, "evt_c")).toBeUndefined();
    expect(decidePendingProposalRevalidation(deps, before, before, "evt_c")).toBeUndefined();
    expect(
      decidePendingProposalRevalidation(
        deps,
        before,
        patchWork(failed, { state: "READY" }),
        "evt_c",
      ),
    ).toBeUndefined();
    expect(
      decidePendingProposalRevalidation(
        deps,
        before,
        patchWork(failed, { pendingProposal: undefined } as unknown as Partial<
          WorkAggregate["work"]
        >),
        "evt_c",
      ),
    ).toBeUndefined();
    // 이미 종결이던 member 는 이 커밋의 종결이 아니다.
    expect(
      decidePendingProposalRevalidation(
        deps,
        patchTask(before, g, { state: "COMPLETED" }),
        failed,
        "evt_c",
      ),
    ).toBeUndefined();
    // 레코드 패치: 커밋 전·후 한쪽에 레코드가 없는 member(다른 생성 경로 대용).
    expect(
      decidePendingProposalRevalidation(deps, withoutTask(before, g), failed, "evt_c"),
    ).toBeUndefined();
    expect(
      decidePendingProposalRevalidation(deps, before, withoutTask(failed, g), "evt_c"),
    ).toBeUndefined();
    // 대조: 같은 종결이 이 커밋에서 일어나면 철회한다.
    expect(decidePendingProposalRevalidation(deps, before, failed, "evt_c")?.event.type).toBe(
      "work_plan_withdrawn",
    );
  });

  it("Happy: 보존 member 실패 커밋의 철회는 그 실패 이벤트를 원인으로 단다 (test_SC032_withdrawal_caused_by_member_failure_event)", () => {
    const { journal, ids } = startJournal([draft("g")], testDeps("killwithdrawcause"));
    const g = ids["g"] as TaskId;
    validate(journal, g);
    start(journal, g);
    journal.apply(replanSignal(journal));
    journal.apply(
      executeCommand(journal.deps, journal.aggregate, {
        kind: "propose_plan",
        expectedRevision: journal.aggregate.work.revision,
        meta: meta(KILL_NOW),
        plan: planInput([], { basePlanRevision: 1, retain: [g] }),
        summary: "replan approval",
      }),
    );
    const commit = fail(journal, g, "fixture_fatal");
    const failed = commit.events.find((event) => event.type === "task_failed");
    const withdrawn = commit.events.find((event) => event.type === "work_plan_withdrawn");
    expect(withdrawn?.causationId).toBe(failed?.id);
    expect(pendingKeysOf(journal.aggregate)).toEqual([]);
  });
});

// ---- 결합 해석·결합 인지 충족 — 커밋된 결합 레코드 직접 판정 ----

/** 완료 생산자 p(text·note), 미완 생산자 q, 결합 소비자로 패치할 g. */
function boundFixture(seed: string) {
  const deps = killBindingDeps(seed);
  const { journal, ids } = startJournal([producerDraft("p"), producerDraft("q"), draft("g")], deps);
  const p = ids["p"] as TaskId;
  const q = ids["q"] as TaskId;
  const g = ids["g"] as TaskId;
  runToCompleted(journal, p, { text: "x", note: "y", stamp: "s" });
  /** 레코드 패치: 결합 소비자 레코드(다른 생성 경로 대용 — 결합 목록은 정의 밖 값도 싣는다). */
  const consumer = (
    aggregate: WorkAggregate,
    bindings: Record<string, unknown>,
    patch: Partial<TaskRecord> = {},
  ): WorkAggregate =>
    patchTask(aggregate, g, {
      type: KILL_CONSUMER,
      inputBindings: bindings as unknown as TaskRecord["inputBindings"],
      ...patch,
    });
  return { deps, journal, p, q, g, consumer };
}

describe("SC-050: 결합 해석 값·digest·순서", () => {
  it("Happy: 결합은 필드 정렬 순으로 기록 값의 digest·결과 id 와 함께 해석된다 (test_SC050_bound_inputs_sorted_with_digest_and_result_id)", () => {
    const { deps, journal, p, g, consumer } = boundFixture("killresolve");
    const aggregate = consumer(journal.aggregate, {
      text: taskBinding(p),
      plain: taskBinding(p, "note"),
    });
    const resultId = journal.task(p).result?.id;
    expect(resolveBoundInputs(deps.registries, aggregate, requireTaskFor(aggregate, g))).toEqual({
      ok: true,
      value: [
        {
          field: "plain",
          binding: taskBinding(p, "note"),
          resultId,
          digest: independentDigest("y"),
        },
        { field: "text", binding: taskBinding(p), resultId, digest: independentDigest("x") },
      ],
    });
  });

  it("Error: 해석 실패는 사유로, 계약 위반 레코드는 불변식 오류로 끝난다 (test_SC047_bound_input_resolution_failures)", () => {
    const { deps, journal, p, q, g, consumer } = boundFixture("killresolvefail");
    const resolve = (aggregate: WorkAggregate) =>
      resolveBoundInputs(deps.registries, aggregate, requireTaskFor(aggregate, g));
    // 결합이 없으면 소비자 유형을 보지 않는다.
    expect(resolve(consumer(journal.aggregate, {}, { type: UNREGISTERED_TASK_TYPE }))).toEqual({
      ok: true,
      value: [],
    });
    expect(() =>
      resolve(
        consumer(journal.aggregate, { text: taskBinding(p) }, { type: UNREGISTERED_TASK_TYPE }),
      ),
    ).toThrow(DomainInvariantError);
    expect(
      resolve(consumer(journal.aggregate, { plain: { from: "occurrence", field: "timezone" } })),
    ).toEqual({
      ok: false,
      error: { kind: "occurrence_unsupported", field: "plain" },
    });
    expect(() =>
      resolve(
        consumer(journal.aggregate, {
          text: { from: "task", task: { draftRef: "p" }, output: "text" },
        }),
      ),
    ).toThrow(DomainInvariantError);
    expect(resolve(consumer(journal.aggregate, { text: taskBinding(GHOST_TASK) }))).toEqual({
      ok: false,
      error: { kind: "producer_result_missing", field: "text", producerTaskId: GHOST_TASK },
    });
    expect(resolve(consumer(journal.aggregate, { text: taskBinding(q) }))).toEqual({
      ok: false,
      error: { kind: "producer_result_missing", field: "text", producerTaskId: q },
    });
    // 레코드 패치: 기록 출력이 정규 JSON 이 아닌 결과(다른 생성 경로 대용).
    const result = journal.task(p).result;
    if (result === undefined) throw new Error("expected producer result");
    const lone = patchTask(journal.aggregate, p, {
      result: { ...result, outputs: { text: "\uD800" } },
    });
    expect(() => resolve(consumer(lone, { text: taskBinding(p) }))).toThrow(DomainInvariantError);
    expect(() => resolve(consumer(journal.aggregate, { nope: taskBinding(p) }))).toThrow(
      DomainInvariantError,
    );
  });
});

describe("SC-048: 결합 인지 의존 충족", () => {
  it("Edge: 결합한 생산자 중 SKIPPED·출력 없는 만족 종결만 불충족이고 dependsOn 순·중복 없이 낸다 (test_SC048_binding_unsatisfied_producers_exact)", () => {
    const { journal, p, q, g, consumer } = boundFixture("killunsatisfied");
    const result = journal.task(p).result;
    if (result === undefined) throw new Error("expected producer result");
    const ids = (aggregate: WorkAggregate) =>
      bindingUnsatisfiedProducerIds(aggregate, requireTaskFor(aggregate, g));
    expect(ids(consumer(journal.aggregate, {}, { dependsOn: [p] }))).toEqual([]);
    expect(ids(consumer(journal.aggregate, { text: taskBinding(p) }, { dependsOn: [p] }))).toEqual(
      [],
    );
    // 레코드 패치: 결과를 가진 SKIPPED·결과 없는 COMPLETED·일부 출력만 가진 결과(다른 생성 경로 대용).
    const skippedWithResult = patchTask(journal.aggregate, p, { state: "SKIPPED" });
    expect(
      ids(consumer(skippedWithResult, { text: taskBinding(p) }, { dependsOn: [p, p] })),
    ).toEqual([p]);
    const unboundSkipped = patchTask(journal.aggregate, q, { state: "SKIPPED" });
    expect(ids(consumer(unboundSkipped, { text: taskBinding(p) }, { dependsOn: [q, p] }))).toEqual(
      [],
    );
    expect(
      ids(
        consumer(journal.aggregate, { text: taskBinding(GHOST_TASK) }, { dependsOn: [GHOST_TASK] }),
      ),
    ).toEqual([]);
    const noResult = patchTask(journal.aggregate, p, {
      result: undefined,
    } as unknown as Partial<TaskRecord>);
    expect(ids(consumer(noResult, { text: taskBinding(p) }, { dependsOn: [p] }))).toEqual([p]);
    const partial = patchTask(journal.aggregate, p, {
      result: { ...result, outputs: { text: "x" } },
    });
    expect(
      ids(
        consumer(
          partial,
          { text: taskBinding(p), plain: taskBinding(p, "note") },
          { dependsOn: [p] },
        ),
      ),
    ).toEqual([p]);
    expect(
      ids(
        consumer(
          journal.aggregate,
          { plain: { from: "occurrence", field: "timezone" }, text: taskBinding(p) },
          { dependsOn: [p] },
        ),
      ),
    ).toEqual([]);
  });

  it("Edge: 활성화는 모든 의존이 레코드가 있고 충족 종결이며 결합 출력을 가질 때만이다 (test_SC048_activation_requires_existing_satisfied_bound_dependencies)", () => {
    const { journal, p, q, g, consumer } = boundFixture("killactivation");
    const result = journal.task(p).result;
    if (result === undefined) throw new Error("expected producer result");
    expect(
      isActivationSatisfied(consumer(journal.aggregate, {}, { dependsOn: [GHOST_TASK] }), g),
    ).toBe(false);
    expect(isActivationSatisfied(consumer(journal.aggregate, {}, { dependsOn: [q] }), g)).toBe(
      false,
    );
    const partial = patchTask(journal.aggregate, p, {
      result: { ...result, outputs: { text: "x" } },
    });
    expect(
      isActivationSatisfied(
        consumer(partial, { plain: taskBinding(p, "note") }, { dependsOn: [p] }),
        g,
      ),
    ).toBe(false);
    expect(
      isActivationSatisfied(
        consumer(journal.aggregate, { text: taskBinding(p) }, { dependsOn: [p] }),
        g,
      ),
    ).toBe(true);
  });

  it("Error: 의존 불충족 라우팅은 레코드 없는 의존을 건너뛰고 같은 의존을 한 번만 싣는다 (test_SC048_unsatisfied_dependency_ids_deduplicated)", () => {
    const { journal, ids } = startJournal([draft("f"), draft("w")], testDeps("killdepround"));
    const f = ids["f"] as TaskId;
    const w = ids["w"] as TaskId;
    validate(journal, w);
    // 레코드 패치: 실패한 의존을 중복·레코드 없는 의존과 함께 가진 READY 소비자(다른 생성 경로 대용).
    let aggregate = patchTask(journal.aggregate, f, { state: "FAILED" });
    aggregate = patchTask(aggregate, w, { dependsOn: [f, GHOST_TASK, f] });
    expect(requireTaskFor(aggregate, w).state).toBe("READY");
    const round = decideDependencyCascadeRound(journal.deps.registries, aggregate);
    const blocked = round.find((c) => c.event.taskId === w);
    expect(blocked?.event.type).toBe("task_blocked");
    expect(blocked?.event.payload).toEqual({
      blockReason: { kind: "dependency_unsatisfied", dependencyTaskIds: [f] },
    });
  });
});

// ---- 확인 Task 결합 기록·완료 결과 ----

function confirmationBound(seed: string) {
  const deps = killBindingDeps(seed);
  const { journal, ids } = startJournal(
    [
      agentGoalDraft("summary", {}, { policy: optionalPolicy() }),
      draft("confirm", {
        type: CONFIRMATION_TYPE,
        input: { targetActor: CONFIRMATION_INPUT.targetActor, allowedDecisions: ["accept"] },
        inputBindings: {
          prompt: { from: "task", task: { draftRef: "summary" }, output: "summary" },
        },
        dependsOn: [{ draftRef: "summary" }],
      }),
    ],
    deps,
  );
  const summary = ids["summary"] as TaskId;
  const confirm = ids["confirm"] as TaskId;
  runToCompleted(journal, summary, { summary: "Ship it?" });
  validate(journal, confirm);
  return { journal, summary, confirm };
}

describe("SC-047: 확인 대기 진입의 결합 기록", () => {
  it("Edge: 첫 확인 대기는 해석 결과를 레코드에 남기고, 이미 해석했으면 다시 싣지 않고 기존 기록을 유지한다 (test_SC047_confirmation_wait_records_bound_inputs_once)", () => {
    const first = confirmationBound("killconfirmfirst");
    const commit = beginConfirmation(first.journal, first.confirm);
    const payload = payloadOf(commit, "task_waiting_confirmation");
    expect(payload["boundInputs"]).toEqual(first.journal.task(first.confirm).boundInputs);
    expect((payload["boundInputs"] as unknown[]).length).toBe(1);

    const again = confirmationBound("killconfirmagain");
    // 레코드 패치: 이미 해석을 기록한 READY 확인 Task(다른 생성 경로 대용).
    again.journal.aggregate = patchTask(again.journal.aggregate, again.confirm, {
      boundInputs: [],
    });
    const repeated = beginConfirmation(again.journal, again.confirm);
    expect(Object.hasOwn(payloadOf(repeated, "task_waiting_confirmation"), "boundInputs")).toBe(
      false,
    );
    expect(again.journal.task(again.confirm).boundInputs).toEqual([]);
  });

  it("Error: 결합 생산자 결과가 없으면 확인 대기 진입은 거절된다 (test_SC047_confirmation_wait_refused_when_binding_unresolved)", () => {
    const { journal, summary, confirm } = confirmationBound("killconfirmrefused");
    // 레코드 패치: 결과를 잃은 생산자(다른 생성 경로 대용).
    const aggregate = patchTask(journal.aggregate, summary, {
      result: undefined,
    } as unknown as Partial<TaskRecord>);
    const outcome = taskCommand(journal.deps, aggregate, confirm, {
      kind: "begin_confirmation_wait",
      confirmationId: nextEntityId(journal.deps.ids, "confirmation"),
    });
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.rejection.detail).toBe("binding_unresolved");
  });

  it("Happy: 확인 수락은 출력·Task·이벤트를 담은 결과를 기록한다 (test_SC042_confirmation_accept_records_full_result)", () => {
    const { journal, confirm } = confirmationBound("killconfirmaccept");
    beginConfirmation(journal, confirm);
    const commit = journal.apply(confirmationSignal(journal, confirm, "accept"));
    const accepted = commit.events.find((event) => event.type === "confirmation_accepted");
    const result = journal.task(confirm).result;
    expect(result?.taskId).toBe(confirm);
    expect(result?.eventId).toBe(accepted?.id);
    expect(result?.outputs["decision"]).toBe("accept");
  });
});

// ---- attempt 결과 기록 — 완료 증거·출력 위반 실패·주차 원인 ----

function recordOnRunning(
  outcome: (deps: DomainDeps, taskId: TaskId) => unknown,
  policy?: Partial<TaskPolicy>,
) {
  const { deps, aggregate, taskId } = reachTaskState(
    "RUNNING",
    policy === undefined ? {} : { policy },
  );
  const task = requireTaskFor(aggregate, taskId);
  const attemptId = task.openAttempt?.attemptId;
  if (attemptId === undefined) throw new Error("expected open attempt");
  const result = executeCommand(deps, aggregate, {
    kind: "record_attempt_outcome",
    taskId,
    expectedRevision: task.revision,
    meta: meta(KILL_NOW),
    attemptId,
    outcome: outcome(deps, taskId),
  } as TaskCommand);
  return { ...mustCommit(result), taskId, attemptId };
}

describe("SC-042: 완료 이벤트의 증거 자리", () => {
  it("Edge: 증거는 있을 때만 완료 이벤트에 싣는다 (test_SC042_completion_evidence_carried_only_when_present)", () => {
    const withEvidence = recordOnRunning(() => ({ kind: "completed", evidence: { log: "ok" } }));
    expect(payloadOf(withEvidence.commit, "task_completed")["evidence"]).toEqual({ log: "ok" });
    const without = recordOnRunning(() => ({ kind: "completed", evidence: undefined }));
    expect(Object.hasOwn(payloadOf(without.commit, "task_completed"), "evidence")).toBe(false);
  });
});

describe("SC-044: 출력 위반 완료는 실패한 attempt 다", () => {
  it("Error: 위반 완료는 출력 이슈·지터 추첨값을 담은 실패 결과로 attempt_failed 종결한다 (test_SC044_violating_completion_fails_with_issues_and_jitter)", () => {
    for (const jitter of [5, undefined]) {
      const { commit, attemptId } = recordOnRunning(
        () => ({
          kind: "completed",
          evidence: {},
          outputs: { extra: 1 },
          ...(jitter !== undefined ? { jitterDrawMs: jitter } : {}),
        }),
        jitter !== undefined ? { retry: { ...basePolicy().retry, jitterMs: 10 } } : undefined,
      );
      expect(payloadOf(commit, "task_failed")["reason"]).toStrictEqual({
        kind: "attempt_failed",
        attemptId,
        attemptNo: 1,
        outcome: {
          kind: "failed",
          code: OUTPUT_SCHEMA_VIOLATION,
          outputIssues: [{ code: "output_undeclared", output: "extra" }],
          ...(jitter !== undefined ? { jitterDrawMs: jitter } : {}),
        },
      });
    }
  });
});

describe("SC-007: 주차 이벤트의 원인", () => {
  it("Edge: 차단 결과는 그 원인으로, dead-letter 결과는 effect_dead_lettered 로 주차한다 (test_SC007_awaiting_human_cause_per_outcome_kind)", () => {
    const blocked = recordOnRunning((deps, taskId) => ({
      kind: "blocked",
      cause: "executor_blocked",
      decision: mustOk(
        parsePendingDecision({
          id: nextEntityId(deps.ids, "decision"),
          kind: "tool_permission_denied_unattended",
          taskId,
          requestedAt: KILL_NOW,
          summary: "blocked",
          surfaceDeliveries: [],
        }),
      ),
    }));
    expect(payloadOf(blocked.commit, "task_awaiting_human")["cause"]).toBe("executor_blocked");
    const deadLettered = recordOnRunning((deps, taskId) => ({
      kind: "effect_dead_lettered",
      decision: deadLetterDecision(deps, taskId, KILL_NOW),
    }));
    expect(payloadOf(deadLettered.commit, "task_awaiting_human")["cause"]).toBe(
      "effect_dead_lettered",
    );
  });
});

// ---- 보고 출력 검사 ----

/** 배열·심볼 키 레코드 출력과 입력이 정하는 필수 출력을 가진 유형. */
const OUTPUT_PROBE_TASK_TYPE: TaskTypeDescriptor = probeTaskType({
  id: "probe_output_paths",
  schema: z.strictObject({ schema: z.unknown().optional() }),
  inputFields: {},
  outputs: {
    list: z.array(z.string()).optional(),
    keyed: z.record(z.symbol(), z.string()).optional(),
    derived: { outputSchemaFromInput: "schema" },
  },
});

describe("SC-046: 보고 출력 검사의 이슈", () => {
  const registries = () =>
    testRegistries({ taskTypes: [PROBE_PRODUCER_TASK_TYPE, OUTPUT_PROBE_TASK_TYPE] });
  const limits = { resultInlineMaxBytes: 1_000 };
  const producer = { type: KILL_PRODUCER, input: {} };

  it("Error: 객체가 아닌 보고·undefined 값·비선언 이름이 정해진 이슈를 낸다 (test_SC046_reported_outputs_issue_list_exact)", () => {
    for (const reported of [null, [], "x"])
      expect(checkReportedOutputs(registries(), producer, reported, limits)).toEqual({
        ok: false,
        issues: [{ code: "outputs_not_object" }],
      });
    expect(
      checkReportedOutputs(registries(), producer, { text: undefined, stamp: "s" }, limits),
    ).toEqual({ ok: false, issues: [{ code: "output_missing", output: "text" }] });
    expect(
      checkReportedOutputs(registries(), producer, { zz: 1, aa: 1, text: "x", stamp: "s" }, limits),
    ).toEqual({
      ok: false,
      issues: [
        { code: "output_undeclared", output: "aa" },
        { code: "output_undeclared", output: "zz" },
      ],
    });
  });

  it("Edge: 위반 경로는 숫자 색인을 유지하고 그 밖 키는 문자열로, 입력이 정하는 출력은 선언이 선택일 때만 생략된다 (test_SC046_violation_paths_and_input_field_output_required)", () => {
    const task = {
      type: { id: "probe_output_paths", version: 1 },
      input: { schema: { type: "string" } },
    };
    const key = Symbol("k");
    // Symbol 키는 정규 JSON 사본에 남지 않아 검사·기록되는 값은 빈 레코드다.
    expect(
      checkReportedOutputs(
        registries(),
        task,
        { derived: "d", list: ["a", 1], keyed: { [key]: 1 } },
        limits,
      ),
    ).toEqual({
      ok: false,
      issues: [{ code: "output_invalid", output: "list", path: [1], schemaIssue: "invalid_type" }],
    });
    const symbolKeyed = checkReportedOutputs(
      registries(),
      task,
      { derived: "d", list: ["a"], keyed: { [key]: 1 } },
      limits,
    );
    expect(symbolKeyed.ok).toBe(true);
    if (symbolKeyed.ok)
      expect(symbolKeyed.outputs).toStrictEqual({ derived: "d", list: ["a"], keyed: {} });
    expect(checkReportedOutputs(registries(), task, {}, limits)).toEqual({
      ok: false,
      issues: [{ code: "output_missing", output: "derived" }],
    });
  });

  it("Error: 미등록 유형의 확인 수락 출력은 task_type_unknown 이다 (test_SC046_acceptance_outputs_unknown_type)", () => {
    expect(
      prepareAcceptanceOutputs(
        testDeps("killacceptance"),
        { type: UNREGISTERED_TASK_TYPE, input: {} },
        KILL_NOW,
      ),
    ).toEqual({ ok: false, issues: [{ code: "task_type_unknown" }] });
  });
});

describe("SC-046: 출력 선언의 구성 검사", () => {
  const defectOf = (overrides: Partial<TaskTypeDescriptor>) => {
    const built = createTaskTypeRegistry([probeTaskType(overrides)]);
    return built.ok
      ? undefined
      : built.error.kind === "descriptor_invalid"
        ? built.error.defect
        : built.error;
  };

  it("Error: 입력이 정하는 출력의 선택 값·확인 수락 출력 선언이 정의 밖이면 구성 실패다 (test_SC046_output_and_acceptance_declarations_checked)", () => {
    expect(
      defectOf({
        outputs: {
          d: { outputSchemaFromInput: "subject", optional: "yes" },
        } as unknown as TaskTypeDescriptor["outputs"],
      }),
    ).toEqual({
      code: "output_invalid",
      output: "d",
    });
    expect(defectOf({ outputs: { d: { outputSchemaFromInput: "subject" } } })).toBeUndefined();
    expect(
      defectOf({ outputs: { d: { outputSchemaFromInput: "subject", optional: true } } }),
    ).toBeUndefined();
    // 런타임 우회: 확인 수락 출력 선언은 정의 밖 값도 들어온다.
    const acceptance = (value: unknown) => ({
      outputs: { result: z.string() },
      acceptanceOutputs: value as NonNullable<TaskTypeDescriptor["acceptanceOutputs"]>,
    });
    expect(defectOf(acceptance({ nope: "decision" }))).toEqual({
      code: "acceptance_output_invalid",
      output: "nope",
    });
    expect(defectOf(acceptance("decision"))).toEqual({
      code: "acceptance_output_invalid",
      output: "",
    });
    expect(defectOf(acceptance({ result: "other" }))).toEqual({
      code: "acceptance_output_invalid",
      output: "result",
    });
    expect(defectOf(acceptance({ result: "decision" }))).toBeUndefined();
    // 확인 수락 출력이 맞아도 뒤의 선언 검사는 계속된다.
    expect(
      defectOf({
        ...acceptance({ result: "decision" }),
        capabilities: { canAutoPlan: "yes" } as unknown as TaskTypeDescriptor["capabilities"],
      }),
    ).toEqual({ code: "declaration_invalid", declaration: "capabilities" });
  });
});

describe("SC-040: agent_goal dataSchema 입력 검증 이슈", () => {
  it("Error: 허용 목록 이슈는 그 하위 경로의 input_field_invalid 로 보고된다 (test_SC040_data_schema_input_issue_path)", () => {
    const result = validateTask(testRegistries(), {
      type: { id: "agent_goal", version: 1 },
      input: {
        goal: "g",
        projectId: "prj_x",
        category: "analysis",
        completionEvidence: "e",
        sessionSelection: "s",
        dataSchema: { type: "object", properties: { a: { format: "x" } } },
      },
      trigger: { kind: "immediate", version: 1, triggerId: "t" },
      policy: basePolicy(),
      reactions: [],
    });
    expect(result.exit).toBe("validation_failed");
    if (result.exit === "validation_failed")
      expect(result.issues).toEqual([
        {
          area: "input",
          path: ["dataSchema", "properties", "a"],
          code: "input_field_invalid",
          detail: "custom",
        },
      ]);
  });
});

// ---- 재계획 열림·대기와 닫힘 발화 판정 ----

describe("SC-013: 재계획 열림·대기 판정과 닫힘 발화 대상", () => {
  it("Edge: 열림은 계획 revision 1 이상의 계획 단계, 대기는 그에 더해 재계획 중 계획 실패다 (test_SC013_replan_open_and_wait_held_need_committed_plan)", () => {
    const work = reachWorkState("PLANNING").aggregate.work;
    // 레코드 패치: 상태·revision·실패 원인 조합을 직접 만든다(다른 생성 경로 대용).
    const withState = (patch: Partial<WorkAggregate["work"]>) => ({ ...work, ...patch });
    expect(isReplanOpen(withState({ state: "PLANNING", planRevision: 0 }))).toBe(false);
    expect(isReplanOpen(withState({ state: "PLANNING", planRevision: 1 }))).toBe(true);
    expect(
      isReplanWaitHeld(
        withState({ state: "FAILED", failureCause: "planning_failed", planRevision: 0 }),
      ),
    ).toBe(false);
    expect(
      isReplanWaitHeld(
        withState({ state: "ACTIVE", failureCause: "planning_failed", planRevision: 1 }),
      ),
    ).toBe(false);
    expect(
      isReplanWaitHeld(
        withState({ state: "FAILED", failureCause: "planning_failed", planRevision: 1 }),
      ),
    ).toBe(true);
  });

  it("Error: 닫힘 발화는 레코드가 있는 READY·SCHEDULED member 만, 예약 Trigger 는 schedule 판정·미등록은 판정 불가로 낸다 (test_SC013_close_firings_cover_only_eligible_members)", () => {
    const { journal, ids } = startJournal(
      [
        draft("r", { trigger: atTrigger("r", { kind: "fire_once_now" }) }),
        draft("m", { trigger: atTrigger("m", { kind: "fire_once_now" }) }),
        draft("u", { trigger: atTrigger("u", { kind: "fire_once_now" }) }),
        draft("d", { trigger: dependencyTrigger("d"), dependsOn: [{ draftRef: "r" }] }),
        draft("s", { trigger: dependencyTrigger("s"), dependsOn: [{ draftRef: "r" }] }),
      ],
      testDeps("killclosefirings"),
    );
    const id = (ref: string) => ids[ref] as TaskId;
    // 레코드 패치: 상태·Trigger·occurrence 조합을 직접 만든다(다른 생성 경로 대용).
    let aggregate = patchWork(journal.aggregate, {
      memberTaskIds: [...journal.aggregate.work.memberTaskIds, GHOST_TASK],
    });
    aggregate = patchTask(aggregate, id("r"), { state: "READY" });
    aggregate = patchTask(aggregate, id("m"), { state: "RUNNING" });
    aggregate = patchTask(aggregate, id("u"), {
      state: "READY",
      trigger: {
        ...requireTaskFor(aggregate, id("u")).trigger,
        kind: "not_registered",
      } as unknown as TaskRecord["trigger"],
    });
    aggregate = patchTask(aggregate, id("d"), {
      state: "READY",
      scheduledOccurrenceId: entityId("occurrence", "occ_" + "D".repeat(26)),
    });
    aggregate = patchTask(aggregate, id("s"), { state: "SCHEDULED" });
    const registries = journal.deps.registries;
    const r = requireTaskFor(aggregate, id("r"));
    expect(decideReplanCloseFirings(registries, aggregate, KILL_NOW)).toEqual({
      ok: true,
      value: [
        {
          taskId: id("r"),
          kind: "decided",
          decision: mustOk(
            decideTaskTriggerMisfire(registries.triggers, {
              taskId: id("r"),
              trigger: r.trigger,
              occurrence: { kind: "schedule" },
              now: KILL_NOW,
            }),
          ),
        },
        { taskId: id("u"), kind: "undecidable", error: { kind: "trigger_descriptor_unknown" } },
      ],
    });
  });
});

// ---- 계획 제안 명령 판정 ----

describe("SC-031: 계획 제안 명령의 판정 결과", () => {
  const propose = (aggregate: WorkAggregate, deps: DomainDeps, fields: Record<string, unknown>) =>
    decideWorkCommand(deps, aggregate, {
      kind: "propose_plan",
      expectedRevision: aggregate.work.revision,
      meta: meta(KILL_NOW),
      plan: planInput([draft("x")]),
      summary: "plan approval",
      ...fields,
    } as WorkCommand);

  it("Happy: 유효 제안의 승인 결정은 빈 전달 목록으로 시작한다 (test_SC031_plan_decision_starts_without_surface_deliveries)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const outcome = propose(aggregate, deps, {});
    expect(outcome.kind).toBe("events");
    if (outcome.kind !== "events") return;
    const proposed = outcome.events.find((event) => event.type === "work_plan_proposed");
    const decision = (proposed?.payload as { decision?: { surfaceDeliveries?: unknown } }).decision;
    expect(decision?.surfaceDeliveries).toEqual([]);
  });

  it("Error: 문자열이 아닌 요약은 invalid_input, 무효 계획의 실패 이벤트는 Work 를 가리킨다 (test_SC031_propose_summary_and_invalid_plan_events)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const badSummary = propose(aggregate, deps, { summary: 1 });
    expect(badSummary.kind === "rejected" ? badSummary.rejection.reason : badSummary.kind).toBe(
      "invalid_input",
    );
    const invalid = propose(aggregate, deps, {
      plan: planInput([draft("x", { policy: optionalPolicy() })]),
      onInvalid: "fail_work",
    });
    expect(invalid.kind).toBe("events");
    if (invalid.kind !== "events") return;
    expect(invalid.events.map((event) => [event.type, event.workId])).toEqual([
      ["work_plan_invalid", aggregate.work.id],
      ["work_failed", aggregate.work.id],
    ]);
  });
});

// ---- 누락 입력 판정의 결합 필드 집합 ----

describe("SC-039: 결합 선언이 객체가 아니면 어떤 필드도 결합된 것으로 보지 않는다", () => {
  it("Edge: 결합 선언이 없거나 배열이면 필수 필드는 이름과 무관하게 누락 요청된다 (test_SC039_non_object_bindings_bind_no_field)", () => {
    // 필드 이름은 변이 도구가 빈 배열 자리에 넣는 표식 문자열이다 — 비객체 결합 선언의 결합 필드
    // 집합이 비어 있음을 등록 가능한 어떤 필드 이름에 대해서도 판별하려면 그 이름이 필요하다.
    const field = "Stryker was here";
    const registries = testRegistries({
      taskTypes: [
        probeTaskType({
          schema: z.strictObject({ [field]: z.string().min(1) }),
          inputFields: {
            [field]: { question: "What is the marker field?", safetyRelevant: false },
          },
        }),
      ],
    });
    const base = {
      type: { id: "probe_extension", version: 1 },
      input: {},
      trigger: { kind: "immediate", version: 1, triggerId: "t" },
      policy: basePolicy(),
      reactions: [],
    } as const;
    const declarations = [
      base,
      // 런타임 우회: 결합 선언 자리에 배열(다른 생성 경로 대용).
      { ...base, inputBindings: [] as unknown as Readonly<Record<string, unknown>> },
    ];
    for (const declaration of declarations) {
      const result = validateTask(registries, declaration);
      expect(result.exit).toBe("input_requested");
      if (result.exit === "input_requested") {
        expect(result.requests.map((request) => request.field)).toEqual([field]);
      }
    }
    const bound = validateTask(registries, {
      ...base,
      inputBindings: { [field]: { from: "task", task: { draftRef: "p" }, output: "text" } },
    });
    expect(bound.exit).toBe("valid");
  });
});

// ---- 취소 신호의 종결 주체 검사 ----

describe("SC-007: 취소 신호 판정의 종결 주체 검사", () => {
  it("Edge: 종결된 Task·Work 에 현재 revision 을 실은 취소는 terminal_subject 낡음이고, 비종결이면 수용된다 (test_SC007_cancel_on_terminal_subject_stale_with_positive_control)", () => {
    const { deps, aggregate, taskId } = reachTaskState("RUNNING");
    const cancel = (agg: WorkAggregate, subject: { taskId: TaskId } | { workId: string }) => {
      const revision =
        "taskId" in subject ? requireTaskFor(agg, subject.taskId).revision : agg.work.revision;
      const signal = {
        type: "cancel_requested",
        subject,
        signalId: nextEntityId(deps.ids, "signal"),
        expectedRevision: revision,
        actorSource: "human_local",
        receivedAt: KILL_NOW,
      } as unknown as DecisionSignal;
      return judgeSignal(deps, agg, signal, { kind: "none" }, KILL_NOW);
    };
    const first = cancel(aggregate, { taskId });
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") return;
    expect(requireTaskFor(first.aggregate, taskId).state).toBe("CANCELED");
    const again = cancel(first.aggregate, { taskId });
    expect(again.kind).toBe("rejected_stale");
    if (again.kind === "rejected_stale") expect(again.reason).toBe("terminal_subject");

    // Task 취소가 Work 를 종결로 파생시킬 수 있어 Work 주체는 취소 전 애그리거트에서 시작한다.
    const work = cancel(aggregate, { workId: aggregate.work.id });
    expect(work.kind).toBe("accepted");
    if (work.kind !== "accepted") return;
    expect(work.aggregate.work.state).toBe("CANCELED");
    const workAgain = cancel(work.aggregate, { workId: work.aggregate.work.id });
    expect(workAgain.kind).toBe("rejected_stale");
    if (workAgain.kind === "rejected_stale") expect(workAgain.reason).toBe("terminal_subject");
  });
});

// ---- 재작업 ×3 판정 보강 — 입력 포착·예약 원인 대조·결과 기록 사본·증명 통제 필드 ----

/** 외부 신호 발화 Trigger(`signal@1`). */
const KILL_SIGNAL_TRIGGER = {
  kind: "signal",
  version: 1,
  triggerId: "listener",
  sourceId: "fixture_source",
  signal: "fixture_ready",
} as unknown as PlanTaskDraft["trigger"];

/** 내장 등록부에서 한 종류의 Trigger 만 뺀 등록부(등록부 drift — 다른 생성 경로 대용). */
function registriesWithoutTrigger(kind: string) {
  return mustOk(
    createDomainRegistries({
      taskTypes: [...BUILTIN_TASK_TYPES, GENERIC_TASK_TYPE],
      triggers: BUILTIN_TRIGGERS.filter((t) => t.kind !== kind),
      reactions: BUILTIN_REACTIONS,
    }),
  );
}

describe("SC-010: 예약 원인 ↔ Trigger 선언 표와 미등록 Trigger 의 재계획 게이트", () => {
  it("Error: 재시도 원인은 발화 선언과 무관하게 참이고 두 원인은 같은 발화 선언에서만 참이며, 정의 밖 원인은 던진다 (test_SC010_schedule_cause_declared_table)", () => {
    const firings = ["on_ready", "schedule", "dependencies_satisfied", "external_signal"] as const;
    for (const firing of firings) {
      expect(scheduleCauseDeclared({ firing }, "retry"), firing).toBe(true);
      expect(scheduleCauseDeclared({ firing }, "schedule"), firing).toBe(firing === "schedule");
      expect(scheduleCauseDeclared({ firing }, "external_signal"), firing).toBe(
        firing === "external_signal",
      );
    }
    // 런타임 우회: 정의 밖 원인 값.
    expect(() => scheduleCauseDeclared({ firing: "schedule" }, "other" as never)).toThrow(Error);
  });

  it("Edge: 재계획 중 Trigger 가 미등록인 member 의 신호 원인 예약은 replan_open 이고, 재계획 밖에서는 조건 미충족 거절이다 (test_SC010_replan_gate_refuses_signal_schedule_when_trigger_unregistered)", () => {
    const { journal, ids } = startJournal(
      [draft("anchor"), draft("listener", { trigger: KILL_SIGNAL_TRIGGER })],
      testDeps("killgateunknown"),
    );
    const listener = ids["listener"] as TaskId;
    validate(journal, ids["anchor"] as TaskId);
    validate(journal, listener);
    const outside = journal.aggregate;
    journal.apply(replanSignal(journal));
    const drift: DomainDeps = { ...journal.deps, registries: registriesWithoutTrigger("signal") };
    const schedule = (aggregate: WorkAggregate) =>
      executeCommand(drift, aggregate, {
        kind: "schedule_task",
        taskId: listener,
        expectedRevision: requireTaskFor(aggregate, listener).revision,
        meta: meta(KILL_NOW),
        occurrenceId: entityId("occurrence", "occ_" + "G".repeat(26)),
        cause: "external_signal",
      });
    const during = schedule(journal.aggregate);
    expect(during.kind).toBe("rejected");
    if (during.kind === "rejected") expect(during.rejection.reason).toBe("replan_open");
    expect(committedChain(during)).toEqual([]);
    // 대조: 재계획 밖의 같은 명령은 Task 판정이 미등록 Trigger 로 거절한다.
    const after = schedule(outside);
    expect(after.kind).toBe("rejected");
    if (after.kind === "rejected") expect(after.rejection.reason).toBe("condition_not_met");
  });
});

describe("SC-022: 정규화한 제안 내용이 정규 JSON 이 될 수 없으면 계획 무효다", () => {
  it("Error: 등록 Trigger 의 파싱 결과가 비유한 수면 그 위치의 proposal_not_canonical_json 하나다 (test_SC022_normalized_content_not_canonical_json_invalid)", () => {
    // 파싱이 값을 비유한 수로 바꾸는 시험 Trigger — 정규화 결과가 정규 JSON 이 아닌 경로의 대용.
    const nanTrigger = {
      ...BUILTIN_TRIGGERS.find((t) => t.kind === "immediate"),
      kind: "probe_nan",
      title: "Probe NaN",
      schema: z.strictObject({
        kind: z.literal("probe_nan"),
        version: z.literal(1),
        triggerId: z.string(),
        weight: z.string().transform(() => Number.NaN),
      }),
    } as (typeof BUILTIN_TRIGGERS)[number];
    const deps = testDeps(
      "killcontentcopy",
      mustOk(createBuiltinRegistries({ taskTypes: [GENERIC_TASK_TYPE], triggers: [nanTrigger] })),
    );
    const planning = reachWorkState("PLANNING").aggregate;
    const trigger = { kind: "probe_nan", version: 1, triggerId: "x", weight: "w" };
    expect(
      validatePlanProposal(
        deps,
        planning,
        planInput([draft("x", { trigger: trigger as unknown as PlanTaskDraft["trigger"] })]),
      ),
    ).toEqual({
      valid: false,
      issues: [{ kind: "proposal_not_canonical_json", path: ["tasks", 0, "trigger", "weight"] }],
    });
    // 대조: 같은 등록부의 내장 Trigger 초안은 유효하다.
    expect(validatePlanProposal(deps, planning, planInput([draft("x")])).valid).toBe(true);
  });
});

describe("SC-041·SC-046: 결과 검사의 진입 사본 순회와 정렬", () => {
  const registries = () => testRegistries();
  const task = {
    type: { id: "agent_goal", version: 1 },
    input: {
      goal: "g",
      projectId: "prj_fixture",
      category: "analysis",
      completionEvidence: "e",
      sessionSelection: "default",
      dataSchema: {},
    },
  };
  const limits = { resultInlineMaxBytes: 65_536 };
  const forbiddenPath = (data: string) => {
    const checked = checkReportedOutputs(
      registries(),
      task,
      { summary: "s", data: JSON.parse(data) as unknown },
      limits,
    );
    if (checked.ok) return "ok";
    const issue = checked.issues.find((i) => i.code === "output_forbidden_key") as
      { readonly path: readonly (string | number)[] } | undefined;
    return issue === undefined ? "other" : JSON.stringify(issue.path);
  };

  it("Edge: 배열 원소·뒤쪽 키 아래의 own __proto__ 키도 깊이 우선 첫 위치로 위반이다 (test_SC041_forbidden_key_found_in_arrays_and_later_keys)", () => {
    expect(forbiddenPath('[{"__proto__":1}]')).toBe('[0,"__proto__"]');
    expect(forbiddenPath('[{},{"__proto__":1}]')).toBe('[1,"__proto__"]');
    expect(forbiddenPath('{"a":{},"b":{"__proto__":1}}')).toBe('["b","__proto__"]');
    expect(forbiddenPath('{"a":[{"x":1}],"b":[[{"__proto__":2}]]}')).toBe('["b",0,0,"__proto__"]');
    // 대조: 같은 모양에 __proto__ 키가 없으면 통과한다.
    expect(forbiddenPath('[{},{"x":1}]')).toBe("ok");
    expect(forbiddenPath('{"a":{},"b":{"x":1}}')).toBe("ok");
  });

  it("Edge: 선언되지 않은 출력 이름은 문자열 정렬 순서로 보고된다(정수 모양 이름 포함) (test_SC046_undeclared_outputs_reported_in_string_order)", () => {
    expect(
      checkReportedOutputs(registries(), task, { summary: "s", "2": 1, "10": 1 }, limits),
    ).toEqual({
      ok: false,
      issues: [
        { code: "output_undeclared", output: "10" },
        { code: "output_undeclared", output: "2" },
      ],
    });
  });

  it("Error: 파싱 결과가 정규 JSON 이 될 수 없으면 기록하지 않고 outputs_not_json 이다 (test_SC042_parsed_outputs_not_canonical_json_refused)", () => {
    // 파싱이 값을 비유한 수로 바꾸는 시험 유형 — 기록 사본을 만들 수 없는 출력의 대용.
    const nanType = probeTaskType({
      id: "probe_nan_output",
      schema: z.strictObject({}),
      inputFields: {},
      outputs: { n: z.string().transform(() => Number.NaN) },
    });
    const nanRegistries = testRegistries({ taskTypes: [nanType] });
    const nanTask = { type: { id: "probe_nan_output", version: 1 }, input: {} };
    expect(checkReportedOutputs(nanRegistries, nanTask, { n: "x" }, limits)).toEqual({
      ok: false,
      issues: [{ code: "outputs_not_json", reason: "non_finite_number", path: ["n"] }],
    });
    // 대조: 같은 유형이라도 출력이 없으면 검사할 값이 없어 오류가 아니다.
    const absentType = probeTaskType({
      id: "probe_nan_output",
      schema: z.strictObject({}),
      inputFields: {},
      outputs: {
        n: z
          .string()
          .transform(() => Number.NaN)
          .optional(),
      },
    });
    expect(
      checkReportedOutputs(testRegistries({ taskTypes: [absentType] }), nanTask, {}, limits).ok,
    ).toBe(true);
  });

  it("Edge: 프로토타입에만 있는 이름의 선언 출력은 보고하지 않으면 없는 것이다 (test_SC046_declared_output_named_like_prototype_member_absent)", () => {
    const protoNamed = probeTaskType({
      id: "probe_proto_named",
      schema: z.strictObject({}),
      inputFields: {},
      outputs: { toString: z.string().optional(), constructor: z.string() },
    });
    const protoTask = { type: { id: "probe_proto_named", version: 1 }, input: {} };
    const built = testRegistries({ taskTypes: [protoNamed] });
    expect(checkReportedOutputs(built, protoTask, {}, limits)).toEqual({
      ok: false,
      issues: [{ code: "output_missing", output: "constructor" }],
    });
    // 대조: 보고하면 그 값이 검사·기록된다.
    const reported = checkReportedOutputs(built, protoTask, { constructor: "c" }, limits);
    expect(reported.ok && reported.outputs).toStrictEqual({ constructor: "c" });
  });
});

describe("SC-037: 결합 선언 검사 순서", () => {
  it("Error: 형태 위반 결합은 필드 이름의 문자열 정렬 순서로 보고된다(정수 모양 이름 포함) (test_SC037_malformed_bindings_reported_in_string_order)", () => {
    const deps = killBindingDeps("killbindingorder");
    expect(
      firstPlanBindingIssues(deps, [
        producerDraft("p"),
        consumerDraft("c", { "2": null, "10": null }),
      ]),
    ).toEqual([
      { kind: "binding_malformed", draftRef: "c", field: "10" },
      { kind: "binding_malformed", draftRef: "c", field: "2" },
    ]);
  });
});

describe("SC-038: 수 검사·수 정의의 통제 필드 판독", () => {
  // zod 가 길이 검사에 넣는 기본 실행 조건 함수 — 수 검사에서는 길이가 없어 검사를 건너뛰게 만든다.
  const lengthGuard = (
    z.string().min(0).def.checks?.[0] as unknown as {
      _zod: { def: { when: () => boolean } };
    }
  )._zod.def.when;
  // zod 는 검사 정의의 when 을 런타임에 받지만 공개 매개변수 타입에는 없다.
  const params = (p: { when?: unknown; abort?: boolean }) => p as { abort?: boolean };
  const OPAQUE = { k: "opaque" };

  it("Edge: 길이 기본 조건 함수를 단 수 검사·수 정의와 abort·사용자 when 을 단 수 정의는 양측에서 증명 불가다 (test_SC038_number_checks_with_length_guard_or_controls_opaque)", () => {
    const guardedGt = z.number().gt(1, params({ when: lengthGuard }));
    // 그 조건은 수에 길이가 없어 검사를 건너뛰므로 경계 밖 값도 통과한다.
    expect(guardedGt.safeParse(0).success).toBe(true);
    for (const schema of [
      guardedGt,
      z.int(params({ when: lengthGuard })),
      z.int(params({ abort: true })),
      z.int(params({ when: () => false })),
    ])
      for (const side of ["producer", "consumer"] as const)
        expect(shapeOf(schema, side), side).toEqual(OPAQUE);
    // 대조: 검사가 아닌 수 스키마의 when·abort 는 타입 판정에 쓰이지 않아 판독된다.
    const numberParams = (p: { when?: unknown; abort?: boolean }) =>
      p as Parameters<typeof z.number>[0];
    for (const schema of [
      z.number(numberParams({ abort: true })),
      z.number(numberParams({ when: () => false })),
    ]) {
      expect(schema.safeParse("x").success).toBe(false);
      for (const side of ["producer", "consumer"] as const)
        expect(shapeOf(schema, side), side).toMatchObject({ k: "number" });
    }
    for (const side of ["producer", "consumer"] as const)
      expect(shapeOf(z.int(), side), side).toMatchObject({ k: "number", int: true });
  });
});

describe("SC-025: 보유 제안 재검증은 보유 내용 전체를 한 사본으로 읽는다", () => {
  it("Edge: 정의 자리를 실은 보유 제안(레코드 패치)의 grant 는 그 자리까지 포함한 사본이 승인 digest 와 맞아 커밋된다 (test_SC025_held_proposal_revalidation_reads_definition_slot)", () => {
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    const held = aggregate.work.pendingProposal;
    if (held === undefined) throw new Error("expected held proposal");
    const definition = { title: "slot" };
    const digest = mustOk(planProposalDigest(aggregate.work.id, { ...held, definition }));
    // 레코드 패치: 정의 자리를 가진 보유 제안(다른 생성 경로 대용) — digest 는 그 내용으로 다시 계산한다.
    const patched = patchWork(aggregate, { pendingProposal: { ...held, definition, digest } });
    const granted = decidePlan(deps, patched, "grant");
    expect(granted.kind).toBe("accepted");
    const types = committedChain(granted).flatMap(eventTypes);
    expect(types).toContain("work_plan_committed");
    expect(types).not.toContain("work_plan_withdrawn");
    // 대조: 정의 자리를 뺀 digest 로 패치하면 내용과 어긋나 철회된다.
    const mismatched = patchWork(aggregate, {
      pendingProposal: { ...held, definition, digest: held.digest },
    });
    expect(committedChain(decidePlan(deps, mismatched, "grant")).flatMap(eventTypes)).toContain(
      "work_plan_withdrawn",
    );
  });
});

describe("SC-046: 선언 출력 변환 결과의 Symbol 키 위반 경로", () => {
  it("Edge: 선언 출력이 변환 뒤 Symbol 키 값에서 실패하면 경로 조각은 그 Symbol 의 문자열이다 (test_SC046_symbol_issue_path_segment_rendered_as_string)", () => {
    // 진입 사본에는 Symbol 키가 없지만 선언 출력의 변환은 Symbol 키 값을 만들 수 있다.
    const key = Symbol("k");
    const symbolType = probeTaskType({
      id: "probe_symbol_output",
      schema: z.strictObject({}),
      inputFields: {},
      outputs: {
        record: z
          .string()
          .transform((text): Record<symbol, unknown> => ({ [key]: text === "ok" ? 1 : "bad" }))
          .pipe(z.record(z.symbol(), z.number())),
      },
    });
    const registries = testRegistries({ taskTypes: [symbolType] });
    const task = { type: { id: "probe_symbol_output", version: 1 }, input: {} };
    const limits = { resultInlineMaxBytes: 65_536 };
    const refused = checkReportedOutputs(registries, task, { record: "bad" }, limits);
    expect(refused).toEqual({
      ok: false,
      issues: [
        {
          code: "output_invalid",
          output: "record",
          path: ["Symbol(k)"],
          schemaIssue: "invalid_type",
        },
      ],
    });
    if (refused.ok) throw new Error("expected refusal");
    const issue = refused.issues[0] as { readonly path: readonly unknown[] };
    expect(issue.path.map((segment) => typeof segment)).toEqual(["string"]);
    // 대조: 같은 변환의 값이 수면 위반 없이 기록되고, 기록 사본에는 Symbol 키가 남지 않는다.
    const accepted = checkReportedOutputs(registries, task, { record: "ok" }, limits);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.outputs).toStrictEqual({ record: {} });
  });
});

describe("SC-038: 소비자 optional 판독의 인스턴스 표면", () => {
  it("Edge: 인스턴스 표면(_zod)이 없거나 객체가 아닌 optional 정의는 소비자 측에서 증명 불가이고 생산자 측에서는 판독된다 (test_SC038_consumer_optional_without_instance_surface_opaque)", () => {
    const optionalDef = { type: "optional", innerType: z.string() };
    // 런타임 우회: 정의만 있고 인스턴스 표면이 없거나 비객체인 스키마(다른 생성 경로 대용).
    const withoutSurface = fakeSchema(optionalDef);
    const nullSurface = { def: optionalDef, _zod: null } as unknown as z.ZodType;
    for (const schema of [withoutSurface, nullSurface]) {
      expect(shapeOf(schema, "consumer")).toEqual(SH.opaque);
      // 대조: 생산자 측은 인스턴스 표면 없이 정의만으로 판독한다.
      expect(shapeOf(schema, "producer")).toEqual({ k: "optional", inner: SH.str() });
    }
    // 대조: zod 인스턴스의 일반 optional 은 소비자 측에서도 판독된다.
    expect(shapeOf(z.string().optional(), "consumer")).toEqual({ k: "optional", inner: SH.str() });
  });
});

describe("SC-035: 계획 출처 값 목록", () => {
  it("Error: 정의된 두 출처 밖의 문자열(빈 문자열 포함) 출처는 invalid_input 이다 (test_SC035_precondition_rejects_source_outside_declared_values)", () => {
    const { aggregate } = reachWorkState("PLANNING");
    const fields = { basePlanRevision: 0, tasks: [], retain: [] };
    const reasonOf = (source: string) =>
      // 런타임 우회: 계획 출력은 외부 값이라 정의 밖 출처 문자열도 들어온다.
      planPreconditionRejection(aggregate.work, { ...fields, source } as PlanProposalInput)?.reason;
    for (const source of ["", "Planner", "definition"])
      expect(reasonOf(source), source).toBe("invalid_input");
    // 대조: 정의된 출처는 사전 거절을 지나거나 미지원으로 거절된다.
    expect(reasonOf("planner")).toBeUndefined();
    expect(reasonOf("definition_template")).toBe("unsupported_in_this_phase");
  });
});

describe("SC-041: 금지 키 첫 위치의 키 순서", () => {
  it("Edge: 금지 키 첫 위치는 객체 키의 문자열 정렬 순서로 정한다 — 정수 모양 키도 문자열로 비교한다 (test_SC041_forbidden_key_first_position_uses_string_key_order)", () => {
    const registries = testRegistries();
    const task = {
      type: { id: "agent_goal", version: 1 },
      input: {
        goal: "g",
        projectId: "prj_fixture",
        category: "analysis",
        completionEvidence: "e",
        sessionSelection: "default",
        dataSchema: {},
      },
    };
    const pathOf = (data: string) => {
      const checked = checkReportedOutputs(
        registries,
        task,
        { summary: "s", data: JSON.parse(data) as unknown },
        { resultInlineMaxBytes: 65_536 },
      );
      if (checked.ok) return "ok";
      const issue = checked.issues.find((i) => i.code === "output_forbidden_key") as
        { readonly path: readonly (string | number)[] } | undefined;
      return issue === undefined ? "other" : JSON.stringify(issue.path);
    };
    // 객체 속성 열거 순서는 정수 모양 키를 수 순서(2 → 10)로 두지만 문자열 정렬은 "10" 이 먼저다.
    expect(pathOf('{"2":{"__proto__":1},"10":{"__proto__":1}}')).toBe('["10","__proto__"]');
    // 대조: 한 곳에만 있으면 그 위치다.
    expect(pathOf('{"2":{"__proto__":1},"10":{}}')).toBe('["2","__proto__"]');
  });
});

describe("SC-010: 명령 진입 포착의 meta 처리", () => {
  it("Error: meta 가 객체가 아닌 명령(null·undefined)은 포착이 그대로 두어 첫 사용에서 TypeError 이고, 객체 meta 명령은 판정된다 (test_SC010_command_capture_leaves_non_object_meta_to_fail_at_first_use)", () => {
    const { journal, ids } = startJournal([draft("member")], testDeps("killmeta"));
    const member = ids["member"] as TaskId;
    validate(journal, member);
    const base = {
      kind: "start_attempt",
      taskId: member,
      expectedRevision: requireTaskFor(journal.aggregate, member).revision,
    };
    // 런타임 우회: 타입이 막는 meta 값(다른 생성 경로 대용).
    for (const bad of [null, undefined])
      expect(
        () =>
          executeCommand(journal.deps, journal.aggregate, {
            ...base,
            meta: bad,
          } as unknown as TaskCommand),
        String(bad),
      ).toThrow(TypeError);
    // 대조: 객체 meta 는 같은 명령이 커밋된다.
    expect(
      executeCommand(journal.deps, journal.aggregate, {
        ...base,
        meta: meta(KILL_NOW),
      } as TaskCommand).kind,
    ).toBe("committed");
  });
});

describe("SC-010: 재계획 게이트의 검증 통과 조건은 VALIDATING member 에만", () => {
  it("Edge: 재계획 중 승인 필요 DRAFT member 의 complete_validation 은 게이트가 아니라 상태 표 밖 거절이고, VALIDATING 이면 replan_open 이다 (test_SC010_validation_gate_applies_only_to_validating_member)", () => {
    const { journal, ids } = startJournal(
      [
        draft("anchor"),
        draft("gated", { policy: basePolicy({ approvalRequiredBeforeExecute: true }) }),
      ],
      testDeps("killvalgate"),
    );
    const gated = ids["gated"] as TaskId;
    validate(journal, ids["anchor"] as TaskId);
    journal.apply(replanSignal(journal));
    expect(journal.aggregate.work.state).toBe("PLANNING");
    expect(requireTaskFor(journal.aggregate, gated).state).toBe("DRAFT");
    const fromDraft = taskCommand(journal.deps, journal.aggregate, gated, {
      kind: "complete_validation",
    });
    expect(fromDraft.kind).toBe("rejected");
    if (fromDraft.kind === "rejected")
      expect(fromDraft.rejection.reason).toBe("transition_not_in_table");
    // 대조: VALIDATING 에 들어간 같은 member 는 게이트가 막는다.
    journal.apply(
      taskCommand(journal.deps, journal.aggregate, gated, { kind: "begin_validation" }),
    );
    const fromValidating = taskCommand(journal.deps, journal.aggregate, gated, {
      kind: "complete_validation",
    });
    expect(fromValidating.kind).toBe("rejected");
    if (fromValidating.kind === "rejected")
      expect(fromValidating.rejection.reason).toBe("replan_open");
  });
});

describe("SC-038: 입력 스키마 객체 수준 검사의 정의 판독", () => {
  it("Error: 정의 checks 가 빈 배열인 스키마는 등록되고, 정의가 null 인 위장 객체는 schema_has_object_check 로 거절된다 (test_SC038_object_check_reading_empty_checks_and_null_definition)", () => {
    const fields = { subject: z.string().min(1) };
    // 인자 없는 check() 는 빈 checks 배열을 가진 ZodObject 를 만든다.
    const emptyChecks = z.strictObject(fields).check();
    expect(emptyChecks instanceof z.ZodObject).toBe(true);
    expect(emptyChecks.def.checks).toEqual([]);
    expect(createTaskTypeRegistry([probeTaskType({ schema: emptyChecks })]).ok).toBe(true);
    // 대조: 검사가 하나 붙으면 거절된다.
    expect(
      createTaskTypeRegistry([
        probeTaskType({ schema: z.strictObject(fields).check(() => undefined) }),
      ]).ok,
    ).toBe(false);

    // zod 4 의 instanceof 는 `_zod.traits` 덕 타이핑이다 — 정의가 null 인 위장 객체(다른 생성 경로 대용).
    const lookalike = { def: null };
    Object.defineProperty(lookalike, "_zod", {
      value: { traits: new Set(["ZodType", "$ZodType", "ZodObject", "$ZodObject"]) },
      enumerable: false,
    });
    expect(
      createTaskTypeRegistry([
        probeTaskType({ schema: lookalike as unknown as TaskTypeDescriptor["schema"] }),
      ]),
    ).toEqual({
      ok: false,
      error: {
        kind: "descriptor_invalid",
        axis: "task_type",
        id: "probe_extension",
        version: 1,
        defect: { code: "schema_has_object_check" },
      },
    });
  });
});
