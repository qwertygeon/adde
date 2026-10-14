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
  deriveOccurrenceId,
  judgeTaskExternalSignal,
  materializationBlocker,
  executeDefinitionCommand,
  createWork,
  parseProjectId,
  parseCancelOrigin,
  localToUtc,
  isScheduleActivation,
  isSignalActivation,
  scheduleActivationView,
  signalActivationView,
  judgeDefinitionSignal,
  workflowStateOf,
  findSteward,
  foldEvents,
  assembleCommit,
  mkEvent,
  foldWorkflowEvents,
  openOccurrenceCount,
  withWork,
  buildTemplateProposal,
  templateProposalDigest,
} from "../../../src/workflow/domain/index.js";
import type {
  ActorSource,
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
  DomainCommit,
  WorkDefinitionId,
  RecurrenceExpander,
  DefinitionRecord,
  DomainRegistries,
  TriggerDescriptor,
  WorkId,
  UtcInstant,
  WorkflowState,
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
  OCCURRENCE_CONSUMER,
  WorkflowJournal,
  dailyActivation,
  dayAt,
  firstTaskOf,
  scheduleOccurrenceId,
  definitionDeps,
  definitionDraft,
  definitionTour,
  externalSignal,
  occurrenceConsumerDeps,
  registerAndMaterializeFirst,
  registerDefinition,
  signalActivation,
  signalDefinitionDraft,
  templateDraft,
  vaultOrigin,
  controlSignal,
  definitionInvalidReasons,
  issuesOf,
  proposeDraft,
  testDailyRecurrence,
  DEF_NOW,
  markdownWorkInPlanning,
  templateIssues,
  withPendingSignalAcceptance,
  FIXTURE_SIGNAL_NAME,
  FIXTURE_SIGNAL_SOURCE,
  typesOf,
  commitOf,
  OCCURRENCE_CONSUMER_TASK_TYPE,
  bindingTemplate,
  payloadsOf,
  stepActivation,
  testStepRecurrence,
} from "./helpers/definition-fixtures.js";
import { ACTION_AT, STEWARD_MEMBER } from "./helpers/definition-row-cases.js";
import type { DefinitionDraftInput } from "./helpers/definition-fixtures.js";
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

function decideOnWorkIn(
  state: WorkStateName,
  body: (deps: DomainDeps) => WorkCommandBody,
  actorSource: ActorSource = "adde_self",
) {
  const { deps, aggregate } = reachWorkState(state);
  expect(aggregate.work.state).toBe(state);
  const command = {
    ...body(deps),
    expectedRevision: aggregate.work.revision,
    meta: meta(KILL_NOW, actorSource),
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
        body: (_deps, taskId) => ({
          kind: "schedule_task",
          occurrenceId: mustOk(
            deriveOccurrenceId({
              kind: "schedule",
              ownerId: taskId,
              triggerId: "fixture_task",
              scheduledForUtc: at("2026-01-01T01:00:00Z"),
              recurrenceIndex: 0,
            }),
          ),
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
      /** 명령 meta 출처 — 취소 명령은 취소 origin 출처와 같아야 한다. */
      readonly actorSource?: ActorSource;
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
        actorSource: "unknown",
      },
    ];
    for (const c of cases) {
      for (const wrong of c.wrong) expectNotInTable(decideOnWorkIn(wrong, c.body, c.actorSource));
      expect(decideOnWorkIn(c.right, c.body, c.actorSource).kind, c.label).toBe("events");
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
        meta: meta(KILL_NOW, "unknown"),
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

/** 유효한 정의 초안(신호 활성화) — 정의 자리를 실은 제안 픽스처. */
const VALID_DEFINITION_DRAFT = {
  title: "slot",
  activation: {
    kind: "signal",
    version: 1,
    triggerId: "on_signal",
    sourceId: "fixture_source",
    signal: "fixture_ready",
  },
  template: [draft("t")],
  maxOpenOccurrences: 1,
};

/** 정의 초안을 낼 수 있는 markdown 출처 Work — markdown 출처 create_work 경로 대용 레코드 패치. */
function asMarkdownWork(aggregate: WorkAggregate): WorkAggregate {
  return patchWork(aggregate, { source: { kind: "markdown", documentId: "doc-kill" } });
}

describe("SC-022: 제안 정규화·digest 의 선택 자리", () => {
  it("Edge: 빈 결합 목록은 정규화 초안·digest 에서 빠지고, 정의 자리는 있을 때만 digest 에 든다 (test_SC022_empty_bindings_omitted_and_definition_in_digest)", () => {
    const deps = killBindingDeps("killdigest");
    const planning = asMarkdownWork(reachWorkState("PLANNING").aggregate);
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

    const withDefinition = validatePlanProposal(
      deps,
      planning,
      planInput([draft("x")], { definition: VALID_DEFINITION_DRAFT }),
    );
    expect(withDefinition.valid).toBe(true);
    if (!withDefinition.valid) return;
    expect(withDefinition.digest).not.toBe(plain.digest);
    // digest 원천은 정규화된 정의 사본이다.
    const definition = withDefinition.content.definition;
    expect(definition).toBeDefined();
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
        // 결합 필드가 회차 입력의 제공 필드여야 결합이 통과한다.
        input: { timezone: "Asia/Seoul" },
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
      error: { kind: "occurrence_input_unavailable", field: "plain" },
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
    const { deps, aggregate: waiting } = reachWorkState("WAITING_APPROVAL");
    const aggregate = asMarkdownWork(waiting);
    const held = aggregate.work.pendingProposal;
    if (held === undefined) throw new Error("expected held proposal");
    // 보유 내용의 정의 자리는 검증이 정규화한 사본이다(제안 경로가 보유하는 형태).
    const normalized = validatePlanProposal(
      deps,
      asMarkdownWork(reachWorkState("PLANNING").aggregate),
      planInput([draft("t")], { definition: VALID_DEFINITION_DRAFT }),
    );
    if (!normalized.valid) throw new Error("expected valid definition draft");
    const definition = normalized.content.definition;
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
    // 대조: 정의된 출처는 사전 거절을 지나고, 템플릿 출처는 materialize 만 만들므로 명령으로는 invalid_input 이다.
    expect(reasonOf("planner")).toBeUndefined();
    expect(reasonOf("definition_template")).toBe("invalid_input");
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

describe("SC-029: materialize 차단 조건의 순서와 경계", () => {
  it("Edge: 정의 비활성 → 오래된 보류 → 열린 회차 상한 순으로 첫 차단 사유를 내고, 모두 통과하면 차단이 없다 (test_SC029_materialization_blocker_order_and_bound)", () => {
    const view = {
      definitionState: "ACTIVE",
      heldCount: 0,
      openCount: 0,
      maxOpenOccurrences: 1,
    } as const;
    expect(materializationBlocker(view)).toBeUndefined();
    // 경계: 열린 회차가 상한과 같으면 차단, 하나 적으면 통과.
    expect(materializationBlocker({ ...view, openCount: 1 })).toBe("open_bound");
    expect(
      materializationBlocker({ ...view, openCount: 1, maxOpenOccurrences: 2 }),
    ).toBeUndefined();
    expect(materializationBlocker({ ...view, heldCount: 1 })).toBe("older_held");
    expect(materializationBlocker({ ...view, heldCount: 1, openCount: 1 })).toBe("older_held");
    expect(
      materializationBlocker({ ...view, definitionState: "PAUSED", heldCount: 1, openCount: 1 }),
    ).toBe("definition_paused");
  });
});

describe("SC-046: 실행 전 승인이 남은 READY Task 의 외부 신호", () => {
  it("Error: 실행 전 승인이 남은 READY 는 unexpected_state 이고 승인된 같은 Task 는 수용된다 (test_SC046_ready_with_pending_pre_execution_approval_refused)", () => {
    const listenerTrigger = {
      kind: "signal",
      version: 1,
      triggerId: "listener",
      sourceId: "fixture_source",
      signal: "fixture_ready",
    } as unknown as TriggerSpec;
    const { journal, ids } = startJournal(
      [draft("listener", { trigger: listenerTrigger })],
      testDeps("killextgate"),
    );
    const listener = ids["listener"] as TaskId;
    validate(journal, listener);
    const signal = {
      type: "external_signal",
      signalId: nextEntityId(journal.deps.ids, "signal"),
      subject: { taskId: listener },
      sourceId: "fixture_source",
      signalName: "fixture_ready",
      sourceOccurrenceId: "src-1",
      payload: {},
      actorSource: "unknown",
      receivedAt: KILL_NOW,
    } as const;
    // 레코드 패치: 실행 전 승인이 남은 READY(명령 경로로 도달 불가 — 검증 차단 → unblock 경로 대용).
    const gated = patchTask(journal.aggregate, listener, {
      policy: basePolicy({ approvalRequiredBeforeExecute: true }),
      preExecutionApproved: false,
    });
    const refused = judgeTaskExternalSignal(journal.deps, gated, signal, KILL_NOW);
    expect(refused.kind).toBe("rejected");
    if (refused.kind === "rejected") expect(refused.reason).toBe("unexpected_state");
    const approved = patchTask(gated, listener, { preExecutionApproved: true });
    expect(judgeTaskExternalSignal(journal.deps, approved, signal, KILL_NOW).kind).toBe("accepted");
  });
});

// ---- 반복 정의·회차 흐름의 커밋 전체 형태 — 공용 판별 입력 ----
// 정의 판정이 만드는 커밋의 이벤트 순서·envelope(커밋 내 위치·ID·원인·Work 정체·출처·행위자·시각)·페이로드와
// 최종 상태의 정의 레코드를 시나리오마다 한 줄씩 투영해 digest 로 고정한다. 값이 undefined 인 키도 표시한다.
// 생성 ID 는 시나리오 안의 첫 등장 순 별칭으로 바꿔 개별 ID 값에 기대지 않는다. 실패 메시지가 투영 전문이라
// 어긋난 줄을 바로 볼 수 있다.

const GOLDEN_ID_TOKEN =
  /\b(?:wrk|wdf|pln|tsk|res|rct|occ|sig|evt|att|cfm|dec|dsp|ctl|cmt|prj)_[0-9A-Za-z]+/g;

class GoldenProjection {
  readonly lines: string[] = [];
  private readonly alias = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  private name(text: string): string {
    return text.replace(GOLDEN_ID_TOKEN, (token) => {
      const known = this.alias.get(token);
      if (known !== undefined) return known;
      const prefix = token.slice(0, 3);
      const n = (this.counters.get(prefix) ?? 0) + 1;
      this.counters.set(prefix, n);
      const named = `${prefix}#${n}`;
      this.alias.set(token, named);
      return named;
    });
  }

  private norm(value: unknown): unknown {
    if (value === undefined) return "<undefined>";
    if (typeof value === "string") return this.name(value);
    if (Array.isArray(value)) return value.map((v) => this.norm(v));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = this.norm((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  }

  note(text: string): void {
    this.lines.push(this.name(text));
  }

  outcome(outcome: unknown): void {
    const o = outcome as {
      kind: string;
      reason?: string;
      rejection?: { reason: string; detail?: string };
    };
    this.note(
      `outcome ${o.kind}${o.reason !== undefined ? ` ${o.reason}` : ""}${
        o.rejection !== undefined ? ` ${o.rejection.reason}/${o.rejection.detail ?? ""}` : ""
      }`,
    );
  }

  commits(commits: readonly DomainCommit[]): void {
    commits.forEach((commit, ci) => {
      for (const e of commit.events) {
        const env = e as unknown as Record<string, unknown> & {
          commit: { index: number; count: number };
        };
        this.lines.push(
          [
            `${ci}`,
            `${env.commit.index}/${env.commit.count}`,
            this.name(String(env["id"])),
            e.type,
            `w=${this.name(String(env["workId"]))}`,
            `prj=${this.name(String(env["projectId"]))}`,
            `corr=${this.name(String(env["correlationId"]))}`,
            env["taskId"] !== undefined ? `t=${this.name(String(env["taskId"]))}` : "",
            env["causationId"] !== undefined ? `c=${this.name(String(env["causationId"]))}` : "",
            `by=${String(env["actorSource"])}`,
            env["actor"] !== undefined ? `actor=${JSON.stringify(this.norm(env["actor"]))}` : "",
            `at=${String(env["occurredAt"])}`,
            JSON.stringify(this.norm(e.payload)),
          ]
            .filter((part) => part !== "")
            .join(" "),
        );
      }
    });
  }

  /** 최종 상태의 Work 마다 상태·정의 레코드 전체. */
  state(state: WorkflowState): void {
    for (const aggregate of Object.values(state.works)) {
      this.lines.push(
        `state w=${this.name(aggregate.work.id)} ${aggregate.work.state}${
          aggregate.definition !== undefined
            ? ` def=${JSON.stringify(this.norm(aggregate.definition))}`
            : ""
        }`,
      );
    }
  }
}

/** 개정 제안 + 사람 grant. 제안이 승인 대기에 들지 않으면 무효 이슈를 기록한다. */
function goldenAmend(
  g: GoldenProjection,
  journal: WorkflowJournal,
  definitionId: WorkDefinitionId,
  overrides: DefinitionDraftInput,
  now: ReturnType<typeof dayAt>,
): void {
  const stewardId = journal.steward(definitionId).work.id;
  const proposed = journal.proposeAmendment(definitionId, overrides, now);
  if (proposed.kind !== "committed" || journal.work(stewardId).work.state !== "WAITING_APPROVAL") {
    const invalid =
      proposed.kind === "committed"
        ? proposed.commit.events.find((e) => e.type === "work_plan_invalid")
        : undefined;
    g.note(`amend-proposal ${proposed.kind} ${JSON.stringify(invalid?.payload ?? null)}`);
    return;
  }
  g.outcome(journal.decidePlan(stewardId, "grant", now));
}

function goldenScenario(run: (g: GoldenProjection) => void): string[] {
  const g = new GoldenProjection();
  run(g);
  return g.lines;
}

const GOLDEN_SCENARIOS: Record<string, () => string[]> = {
  tour: () =>
    goldenScenario((g) => {
      const tour = definitionTour(definitionDeps("goldtour"), definitionDeps("goldtoursig"));
      g.note(`failures ${JSON.stringify(tour.failures)}`);
      for (const journal of tour.journals) {
        g.commits(journal.commits);
        g.state(journal.state);
      }
    }),
  misfire: () =>
    goldenScenario((g) => {
      for (const misfire of [
        { kind: "skip" },
        { kind: "fire_once_now" },
        { kind: "catch_up_bounded", maxCatchUp: 2 },
        { kind: "catch_up_bounded", maxCatchUp: 1 },
        { kind: "catch_up_bounded", maxCatchUp: 0 },
      ] as const) {
        const seed = `goldmis${misfire.kind.replace(/_/g, "")}${"maxCatchUp" in misfire ? misfire.maxCatchUp : ""}`;
        const r = registerDefinition(definitionDeps(seed), {
          draft: definitionDraft({
            activation: dailyActivation({ misfire }),
            maxOpenOccurrences: 2,
          }),
        });
        const before = r.journal.commits.length;
        g.note(JSON.stringify(misfire));
        g.outcome(r.journal.resolveDue(r.definitionId, dayAt(3)));
        g.outcome(r.journal.resolveDue(r.definitionId, dayAt(5), { late: true }));
        g.commits(r.journal.commits.slice(before));
        g.state(r.journal.state);
      }
    }),
  signalExhaustion: () =>
    goldenScenario((g) => {
      const r = registerDefinition(definitionDeps("goldsigmax"), {
        draft: signalDefinitionDraft({ maxOccurrences: 1 }),
      });
      const before = r.journal.commits.length;
      g.outcome(r.journal.external(r.definitionId, "src-1", dayAt(0)));
      g.outcome(r.journal.external(r.definitionId, "src-2", dayAt(0, "08:00")));
      g.commits(r.journal.commits.slice(before));
      g.state(r.journal.state);
    }),
  stewardCancel: () =>
    goldenScenario((g) => {
      for (const kind of ["vault", "control"] as const) {
        const r = registerAndMaterializeFirst(definitionDeps(`goldcancel${kind}`));
        r.journal.resolveDue(r.definitionId, dayAt(1));
        const before = r.journal.commits.length;
        const origin =
          kind === "vault"
            ? vaultOrigin(r.journal.deps)
            : mustOk(
                parseCancelOrigin({
                  kind: "control_request",
                  actorSource: "unknown",
                  controlRequestId: nextEntityId(r.journal.deps.ids, "controlRequest"),
                  keyId: "fixture-key",
                }),
              );
        g.note(kind);
        g.outcome(
          r.journal.onWork(r.stewardId, { kind: "cancel_work", origin }, dayAt(1, "09:00"), {
            actorSource: kind === "vault" ? "human_local" : "unknown",
          }),
        );
        g.commits(r.journal.commits.slice(before));
        g.state(r.journal.state);
      }
      for (const state of ["PAUSED", "STOPPED"] as const) {
        const r = registerAndMaterializeFirst(definitionDeps(`goldcxl${state.toLowerCase()}`));
        r.journal.control(r.definitionId, state === "PAUSED" ? "pause" : "stop", dayAt(0, "08:00"));
        const before = r.journal.commits.length;
        g.note(state);
        g.outcome(
          r.journal.onWork(
            r.stewardId,
            { kind: "cancel_work", origin: vaultOrigin(r.journal.deps) },
            dayAt(0, "09:00"),
            { actorSource: "human_local" },
          ),
        );
        g.commits(r.journal.commits.slice(before));
        g.state(r.journal.state);
      }
    }),
  amendment: () =>
    goldenScenario((g) => {
      const a = registerAndMaterializeFirst(definitionDeps("goldamtime"));
      a.journal.resolveDue(a.definitionId, dayAt(1));
      const beforeA = a.journal.commits.length;
      goldenAmend(
        g,
        a.journal,
        a.definitionId,
        { activation: dailyActivation({ localTime: "08:00" }) },
        dayAt(1, "10:00"),
      );
      goldenAmend(
        g,
        a.journal,
        a.definitionId,
        { activation: signalActivation(), maxOccurrences: 3 },
        dayAt(1, "11:00"),
      );
      g.outcome(a.journal.external(a.definitionId, "src-a", dayAt(1, "11:30")));
      goldenAmend(
        g,
        a.journal,
        a.definitionId,
        { activation: dailyActivation({ triggerId: "daily2" }) },
        dayAt(1, "11:40"),
      );
      goldenAmend(
        g,
        a.journal,
        a.definitionId,
        {
          activation: dailyActivation({ triggerId: "daily2" }),
          maxOccurrences: undefined,
        } as unknown as DefinitionDraftInput,
        dayAt(1, "12:00"),
      );
      g.commits(a.journal.commits.slice(beforeA));
      g.state(a.journal.state);

      const b = registerDefinition(definitionDeps("goldamsig"), {
        draft: signalDefinitionDraft({ maxOccurrences: 5 }),
      });
      b.journal.external(b.definitionId, "src-1", dayAt(0));
      b.journal.external(b.definitionId, "src-2", dayAt(0, "07:10"));
      const beforeB = b.journal.commits.length;
      goldenAmend(g, b.journal, b.definitionId, { maxOccurrences: 1 }, dayAt(0, "08:00"));
      g.commits(b.journal.commits.slice(beforeB));
      g.state(b.journal.state);

      const c = registerAndMaterializeFirst(definitionDeps("goldamend"));
      const beforeC = c.journal.commits.length;
      goldenAmend(
        g,
        c.journal,
        c.definitionId,
        { activation: dailyActivation({ until: dayAt(0, "08:00") }) },
        dayAt(0, "09:00"),
      );
      g.commits(c.journal.commits.slice(beforeC));
      g.state(c.journal.state);
    }),
  signalRecords: () =>
    goldenScenario((g) => {
      const r = registerAndMaterializeFirst(definitionDeps("goldrej"));
      const id = r.definitionId;
      const before = r.journal.commits.length;
      g.outcome(r.journal.control(id, "pause", dayAt(0, "08:00"), { expectedRevision: 0 }));
      g.outcome(r.journal.control(id, "resume", dayAt(0, "08:01")));
      g.outcome(
        r.journal.control(id, "pause", dayAt(0, "08:02"), { actorSource: "agent_session" }),
      );
      g.outcome(r.journal.control(id, "pause", dayAt(0, "08:03"), { channel: "control_request" }));
      g.outcome(
        r.journal.control(id, "pause", dayAt(0, "08:03"), {
          channel: "control_request",
          expectedRevision: r.journal.definition(id).revision - 1,
        }),
      );
      g.outcome(r.journal.external(id, "src-x", dayAt(0, "08:04")));
      g.outcome(r.journal.control(id, "resume", dayAt(0, "08:05"), { channel: "control_request" }));
      g.outcome(r.journal.control(id, "stop", dayAt(0, "08:06"), { channel: "control_request" }));
      g.outcome(r.journal.control(id, "stop", dayAt(0, "08:07")));
      g.commits(r.journal.commits.slice(before));
      g.state(r.journal.state);

      const s = registerDefinition(definitionDeps("goldrejsig"), {
        draft: signalDefinitionDraft(),
      });
      const beforeS = s.journal.commits.length;
      g.outcome(s.journal.external(s.definitionId, "src-0", dayAt(0)));
      g.outcome(s.journal.external(s.definitionId, "src-0", dayAt(0, "06:30")));
      g.outcome(s.journal.external(s.definitionId, "src-1", dayAt(0), { signalName: "other" }));
      g.outcome(s.journal.control(s.definitionId, "stop", dayAt(0, "08:00")));
      g.outcome(s.journal.external(s.definitionId, "src-2", dayAt(0, "09:00")));
      g.commits(s.journal.commits.slice(beforeS));
      g.state(s.journal.state);
    }),
  taskSignal: () =>
    goldenScenario((g) => {
      const listenerTrigger = {
        kind: "signal",
        version: 1,
        triggerId: "listener",
        sourceId: "fixture_source",
        signal: "fixture_ready",
      } as unknown as TriggerSpec;
      const { journal, ids } = startJournal(
        [draft("listener", { trigger: listenerTrigger })],
        definitionDeps("goldtask"),
      );
      const listener = ids["listener"] as TaskId;
      const workId = journal.aggregate.work.id;
      const signal = (occ: string, overrides: Record<string, unknown> = {}) =>
        ({
          ...externalSignal(journal.deps, {
            subject: { taskId: listener },
            sourceOccurrenceId: occ,
            receivedAt: dayAt(0),
          }),
          ...overrides,
        }) as never;
      const draftStage = new WorkflowJournal(
        journal.deps,
        { works: { [workId]: journal.aggregate } } as never,
        [],
      );
      g.outcome(draftStage.taskExternal(workId, signal("o-1"), dayAt(0)));
      validate(journal, listener);
      const ready = new WorkflowJournal(
        journal.deps,
        { works: { [workId]: journal.aggregate } } as never,
        [],
      );
      g.outcome(ready.taskExternal(workId, signal("o-2", { signalName: "other" }), dayAt(0)));
      g.outcome(
        ready.taskExternal(workId, signal("o-3", { actor: { kind: "human", id: "u1" } }), dayAt(0)),
      );
      g.outcome(ready.taskExternal(workId, signal("o-3"), dayAt(0, "07:01")));
      g.commits([...draftStage.commits, ...ready.commits]);
      g.state(ready.state);
    }),
  templateDrift: () =>
    goldenScenario((g) => {
      const registered = registerDefinition(occurrenceConsumerDeps("golddrift"), {
        draft: definitionDraft({
          template: [templateDraft("consumer", { type: OCCURRENCE_CONSUMER, input: {} })],
        }),
      });
      const j = new WorkflowJournal(
        { ...registered.journal.deps, registries: testRegistries() },
        registered.journal.state,
        registered.journal.commits,
      );
      const before = j.commits.length;
      g.outcome(j.resolveDue(registered.definitionId, dayAt(0)));
      g.outcome(j.control(registered.definitionId, "resume", dayAt(0, "08:00")));
      g.outcome(j.release(registered.definitionId, dayAt(0, "08:01")));
      g.commits(j.commits.slice(before));
      g.state(j.state);
    }),
  commandMeta: () =>
    goldenScenario((g) => {
      const r = registerDefinition(definitionDeps("goldmeta"));
      const pending = r.journal.definition(r.definitionId).pendingSchedule;
      if (pending === undefined) throw new Error("golden: no pending schedule");
      const outcome = executeDefinitionCommand(r.journal.deps, r.journal.state, {
        kind: "resolve_due_schedule",
        definitionId: r.definitionId,
        occurrenceId: pending.occurrenceId,
        meta: {
          ...meta(dayAt(0), "adde_self"),
          actor: { kind: "system", id: "sched" },
          causationId: entityId("event", "evt_cause1"),
        },
      } as never);
      g.outcome(outcome);
      if ("commit" in outcome) {
        g.commits([outcome.commit]);
        g.state(outcome.state);
      }
    }),
  overdueResume: () =>
    goldenScenario((g) => {
      const r = registerDefinition(definitionDeps("goldoverdue"), {
        draft: definitionDraft({ activation: dailyActivation({ misfire: { kind: "skip" } }) }),
      });
      const before = r.journal.commits.length;
      g.outcome(r.journal.control(r.definitionId, "pause", dayAt(-1, "13:00")));
      g.outcome(r.journal.resolveDue(r.definitionId, dayAt(0)));
      g.outcome(r.journal.control(r.definitionId, "resume", dayAt(0, "09:00")));
      g.outcome(r.journal.resolveDue(r.definitionId, dayAt(0, "09:01")));
      g.commits(r.journal.commits.slice(before));
      g.state(r.journal.state);
    }),
  signalRelease: () =>
    goldenScenario((g) => {
      const r = registerDefinition(definitionDeps("goldrelease"), {
        draft: signalDefinitionDraft(),
      });
      const before = r.journal.commits.length;
      g.outcome(r.journal.external(r.definitionId, "s-1", dayAt(0)));
      g.outcome(r.journal.external(r.definitionId, "s-2", dayAt(0, "07:01")));
      g.outcome(r.journal.external(r.definitionId, "s-3", dayAt(0, "07:02")));
      g.outcome(r.journal.release(r.definitionId, dayAt(0, "07:03")));
      const second = r.journal.definition(r.definitionId).held[1]?.occurrenceId;
      const firstWork = r.journal.occurrenceWorkIds(r.definitionId)[0];
      if (second === undefined || firstWork === undefined) throw new Error("golden: holds");
      r.journal.completeWork(firstWork, dayAt(0, "07:04"));
      g.outcome(r.journal.release(r.definitionId, dayAt(0, "07:05"), { occurrenceId: second }));
      g.outcome(r.journal.release(r.definitionId, dayAt(0, "07:06")));
      g.commits(r.journal.commits.slice(before));
      g.state(r.journal.state);
    }),
  releaseExhaustion: () =>
    goldenScenario((g) => {
      const r = registerDefinition(definitionDeps("goldrelmax"), {
        draft: signalDefinitionDraft({ maxOccurrences: 2 }),
      });
      const before = r.journal.commits.length;
      g.outcome(r.journal.control(r.definitionId, "pause", dayAt(0, "06:00")));
      for (const [k, occ] of ["h-1", "h-2", "h-3"].entries()) {
        g.outcome(r.journal.external(r.definitionId, occ, dayAt(0, `06:1${k}`)));
      }
      g.outcome(r.journal.control(r.definitionId, "resume", dayAt(0, "06:30")));
      g.outcome(r.journal.release(r.definitionId, dayAt(0, "06:31")));
      const firstWork = r.journal.occurrenceWorkIds(r.definitionId)[0];
      if (firstWork === undefined) throw new Error("golden: first occurrence");
      r.journal.completeWork(firstWork, dayAt(0, "06:40"));
      g.outcome(r.journal.release(r.definitionId, dayAt(0, "06:41")));
      g.commits(r.journal.commits.slice(before));
      g.state(r.journal.state);
    }),
  stewardReplan: () =>
    goldenScenario((g) => {
      for (const stopped of [true, false]) {
        const r = registerDefinition(definitionDeps(`goldreplan${stopped ? "stop" : "live"}`), {
          tasks: STEWARD_MEMBER,
        });
        if (stopped) r.journal.control(r.definitionId, "stop", dayAt(0, "08:00"));
        const before = r.journal.commits.length;
        g.note(stopped ? "stopped" : "live");
        r.journal.ensurePlanning(r.stewardId, dayAt(0, "09:00"));
        g.outcome(
          r.journal.commitPlan(
            r.stewardId,
            r.journal.replanBase(r.stewardId, { tasks: [templateDraft("added")] }),
            dayAt(0, "09:00"),
          ),
        );
        g.commits(r.journal.commits.slice(before));
        g.state(r.journal.state);
      }
    }),
  exhaustionWithdrawsAmendment: () =>
    goldenScenario((g) => {
      const r = registerDefinition(definitionDeps("goldwithdraw"), {
        draft: signalDefinitionDraft({ maxOccurrences: 1 }),
      });
      r.journal.proposeAmendment(r.definitionId, { title: "pending title" }, dayAt(0, "06:00"));
      const before = r.journal.commits.length;
      g.note(`state ${r.journal.steward(r.definitionId).work.state}`);
      g.outcome(r.journal.external(r.definitionId, "s-1", dayAt(0)));
      g.note(`state ${r.journal.steward(r.definitionId).work.state}`);
      g.commits(r.journal.commits.slice(before));
      g.state(r.journal.state);
    }),
  commandRejections: () =>
    goldenScenario((g) => {
      const r = registerAndMaterializeFirst(definitionDeps("goldcmdrej"));
      const id = r.definitionId;
      const pending = r.journal.definition(id).pendingSchedule?.occurrenceId;
      if (pending === undefined) throw new Error("golden: no pending schedule");
      g.outcome(r.journal.resolveDue(id, dayAt(0, "08:00"), { occurrenceId: pending }));
      g.outcome(
        r.journal.resolveDue(id, dayAt(1), {
          occurrenceId: "occ_AAAAAAAAAAAAAAAAAAAAAAAAAA" as never,
        }),
      );
      g.outcome(r.journal.release(id, dayAt(1), { occurrenceId: pending }));
      r.journal.resolveDue(id, dayAt(1));
      r.journal.completeWork(r.firstWorkId, dayAt(1, "07:10"));
      g.outcome(r.journal.resolveDue(id, dayAt(2)));
      g.outcome(
        executeDefinitionCommand(r.journal.deps, r.journal.state, {
          kind: "unknown_kind",
          meta: meta(dayAt(2)),
        } as never),
      );
      for (const kind of ["resolve_due_schedule", "release_held_occurrence"] as const) {
        g.outcome(
          executeDefinitionCommand(r.journal.deps, r.journal.state, {
            kind,
            definitionId: nextEntityId(r.journal.deps.ids, "workDefinition"),
            occurrenceId: pending,
            meta: meta(dayAt(2)),
          }),
        );
      }
      const s = registerDefinition(definitionDeps("goldcmdrejsig"), {
        draft: signalDefinitionDraft(),
      });
      g.outcome(
        s.journal.resolveDue(s.definitionId, dayAt(0), {
          occurrenceId: "occ_AAAAAAAAAAAAAAAAAAAAAAAAAA" as never,
        }),
      );
    }),
  heldPolicies: () =>
    goldenScenario((g) => {
      for (const misfire of [
        { kind: "fire_once_now" },
        { kind: "catch_up_bounded", maxCatchUp: 1 },
        { kind: "catch_up_bounded", maxCatchUp: 2 },
        { kind: "skip" },
      ] as const) {
        const seed = `goldheld${misfire.kind.replace(/_/g, "")}${"maxCatchUp" in misfire ? misfire.maxCatchUp : ""}`;
        const r = registerAndMaterializeFirst(
          definitionDeps(seed),
          definitionDraft({ activation: dailyActivation({ misfire, until: dayAt(3) }) }),
        );
        const id = r.definitionId;
        const before = r.journal.commits.length;
        g.note(JSON.stringify(misfire));
        for (const k of [1, 2, 3]) g.outcome(r.journal.resolveDue(id, dayAt(k)));
        for (let round = 0; round < 3 && r.journal.definition(id).held.length > 0; round += 1) {
          for (const workId of r.journal.occurrenceWorkIds(id)) {
            if (r.journal.work(workId).work.state !== "COMPLETED") {
              r.journal.completeWork(workId, dayAt(3, `0${round + 7}:30`));
            }
          }
          g.outcome(r.journal.release(id, dayAt(3, `0${round + 7}:40`)));
        }
        g.commits(r.journal.commits.slice(before));
        g.state(r.journal.state);
      }
    }),
  amendmentSearch: () =>
    goldenScenario((g) => {
      const a = registerAndMaterializeFirst(definitionDeps("goldroundtrip"));
      const beforeA = a.journal.commits.length;
      goldenAmend(
        g,
        a.journal,
        a.definitionId,
        { activation: dailyActivation({ localTime: "08:00" }) },
        dayAt(0, "09:00"),
      );
      goldenAmend(
        g,
        a.journal,
        a.definitionId,
        { activation: dailyActivation() },
        dayAt(0, "10:00"),
      );
      goldenAmend(g, a.journal, a.definitionId, { title: "renamed" }, dayAt(0, "11:00"));
      g.commits(a.journal.commits.slice(beforeA));
      g.state(a.journal.state);

      const b = registerAndMaterializeFirst(definitionDeps("goldsearchend"));
      const beforeB = b.journal.commits.length;
      goldenAmend(
        g,
        b.journal,
        b.definitionId,
        { activation: dailyActivation({ localTime: "08:00", until: dayAt(0, "08:00") }) },
        dayAt(0, "07:30"),
      );
      g.commits(b.journal.commits.slice(beforeB));
      g.state(b.journal.state);

      const p = registerAndMaterializeFirst(definitionDeps("goldsearchstart"));
      const beforeP = p.journal.commits.length;
      goldenAmend(
        g,
        p.journal,
        p.definitionId,
        { activation: dailyActivation({ localTime: "03:00" }) },
        dayAt(1, "06:00"),
      );
      g.commits(p.journal.commits.slice(beforeP));
      g.state(p.journal.state);

      for (const [seed, at] of [
        ["golddueexact", dayAt(1)],
        ["goldduepast", dayAt(1, "10:00")],
      ] as const) {
        const c = registerAndMaterializeFirst(definitionDeps(seed));
        const beforeC = c.journal.commits.length;
        goldenAmend(g, c.journal, c.definitionId, { title: "renamed" }, at);
        g.commits(c.journal.commits.slice(beforeC));
        g.state(c.journal.state);
      }
    }),
  amendHeldSignals: () =>
    goldenScenario((g) => {
      for (const [seed, activation] of [
        ["goldheldsrc", signalActivation({ sourceId: "other_source" })],
        ["goldheldname", signalActivation({ signal: "other_signal" })],
        ["goldheldsame", signalActivation({ triggerId: "on_signal2" })],
        ["goldheldsched", dailyActivation()],
      ] as const) {
        const r = registerDefinition(definitionDeps(seed), { draft: signalDefinitionDraft() });
        const before = r.journal.commits.length;
        g.note(seed);
        r.journal.control(r.definitionId, "pause", dayAt(0, "06:00"));
        r.journal.external(r.definitionId, "h-1", dayAt(0, "06:10"));
        r.journal.external(r.definitionId, "h-2", dayAt(0, "06:20"));
        r.journal.control(r.definitionId, "resume", dayAt(0, "06:30"));
        g.state(r.journal.state);
        goldenAmend(g, r.journal, r.definitionId, { activation }, dayAt(0, "06:40"));
        g.commits(r.journal.commits.slice(before));
        g.state(r.journal.state);
      }
    }),
  templateInvalidCandidates: () =>
    goldenScenario((g) => {
      const registered = registerDefinition(occurrenceConsumerDeps("goldtplcand"), {
        draft: definitionDraft({
          activation: dailyActivation({ misfire: { kind: "catch_up_bounded", maxCatchUp: 2 } }),
          maxOpenOccurrences: 2,
          template: [templateDraft("consumer", { type: OCCURRENCE_CONSUMER, input: {} })],
        }),
      });
      const j = new WorkflowJournal(
        { ...registered.journal.deps, registries: testRegistries() },
        registered.journal.state,
        registered.journal.commits,
      );
      const before = j.commits.length;
      g.outcome(j.resolveDue(registered.definitionId, dayAt(1)));
      g.commits(j.commits.slice(before));
      g.state(j.state);
    }),
};

const GOLDEN_DIGESTS: Record<string, string> = {
  tour: "6dda0185f5ce3f2fedd08351ada49317121caf2dc2cc6e15242aa482ef1a72bd",
  misfire: "947195d28a24260275cb7cfe5a0f835b5e9109008ea461bbfbfee320d7d503fc",
  signalExhaustion: "6c57f3c838bf92a43c224902212796546d85f4fb27693f2bf6428058e6f22561",
  stewardCancel: "991559d1b9275b0d5a80c667adb75c9f40a8cc066d3865eab4748bca7f1ceef5",
  amendment: "3d024dda48c811d928cd9d7c9a0dceca75eb5fd3ccf2bed2dff387a9705b6da6",
  signalRecords: "28f149b201b4ad45ecfba838465f8a6fd59a8edfb42dbeac1620b47fd96ec942",
  taskSignal: "70d169571c7819a85f6a49abe5e5d665a652dce0962f3ae07abb2144d73fa69c",
  templateDrift: "75b165a8bcd853983118d40e40e0682b9aec9c1683f47a63a6c406148ead3260",
  commandMeta: "af6336e32119162ac4721be203997d643a070d5a9e6dbc0c348cbb0c536e7328",
  overdueResume: "5516710cfcdf3c3ac9e62a72141479cabe4efed34fdf7b1dd192680302745508",
  signalRelease: "16cb925d085cc4c9d398843db25fb4a44ee18a8876047c14b1715d84fd810f9d",
  releaseExhaustion: "345d8d35355d70af4e7806418d58820488a5cbcf729fba05e808e714f2ba24ad",
  stewardReplan: "35f609e092768ac6a4281293fb7b48677fdbaa289cb673f145849ff7edac749e",
  exhaustionWithdrawsAmendment: "57729189361c4018ce489350a408b7b73c8e352e0411db7ecace5ac112600ac6",
  commandRejections: "368fe7cb7f9dea5a7c97c0976d4236776b9ae494ca498adb171dfa0f09e33514",
  heldPolicies: "1c8175d3c0997d48af7c94c7b836df3c12455c455c2f1c0b704f0d8586aae339",
  amendmentSearch: "a7cc01b738f060081286df67fed382d7513c892f4a384955e8bc8c060888b7ee",
  amendHeldSignals: "21c3ee0b4213664dc0937839f64cc4816bc140f34eabf7c798976069fb23135c",
  templateInvalidCandidates: "c336b6461ec8aeaee5139fe57ef2e24a61a6224856ba76225f7056ef46620d41",
};

describe("SC-023·SC-063: 정의 흐름 커밋 전체 형태(공용 판별 입력)", () => {
  for (const [name, scenario] of Object.entries(GOLDEN_SCENARIOS)) {
    it(`Edge: 시나리오 ${name} 의 커밋 투영 digest 가 고정값이다 (test_SC023_definition_flow_projection_${name})`, () => {
      const projection = scenario().join("\n");
      expect(sha256Hex(projection), projection).toBe(GOLDEN_DIGESTS[name]);
    });
  }
});

// ---- 반복 정의·회차 판정의 입력 경계 — 전체 mutation 실행이 생존·미커버로 지목한 조건 ----

describe("SC-052·SC-053: 재계산 입력 형식의 경계", () => {
  it("Error: 앞뒤 군더더기·범위 밖 시각은 거절되고 초 단독·짧은 밀리초는 정확히 읽는다 (test_SC052_local_input_format_boundaries)", () => {
    const kindOf = (localDate: string, localTime: string): string => {
      const result = localToUtc({ localDate, localTime, timeZone: "UTC" });
      return result.ok ? result.value.kind : result.error.kind;
    };
    expect(kindOf("x2026-03-01", "07:00")).toBe("local_date_invalid");
    expect(kindOf("2026-03-01x", "07:00")).toBe("local_date_invalid");
    expect(kindOf("2026-02-30", "07:00")).toBe("local_date_invalid");
    expect(kindOf("2026-03-01", "x07:00")).toBe("local_time_invalid");
    expect(kindOf("2026-03-01", "07:00x")).toBe("local_time_invalid");
    expect(kindOf("2026-03-01", "24:00")).toBe("local_time_invalid");
    expect(kindOf("2026-03-01", "07:60")).toBe("local_time_invalid");
    expect(kindOf("2026-03-01", "07:00:60")).toBe("local_time_invalid");
    // 대조: 같은 날짜의 정상 시각은 정확히 하나다.
    const exactOf = (localTime: string) =>
      localToUtc({ localDate: "2026-03-01", localTime, timeZone: "UTC" });
    expect(exactOf("07:00:30")).toEqual({
      ok: true,
      value: { kind: "exact", utc: "2026-03-01T07:00:30.000Z" },
    });
    expect(exactOf("07:00:00.5")).toEqual({
      ok: true,
      value: { kind: "exact", utc: "2026-03-01T07:00:00.500Z" },
    });
    expect(exactOf("07:00:00.05")).toEqual({
      ok: true,
      value: { kind: "exact", utc: "2026-03-01T07:00:00.050Z" },
    });
    expect(exactOf("23:59:59.999")).toEqual({
      ok: true,
      value: { kind: "exact", utc: "2026-03-01T23:59:59.999Z" },
    });
  });
});

describe("SC-010·SC-045: 활성화 판독(형태·descriptor)의 경계", () => {
  it("Error: 형태가 어긋난 활성화는 판독하지 않고 미등록 활성화는 어느 종류도 아니다 (test_SC010_activation_view_shape_boundaries)", () => {
    const registries = definitionDeps("killview").registries;
    const daily = dailyActivation() as unknown as Record<string, unknown>;
    const signal = signalActivation() as unknown as Record<string, unknown>;
    const asSpec = (raw: Record<string, unknown>) => raw as unknown as TriggerSpec;
    expect(scheduleActivationView(asSpec(daily))).toEqual({
      triggerId: "daily",
      timezone: "UTC",
      misfire: { kind: "fire_once_now" },
      recurrence: daily["recurrence"],
    });
    for (const broken of [
      { ...daily, triggerId: 1 },
      { ...daily, timezone: 1 },
      { ...daily, misfire: null },
      { ...daily, misfire: "skip" },
      { ...daily, recurrence: null },
      { ...daily, recurrence: "test-daily 07:00" },
    ]) {
      expect(scheduleActivationView(asSpec(broken))).toBeUndefined();
    }
    expect(signalActivationView(asSpec(signal))).toEqual({
      triggerId: "on_signal",
      sourceId: "fixture_source",
      signal: "fixture_ready",
    });
    for (const broken of [
      { ...signal, triggerId: 1 },
      { ...signal, sourceId: 1 },
      { ...signal, signal: 1 },
    ]) {
      expect(signalActivationView(asSpec(broken))).toBeUndefined();
    }
    // descriptor 판독: kind·version 형태가 어긋나거나 미등록이면 어느 종류도 아니고 던지지 않는다.
    expect(isScheduleActivation(registries, asSpec(daily))).toBe(true);
    expect(isSignalActivation(registries, asSpec(signal))).toBe(true);
    expect(isScheduleActivation(registries, asSpec(signal))).toBe(false);
    expect(isSignalActivation(registries, asSpec(daily))).toBe(false);
    for (const broken of [
      { ...daily, kind: 1 },
      { ...daily, version: "1" },
      { ...daily, kind: "unregistered" },
    ]) {
      expect(isScheduleActivation(registries, asSpec(broken))).toBe(false);
      expect(isSignalActivation(registries, asSpec({ ...signal, ...broken }))).toBe(false);
    }
    const { recurrence: _omit, ...noRecurrence } = daily;
    void _omit;
    expect(isScheduleActivation(registries, asSpec(noRecurrence))).toBe(false);
  });
});

describe("SC-041: 반복 전개 포트 출력 계약의 검사", () => {
  function portedJournal(seed: string, port: RecurrenceExpander) {
    const registered = registerDefinition(definitionDeps(seed));
    const journal = new WorkflowJournal(
      { ...registered.journal.deps, recurrence: port },
      registered.journal.state,
      registered.journal.commits,
    );
    return { journal, definitionId: registered.definitionId };
  }
  function stepping(
    override: (step: { scheduledForUtc: unknown; recurrenceIndex: unknown }) => unknown,
  ): RecurrenceExpander {
    return {
      firstAtOrAfter: (activation, atOrAfter) => {
        const real = testDailyRecurrence.firstAtOrAfter(activation, atOrAfter);
        return real === undefined ? undefined : (override(real) as never);
      },
      periodOf: (activation, at) => testDailyRecurrence.periodOf(activation, at),
    };
  }

  it("Error: 정규 표기 아님·질의보다 이름·0 이상 안전 정수 아닌 번호·빈 주기 키는 불변식 위반이다 (test_SC041_recurrence_port_output_contract_enforced)", () => {
    const broken: Record<string, RecurrenceExpander> = {
      notCanonical: stepping((s) => ({
        ...s,
        scheduledForUtc: String(s.scheduledForUtc).replace(".000Z", "Z"),
      })),
      notString: stepping((s) => ({
        ...s,
        scheduledForUtc: Date.parse(String(s.scheduledForUtc)),
      })),
      earlier: stepping((s) => ({ ...s, scheduledForUtc: "2026-02-01T07:00:00.000Z" })),
      indexString: stepping((s) => ({ ...s, recurrenceIndex: String(s.recurrenceIndex) })),
      indexFraction: stepping((s) => ({ ...s, recurrenceIndex: 1.5 })),
      indexNegative: stepping((s) => ({ ...s, recurrenceIndex: -1 })),
      emptyPeriod: {
        firstAtOrAfter: (a, t) => testDailyRecurrence.firstAtOrAfter(a, t),
        periodOf: () => "",
      },
      numberPeriod: {
        firstAtOrAfter: (a, t) => testDailyRecurrence.firstAtOrAfter(a, t),
        periodOf: () => 7 as unknown as string,
      },
    };
    for (const [name, port] of Object.entries(broken)) {
      const { journal, definitionId } = portedJournal(`killport${name.toLowerCase()}`, port);
      // 첫 회차 해소는 다음 대기 행을 포트로 전개한다. 주기 키는 개정 재예약이 읽는다.
      const act = () =>
        name.endsWith("Period")
          ? (() => {
              journal.resolveDue(definitionId, dayAt(0));
              return journal.amend(
                definitionId,
                { activation: dailyActivation({ localTime: "09:00" }) },
                dayAt(0, "08:00"),
              );
            })()
          : journal.resolveDue(definitionId, dayAt(0));
      // 포트 출력 검사가 직접 잡는다 — 뒤 단계(occurrence 파생·개정 탐색 상한)의 실패로 대신 걸리지 않는다.
      const message = name.startsWith("index")
        ? /회차 번호/
        : name.endsWith("Period")
          ? /주기 키/
          : name === "earlier"
            ? /보다 이른 회차/
            : /정규 UTC 표기가 아닌/;
      let thrown: unknown;
      try {
        act();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeInstanceOf(DomainInvariantError);
      expect((thrown as Error).message, name).toMatch(message);
    }
    // 대조: 같은 경로를 정상 포트로 돌리면 던지지 않는다.
    const { journal, definitionId } = portedJournal("killportok", testDailyRecurrence);
    expect(journal.resolveDue(definitionId, dayAt(0)).kind).toBe("committed");
    expect(
      journal.amend(
        definitionId,
        { activation: dailyActivation({ localTime: "09:00" }) },
        dayAt(0, "08:00"),
      ).kind,
    ).toBe("accepted");
  });

  it("Edge: 포트가 계열 끝(undefined)을 내면 대기 행 없이 생성 커밋에서 중지하고 다음 회차가 없다 (test_SC041_port_series_end_stops_at_creation_and_after_resolution)", () => {
    const ended: RecurrenceExpander = {
      firstAtOrAfter: () => undefined,
      periodOf: (a, t) => testDailyRecurrence.periodOf(a, t),
    };
    const created = registerDefinition(definitionDeps("killportend", undefined, ended));
    expect(created.journal.definition(created.definitionId).state).toBe("STOPPED");
    expect(created.journal.definition(created.definitionId).pendingSchedule).toBeUndefined();
    // 첫 회차 뒤 포트가 끝을 내면 그 해소 커밋에서 다음 대기 행이 없다(null).
    const { journal, definitionId } = portedJournal("killportendafter", {
      firstAtOrAfter: (a, t) =>
        Date.parse(t) <= Date.parse(dayAt(0))
          ? testDailyRecurrence.firstAtOrAfter(a, t)
          : undefined,
      periodOf: (a, t) => testDailyRecurrence.periodOf(a, t),
    });
    const outcome = journal.resolveDue(definitionId, dayAt(0));
    expect(outcome.kind).toBe("committed");
    const fired =
      "commit" in outcome
        ? outcome.commit.events.find((e) => e.type === "trigger_fired")
        : undefined;
    expect((fired?.payload as unknown as Record<string, unknown>)["nextSchedule"]).toBeNull();
  });

  it("Error: 개정 탐색이 주기 필터로 끝없이 넘기면 탐색 상한에서 불변식 위반이다 (test_SC041_amendment_search_limit_enforced)", () => {
    const { journal, definitionId } = portedJournal("killportloop", {
      firstAtOrAfter: (a, t) => testDailyRecurrence.firstAtOrAfter(a, t),
      periodOf: () => "same-period",
    });
    journal.resolveDue(definitionId, dayAt(0));
    expect(() =>
      journal.amend(
        definitionId,
        { activation: dailyActivation({ localTime: "09:00" }) },
        dayAt(0, "08:00"),
      ),
    ).toThrow(DomainInvariantError);
  });

  it("Edge: 탐색 상한은 정확히 1만 후보다 — 1만째 후보에서 주기가 바뀌면 찾고 1만 1째면 던진다 (test_SC041_amendment_search_limit_exact)", () => {
    const amendWithBoundary = (seed: string, boundary: UtcInstant) => {
      const { journal, definitionId } = portedJournal(seed, {
        firstAtOrAfter: (a, t) => testDailyRecurrence.firstAtOrAfter(a, t),
        periodOf: (_a, t) => (Date.parse(t) < Date.parse(boundary) ? "p0" : t),
      });
      journal.resolveDue(definitionId, dayAt(0));
      return () =>
        journal.amend(
          definitionId,
          { activation: dailyActivation({ localTime: "09:00" }) },
          dayAt(0, "08:00"),
        );
    };
    // 후보 k 는 dayAt(k, 09:00) — 0..9999 가 상한 안이다.
    expect(amendWithBoundary("killsearch9999", dayAt(9999, "09:00"))().kind).toBe("accepted");
    expect(amendWithBoundary("killsearch10000", dayAt(10000, "09:00"))).toThrow(
      DomainInvariantError,
    );
  });

  it("Edge: 커밋 시각이 회차 시각과 같으면 그 회차가 첫 대기 행이다 (test_SC041_first_row_at_exact_commit_instant)", () => {
    const r = registerDefinition(definitionDeps("killexactfirst"), { now: dayAt(0) });
    expect(r.journal.definition(r.definitionId).pendingSchedule?.scheduledForUtc).toBe(dayAt(0));
  });
});

describe("SC-034: 정의 제어 신호 판독의 경계", () => {
  it("Error: 동작·식별·채널 형태가 어긋난 제어 신호는 수용되지 않고 정의가 그대로다 (test_SC034_control_signal_input_boundaries)", () => {
    const r = registerAndMaterializeFirst(definitionDeps("killctlinput"));
    const id = r.definitionId;
    const base = () =>
      controlSignal(r.journal.deps, {
        definitionId: id,
        expectedRevision: r.journal.definition(id).revision,
        action: "pause",
        channel: "control_request",
        receivedAt: dayAt(0, "08:00"),
      });
    const judge = (signal: unknown) =>
      judgeDefinitionSignal(r.journal.deps, r.journal.state, signal as never, dayAt(0, "08:00"));
    const label = (j: { kind: string; reason?: string; rejection?: { reason: string } }) =>
      j.kind === "not_applicable" ? `na:${j.rejection?.reason}` : `${j.kind}:${j.reason ?? ""}`;
    const before = r.journal.definition(id);
    expect(label(judge({ ...base(), action: "explode" }))).toBe("na:invalid_input");
    expect(label(judge({ ...base(), definitionId: "wdf_unknowndef" }))).toBe("na:unknown_subject");
    const ctl = base().channel as unknown as Record<string, unknown>;
    // 채널 종류가 제어 요청이 아니면 ctl_ ID·keyId 가 있어도 인증 요청이 아니다.
    expect(label(judge({ ...base(), channel: { ...ctl, kind: "markdown" } }))).toBe(
      "rejected:provenance_not_human",
    );
    // 요청 ID 가 없으면 던지지 않고 사람 아님이다.
    const { controlRequestId: _drop, ...noId } = ctl;
    void _drop;
    expect(label(judge({ ...base(), channel: noId }))).toBe("rejected:provenance_not_human");
    expect(r.journal.definition(id)).toEqual(before);
    // 대조: 형태가 맞는 같은 요청은 수용된다.
    expect(label(judge(base()))).toBe("accepted:");
  });

  it("Edge: 노트 출처 전이 출처는 요청 필드를 싣지 않고 신호 행위자는 envelope 에 실린다 (test_SC034_vault_origin_has_no_request_fields_and_actor_carried)", () => {
    const r = registerAndMaterializeFirst(definitionDeps("killctlorigin"));
    const signal = {
      ...controlSignal(r.journal.deps, {
        definitionId: r.definitionId,
        expectedRevision: r.journal.definition(r.definitionId).revision,
        action: "pause",
        receivedAt: dayAt(0, "08:00"),
      }),
      actor: { kind: "human", id: "owner" },
    };
    const judged = r.journal.signal(signal as never, dayAt(0, "08:00"));
    expect(judged.kind).toBe("accepted");
    const commit = "commit" in judged ? judged.commit : undefined;
    const paused = commit?.events.find((e) => e.type === "work_definition_paused");
    const origin = (paused?.payload as unknown as { pauseOrigin: Record<string, unknown> })
      .pauseOrigin;
    expect(Object.keys(origin).sort()).toEqual(["actorSource", "kind", "signalId"]);
    expect(
      commit?.events.every((e) => (e as unknown as { actor?: unknown }).actor !== undefined),
    ).toBe(true);
    // 대조: 행위자 없는 신호의 envelope 에는 행위자 키가 없다.
    const resumed = r.journal.control(r.definitionId, "resume", dayAt(0, "09:00"));
    const resumeCommit = "commit" in resumed ? resumed.commit : undefined;
    expect(resumeCommit?.events.some((e) => "actor" in e)).toBe(false);
  });

  it("Edge: 대기 행 시각에 정확히 재개하면 지연 표식이고 대기 행 없는 신호 정의 재개는 표식 없이 수용된다 (test_SC036_resume_overdue_boundary_and_signal_definition)", () => {
    const r = registerDefinition(definitionDeps("killresumeedge"));
    r.journal.control(r.definitionId, "pause", dayAt(-1, "13:00"));
    const atDue = r.journal.control(r.definitionId, "resume", dayAt(0));
    const resumedAt =
      "commit" in atDue
        ? atDue.commit.events.find((e) => e.type === "work_definition_resumed")
        : undefined;
    expect(
      (resumedAt?.payload as unknown as Record<string, unknown>)["pendingScheduleOverdue"],
    ).toBe(true);
    const s = registerDefinition(definitionDeps("killresumesig"), {
      draft: signalDefinitionDraft(),
    });
    s.journal.control(s.definitionId, "pause", dayAt(0));
    const signalResume = s.journal.control(s.definitionId, "resume", dayAt(0, "08:00"));
    expect(signalResume.kind).toBe("accepted");
    const resumedSig =
      "commit" in signalResume
        ? signalResume.commit.events.find((e) => e.type === "work_definition_resumed")
        : undefined;
    expect(
      (resumedSig?.payload as unknown as Record<string, unknown>)["pendingScheduleOverdue"],
    ).toBe(false);
  });
});

describe("SC-023: 정의 명령의 진입 포착과 입력 경계", () => {
  it("Error: 명령 meta 는 한 번만 읽고 객체가 아닌 meta·모르는 명령은 커밋하지 않는다 (test_SC023_definition_command_meta_captured_once)", () => {
    const r = registerDefinition(definitionDeps("killcmdmeta"));
    const pending = r.journal.definition(r.definitionId).pendingSchedule;
    if (pending === undefined) throw new Error("no pending schedule");
    const reads: Record<string, number> = {};
    const counted = (key: string, value: unknown) => ({
      get: () => {
        reads[key] = (reads[key] ?? 0) + 1;
        return value;
      },
      enumerable: true,
    });
    const metaObject = Object.defineProperties(
      {},
      {
        now: counted("now", dayAt(0)),
        actorSource: counted("actorSource", "adde_self"),
        actor: counted("actor", { kind: "system", id: "sched" }),
        causationId: counted("causationId", entityId("event", "evt_metacause")),
      },
    );
    const outcome = executeDefinitionCommand(r.journal.deps, r.journal.state, {
      kind: "resolve_due_schedule",
      definitionId: r.definitionId,
      occurrenceId: pending.occurrenceId,
      meta: metaObject,
    } as never);
    expect(outcome.kind).toBe("committed");
    expect(reads).toEqual({ now: 1, actorSource: 1, actor: 1, causationId: 1 });
    // 객체가 아닌 meta 는 복사하지 않고 그대로 읽어 던진다(커밋하지 않는다).
    expect(() =>
      executeDefinitionCommand(r.journal.deps, r.journal.state, {
        kind: "resolve_due_schedule",
        definitionId: r.definitionId,
        occurrenceId: pending.occurrenceId,
        meta: null,
      } as never),
    ).toThrow(TypeError);
    const unknown = executeDefinitionCommand(r.journal.deps, r.journal.state, {
      kind: "rewind",
      meta: meta(dayAt(0)),
    } as never);
    expect(unknown).toEqual({
      kind: "rejected",
      rejection: { reason: "invalid_input", detail: "unknown_command" },
    });
  });

  it("Error: 정의 신호 진입은 대상이 객체가 아니거나 Task 대상이면 적용하지 않는다 (test_SC045_definition_signal_entry_subject_checks)", () => {
    const r = registerDefinition(definitionDeps("killsigentry"), {
      draft: signalDefinitionDraft(),
    });
    const ext = externalSignal(r.journal.deps, {
      subject: { definitionId: r.definitionId },
      sourceOccurrenceId: "e-1",
    });
    const judge = (signal: unknown) =>
      judgeDefinitionSignal(r.journal.deps, r.journal.state, signal as never, dayAt(0));
    expect(judge({ ...ext, subject: null })).toEqual({
      kind: "not_applicable",
      rejection: { reason: "invalid_input" },
    });
    expect(judge({ ...ext, subject: "wdf" })).toEqual({
      kind: "not_applicable",
      rejection: { reason: "invalid_input" },
    });
    expect(judge({ ...ext, subject: { taskId: "tsk_x" } })).toEqual({
      kind: "not_applicable",
      rejection: { reason: "invalid_input", detail: "task_subject_not_definition_signal" },
    });
    expect(judge({ ...ext, type: "unknown_type" })).toEqual({
      kind: "not_applicable",
      rejection: { reason: "invalid_input" },
    });
    expect(judge({ ...ext, subject: { definitionId: "wdf_unknowndef" } })).toEqual({
      kind: "not_applicable",
      rejection: { reason: "unknown_subject" },
    });
    expect(judge({ ...ext, sourceOccurrenceId: "" })).toEqual({
      kind: "not_applicable",
      rejection: { reason: "invalid_input" },
    });
    expect(judge({ ...ext, payload: { bad: Number.NaN } })).toEqual({
      kind: "not_applicable",
      rejection: { reason: "invalid_input" },
    });
    // 대조: 형태가 맞는 같은 신호는 수용된다.
    expect(judge(ext).kind).toBe("accepted");
  });
});

describe("SC-046: Task 대상 외부 신호 진입의 경계", () => {
  it("Error: Task ID 가 문자열이 아니거나 없는 Task·예약 Trigger Task 는 수용되지 않는다 (test_SC046_task_signal_entry_boundaries)", () => {
    const listenerTrigger = {
      kind: "signal",
      version: 1,
      triggerId: "listener",
      sourceId: "fixture_source",
      signal: "fixture_ready",
    } as unknown as TriggerSpec;
    const { journal, ids } = startJournal(
      [draft("listener", { trigger: listenerTrigger }), draft("timed")],
      definitionDeps("killtaskentry"),
    );
    const listener = ids["listener"] as TaskId;
    const timed = ids["timed"] as TaskId;
    validate(journal, listener);
    validate(journal, timed);
    const ext = (subject: unknown, overrides: Record<string, unknown> = {}) => ({
      ...externalSignal(journal.deps, { subject: { taskId: listener }, sourceOccurrenceId: "t-1" }),
      subject,
      ...overrides,
    });
    const judge = (signal: unknown) =>
      judgeTaskExternalSignal(journal.deps, journal.aggregate, signal as never, KILL_NOW);
    const label = (j: { kind: string; reason?: string; rejection?: { reason: string } }) =>
      j.kind === "not_applicable" ? `na:${j.rejection?.reason}` : `${j.kind}:${j.reason ?? ""}`;
    expect(label(judge(ext({ taskId: 7 })))).toBe("na:invalid_input");
    expect(label(judge(ext({ taskId: "tsk_notinwork" })))).toBe("na:unknown_subject");
    expect(label(judge(ext({ taskId: listener }, { sourceOccurrenceId: "" })))).toBe(
      "na:invalid_input",
    );
    expect(label(judge(ext({ taskId: listener }, { payload: { bad: Number.NaN } })))).toBe(
      "na:invalid_input",
    );
    expect(label(judge(ext({ taskId: timed })))).toBe("rejected:trigger_mismatch");
    expect(label(judge(ext({ taskId: listener }, { sourceId: "other_source" })))).toBe(
      "rejected:trigger_mismatch",
    );
    expect(label(judge(ext({ taskId: listener })))).toBe("accepted:");
  });
});

describe("SC-016·SC-018: 중지된 정의의 관리 Work 파생 상태", () => {
  it("Edge: 정의가 중지된 관리 Work 의 새 계획은 member 가 시작 전이면 READY 다 (test_SC018_stopped_steward_new_plan_derives_ready)", () => {
    const r = registerDefinition(definitionDeps("killstopready"), { tasks: STEWARD_MEMBER });
    r.journal.control(r.definitionId, "stop", dayAt(0, "08:00"));
    const steward = r.stewardId;
    expect(r.journal.work(steward).work.state).toBe("ACTIVE");
    r.journal.ensurePlanning(steward, dayAt(0, "09:00"));
    const committed = r.journal.commitPlan(
      steward,
      r.journal.replanBase(steward, { tasks: [templateDraft("added")] }),
      dayAt(0, "09:00"),
    );
    expect(committed.kind).toBe("committed");
    expect(r.journal.work(steward).work.state).toBe("READY");
    // 대조: 살아 있는 정의의 같은 계획은 ACTIVE 다(정의가 진행을 붙든다).
    const live = registerDefinition(definitionDeps("killliveactive"), { tasks: STEWARD_MEMBER });
    live.journal.ensurePlanning(live.stewardId, dayAt(0, "09:00"));
    live.journal.commitPlan(
      live.stewardId,
      live.journal.replanBase(live.stewardId, { tasks: [templateDraft("added")] }),
      dayAt(0, "09:00"),
    );
    expect(live.journal.work(live.stewardId).work.state).toBe("ACTIVE");
  });
});

describe("SC-008·SC-009·SC-010: 정의 초안 형태 판독의 경계", () => {
  it("Error: 객체·키·필드 형태가 어긋난 초안은 draft_malformed 하나이고 수치 필드는 각자의 사유다 (test_SC010_definition_draft_shape_boundaries)", () => {
    const deps = definitionDeps("killdraftshape");
    const reasons = (content: unknown): string[] =>
      definitionInvalidReasons(issuesOf(proposeDraft(deps, content).outcome));
    const base = definitionDraft();
    const validAmends = { definitionId: "wdf_someother", expectedRevision: 1 };
    const malformed: Record<string, unknown> = {
      nullDraft: null,
      arrayDraft: [base],
      stringDraft: "draft",
      extraKey: { ...base, extra: 1 },
      missingTitle: (() => {
        const { title: _t, ...rest } = base;
        void _t;
        return rest;
      })(),
      titleNumber: { ...base, title: 5 },
      templateString: { ...base, template: "digest" },
      amendsString: { ...base, amends: "wdf_x" },
      amendsThreeKeys: { ...base, amends: { ...validAmends, extra: 1 } },
      amendsNoDefinitionId: { ...base, amends: { other: "wdf_x", expectedRevision: 1 } },
      amendsNoRevision: { ...base, amends: { definitionId: "wdf_x", other: 1 } },
      amendsIdNumber: { ...base, amends: { definitionId: 5, expectedRevision: 1 } },
      amendsIdFormat: { ...base, amends: { definitionId: "wrk_notadef", expectedRevision: 1 } },
      amendsRevisionString: { ...base, amends: { ...validAmends, expectedRevision: "1" } },
      amendsRevisionFraction: { ...base, amends: { ...validAmends, expectedRevision: 1.5 } },
      amendsRevisionNegative: { ...base, amends: { ...validAmends, expectedRevision: -1 } },
    };
    for (const [name, content] of Object.entries(malformed)) {
      expect(reasons(content), name).toEqual(["draft_malformed"]);
    }
    // 대조: 형태가 맞는 개정(0 revision 포함)은 형태를 통과해 관리 여부 판정에 이른다.
    expect(reasons({ ...base, amends: validAmends })).toEqual(["amends_not_steward"]);
    expect(reasons({ ...base, amends: { ...validAmends, expectedRevision: 0 } })).toEqual([
      "amends_not_steward",
    ]);
    for (const value of [0, 1.5, "1"]) {
      expect(reasons({ ...base, maxOpenOccurrences: value }), String(value)).toEqual([
        "max_open_occurrences_invalid",
      ]);
    }
    expect(reasons(signalDefinitionDraft({ maxOccurrences: 0 }))).toEqual([
      "max_occurrences_invalid",
    ]);
    expect(reasons({ ...base, maxOccurrences: 2 })).toEqual(["max_occurrences_not_allowed"]);
    expect(reasons({ ...base, activation: { ...dailyActivation(), kind: 5 } })).toEqual([
      "activation_descriptor_unknown",
    ]);
    expect(reasons({ ...base, activation: { ...dailyActivation(), version: "1" } })).toEqual([
      "activation_descriptor_unknown",
    ]);
    expect(reasons({ ...base, activation: "daily" })).toEqual(["activation_descriptor_unknown"]);
    expect(reasons(base)).toEqual([]);
  });

  it("Edge: 정규화한 초안·생성 정의는 없는 선택 필드의 키를 싣지 않는다 (test_SC006_normalized_draft_omits_absent_optional_keys)", () => {
    const r = registerDefinition(definitionDeps("killdraftkeys"));
    const proposed = r.commits
      .flatMap((c) => c.events)
      .find((e) => e.type === "work_plan_proposed");
    const created = r.grant.events.find((e) => e.type === "work_definition_created");
    const proposedDefinition = (
      proposed?.payload as unknown as { proposal: { definition: Record<string, unknown> } }
    ).proposal.definition;
    const createdDefinition = (
      created?.payload as unknown as { definition: Record<string, unknown> }
    ).definition;
    for (const record of [proposedDefinition, createdDefinition]) {
      expect(Object.hasOwn(record, "amends")).toBe(false);
      expect(Object.hasOwn(record, "maxOccurrences")).toBe(false);
    }
    // 대조: 신호 정의의 최대 회차 수는 키로 실린다.
    const s = registerDefinition(definitionDeps("killdraftkeyssig"), {
      draft: signalDefinitionDraft({ maxOccurrences: 4 }),
    });
    const sigCreated = s.grant.events.find((e) => e.type === "work_definition_created");
    expect(
      (sigCreated?.payload as unknown as { definition: Record<string, unknown> }).definition[
        "maxOccurrences"
      ],
    ).toBe(4);
  });

  it("Error: 템플릿 출처 제안의 내용·digest 는 계약 입력 그대로이고 정규 JSON 이 아닌 템플릿은 불변식 위반이다 (test_SC024_template_proposal_content_and_digest_inputs)", () => {
    const r = registerDefinition(definitionDeps("killtplcontent"));
    const definition = r.journal.definition(r.definitionId);
    const occurrenceId = definition.pendingSchedule?.occurrenceId;
    if (occurrenceId === undefined) throw new Error("no pending schedule");
    const input = {
      occurrenceId,
      definitionId: definition.id,
      definitionRevision: definition.revision,
      scheduledForUtc: dayAt(0),
      localDate: "2026-03-01",
      timezone: "UTC",
    };
    const built = buildTemplateProposal(r.journal.deps, definition, {
      occurrenceId,
      input,
    } as never);
    expect(built.valid).toBe(true);
    if (!built.valid) return;
    expect(built.content).toEqual({
      basePlanRevision: 0,
      source: "definition_template",
      tasks: definition.template,
      retain: [],
    });
    expect(built.digest).toBe(
      independentDigest({
        source: "definition_template",
        definitionId: definition.id,
        definitionRevision: definition.revision,
        occurrenceId,
        basePlanRevision: 0,
        tasks: definition.template,
        retain: [],
      }),
    );
    expect(() =>
      templateProposalDigest({
        definitionId: definition.id,
        definitionRevision: 1,
        occurrenceId,
        tasks: [{ bad: Number.NaN }] as never,
      }),
    ).toThrow(DomainInvariantError);
  });
});

describe("SC-005·SC-016: 다중 Work 상태와 전체 로그 fold 의 방어 경계", () => {
  it("Error: 같은 Work 둘·같은 정의를 가진 Work 둘·상태에 없는 회차 Work 는 불변식 위반이다 (test_SC016_workflow_state_invariants_enforced)", () => {
    const r = registerAndMaterializeFirst(definitionDeps("stateinv"));
    const steward = r.journal.work(r.stewardId);
    const occurrence = r.journal.work(r.firstWorkId);
    expect(Object.keys(workflowStateOf([steward, occurrence]).works)).toEqual([
      r.stewardId,
      r.firstWorkId,
    ]);
    expect(() => workflowStateOf([steward, occurrence, steward])).toThrow(DomainInvariantError);

    const definition = r.journal.definition(r.definitionId);
    const twin = { ...occurrence, definition };
    expect(findSteward(withWork(r.journal.state, steward), r.definitionId)).toBe(steward);
    expect(() => findSteward(withWork(r.journal.state, twin), r.definitionId)).toThrow(
      DomainInvariantError,
    );

    expect(openOccurrenceCount(r.journal.state, definition)).toBe(1);
    const withoutOccurrence = workflowStateOf([steward]);
    expect(() => openOccurrenceCount(withoutOccurrence, definition)).toThrow(DomainInvariantError);
  });

  it("Error: 전체 로그 fold 의 실패는 종류·대상 이벤트·사유를 그대로 돌려준다 (test_SC005_fold_errors_carry_kind_and_reason)", () => {
    const { journal } = registerAndMaterializeFirst(definitionDeps("folderr"));
    const events = journal.commits.flatMap((c) => c.events);
    expect(foldWorkflowEvents(events).ok).toBe(true);
    const multi = journal.commits.find((c) => new Set(c.events.map((e) => e.workId)).size > 1);
    if (multi === undefined) throw new Error("expected a multi-work commit");
    const before = journal.commits
      .slice(0, journal.commits.indexOf(multi))
      .flatMap((c) => c.events);
    const [m1, m2] = multi.events;
    if (m1 === undefined || m2 === undefined) throw new Error("expected two events");
    const mid = multi.events.slice(2);
    const foldErr = (stream: readonly unknown[]) => {
      const folded = foldWorkflowEvents(stream as never);
      return folded.ok ? "ok" : folded.error;
    };

    const first = events[0];
    if (first === undefined) throw new Error("expected events");
    expect(foldErr([{ ...first, type: "no_such_event" }, ...events.slice(1)])).toEqual({
      kind: "unknown_event_type",
      eventId: first.id,
      type: "no_such_event",
    });
    expect(foldErr([{ ...first, schemaVersion: 2 }, ...events.slice(1)])).toEqual({
      kind: "unsupported_schema_version",
      eventId: first.id,
      schemaVersion: 2,
    });
    const { workId: _dropped, ...withoutWork } = first;
    void _dropped;
    expect(foldErr([withoutWork, ...events.slice(1)])).toEqual({
      kind: "inconsistent_stream",
      eventId: first.id,
      reason: "missing_work_id",
    });

    const recount = { ...m2, commit: { ...m2.commit, count: m2.commit.count + 1 } };
    expect(foldErr([...before, m1, recount, ...mid])).toEqual({
      kind: "malformed_commit",
      commitId: multi.id,
      reason: "inconsistent_count",
    });
    const reindex = { ...m2, commit: { ...m2.commit, index: 3 } };
    expect(foldErr([...before, m1, reindex, ...mid])).toEqual({
      kind: "malformed_commit",
      commitId: multi.id,
      reason: "non_consecutive_index",
    });
    expect(foldErr([...before, ...multi.events.slice(0, -1)])).toEqual({
      kind: "malformed_commit",
      commitId: multi.id,
      reason: "count_mismatch",
    });

    // 등록 커밋을 빼면 관리 Work 의 첫 이벤트가 work_created 가 아니다.
    const registration = journal.commits[0];
    if (registration === undefined) throw new Error("expected registration");
    const rest = journal.commits.slice(1).flatMap((c) => c.events);
    const restFirst = rest[0];
    if (restFirst === undefined) throw new Error("expected later events");
    expect(foldErr(rest)).toEqual({
      kind: "inconsistent_stream",
      eventId: restFirst.id,
      reason: "first_event_not_work_created",
    });
    // 등록 커밋을 다른 커밋 ID 로 다시 덧붙이면 이미 있는 Work 의 work_created 다.
    const again = registration.events.map((e) => ({
      ...e,
      commit: { ...e.commit, id: "cmt_again000000001" },
    }));
    const createdAgain = again.find((e) => e.type === "work_created");
    if (createdAgain === undefined) throw new Error("expected work_created");
    expect(foldErr([...events, ...again])).toEqual({
      kind: "inconsistent_stream",
      eventId: createdAgain.id,
      reason: "duplicate_work_created",
    });
    // 같은 커밋 안에서 새 Work 의 work_created 가 두 번 나온다.
    const createdAt = multi.events.findIndex((e) => e.type === "work_created");
    const created = multi.events[createdAt];
    if (created === undefined) throw new Error("expected occurrence work_created");
    const twice = [
      ...multi.events.slice(0, createdAt + 1),
      { ...created, id: "evt_twice000000001" },
      ...multi.events.slice(createdAt + 1),
    ].map((e, i, all) => ({ ...e, commit: { ...e.commit, index: i + 1, count: all.length } }));
    expect(foldErr([...before, ...twice])).toEqual({
      kind: "inconsistent_stream",
      eventId: "evt_twice000000001",
      reason: "duplicate_work_created",
    });
  });
});

describe("SC-008·SC-010·SC-011: 정의 초안·회차 출처의 판독 경계", () => {
  it("Error: 필수 키가 빠지거나 amends 가 null 이면 draft_malformed 하나다 (test_SC010_required_keys_and_null_amends_malformed)", () => {
    const deps = definitionDeps("killdraftkeys2");
    const reasons = (content: unknown): string[] =>
      definitionInvalidReasons(issuesOf(proposeDraft(deps, content).outcome));
    const base = definitionDraft();
    for (const key of ["title", "activation", "template", "maxOpenOccurrences"]) {
      const { [key]: _omitted, ...rest } = base;
      void _omitted;
      expect(reasons(rest), key).toEqual(["draft_malformed"]);
    }
    expect(reasons({ ...base, amends: null })).toEqual(["draft_malformed"]);
    expect(reasons(base)).toEqual([]);
  });

  it("Error: 관리 Work 가 다른 정의를 개정하려는 초안은 amends_not_steward 하나다 (test_SC009_steward_amending_other_definition_not_steward)", () => {
    const r = registerDefinition(definitionDeps("killamendother"));
    const other = nextEntityId(r.journal.deps.ids, "workDefinition");
    r.journal.ensurePlanning(r.stewardId, dayAt(0, "06:00"));
    const proposeWith = (definitionId: WorkDefinitionId) =>
      r.journal.propose(
        r.stewardId,
        r.journal.replanBase(r.stewardId, {
          definition: definitionDraft({
            amends: {
              definitionId,
              expectedRevision: r.journal.definition(r.definitionId).revision,
            },
          }),
        }),
        dayAt(0, "06:00"),
      );
    expect(definitionInvalidReasons(issuesOf(proposeWith(other)))).toEqual(["amends_not_steward"]);
  });

  it("Edge: 템플릿 판정 문맥에는 기준 member 가 없어 Task ID 참조는 미지 의존이다 (test_SC011_template_task_refs_have_no_base_members)", () => {
    const deps = definitionDeps("killtplbase");
    // 판정 문맥의 기준 member 목록이 비어 있음을 본다 — 어떤 문자열 참조도(변이 도구의 대체 표식 포함) 기준
    // member 로 풀리지 않는다.
    for (const ref of ["tsk_AAAAAAAAAAAAAAAAAAAAAAAAAA", "Stryker was here"]) {
      const content = definitionDraft({
        template: [templateDraft("digest", { dependsOn: [{ taskId: ref as TaskId }] })],
      });
      const kinds = templateIssues(issuesOf(proposeDraft(deps, content).outcome)).map(
        (i) => i["kind"],
      );
      expect(kinds, ref).toContain("unknown_dependency");
      expect(kinds, ref).not.toContain("dependency_outside_revision");
    }
  });

  it("Error: 명령 경로의 회차 출처 Work 생성과 정의 템플릿 출처 제안은 지정 detail 로 거절된다 (test_SC008_reserved_occurrence_and_template_sources_refused)", () => {
    const deps = definitionDeps("killreserved");
    const projectId = mustOk(parseProjectId("prj_reservedsource"));
    const create = (source: unknown) =>
      createWork(deps, {
        kind: "create_work",
        meta: meta(DEF_NOW),
        projectId,
        title: "t",
        objective: "t",
        source,
      } as never);
    expect(
      create({
        kind: "definition_occurrence",
        definitionId: "wdf_AAAAAAAAAAAAAAAAAAAAAAAAAA",
        definitionRevision: 1,
        occurrenceId: "occ_AAAAAAAAAAAAAAAAAAAAAAAAAA",
        input: {},
      }),
    ).toEqual({
      kind: "rejected",
      rejection: {
        reason: "invalid_input",
        detail: "definition_occurrence_by_materialization_only",
      },
    });
    expect(create({ kind: "markdown", documentId: "doc-x" }).kind).toBe("committed");

    const { journal, workId } = markdownWorkInPlanning(definitionDeps("killreservedplan"));
    const propose = (source: string) =>
      journal.propose(
        workId,
        { basePlanRevision: 0, source, tasks: [], retain: [] } as never,
        DEF_NOW,
      );
    expect(propose("definition_template")).toEqual({
      kind: "rejected",
      rejection: { reason: "invalid_input", detail: "definition_template_source_reserved" },
    });
  });
});

describe("SC-048: schedule_task 의 계약 입력 재계산 — Task 기록 패치 경계", () => {
  const LISTENER = {
    kind: "signal",
    version: 1,
    triggerId: "listener",
    sourceId: FIXTURE_SIGNAL_SOURCE,
    signal: FIXTURE_SIGNAL_NAME,
  } as unknown as TriggerSpec;
  const AT_FIRE = at("2026-01-01T01:00:00Z");

  function readyTasks(seed: string) {
    const { journal, ids } = startJournal(
      [
        draft("timed", { trigger: atTrigger("timed", { kind: "skip" }) }),
        draft("listener", { trigger: LISTENER }),
        draft("retry"),
      ],
      testDeps(seed),
    );
    for (const ref of ["timed", "listener", "retry"]) validate(journal, ids[ref] as TaskId);
    return {
      journal,
      timed: ids["timed"] as TaskId,
      listener: ids["listener"] as TaskId,
      retry: ids["retry"] as TaskId,
    };
  }
  const scheduleId = (taskId: TaskId, triggerId = "timed") =>
    mustOk(
      deriveOccurrenceId({
        kind: "schedule",
        ownerId: taskId,
        triggerId,
        scheduledForUtc: AT_FIRE,
        recurrenceIndex: 0,
      }),
    );
  const schedule = (
    journal: Journal,
    taskId: TaskId,
    occurrenceId: string,
    cause: "schedule" | "external_signal" | "retry",
  ) =>
    taskCommand(journal.deps, journal.aggregate, taskId, {
      kind: "schedule_task",
      occurrenceId: occurrenceId as never,
      cause,
    });
  const condition = (detail: string) => ({
    kind: "rejected",
    rejection: { reason: "condition_not_met", detail },
  });

  it("Error: 예정 시각이 문자열이 아닌 기록은 occurrence_id_mismatch, 파생 불가 Trigger ID 는 불변식 위반이다 (test_SC048_patched_schedule_record_refused_or_invariant)", () => {
    const { journal, timed } = readyTasks("killtaskrec1");
    const trigger = journal.task(timed).trigger as unknown as Record<string, unknown>;
    const valid = scheduleId(timed);
    const nonString = patchTask(journal.aggregate, timed, {
      trigger: { ...trigger, scheduledForUtc: 5 } as never,
    });
    expect(
      taskCommand(journal.deps, nonString, timed, {
        kind: "schedule_task",
        occurrenceId: valid,
        cause: "schedule",
      }),
    ).toEqual(condition("occurrence_id_mismatch"));
    const badTriggerId = patchTask(journal.aggregate, timed, {
      trigger: { ...trigger, triggerId: "" } as never,
    });
    expect(() =>
      taskCommand(journal.deps, badTriggerId, timed, {
        kind: "schedule_task",
        occurrenceId: valid,
        cause: "schedule",
      }),
    ).toThrow(DomainInvariantError);
    // 대조: 기록이 온전하면 예약되고 시각 원인 예약은 원인 이벤트 키를 싣지 않는다.
    const scheduled = journal.apply(schedule(journal, timed, valid, "schedule"));
    const payload = payloadOf(scheduled, "task_scheduled");
    expect(Object.keys(payload).sort()).toEqual(["cause", "occurrenceId"]);
  });

  it("Error: 신호 이름만 다른 수용 참조는 signal_source_mismatch 다 (test_SC048_signal_name_mismatch_refused)", () => {
    const { journal, listener } = readyTasks("killtaskrec2");
    const otherName = withPendingSignalAcceptance(journal.aggregate, listener, {
      signalName: "other_signal",
    });
    expect(
      taskCommand(journal.deps, otherName.aggregate, listener, {
        kind: "schedule_task",
        occurrenceId: otherName.occurrenceId,
        cause: "external_signal",
      }),
    ).toEqual(condition("signal_source_mismatch"));
    const same = withPendingSignalAcceptance(journal.aggregate, listener);
    expect(
      taskCommand(journal.deps, same.aggregate, listener, {
        kind: "schedule_task",
        occurrenceId: same.occurrenceId,
        cause: "external_signal",
      }).kind,
    ).toBe("committed");
  });

  it("Error: 재시도 대기 기록이 없는 RETRY_WAIT 는 불변식 위반이다 (test_SC048_retry_wait_without_record_invariant)", () => {
    const { journal, retry } = readyTasks("killtaskrec3");
    journal.apply(taskCommand(journal.deps, journal.aggregate, retry, { kind: "start_attempt" }));
    const attemptId = journal.task(retry).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    journal.apply(
      executeCommand(journal.deps, journal.aggregate, {
        kind: "record_attempt_outcome",
        taskId: retry,
        expectedRevision: journal.task(retry).revision,
        meta: meta(at("2026-01-01T00:00:00Z")),
        attemptId,
        outcome: { kind: "failed", code: "fixture_retryable" },
      }),
    );
    expect(journal.task(retry).state).toBe("RETRY_WAIT");
    const { lastRetryWait: _wait, ...withoutWait } = journal.task(retry);
    void _wait;
    const patched = {
      ...journal.aggregate,
      tasks: { ...journal.aggregate.tasks, [retry]: withoutWait },
    };
    expect(() =>
      taskCommand(journal.deps, patched, retry, {
        kind: "schedule_task",
        occurrenceId: scheduleId(retry, "retry"),
        cause: "retry",
      }),
    ).toThrow(DomainInvariantError);
  });
});

describe("SC-014·SC-029·SC-045: 정의 레코드 패치 경계 — 재검증·신호 일치·보류 신호·활성화 형태", () => {
  it("Edge: 정의 revision 이 바뀌어도 정의 개정을 싣지 않은 대기 제안은 재검증하지 않는다 (test_SC014_revision_change_revalidates_only_amending_proposals)", () => {
    const r = registerDefinition(definitionDeps("killrevalpatch"));
    r.journal.proposeAmendment(r.definitionId, { title: "pending" }, dayAt(0, "06:00"));
    const stewardId = r.stewardId;
    expect(r.journal.work(stewardId).work.state).toBe("WAITING_APPROVAL");
    const withProposalDefinition = (definition: unknown) => {
      const j = new WorkflowJournal(r.journal.deps, r.journal.state, r.journal.commits);
      j.patchWork(stewardId, (agg) => {
        const pending = agg.work.pendingProposal;
        if (pending === undefined) throw new Error("expected pending proposal");
        const { definition: _d, ...rest } = pending;
        void _d;
        // 기준 계획 revision 을 어긋나게 해 재검증하면 무효가 되는 제안으로 둔다.
        const next = {
          ...rest,
          basePlanRevision: 99,
          ...(definition === "absent" ? {} : { definition }),
        };
        return { ...agg, work: { ...agg.work, pendingProposal: next as never } };
      });
      return j;
    };
    const withoutAmends = { ...definitionDraft(), title: "creation draft" };
    for (const [label, definition] of [
      ["null", null],
      ["absent", "absent"],
      ["creation", withoutAmends],
    ] as const) {
      const j = withProposalDefinition(definition);
      const judged = j.control(r.definitionId, "pause", dayAt(0, "07:00"));
      expect(judged.kind, label).toBe("accepted");
      expect(typesOf(commitOf(judged)), label).not.toContain("work_plan_withdrawn");
      expect(j.work(stewardId).work.state, label).toBe("WAITING_APPROVAL");
    }
    // 정의 revision 이 그대로인 회차 해소 커밋은 개정 제안도 재검증하지 않는다.
    const amendingUnchanged = withProposalDefinition(
      r.journal.work(stewardId).work.pendingProposal?.definition,
    );
    const materialized = amendingUnchanged.resolveDue(r.definitionId, dayAt(0));
    expect(typesOf(commitOf(materialized))).not.toContain("work_plan_withdrawn");
    expect(amendingUnchanged.work(stewardId).work.state).toBe("WAITING_APPROVAL");
    // 대조: 정의 개정을 실은 같은 제안은 철회된다.
    const amending = withProposalDefinition(
      r.journal.work(stewardId).work.pendingProposal?.definition,
    );
    const judged = amending.control(r.definitionId, "pause", dayAt(0, "07:00"));
    expect(typesOf(commitOf(judged))).toContain("work_plan_withdrawn");
  });

  it("Error: Task Trigger 가 미등록 종류이거나 외부 신호 발화가 아니면 출처·이름이 같아도 일치하지 않는다 (test_SC045_task_trigger_must_be_registered_external_firing)", () => {
    const { journal, ids } = startJournal(
      [
        draft("listener", {
          trigger: {
            kind: "signal",
            version: 1,
            triggerId: "listener",
            sourceId: FIXTURE_SIGNAL_SOURCE,
            signal: FIXTURE_SIGNAL_NAME,
          } as unknown as TriggerSpec,
        }),
      ],
      testDeps("killtasktrigger"),
    );
    const listener = ids["listener"] as TaskId;
    validate(journal, listener);
    const trigger = journal.task(listener).trigger as unknown as Record<string, unknown>;
    const judge = (aggregate: WorkAggregate, occ: string) =>
      judgeTaskExternalSignal(
        journal.deps,
        aggregate,
        externalSignal(journal.deps, {
          subject: { taskId: listener },
          sourceOccurrenceId: occ,
          receivedAt: at("2026-01-01T00:05:00Z"),
        }),
        at("2026-01-01T00:05:00Z"),
      );
    const unregistered = patchTask(journal.aggregate, listener, {
      trigger: { ...trigger, kind: "no_such_trigger" } as never,
    });
    expect(judge(unregistered, "o-1").kind).toBe("rejected");
    const scheduleFiring = patchTask(journal.aggregate, listener, {
      trigger: {
        ...(atTrigger("listener", { kind: "skip" }) as unknown as Record<string, unknown>),
        sourceId: FIXTURE_SIGNAL_SOURCE,
        signal: FIXTURE_SIGNAL_NAME,
      } as never,
    });
    expect(judge(scheduleFiring, "o-2").kind).toBe("rejected");
    expect(judge(journal.aggregate, "o-3").kind).toBe("accepted");
  });

  it("Error: 정의 활성화가 신호 발화가 아니거나 신호 형태가 없으면 출처·이름이 같아도 일치하지 않는다 (test_SC045_definition_activation_must_be_signal_shaped)", () => {
    const outcomeWith = (seed: string, activation: unknown) => {
      const r = registerDefinition(definitionDeps(seed), { draft: signalDefinitionDraft() });
      r.journal.patchWork(r.stewardId, (agg) => ({
        ...agg,
        definition: {
          ...(agg.definition as unknown as Record<string, unknown>),
          activation,
        } as never,
      }));
      return r.journal.external(r.definitionId, "s-1", dayAt(0)).kind;
    };
    expect(
      outcomeWith("killdefact1", {
        ...(dailyActivation() as unknown as Record<string, unknown>),
        sourceId: FIXTURE_SIGNAL_SOURCE,
        signal: FIXTURE_SIGNAL_NAME,
      }),
    ).toBe("rejected");
    const { sourceId: _s, ...noSource } = signalActivation() as unknown as Record<string, unknown>;
    void _s;
    expect(outcomeWith("killdefact2", noSource)).toBe("rejected");
    expect(outcomeWith("killdefact3", signalActivation())).toBe("accepted");
  });

  it("Edge: 신호 발화가 아닌 활성화로의 개정은 출처·이름 필드가 같아도 보류 신호 회차를 받지 않는다 (test_SC044_non_signal_activation_never_accepts_held_signals)", () => {
    const at = BUILTIN_TRIGGERS.find((t) => t.kind === "at");
    if (at === undefined) throw new Error("expected at trigger");
    // 예약 발화 활성화이면서 신호 활성화와 같은 출처·이름 필드를 싣는 등록 확장 유형.
    const tagged = {
      ...at,
      kind: "at_tagged",
      schema: (at.schema as z.ZodObject).extend({
        kind: z.literal("at_tagged"),
        sourceId: z.string(),
        signal: z.string(),
      }),
    };
    const registries = mustOk(
      createBuiltinRegistries({ taskTypes: [GENERIC_TASK_TYPE], triggers: [tagged] }),
    );
    const r = registerDefinition(definitionDeps("killtaggedheld", registries), {
      draft: signalDefinitionDraft(),
    });
    r.journal.control(r.definitionId, "pause", dayAt(0, "06:00"));
    r.journal.external(r.definitionId, "h-1", dayAt(0, "06:10"));
    r.journal.control(r.definitionId, "resume", dayAt(0, "06:20"));
    const activation = {
      ...(dailyActivation() as unknown as Record<string, unknown>),
      kind: "at_tagged",
      sourceId: FIXTURE_SIGNAL_SOURCE,
      signal: FIXTURE_SIGNAL_NAME,
    } as unknown as TriggerSpec;
    expect(r.journal.amend(r.definitionId, { activation }, dayAt(0, "06:30")).kind).toBe(
      "accepted",
    );
    expect(r.journal.definition(r.definitionId).activation).toEqual(activation);
    expect(r.journal.definition(r.definitionId).held).toEqual([]);
  });

  it("Edge: 신호 입력이 없는 보류 신호 회차는 새 신호 활성화가 받지 않고 건너뛴다 (test_SC029_held_signal_without_signal_input_skipped_on_amendment)", () => {
    const r = registerDefinition(definitionDeps("killheldnosig"), {
      draft: signalDefinitionDraft(),
    });
    r.journal.control(r.definitionId, "pause", dayAt(0, "06:00"));
    r.journal.external(r.definitionId, "h-1", dayAt(0, "06:10"));
    r.journal.control(r.definitionId, "resume", dayAt(0, "06:20"));
    r.journal.patchWork(r.stewardId, (agg) => {
      const definition = agg.definition;
      if (definition === undefined) throw new Error("expected definition");
      const held = definition.held.map((h) => {
        const { signal: _sig, ...input } = h.input;
        void _sig;
        return { ...h, input };
      });
      return { ...agg, definition: { ...definition, held } };
    });
    const granted = r.journal.amend(
      r.definitionId,
      { activation: signalActivation({ triggerId: "on_signal2" }) },
      dayAt(0, "06:30"),
    );
    expect(granted.kind).toBe("accepted");
    expect(r.journal.definition(r.definitionId).held).toEqual([]);
  });

  it("Error: 대기 행이 있는데 활성화가 일정 형태가 아니거나 타임존을 읽을 수 없으면 불변식 위반이다 (test_SC041_pending_row_needs_schedule_activation_view)", () => {
    // 타임존을 읽지 않는 포트 — 회차 현지 날짜 재계산이 타임존을 처음 읽는 곳이 되게 한다.
    const zoneBlind: RecurrenceExpander = {
      firstAtOrAfter: (a, t) =>
        testDailyRecurrence.firstAtOrAfter({ ...a, timezone: "UTC" } as never, t),
      periodOf: (a, t) => testDailyRecurrence.periodOf({ ...a, timezone: "UTC" } as never, t),
    };
    const patched = (seed: string, patch: (activation: Record<string, unknown>) => unknown) => {
      const r = registerDefinition(definitionDeps(seed, undefined, zoneBlind));
      r.journal.patchWork(r.stewardId, (agg) => {
        const definition = agg.definition;
        if (definition === undefined) throw new Error("expected definition");
        return {
          ...agg,
          definition: {
            ...definition,
            activation: patch(definition.activation as unknown as Record<string, unknown>) as never,
          },
        };
      });
      return () => r.journal.resolveDue(r.definitionId, dayAt(0));
    };
    expect(patched("killviewsig", () => signalActivation())).toThrow(DomainInvariantError);
    // 중지 해소도 도래한 대기 행을 이전 활성화로 전개하므로 같은 검사를 거친다.
    const stopping = registerDefinition(definitionDeps("killviewstop", undefined, zoneBlind));
    stopping.journal.patchWork(stopping.stewardId, (agg) => ({
      ...agg,
      definition: {
        ...(agg.definition as NonNullable<WorkAggregate["definition"]>),
        activation: signalActivation(),
      },
    }));
    expect(() =>
      stopping.journal.control(stopping.definitionId, "stop", dayAt(0, "08:00")),
    ).toThrow(DomainInvariantError);
    expect(patched("killviewtz", (a) => ({ ...a, timezone: "Not/AZone" }))).toThrow(
      DomainInvariantError,
    );
    expect(patched("killviewok", (a) => a)().kind).toBe("committed");
  });
});

describe("SC-005: 정의 이벤트 fold 의 대상 정의 검사", () => {
  it("Error: 다른 정의를 가리키는 정의 이벤트·관리 중인 Work 의 두 번째 정의 생성은 fold 가 던진다 (test_SC005_fold_rejects_foreign_definition_events)", () => {
    const r = registerDefinition(definitionDeps("killfolddef"));
    r.journal.control(r.definitionId, "pause", dayAt(0, "06:00"));
    const events = r.journal.commits.flatMap((c) => c.events);
    expect(() => foldWorkflowEvents(events)).not.toThrow();
    const foreign = nextEntityId(r.journal.deps.ids, "workDefinition");
    const retargeted = events.map((e) =>
      e.type === "work_definition_paused"
        ? { ...e, payload: { ...e.payload, definitionId: foreign } }
        : e,
    );
    expect(() => foldWorkflowEvents(retargeted as never)).toThrow(/관리하지 않는다/);
    const created = events.find((e) => e.type === "work_definition_created");
    if (created === undefined) throw new Error("expected created event");
    const again = {
      ...created,
      id: "evt_againcreated001",
      commit: { id: "cmt_againcreated001", index: 1, count: 1 },
    };
    expect(() => foldWorkflowEvents([...events, again] as never)).toThrow(/이미 정의/);
    // 정의를 관리하지 않는 Work 의 정의 이벤트.
    const m = registerAndMaterializeFirst(definitionDeps("killfoldnodef"));
    const mEvents = m.journal.commits.flatMap((c) => c.events);
    const created2 = mEvents.find((e) => e.type === "work_created" && e.workId === m.firstWorkId);
    if (created2 === undefined) throw new Error("expected occurrence work_created");
    const pausedOnOccurrence = {
      ...created2,
      id: "evt_pausedonocc0001",
      type: "work_definition_paused",
      commit: { id: "cmt_pausedonocc0001", index: 1, count: 1 },
      payload: {
        definitionId: m.definitionId,
        pauseOrigin: { kind: "template_invalid", actorSource: "adde_self" },
      },
    };
    expect(() => foldWorkflowEvents([...mEvents, pausedOnOccurrence] as never)).toThrow(
      /관리하지 않는다/,
    );
  });
});

describe("SC-049·SC-050: 회차 결합의 생산자 형태·제공 필드·해석 방어", () => {
  const signalShape = {
    sourceId: z.string(),
    signalName: z.string(),
    sourceOccurrenceId: z.string(),
    payload: z.unknown(),
  };
  const consumerWithEvent = (event: z.ZodType) => ({
    ...OCCURRENCE_CONSUMER_TASK_TYPE,
    schema: z.strictObject({ event: event.optional() }),
    inputFields: {},
  });
  const templateKinds = (seed: string, consumer: TaskTypeDescriptor) =>
    templateIssues(
      issuesOf(
        proposeDraft(
          occurrenceConsumerDeps(seed, consumer),
          signalDefinitionDraft({ template: [bindingTemplate("event", "signal")] }),
        ).outcome,
      ),
    );

  it("Error: 신호 payload 를 좁힌 소비자·상속 멤버 이름 키를 가진 소비자는 증명하지 않는다 (test_SC049_signal_binding_unprovable_consumers)", () => {
    const narrowPayload = consumerWithEvent(
      z.strictObject({ ...signalShape, payload: z.string() }),
    );
    const inheritedKey = consumerWithEvent(
      z.strictObject({ ...signalShape, toString: z.string().optional() }),
    );
    for (const [seed, consumer] of [
      ["killbindpayload", narrowPayload],
      ["killbindinherited", inheritedKey],
    ] as const) {
      expect(templateKinds(seed, consumer), seed).toEqual([
        {
          kind: "binding_schema_incompatible",
          draftRef: "consumer",
          field: "event",
          reason: "not_provable",
        },
      ]);
    }
    expect(templateKinds("killbindok", consumerWithEvent(z.strictObject(signalShape)))).toEqual([]);
  });

  /** 신호 정의의 회차 Work 와 event ← signal 결합 Task. */
  function boundSignalOccurrence(seed: string) {
    const r = registerDefinition(occurrenceConsumerDeps(seed), {
      draft: signalDefinitionDraft({ template: [bindingTemplate("event", "signal")] }),
    });
    r.journal.external(r.definitionId, "s-1", dayAt(0));
    const workId = r.journal.occurrenceWorkIds(r.definitionId)[0];
    if (workId === undefined) throw new Error("expected occurrence work");
    const taskId = r.journal.work(workId).work.memberTaskIds[0];
    if (taskId === undefined) throw new Error("expected bound task");
    return { r, workId, taskId };
  }

  it("Error: 회차 입력에 없는 필드를 결합한 템플릿은 materialize 시점에 무효다 (test_SC050_template_binding_to_absent_input_field_invalid)", () => {
    const r = registerDefinition(occurrenceConsumerDeps("killbindabsent"), {
      draft: signalDefinitionDraft({ template: [bindingTemplate("event", "signal")] }),
    });
    // 레코드 패치: 신호 회차 입력에 없는 scheduledForUtc 결합(초안 검증이 막는 상태 — 다른 생성 경로 대용).
    r.journal.patchWork(r.stewardId, (agg) => ({
      ...agg,
      definition: {
        ...(agg.definition as NonNullable<WorkAggregate["definition"]>),
        template: [bindingTemplate("when", "scheduledForUtc")] as never,
      },
    }));
    const judged = r.journal.external(r.definitionId, "s-1", dayAt(0));
    expect(typesOf(commitOf(judged))).toContain("work_definition_paused");
    expect(typesOf(commitOf(judged))).not.toContain("work_created");
  });

  it("Error: 정규 JSON 이 아니거나 소비자 스키마를 어기거나 선언에 없는 필드의 회차 값은 해석 불변식 위반이다 (test_SC050_resolution_defends_occurrence_values)", () => {
    const { r, workId, taskId } = boundSignalOccurrence("killbindresolve");
    const aggregate = r.journal.work(workId);
    const task = r.journal.task(workId, taskId);
    const withSignal = (signal: unknown) => {
      const source = aggregate.work.source as unknown as { input: Record<string, unknown> };
      return patchWork(aggregate, {
        source: { ...(source as object), input: { ...source.input, signal } } as never,
      });
    };
    const registries = r.journal.deps.registries;
    const original = (source: unknown) =>
      (source as { input: { signal: Record<string, unknown> } }).input.signal;
    const signal = original(aggregate.work.source);
    expect(resolveBoundInputs(registries, aggregate, task).ok).toBe(true);
    expect(() =>
      resolveBoundInputs(registries, withSignal({ ...signal, payload: Number.NaN }), task),
    ).toThrow(DomainInvariantError);
    expect(() =>
      resolveBoundInputs(registries, withSignal({ ...signal, sourceId: 5 }), task),
    ).toThrow(DomainInvariantError);
    const undeclared = {
      ...task,
      inputBindings: { nope: { from: "occurrence", field: "signal" } },
    } as unknown as TaskRecord;
    expect(() => resolveBoundInputs(registries, aggregate, undeclared)).toThrow(
      DomainInvariantError,
    );
  });
});

describe("SC-059: 정의 대기 행 취소 이벤트의 fold", () => {
  it("Edge: 현재 대기 행을 취소하는 이벤트는 대기 행을 비우고 그 ID 를 취소 목록 끝에 둔다 (test_SC042_fold_cancel_of_current_pending_row_clears_and_retires)", () => {
    const r = registerAndMaterializeFirst(definitionDeps("killcancelfold"));
    const events = r.journal.commits.flatMap((c) => c.events);
    const pending = r.journal.definition(r.definitionId).pendingSchedule;
    if (pending === undefined) throw new Error("expected pending row");
    const template = events.find((e) => e.type === "trigger_fired");
    if (template === undefined) throw new Error("expected trigger_fired");
    const cancel = (row: {
      occurrenceId: string;
      scheduledForUtc: string;
      recurrenceIndex: number;
    }) => ({
      ...template,
      id: "evt_cancelfold00001",
      type: "trigger_canceled",
      commit: { id: "cmt_cancelfold00001", index: 1, count: 1 },
      payload: {
        definitionId: r.definitionId,
        triggerId: "daily",
        occurrenceId: row.occurrenceId,
        scheduledForUtc: row.scheduledForUtc,
        recurrenceIndex: row.recurrenceIndex,
        reason: "definition_revised",
      },
    });
    const foldedDefinition = (extra: unknown) => {
      const folded = foldWorkflowEvents([...events, extra] as never);
      if (!folded.ok) throw new Error(`fold failed ${JSON.stringify(folded.error)}`);
      const definition = findSteward(folded.value, r.definitionId)?.definition;
      if (definition === undefined) throw new Error("expected folded definition");
      return definition;
    };

    const current = foldedDefinition(cancel(pending));
    expect(current.pendingSchedule).toBeUndefined();
    expect(current.retiredOccurrenceIds.at(-1)).toBe(pending.occurrenceId);
    expect(current.retiredOccurrenceIds).toHaveLength(1);

    // 대조: 다른 ID 를 취소하는 같은 커밋은 대기 행을 두고 ID 만 등록한다.
    const otherId = deriveOccurrenceId({
      kind: "schedule",
      ownerId: r.definitionId,
      triggerId: "daily",
      scheduledForUtc: dayAt(5),
      recurrenceIndex: 5,
    });
    if (!otherId.ok) throw new Error("expected occurrence id");
    const other = foldedDefinition(
      cancel({ occurrenceId: otherId.value, scheduledForUtc: dayAt(5), recurrenceIndex: 5 }),
    );
    expect(other.pendingSchedule?.occurrenceId).toBe(pending.occurrenceId);
    expect(other.retiredOccurrenceIds).toEqual([otherId.value]);
  });
});

describe("SC-048: Task 외부 신호 수용 참조의 fold", () => {
  const LISTENER = {
    kind: "signal",
    version: 1,
    triggerId: "listener",
    sourceId: FIXTURE_SIGNAL_SOURCE,
    signal: FIXTURE_SIGNAL_NAME,
  } as unknown as TriggerSpec;

  /** READY 리스너 Task 의 이전 이벤트 열과 외부 신호 수용 커밋. */
  function acceptedListener(seed: string) {
    const { journal, ids } = startJournal(
      [draft("listener", { trigger: LISTENER })],
      testDeps(seed),
    );
    const taskId = ids["listener"] as TaskId;
    validate(journal, taskId);
    const judged = judgeTaskExternalSignal(
      journal.deps,
      journal.aggregate,
      externalSignal(journal.deps, {
        subject: { taskId },
        sourceOccurrenceId: "o-1",
        receivedAt: KILL_NOW,
      }),
      KILL_NOW,
    );
    if (judged.kind !== "accepted") throw new Error(`expected accepted, got ${judged.kind}`);
    expect(eventTypes(judged.commit)).toEqual(["signal_accepted", "task_scheduled"]);
    const accepted = judged.commit.events[0];
    if (accepted === undefined) throw new Error("expected signal_accepted");
    return {
      taskId,
      prior: journal.commits.flatMap((c) => c.events),
      whole: judged.commit.events,
      accepted,
    };
  }

  /** 그 이벤트 하나만 담은 커밋으로 바꾼다. */
  const alone = <E extends { readonly commit: object }>(event: E): E => ({
    ...event,
    commit: { ...event.commit, index: 1, count: 1 },
  });

  it("Edge: 수용과 예약을 나눈 커밋을 접으면 수용 참조가 Task 기록에 남는다 (test_SC048_fold_split_acceptance_commit_keeps_pending_reference)", () => {
    const { taskId, prior, whole, accepted } = acceptedListener("killaccsplit");
    const split = foldEvents([...prior, alone(accepted)]);
    if (!split.ok) throw new Error(`fold failed ${JSON.stringify(split.error)}`);
    expect(split.value.tasks[taskId]?.pendingSignalAcceptance).toEqual({
      eventId: accepted.id,
      occurredAt: accepted.occurredAt,
      sourceId: FIXTURE_SIGNAL_SOURCE,
      signalName: FIXTURE_SIGNAL_NAME,
    });

    // 대조: 원래 커밋은 같은 커밋의 예약이 참조를 소비한다.
    const together = foldEvents([...prior, ...whole]);
    if (!together.ok) throw new Error(`fold failed ${JSON.stringify(together.error)}`);
    expect(together.value.tasks[taskId]?.pendingSignalAcceptance).toBeUndefined();

    // 대조: 정의 대상 외부 신호 수용은 관리 Work 의 Task 기록을 바꾸지 않는다.
    const r = registerDefinition(definitionDeps("killaccdef"), {
      draft: signalDefinitionDraft(),
      tasks: STEWARD_MEMBER,
    });
    const tasksBefore = r.journal.steward(r.definitionId).tasks;
    commitOf(r.journal.external(r.definitionId, "s-1", dayAt(0)));
    // 관리 Work 스트림만 남긴다 — 회차 Work 와 함께 낸 커밋은 스트림 안 번호로 다시 매긴다.
    const stewardEvents = r.journal.commits.flatMap((c) => {
      const own = c.events.filter((e) => e.workId === r.stewardId);
      return own.map((e, i) => ({
        ...e,
        commit: { ...e.commit, index: i + 1, count: own.length },
      }));
    });
    expect(stewardEvents.map((e) => e.type)).toContain("signal_accepted");
    const steward = foldEvents(stewardEvents);
    if (!steward.ok) throw new Error(`fold failed ${JSON.stringify(steward.error)}`);
    expect(steward.value.tasks).toEqual(tasksBefore);
  });

  it("Error: trigger 없는 Task 외부 신호 수용 이벤트를 접으면 가드가 던진다 (test_SC048_fold_task_acceptance_without_trigger_throws_guard_error)", () => {
    const { prior, accepted } = acceptedListener("killaccnotrigger");
    const payload = Object.fromEntries(
      Object.entries(accepted.payload as unknown as Record<string, unknown>).filter(
        ([key]) => key !== "trigger",
      ),
    );
    const stripped = alone({ ...accepted, payload });
    let thrown: unknown;
    try {
      foldEvents([...prior, stripped as never]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
  });
});

describe("SC-042: 마지막 해소 장부와 개정 시작점", () => {
  const STEPS = "kill-steps";
  // 회차 1(D+1 07:00)은 개정이 취소한 기존 대기 행과 같은 ID 다 — 해소가 미도래 잃는 회차로 기록해 장부를 now 뒤로 올린다.
  const port = testStepRecurrence({
    rule: STEPS,
    period: "utc_hour",
    steps: [
      { scheduledForUtc: dayAt(1, "05:00"), recurrenceIndex: 0 },
      { scheduledForUtc: dayAt(1), recurrenceIndex: 1 },
      { scheduledForUtc: dayAt(2), recurrenceIndex: 2 },
    ],
  });

  const committed = (outcome: { kind: string; commit?: DomainCommit }): DomainCommit => {
    if (outcome.commit === undefined) throw new Error(`expected a commit, got ${outcome.kind}`);
    return outcome.commit;
  };

  it("Edge: 장부가 now 뒤에 있으면 개정 탐색은 장부 다음부터 시작한다 (test_SC042_amendment_start_after_ledger_ahead_of_now)", () => {
    const r = registerAndMaterializeFirst(definitionDeps("killledgerahead", undefined, port));
    committed(
      r.journal.amend(r.definitionId, { activation: stepActivation(STEPS) }, dayAt(0, "08:00")),
    );
    committed(r.journal.resolveDue(r.definitionId, dayAt(1, "05:00")));
    expect(r.journal.definition(r.definitionId).lastResolvedSchedule).toEqual({
      scheduledForUtc: dayAt(1),
      recurrenceIndex: 1,
    });
    // 새 활성화의 D+1 06:45 는 now(06:30) 뒤·장부(07:00) 앞이고 장부와 다른 시 단위 주기다.
    const amended = committed(
      r.journal.amend(
        r.definitionId,
        { activation: dailyActivation({ localTime: "06:45" }) },
        dayAt(1, "06:30"),
      ),
    );
    const next = payloadsOf(amended, "work_definition_revised")[0]?.["nextSchedule"] as
      { scheduledForUtc: string } | undefined;
    expect(next?.scheduledForUtc).toBe(dayAt(2, "06:45"));
    expect(r.journal.definition(r.definitionId).pendingSchedule?.scheduledForUtc).toBe(
      dayAt(2, "06:45"),
    );

    // 대조: 장부가 now 앞이면 now 부터 찾아 같은 날 06:45 를 고른다.
    const plain = registerAndMaterializeFirst(definitionDeps("killledgerbehind"));
    plain.journal.completeWork(plain.firstWorkId, dayAt(0, "09:00"));
    committed(plain.journal.resolveDue(plain.definitionId, dayAt(1)));
    const behind = committed(
      plain.journal.amend(
        plain.definitionId,
        { activation: dailyActivation({ localTime: "06:45" }) },
        dayAt(1, "08:00"),
      ),
    );
    const behindNext = payloadsOf(behind, "work_definition_revised")[0]?.["nextSchedule"] as
      { scheduledForUtc: string } | undefined;
    expect(behindNext?.scheduledForUtc).toBe(dayAt(2, "06:45"));
  });

  it("Edge: 장부와 같은 시각의 회차 값은 장부를 바꾸지 않는다 (test_SC042_ledger_equal_instant_keeps_current_value)", () => {
    const patched = registerAndMaterializeFirst(definitionDeps("killledgereq"));
    const ledger = { scheduledForUtc: dayAt(1), recurrenceIndex: 77 };
    // 레코드 패치: 다음 회차와 같은 시각·다른 회차 번호의 장부. 명령 경로로 만들 수 없어 다른 생성 경로 대용으로 둔다.
    patched.journal.patchWork(patched.stewardId, (aggregate) => {
      const definition = aggregate.definition;
      if (definition === undefined) throw new Error("steward has no definition");
      return { ...aggregate, definition: { ...definition, lastResolvedSchedule: ledger } };
    });
    patched.journal.completeWork(patched.firstWorkId, dayAt(0, "09:00"));
    const fired = committed(patched.journal.resolveDue(patched.definitionId, dayAt(1)));
    expect(payloadsOf(fired, "trigger_fired").map((f) => f["recurrenceIndex"])).toEqual([1]);
    expect(patched.journal.definition(patched.definitionId).lastResolvedSchedule).toEqual(ledger);

    // 대조: 패치하지 않으면 더 늦은 회차 값을 받는다.
    const plain = registerAndMaterializeFirst(definitionDeps("killledgerlt"));
    plain.journal.completeWork(plain.firstWorkId, dayAt(0, "09:00"));
    committed(plain.journal.resolveDue(plain.definitionId, dayAt(1)));
    expect(plain.journal.definition(plain.definitionId).lastResolvedSchedule).toEqual({
      scheduledForUtc: dayAt(1),
      recurrenceIndex: 1,
    });
  });
});

describe("SC-019: 취소 출처 파서의 거절 값", () => {
  it("Error: 인증 형태·종류 밖 필드·필드 형의 거절마다 오류 값 전체가 정해져 있다 (test_SC019_cancel_origin_parser_errors_exact)", () => {
    const control = {
      kind: "control_request",
      actorSource: "unknown",
      controlRequestId: "ctl_a1",
      keyId: "k",
    };
    const vault = { kind: "vault_signal", actorSource: "human_local", signalId: "sig_a1" };
    const cascade = { kind: "work_cascade", actorSource: "adde_self", workEventId: "evt_a1" };
    const dropped = { kind: "replan_dropped", actorSource: "adde_self", workEventId: "evt_a2" };
    const rows: readonly [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
      string,
      string,
    ][] = [
      [
        "keyId missing",
        { ...control, keyId: undefined },
        control,
        "cancelOrigin",
        "control_request_auth_shape_invalid",
      ],
      [
        "keyId empty",
        { ...control, keyId: "" },
        control,
        "cancelOrigin",
        "control_request_auth_shape_invalid",
      ],
      [
        "not ctl_ id",
        { ...control, controlRequestId: "req-1" },
        control,
        "cancelOrigin",
        "control_request_auth_shape_invalid",
      ],
      [
        "vault + keyId",
        { ...vault, keyId: "k" },
        vault,
        "cancelOrigin.keyId",
        "not_allowed_for_kind",
      ],
      [
        "vault + workEventId",
        { ...vault, workEventId: "evt_a3" },
        vault,
        "cancelOrigin.workEventId",
        "not_allowed_for_kind",
      ],
      [
        "control + signalId",
        { ...control, signalId: "sig_a2" },
        control,
        "cancelOrigin.signalId",
        "not_allowed_for_kind",
      ],
      [
        "cascade + controlRequestId",
        { ...cascade, controlRequestId: "ctl_a2" },
        cascade,
        "cancelOrigin.controlRequestId",
        "not_allowed_for_kind",
      ],
      [
        "dropped + provenance",
        { ...dropped, provenance: {} },
        dropped,
        "cancelOrigin.provenance",
        "not_allowed_for_kind",
      ],
      [
        "numeric signalId",
        { ...vault, signalId: 5 },
        vault,
        "cancelOrigin.signalId",
        "required_for_vault_signal",
      ],
      [
        "not evt_ workEventId",
        { ...cascade, workEventId: "wev-1" },
        cascade,
        "cancelOrigin.workEventId",
        "required_for_kind",
      ],
      [
        "non-object provenance",
        { ...vault, provenance: "p" },
        vault,
        "cancelOrigin.provenance",
        "not_an_object",
      ],
      [
        "ill-typed actor",
        { ...control, actor: { kind: "user" } },
        control,
        "cancelOrigin.actor",
        "not_a_string",
      ],
      [
        "numeric reason",
        { ...control, reason: 42 },
        control,
        "cancelOrigin.reason",
        "not_a_string",
      ],
    ];
    for (const [label, raw, fixed, field, reason] of rows) {
      const input = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
      expect(parseCancelOrigin(input), label).toEqual({
        ok: false,
        error: { kind: "value_format", field, reason },
      });
      // 대조: 문제 필드만 고친 입력은 통과하고 결과에는 검사한 필드만 있다.
      const parsed = parseCancelOrigin(fixed);
      expect(parsed.ok, label).toBe(true);
      if (parsed.ok)
        expect(Object.keys(parsed.value).sort(), label).toEqual(Object.keys(fixed).sort());
    }
    const unknownKey = parseCancelOrigin({ ...control, note: "x" });
    expect(unknownKey.ok && Object.keys(unknownKey.value).sort()).toEqual([
      "actorSource",
      "controlRequestId",
      "keyId",
      "kind",
    ]);
    // 신호 ID 의 sig_ 형식은 보지 않는다.
    expect(parseCancelOrigin({ ...vault, signalId: "not-sig" })).toEqual({
      ok: true,
      value: { kind: "vault_signal", actorSource: "human_local", signalId: "not-sig" },
    });
  });
});

// ---- 판정 기록 재점검 판별 — 레코드 패치·공개 호출·손수 만든 등록부로 만든 입력 ----

function patchDefinitionRecord(
  journal: WorkflowJournal,
  stewardId: WorkId,
  patch: (definition: DefinitionRecord) => DefinitionRecord,
): void {
  journal.patchWork(stewardId, (aggregate) => {
    if (aggregate.definition === undefined) throw new Error("steward has no definition");
    return { ...aggregate, definition: patch(aggregate.definition) };
  });
}

function patchActivation(
  journal: WorkflowJournal,
  stewardId: WorkId,
  fields: Record<string, unknown>,
): void {
  patchDefinitionRecord(journal, stewardId, (d) => ({
    ...d,
    activation: { ...(d.activation as object), ...fields } as unknown as TriggerSpec,
  }));
}

/** 등록부 값의 Trigger descriptor 하나를 바꾼다 — `createDomainRegistries` 를 거치지 않은 등록부. */
function withTriggerDescriptor(
  base: DomainRegistries,
  kind: string,
  patch: (descriptor: TriggerDescriptor | undefined) => TriggerDescriptor,
): DomainRegistries {
  return {
    ...base,
    triggers: {
      get: (id, version) =>
        id === kind ? patch(base.triggers.get(id, version)) : base.triggers.get(id, version),
      list: () => base.triggers.list(),
    },
  };
}

function commitOrThrow(outcome: { kind: string; commit?: DomainCommit }): DomainCommit {
  if (outcome.commit === undefined || (outcome.kind !== "committed" && outcome.kind !== "accepted"))
    throw new Error(`expected a commit, got ${JSON.stringify(outcome)}`);
  return outcome.commit;
}

/** 정의 입력이 아니라 레코드 패치로 둔 신호 회차 하나. */
function strayHeldSignal(definitionId: WorkDefinitionId) {
  const occurrenceId = mustOk(
    deriveOccurrenceId({
      kind: "event_caused",
      ownerId: definitionId,
      triggerId: "on_signal",
      causingEvent: { id: entityId("event", "evt_stray00001"), occurredAt: dayAt(0, "12:00") },
    }),
  );
  return {
    occurrenceId,
    triggerId: "on_signal",
    originalInstant: dayAt(0, "12:00"),
    input: {
      occurrenceId,
      definitionId,
      signal: {
        sourceId: FIXTURE_SIGNAL_SOURCE,
        signalName: FIXTURE_SIGNAL_NAME,
        sourceOccurrenceId: "stray",
        payload: {},
      },
    },
  } as unknown as DefinitionRecord["held"][number];
}

describe("판정 기록 재점검: 조립·연쇄·ID 충돌", () => {
  it("Edge: 공개 조립의 지연 head 는 meta 의 원인 ID 를 받는다 (test_SC046_public_assemble_commit_deferred_head_takes_meta_causation)", () => {
    const r = registerDefinition(definitionDeps("killr03"));
    const head = (seed: string) =>
      ({
        type: "signal_accepted",
        payload: {
          signalId: entityId("signal", `sig_${seed}`),
          signalType: "replan_requested",
          dedupKey: `k-${seed}`,
          subject: { workId: r.stewardId },
        },
        workId: r.stewardId,
      }) as never;
    const withCause = assembleCommit(
      r.journal.deps,
      r.journal.work(r.stewardId),
      { head: head("a1"), then: () => [] },
      { ...meta(dayAt(0)), causationId: "evt_cause00001" },
    );
    expect(withCause.commit.events[0]?.causationId).toBe("evt_cause00001");
    const withoutCause = assembleCommit(
      r.journal.deps,
      r.journal.work(r.stewardId),
      { head: head("a2"), then: () => [] },
      meta(dayAt(0)),
    );
    expect(withoutCause.commit.events[0]?.causationId).toBeUndefined();
  });

  it("Edge: 현재 동작 고정(계약 아님) — 다중 Work 커밋은 관리 Work 의 의존 연쇄를 돌린다 (test_SC023_multi_work_commit_runs_steward_dependency_cascade)", () => {
    const stewardSegment = (patched: boolean, seed: string) => {
      const r = registerDefinition(definitionDeps(seed), {
        tasks: [templateDraft("a"), templateDraft("b", { dependsOn: [{ draftRef: "a" }] })],
      });
      const [a, b] = r.journal.work(r.stewardId).work.taskIds;
      if (a === undefined || b === undefined) throw new Error("expected two steward tasks");
      const cause = entityId("event", "evt_depfail0001");
      if (patched) {
        // 레코드 패치: 의존 대상이 FAILED 이고 의존 Task 가 READY 인 관리 Work — 명령 경로로는 연쇄가 같은 커밋에서 정리하므로 다른 생성 경로 대용으로 둔다.
        r.journal.patchWork(r.stewardId, (agg) =>
          patchTask(
            patchTask(agg, a, {
              state: "FAILED",
              terminalRef: {
                eventId: cause,
                occurredAt: dayAt(0, "06:00"),
                position: { commitSeq: 1, index: 1 },
              },
            }),
            b,
            { state: "READY" },
          ),
        );
      }
      const commit = commitOrThrow(r.journal.resolveDue(r.definitionId, dayAt(0)));
      return { events: commit.events.filter((e) => e.workId === r.stewardId), b, cause };
    };
    const { events, b, cause } = stewardSegment(true, "killr04");
    expect(events.map((e) => e.type)).toEqual(["trigger_fired", "task_blocked", "work_blocked"]);
    const blocked = events[1];
    expect(blocked?.taskId).toBe(b);
    expect(blocked?.causationId).toBe(cause);
    expect(events[2]?.causationId).toBe(blocked?.id);
    expect(stewardSegment(false, "killr04c").events.map((e) => e.type)).not.toContain(
      "task_blocked",
    );
  });

  it("Error: 새 회차 Work ID 가 상태에 이미 있으면 materialize 가 불변식 오류로 닫힌다 (test_SC016_materialize_into_existing_work_id_fails_closed)", () => {
    const peek = registerAndMaterializeFirst(definitionDeps("killr05"));
    const r = registerDefinition(definitionDeps("killr05"));
    const steward = r.journal.work(r.stewardId);
    // 레코드 패치: 다음 회차 Work ID 를 이미 가진 Work — ID 생성기가 이 커밋에서 발급하므로 명령 경로로 만들 수 없어 다른 생성 경로 대용으로 둔다.
    const occupant = {
      ...steward,
      work: { ...steward.work, id: peek.firstWorkId },
      definition: undefined,
    } as unknown as WorkAggregate;
    r.journal.state = { works: { ...r.journal.state.works, [peek.firstWorkId]: occupant } };
    const stateBefore = r.journal.state;
    const commitsBefore = r.journal.commits.length;
    expect(() => r.journal.resolveDue(r.definitionId, dayAt(0))).toThrow(DomainInvariantError);
    expect(r.journal.state).toBe(stateBefore);
    expect(r.journal.commits).toHaveLength(commitsBefore);
    const clean = registerDefinition(definitionDeps("killr05"));
    expect(clean.journal.resolveDue(clean.definitionId, dayAt(0)).kind).toBe("committed");
  });
});

describe("판정 기록 재점검: 섞인 보류 목록·정책 필드", () => {
  it("Edge: 현재 동작 고정(계약 아님) — fire_once_now 는 일정 보류만 대체하고 신호 회차는 남긴다 (test_SC029_fire_once_now_supersedes_only_schedule_held)", () => {
    const r = registerAndMaterializeFirst(definitionDeps("killr06f"));
    commitOrThrow(r.journal.resolveDue(r.definitionId, dayAt(1)));
    const d1 = r.journal.definition(r.definitionId).held[0]?.occurrenceId;
    const stray = strayHeldSignal(r.definitionId);
    // 레코드 패치: 일정 정의 보류 목록 앞의 신호 회차 — 일정 정의는 신호 회차를 만들지 않으므로 다른 생성 경로 대용으로 둔다.
    patchDefinitionRecord(r.journal, r.stewardId, (d) => ({ ...d, held: [stray, ...d.held] }));
    const commit = commitOrThrow(r.journal.resolveDue(r.definitionId, dayAt(2)));
    expect(
      payloadsOf(commit, "work_definition_occurrences_skipped").map((p) => p["heldOccurrenceIds"]),
    ).toEqual([[d1]]);
    expect(r.journal.definition(r.definitionId).held.map((h) => h.originalInstant)).toEqual([
      stray.originalInstant,
      dayAt(2),
    ]);
  });

  it("Edge: 현재 동작 고정(계약 아님) — catch_up_bounded 밀어내기는 일정 보류만 센다 (test_SC030_catch_up_eviction_counts_only_schedule_held)", () => {
    const r = registerAndMaterializeFirst(
      definitionDeps("killr06c"),
      definitionDraft({
        activation: dailyActivation({ misfire: { kind: "catch_up_bounded", maxCatchUp: 1 } }),
      }),
    );
    commitOrThrow(r.journal.resolveDue(r.definitionId, dayAt(1)));
    const d1 = r.journal.definition(r.definitionId).held[0]?.occurrenceId;
    const stray = strayHeldSignal(r.definitionId);
    // 레코드 패치: 일정 정의 보류 목록 앞의 신호 회차(다른 생성 경로 대용 — 일정 정의는 신호 회차를 만들지 않는다).
    patchDefinitionRecord(r.journal, r.stewardId, (d) => ({ ...d, held: [stray, ...d.held] }));
    const commit = commitOrThrow(r.journal.resolveDue(r.definitionId, dayAt(2)));
    const evicted = payloadsOf(commit, "work_definition_occurrences_skipped").flatMap(
      (p) => p["heldOccurrenceIds"] as string[],
    );
    expect(evicted).toEqual([d1]);
    expect(r.journal.definition(r.definitionId).held.map((h) => h.occurrenceId)).toContain(
      stray.occurrenceId,
    );
  });

  it("Edge: 현재 동작 고정(계약 아님) — 신호 입력을 가진 일정 보류도 신호 활성화 개정이 건너뛴다 (test_SC044_amendment_skips_schedule_held_with_signal_input)", () => {
    const r = registerAndMaterializeFirst(definitionDeps("killr06a"));
    commitOrThrow(r.journal.resolveDue(r.definitionId, dayAt(1)));
    const d1 = r.journal.definition(r.definitionId).held[0];
    if (d1 === undefined) throw new Error("expected held");
    // 레코드 패치: 일정 보류 회차에 새 활성화와 같은 출처·이름의 신호 입력(다른 생성 경로 대용 — 일정 회차 입력에는 신호가 없다).
    patchDefinitionRecord(r.journal, r.stewardId, (d) => ({
      ...d,
      held: d.held.map((h) => ({
        ...h,
        input: {
          ...h.input,
          signal: {
            sourceId: FIXTURE_SIGNAL_SOURCE,
            signalName: FIXTURE_SIGNAL_NAME,
            sourceOccurrenceId: "stray",
            payload: {},
          },
        } as never,
      })),
    }));
    const grant = commitOrThrow(
      r.journal.amend(r.definitionId, { activation: signalActivation() }, dayAt(1, "08:00")),
    );
    const skipped = payloadsOf(grant, "work_definition_occurrences_skipped");
    expect(skipped.map((p) => p["reason"])).toContain("definition_revised");
    expect(skipped.flatMap((p) => p["heldOccurrenceIds"] as string[])).toContain(d1.occurrenceId);
    expect(r.journal.definition(r.definitionId).held).toEqual([]);
  });

  it("Error: 모르는 지연 정책 종류는 후보 경로에서 불변식 오류다 — 대조 칸(놓친 회차 없는 제때 해소)은 현재 동작 고정(계약 아님) (test_SC030_unknown_misfire_kind_fails_closed)", () => {
    const late = registerDefinition(definitionDeps("killr07a"));
    // 레코드 패치: 등록부가 받지 않는 지연 정책 종류(다른 생성 경로 대용).
    patchActivation(late.journal, late.stewardId, { misfire: { kind: "later" } });
    const commitsBefore = late.journal.commits.length;
    expect(() => late.journal.resolveDue(late.definitionId, dayAt(0), { late: true })).toThrow(
      DomainInvariantError,
    );
    expect(late.journal.commits).toHaveLength(commitsBefore);

    const onTime = registerDefinition(definitionDeps("killr07b"));
    patchActivation(onTime.journal, onTime.stewardId, { misfire: { kind: "later" } });
    const commit = commitOrThrow(onTime.journal.resolveDue(onTime.definitionId, dayAt(0)));
    expect(typesOf(commit)[0]).toBe("trigger_fired");
  });

  it("Edge: 현재 동작 고정(계약 아님) — fire_once_now 는 남는 maxCatchUp 을 읽지 않는다 (test_SC029_fire_once_now_ignores_stray_max_catch_up)", () => {
    const run = (seed: string, stray: boolean) => {
      const r = registerAndMaterializeFirst(definitionDeps(seed));
      // 레코드 패치: fire_once_now 에 남은 maxCatchUp(다른 생성 경로 대용 — 초안 검증이 막는다).
      if (stray)
        patchActivation(r.journal, r.stewardId, {
          misfire: { kind: "fire_once_now", maxCatchUp: 0 },
        });
      return commitOrThrow(r.journal.resolveDue(r.definitionId, dayAt(2)));
    };
    const patched = run("killr07f", true);
    const plain = run("killr07g", false);
    expect(typesOf(patched)).toEqual(typesOf(plain));
    expect(
      payloadsOf(patched, "work_definition_occurrences_skipped").map((p) => p["reason"]),
    ).toEqual(["superseded_by_later"]);
  });

  it("Error: 정수가 아닌 maxCatchUp 은 같은 해소의 보류를 밀어내기 전에 불변식 오류다 (test_SC030_non_integer_max_catch_up_fails_closed)", () => {
    const run = (seed: string, maxCatchUp: number) => {
      const r = registerAndMaterializeFirst(definitionDeps(seed));
      // 레코드 패치: 정수가 아닌 maxCatchUp(다른 생성 경로 대용 — 초안 검증이 막는다).
      patchActivation(r.journal, r.stewardId, {
        misfire: { kind: "catch_up_bounded", maxCatchUp },
      });
      return r;
    };
    const fraction = run("killr08a", 1.5);
    const commitsBefore = fraction.journal.commits.length;
    expect(() => fraction.journal.resolveDue(fraction.definitionId, dayAt(2))).toThrow(
      DomainInvariantError,
    );
    expect(fraction.journal.commits).toHaveLength(commitsBefore);
    const whole = run("killr08b", 1);
    expect(whole.journal.resolveDue(whole.definitionId, dayAt(2)).kind).toBe("committed");
  });

  it("Edge: 현재 동작 고정(계약 아님) — 일정 정의는 남은 maxOccurrences 로 중지하지 않는다 (test_SC039_schedule_definition_ignores_draft_max_occurrences)", () => {
    const r = registerAndMaterializeFirst(definitionDeps("killr09"));
    commitOrThrow(r.journal.resolveDue(r.definitionId, dayAt(1)));
    r.journal.completeTask(r.firstWorkId, firstTaskOf(r.journal, r.firstWorkId), dayAt(1, "08:00"));
    // 레코드 패치: 일정 정의의 maxOccurrences(다른 생성 경로 대용 — 일정 정의 초안은 가질 수 없다).
    patchDefinitionRecord(r.journal, r.stewardId, (d) => ({ ...d, maxOccurrences: 1 }));
    const released = commitOrThrow(r.journal.release(r.definitionId, dayAt(1, "09:00")));
    expect(typesOf(released)).not.toContain("work_definition_stopped");
    expect(r.journal.definition(r.definitionId).state).toBe("ACTIVE");
  });
});

describe("판정 기록 재점검: 손상된 triggerId·같은 시각 건너뜀·배열 종류", () => {
  it("Error: 빈 일정 triggerId 는 해소에서 불변식 오류다 (test_SC021_corrupt_schedule_trigger_id_fails_closed)", () => {
    const r = registerAndMaterializeFirst(definitionDeps("killr10a"));
    // 레코드 패치: 빈 triggerId(다른 생성 경로 대용 — 초안 검증이 막는다).
    patchActivation(r.journal, r.stewardId, { triggerId: "" });
    const commitsBefore = r.journal.commits.length;
    expect(() => r.journal.resolveDue(r.definitionId, dayAt(1))).toThrow(DomainInvariantError);
    expect(r.journal.commits).toHaveLength(commitsBefore);
  });

  it("Error: 구분 문자를 담은 신호 triggerId 는 외부 신호에서 불변식 오류다 (test_SC022_corrupt_signal_trigger_id_fails_closed)", () => {
    const r = registerDefinition(definitionDeps("killr10b"), { draft: signalDefinitionDraft() });
    // 레코드 패치: U+001F 를 담은 triggerId(다른 생성 경로 대용).
    patchActivation(r.journal, r.stewardId, { triggerId: "a\u001fb" });
    const commitsBefore = r.journal.commits.length;
    expect(() => r.journal.external(r.definitionId, "s-1", dayAt(0))).toThrow(DomainInvariantError);
    expect(r.journal.commits).toHaveLength(commitsBefore);
  });

  it("Error: 빈 Task Trigger triggerId 는 외부 신호에서 불변식 오류다 (test_SC046_corrupt_task_trigger_id_fails_closed)", () => {
    const listener = {
      kind: "signal",
      version: 1,
      triggerId: "listener",
      sourceId: FIXTURE_SIGNAL_SOURCE,
      signal: FIXTURE_SIGNAL_NAME,
    } as unknown as TriggerSpec;
    const { journal, ids } = startJournal(
      [draft("listener", { trigger: listener })],
      testDeps("killr10c"),
    );
    const taskId = ids["listener"] as TaskId;
    validate(journal, taskId);
    const trigger = journal.task(taskId).trigger as unknown as Record<string, unknown>;
    // 레코드 패치: 빈 triggerId(다른 생성 경로 대용 — 계획 검증이 막는다).
    const patched = patchTask(journal.aggregate, taskId, {
      trigger: { ...trigger, triggerId: "" } as unknown as TriggerSpec,
    });
    const signal = externalSignal(journal.deps, {
      subject: { taskId },
      sourceOccurrenceId: "o-1",
      receivedAt: KILL_NOW,
    });
    expect(() => judgeTaskExternalSignal(journal.deps, patched, signal, KILL_NOW)).toThrow(
      DomainInvariantError,
    );
  });

  it("Edge: 현재 동작 고정(계약 아님) — 같은 원래 시각의 건너뜀 항목은 앞 항목을 장부에 남긴다 (test_SC033_equal_instant_skip_items_keep_first_as_last_resolved)", () => {
    const r = registerAndMaterializeFirst(definitionDeps("killr11"));
    commitOrThrow(r.journal.resolveDue(r.definitionId, dayAt(1)));
    // 레코드 패치: 같은 원래 시각·다른 회차 번호의 보류 회차(다른 생성 경로 대용 — 계열 시각은 엄격히 는다).
    patchDefinitionRecord(r.journal, r.stewardId, (d) => {
      const first = d.held[0];
      if (first === undefined) throw new Error("expected held");
      const twin = {
        ...first,
        occurrenceId: scheduleOccurrenceId(r.definitionId, "daily", dayAt(1), 7),
        recurrenceIndex: 7,
      };
      return { ...d, held: [first, twin] };
    });
    const stopped = commitOrThrow(r.journal.control(r.definitionId, "stop", dayAt(1, "08:00")));
    expect(
      payloadsOf(stopped, "work_definition_occurrences_skipped")[0]?.["lastResolvedSchedule"],
    ).toEqual({ scheduledForUtc: dayAt(1), recurrenceIndex: 1 });
  });

  it("Error: 배열 kind 활성화 초안은 스키마 판정 전에 descriptor 미등록이다 — 이슈 사유는 현재 동작 고정(계약 아님) (test_SC010_array_activation_kind_is_descriptor_unknown)", () => {
    const deps = definitionDeps("killr12a");
    const draftContent = definitionDraft();
    const reasons = definitionInvalidReasons(
      issuesOf(
        proposeDraft(deps, {
          ...draftContent,
          activation: { ...(dailyActivation() as unknown as object), kind: ["at"] },
        }).outcome,
      ),
    );
    expect(reasons).toEqual(["activation_descriptor_unknown"]);
  });

  it("Error: 현재 동작 고정(계약 아님) — 배열 kind 신호 활성화의 외부 신호는 trigger_mismatch 다 (test_SC045_array_kind_signal_activation_in_state_mismatches)", () => {
    const r = registerDefinition(definitionDeps("killr12b"), { draft: signalDefinitionDraft() });
    // 레코드 패치: 배열 kind(다른 생성 경로 대용 — 초안 검증이 막는다).
    patchActivation(r.journal, r.stewardId, { kind: ["signal"] });
    const before = r.journal.definition(r.definitionId);
    const judged = r.journal.external(r.definitionId, "s-1", dayAt(0));
    expect(judged.kind).toBe("rejected");
    if (judged.kind === "rejected") expect(judged.reason).toBe("trigger_mismatch");
    expect(typesOf(commitOf(judged))).not.toContain("trigger_fired");
    expect(r.journal.definition(r.definitionId)).toEqual(before);
  });
});

describe("판정 기록 재점검: 손수 만든 등록부", () => {
  it("Error: 발화·파생 짝이 어긋난 일정 descriptor 는 일정 활성화로 받지 않는다 (test_SC051_hand_built_registry_pair_violation_not_schedule_activation)", () => {
    const base = definitionDeps("killr13a").registries;
    const variants: readonly [string, (d: TriggerDescriptor) => TriggerDescriptor][] = [
      ["derivation none", (d) => ({ ...d, occurrenceDerivation: { kind: "none" } })],
      ["firing on_ready", (d) => ({ ...d, firing: "on_ready" })],
    ];
    variants.forEach(([label, change], i) => {
      const registries = withTriggerDescriptor(base, "at", (d) => {
        if (d === undefined) throw new Error("expected at descriptor");
        return change(d);
      });
      const reasons = definitionInvalidReasons(
        issuesOf(
          proposeDraft(definitionDeps(`killr13a${i}`, registries), definitionDraft()).outcome,
        ),
      );
      expect(reasons, label).toEqual(["activation_kind_not_allowed"]);
    });
  });

  it("Error: 예약 원인은 파생이 schedule 인 descriptor 를 요구한다 (test_SC048_schedule_cause_requires_schedule_derivation_descriptor)", () => {
    const base = testDeps("killr13b");
    const registries = withTriggerDescriptor(base.registries, "at", (d) => {
      if (d === undefined) throw new Error("expected at descriptor");
      return { ...d, occurrenceDerivation: { kind: "none" } };
    });
    const deps = { ...base, registries };
    const trigger = atTrigger("timed", { kind: "fire_once_now" });
    const { journal, ids } = startJournal([draft("timed", { trigger })], deps);
    const taskId = ids["timed"] as TaskId;
    validate(journal, taskId);
    const before = journal.task(taskId);
    const occurrenceId = mustOk(
      deriveOccurrenceId({
        kind: "schedule",
        ownerId: taskId,
        triggerId: "timed",
        scheduledForUtc: (trigger as unknown as { scheduledForUtc: UtcInstant }).scheduledForUtc,
        recurrenceIndex: 0,
      }),
    );
    const outcome = taskCommand(journal.deps, journal.aggregate, taskId, {
      kind: "schedule_task",
      occurrenceId,
      cause: "schedule",
    });
    expect(outcome).toEqual({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "occurrence_derivation_not_schedule" },
    });
    expect(journal.task(taskId)).toEqual(before);
  });

  it("Edge: 현재 동작 고정(계약 아님) — 출처 필드 없는 신호 발화 활성화로 개정하면 보류 신호 회차를 건너뛴다 (test_SC044_signal_firing_activation_without_signal_fields_skips_held)", () => {
    const bareKind = "bare_signal";
    const base = definitionDeps("killr13c").registries;
    const signalDescriptor = base.triggers.get("signal", 1);
    if (signalDescriptor === undefined) throw new Error("expected signal descriptor");
    const registries = withTriggerDescriptor(base, bareKind, () => ({
      ...signalDescriptor,
      kind: bareKind,
      title: "bare signal",
      schema: z.strictObject({
        kind: z.literal(bareKind),
        version: z.literal(1),
        triggerId: z.string(),
      }),
    }));
    const r = registerDefinition(definitionDeps("killr13c", registries), {
      draft: signalDefinitionDraft(),
      tasks: STEWARD_MEMBER,
    });
    for (const s of ["open", "h1"]) commitOrThrow(r.journal.external(r.definitionId, s, dayAt(0)));
    const heldIds = r.journal.definition(r.definitionId).held.map((h) => h.occurrenceId);
    expect(heldIds).toHaveLength(1);
    const grant = commitOrThrow(
      r.journal.amend(
        r.definitionId,
        {
          activation: {
            kind: bareKind,
            version: 1,
            triggerId: "on_signal",
          } as unknown as TriggerSpec,
        },
        dayAt(0, "08:00"),
      ),
    );
    expect(
      payloadsOf(grant, "work_definition_occurrences_skipped").flatMap(
        (p) => p["heldOccurrenceIds"] as string[],
      ),
    ).toEqual(heldIds);
    expect(r.journal.definition(r.definitionId).held).toEqual([]);
  });
});

describe("SC-063: 상태 키와 work.id 가 다른 관리 Work", () => {
  it("Error: 관리 Work 의 상태 키와 work.id 가 다르면 정의 입력 셋이 불변식 오류로 닫힌다 (test_SC063_state_key_work_id_mismatch_fails_closed)", () => {
    const paths = ["control", "external", "resolve"] as const;
    const setup = (path: (typeof paths)[number], seed: string) =>
      path === "external"
        ? registerDefinition(definitionDeps(seed), { draft: signalDefinitionDraft() })
        : registerDefinition(definitionDeps(seed));
    const act = (r: ReturnType<typeof setup>, path: (typeof paths)[number]) =>
      path === "control"
        ? r.journal.control(r.definitionId, "pause", dayAt(0, "01:00"))
        : path === "external"
          ? r.journal.external(r.definitionId, "s-1", dayAt(0))
          : r.journal.resolveDue(r.definitionId, dayAt(0));
    for (const path of paths) {
      const r = setup(path, `killj2${path}`);
      const steward = r.journal.work(r.stewardId);
      // 상태 재구성: 키는 그대로 두고 work.id 만 다른 ID — 다중 Work 상태를 임의로 만든 입력(다른 생성 경로 대용).
      r.journal.state = {
        works: {
          ...r.journal.state.works,
          [r.stewardId]: {
            ...steward,
            work: { ...steward.work, id: nextEntityId(r.journal.deps.ids, "work") },
          },
        },
      };
      const stateBefore = r.journal.state;
      const commitsBefore = r.journal.commits.length;
      expect(() => act(r, path), path).toThrow(DomainInvariantError);
      expect(r.journal.state, path).toBe(stateBefore);
      expect(r.journal.commits, path).toHaveLength(commitsBefore);

      const clean = setup(path, `killj2${path}ok`);
      expect(["accepted", "committed"], path).toContain(act(clean, path).kind);
    }
  });
});

describe("SC-019: 취소 출처 파서 진입·선택 필드와 중지 출처 필드 유무", () => {
  it("Error: 파서 진입의 객체·종류·출처·회차 이벤트 ID 거절은 반환 전체가 정해져 있다 (test_SC019_cancel_origin_parser_entry_rejections_exact)", () => {
    const evt = nextEntityId(testDeps("killrw6a").ids, "event");
    const failure = (field: string, reason: string) => ({
      ok: false,
      error: { kind: "value_format", field, reason },
    });
    const rows: readonly [string, unknown, unknown][] = [
      ["null", null, failure("cancelOrigin", "not_an_object")],
      ["string", "work_cascade", failure("cancelOrigin", "not_an_object")],
      ["array", [], failure("cancelOrigin", "not_an_object")],
      [
        "unknown string kind",
        { kind: "bogus", actorSource: "adde_self", workEventId: evt },
        failure("cancelOrigin.kind", "unknown_kind"),
      ],
      [
        "numeric kind",
        { kind: 7, actorSource: "adde_self", workEventId: evt },
        failure("cancelOrigin.kind", "unknown_kind"),
      ],
      [
        "unknown actorSource",
        { kind: "work_cascade", actorSource: "robot", workEventId: evt },
        failure("cancelOrigin.actorSource", "unknown_actor_source"),
      ],
      [
        "missing workEventId",
        { kind: "work_cascade", actorSource: "adde_self" },
        failure("cancelOrigin.workEventId", "required_for_kind"),
      ],
      [
        "numeric workEventId",
        { kind: "replan_dropped", actorSource: "adde_self", workEventId: 42 },
        failure("cancelOrigin.workEventId", "required_for_kind"),
      ],
    ];
    for (const [label, raw, expected] of rows) {
      expect(parseCancelOrigin(raw), label).toStrictEqual(expected);
    }
    // 대조: 같은 꼴의 맞는 입력은 같은 값으로 통과한다.
    const valid = { kind: "work_cascade", actorSource: "adde_self", workEventId: evt };
    expect(parseCancelOrigin(valid)).toStrictEqual({ ok: true, value: valid });
  });

  it("Happy: 파서 수용은 선택 필드를 있을 때만 싣고 반환 전체가 입력과 같다 (test_SC019_cancel_origin_parser_ok_values_exact)", () => {
    const ids = testDeps("killrw6b").ids;
    const evt = nextEntityId(ids, "event");
    const sig = nextEntityId(ids, "signal");
    const ctl = nextEntityId(ids, "controlRequest");
    const rows: readonly [string, Record<string, unknown>][] = [
      [
        "(a) vault + provenance + user actor + reason",
        {
          kind: "vault_signal",
          actorSource: "human_local",
          signalId: sig,
          provenance: { channel: "vault", note: "n1" },
          actor: { kind: "user", id: "u1" },
          reason: "stop",
        },
      ],
      ["(b) vault bare", { kind: "vault_signal", actorSource: "human_local", signalId: sig }],
      [
        "(c) work cascade + session actor",
        {
          kind: "work_cascade",
          actorSource: "adde_self",
          workEventId: evt,
          actor: { kind: "session", sid: "s1" },
        },
      ],
      [
        "(d) control request + empty reason",
        {
          kind: "control_request",
          actorSource: "unknown",
          controlRequestId: ctl,
          keyId: "k1",
          reason: "",
        },
      ],
    ];
    for (const [label, raw] of rows) {
      expect(parseCancelOrigin(raw), label).toStrictEqual({ ok: true, value: raw });
    }
  });

  it("Edge: 종류 필드가 빠진 취소 출처의 중지 출처에는 그 키가 없다 (test_SC019_cascade_stop_origin_omits_absent_kind_fields)", () => {
    const rows: readonly [Record<string, unknown>, Record<string, unknown>][] = [
      [
        { kind: "vault_signal", actorSource: "human_local" },
        { kind: "work_cascade", actorSource: "human_local" },
      ],
      [
        { kind: "control_request", actorSource: "unknown" },
        { kind: "work_cascade", actorSource: "unknown" },
      ],
      [
        { kind: "control_request", actorSource: "unknown", controlRequestId: "ctl_x" },
        { kind: "work_cascade", actorSource: "unknown", controlRequestId: "ctl_x" },
      ],
      [
        { kind: "control_request", actorSource: "unknown", keyId: "k" },
        { kind: "work_cascade", actorSource: "unknown", keyId: "k" },
      ],
    ];
    rows.forEach(([origin, expected], i) => {
      const r = registerDefinition(definitionDeps(`killrw6c${i}`));
      const { commit } = assembleCommit(
        r.journal.deps,
        r.journal.work(r.stewardId),
        [mkEvent("work_canceled", { origin } as never, { workId: r.stewardId })],
        meta(ACTION_AT, origin["actorSource"] as ActorSource),
      );
      expect(
        payloadsOf(commit, "work_definition_stopped")[0]?.["stopOrigin"],
        JSON.stringify(origin),
      ).toStrictEqual(expected);
    });
  });

  it("Happy: 공개 decideWorkCommand 의 Work 취소 이벤트는 그 Work 를 가리킨다 (test_SC019_decide_cancel_work_event_carries_work_id)", () => {
    const { deps, aggregate } = reachWorkState("ACTIVE");
    const origin = controlRequestCancelOrigin(deps);
    const command: WorkCommand = {
      kind: "cancel_work",
      origin,
      expectedRevision: aggregate.work.revision,
      meta: meta(KILL_NOW, "unknown"),
    };
    expect(decideWorkCommand(deps, aggregate, command)).toStrictEqual({
      kind: "events",
      events: [{ type: "work_canceled", payload: { origin }, workId: aggregate.work.id }],
    });
  });
});

describe("독립 재검증 2회차 판별 — 신호 상한 보류·반환 애그리거트 키·제어 상태 적격", () => {
  it("Error: 신호 상한에 닿은 기록에서 보류된 신호 회차는 같은 커밋의 중지 건너뜀에 들고 보류 목록이 빈다 (test_SC039_signal_bound_hold_skipped_by_same_commit_stop)", () => {
    const setup = (seed: string) => {
      const r = registerDefinition(definitionDeps(seed), {
        draft: signalDefinitionDraft({ maxOpenOccurrences: 1, maxOccurrences: 3 }),
        tasks: STEWARD_MEMBER,
      });
      commitOrThrow(r.journal.external(r.definitionId, "s1", dayAt(0)));
      return r;
    };
    const r = setup("killc1a");
    // 레코드 패치: 일생 materialize 수와 같은 신호 상한(다른 생성 경로 대용 — 상한 도달 커밋이 멈춘다).
    patchDefinitionRecord(r.journal, r.stewardId, (d) => ({
      ...d,
      maxOccurrences: d.materialized.length,
    }));
    const commit = commitOrThrow(r.journal.external(r.definitionId, "s2", dayAt(0, "01:00")));
    const heldIds = payloadsOf(commit, "work_definition_occurrence_held").map(
      (p) => p["occurrenceId"],
    );
    expect(heldIds).toHaveLength(1);
    expect(typesOf(commit)).toContain("work_definition_stopped");
    const skips = payloadsOf(commit, "work_definition_occurrences_skipped");
    expect(skips.map((p) => p["reason"])).toEqual(["definition_stopped"]);
    expect(skips[0]?.["heldOccurrenceIds"]).toEqual(heldIds);
    const after = r.journal.definition(r.definitionId);
    expect(after.state).toBe("STOPPED");
    expect(after.held).toEqual([]);

    // 대조: 상한 아래 기록에서는 같은 신호가 보류만 되고 보류 목록에 남는다.
    const room = setup("killc1b");
    const held = commitOrThrow(room.journal.external(room.definitionId, "s2", dayAt(0, "01:00")));
    expect(typesOf(held)).not.toContain("work_definition_stopped");
    const roomHeld = payloadsOf(held, "work_definition_occurrence_held").map(
      (p) => p["occurrenceId"],
    );
    expect(room.journal.definition(room.definitionId).held.map((h) => h.occurrenceId)).toEqual(
      roomHeld,
    );
  });

  it("Happy: 정의를 관리하지 않는 Work 의 공개 반환 애그리거트에는 definition 키가 없다 (test_SC016_aggregate_without_definition_has_no_definition_key)", () => {
    const deps = definitionDeps("killc2");
    const created = createWork(deps, {
      kind: "create_work",
      meta: meta(DEF_NOW),
      projectId: mustOk(parseProjectId("prj_killc2project0001")),
      title: "plain work",
      objective: "plain work",
      source: { kind: "markdown", documentId: "doc-killc2" },
    });
    if (created.kind !== "committed") throw new Error(`expected commit, got ${created.kind}`);
    expect(Object.hasOwn(created.aggregate, "definition")).toBe(false);
    const { journal, workId } = markdownWorkInPlanning(definitionDeps("killc2b"));
    expect(Object.hasOwn(journal.work(workId), "definition")).toBe(false);
    // 대조: 관리 Work 는 정의 키를 가진다.
    const r = registerDefinition(definitionDeps("killc2c"));
    expect(Object.hasOwn(r.journal.work(r.stewardId), "definition")).toBe(true);
  });

  it("Error: 기록 상태가 세 정의 상태 밖이면 중지 제어는 unexpected_state 로 거절된다 (test_SC034_stop_on_unknown_definition_state_refused)", () => {
    const r = registerDefinition(definitionDeps("killc4a"));
    // 레코드 패치: 계약 열거 밖 상태 값(다른 생성 경로 대용 — evolve 는 세 상태만 쓴다).
    patchDefinitionRecord(r.journal, r.stewardId, (d) => ({ ...d, state: "X" as never }));
    const judged = r.journal.control(r.definitionId, "stop", dayAt(0, "01:00"));
    expect(judged.kind).toBe("rejected");
    if (judged.kind === "rejected") expect(judged.reason).toBe("unexpected_state");
    expect(r.journal.definition(r.definitionId).state).toBe("X");
    // 대조: ACTIVE 정의의 같은 중지는 수용된다.
    const ok = registerDefinition(definitionDeps("killc4b"));
    expect(ok.journal.control(ok.definitionId, "stop", dayAt(0, "01:00")).kind).toBe("accepted");
  });
});

describe("독립 재검증 2회차 판별 — 중지 출처·공유 인증 형태·파서 결과", () => {
  it("Edge: 중지 출처의 출처는 취소 origin 이 아니라 명령 meta 출처다 (test_SC019_cascade_stop_origin_actor_source_from_meta)", () => {
    const rows: readonly [ActorSource, ActorSource][] = [
      ["human_local", "unknown"],
      ["human_local", "human_local"],
    ];
    rows.forEach(([originSource, metaSource], i) => {
      const r = registerDefinition(definitionDeps(`killb2${i}`));
      const signalId = nextEntityId(r.journal.deps.ids, "signal");
      const origin = { kind: "vault_signal", actorSource: originSource, signalId };
      const { commit } = assembleCommit(
        r.journal.deps,
        r.journal.work(r.stewardId),
        [mkEvent("work_canceled", { origin } as never, { workId: r.stewardId })],
        meta(ACTION_AT, metaSource),
      );
      expect(
        payloadsOf(commit, "work_definition_stopped")[0]?.["stopOrigin"],
        `${originSource}/${metaSource}`,
      ).toStrictEqual({ kind: "work_cascade", actorSource: metaSource, signalId });
    });
  });

  it("Error: 문자열이 아닌 keyId 의 제어 요청은 정의 제어와 Work 취소 양쪽에서 거절된다 (test_SC019_non_string_key_id_refused_in_both_paths)", () => {
    const rows: readonly [string, unknown, boolean][] = [
      ["number", 5, false],
      ["array", ["k"], false],
      ["string", "k", true],
    ];
    rows.forEach(([label, keyId, shaped], i) => {
      const { journal, definitionId } = registerDefinition(definitionDeps(`killb3a${i}`));
      const controlRequestId = nextEntityId(journal.deps.ids, "controlRequest");
      const channel = { kind: "control_request", controlRequestId, keyId } as never;
      const paused = journal.control(definitionId, "pause", ACTION_AT, {
        channel,
        actorSource: "unknown",
      });
      const markdown = journal.createMarkdownWork(ACTION_AT);
      const canceled = journal.onWork(
        markdown,
        {
          kind: "cancel_work",
          origin: {
            kind: "control_request",
            actorSource: "unknown",
            controlRequestId,
            keyId,
          } as never,
        },
        ACTION_AT,
        { actorSource: "unknown" },
      );
      if (shaped) {
        expect(paused.kind, label).toBe("accepted");
        expect(canceled.kind, label).toBe("committed");
      } else {
        expect(paused.kind, label).toBe("rejected");
        if (paused.kind === "rejected") expect(paused.reason, label).toBe("provenance_not_human");
        expect(canceled, label).toEqual({
          kind: "rejected",
          rejection: { reason: "invalid_input", detail: "cancel_origin_invalid" },
        });
      }
    });
  });

  it("Happy: 파서 수용 결과의 actor 는 검사한 필드만 담는다 (test_SC019_cancel_origin_parser_actor_drops_extra_keys)", () => {
    const sig = nextEntityId(testDeps("killb3b").ids, "signal");
    const base = { kind: "vault_signal", actorSource: "human_local", signalId: sig };
    expect(
      parseCancelOrigin({ ...base, actor: { kind: "user", id: "u1", role: "admin" } }),
    ).toStrictEqual({ ok: true, value: { ...base, actor: { kind: "user", id: "u1" } } });
    expect(
      parseCancelOrigin({ ...base, actor: { kind: "session", sid: "s1", note: 1 } }),
    ).toStrictEqual({ ok: true, value: { ...base, actor: { kind: "session", sid: "s1" } } });
  });
});

describe("독립 재검증 2회차 판별 — 정의 이벤트의 관리 Work 귀속(외부 신호·해제·취소 연쇄)", () => {
  it("Error: sourceWorkId 가 다른 기록에서도 외부 신호·보류 해제·관리 Work 취소 연쇄의 정의 이벤트는 관리 Work 로 간다 (test_SC063_signal_release_cascade_events_follow_steward)", () => {
    const registered = registerDefinition(definitionDeps("killc6"), {
      draft: signalDefinitionDraft({ maxOpenOccurrences: 1 }),
      tasks: STEWARD_MEMBER,
    });
    const { definitionId, stewardId } = registered;
    const other = registered.journal.createMarkdownWork(dayAt(0, "00:10"));
    const commits = registered.journal.commits.map((c) => ({
      ...c,
      events: c.events.map((e) => {
        if (e.type !== "work_definition_created") return e;
        const payload = e.payload as unknown as { definition: Record<string, unknown> };
        return {
          ...e,
          payload: { ...payload, definition: { ...payload.definition, sourceWorkId: other } },
        } as unknown as typeof e;
      }),
    })) as DomainCommit[];
    const folded = foldWorkflowEvents(commits.flatMap((c) => c.events));
    if (!folded.ok) throw new Error(`fold failed ${JSON.stringify(folded.error)}`);
    const journal = new WorkflowJournal(registered.journal.deps, folded.value, commits);
    expect(journal.definition(definitionId).sourceWorkId).toBe(other);

    const steps: readonly [string, () => DomainCommit][] = [
      ["signal materialize", () => commitOrThrow(journal.external(definitionId, "s1", dayAt(0)))],
      ["signal hold", () => commitOrThrow(journal.external(definitionId, "s2", dayAt(0, "01:00")))],
      [
        "release",
        () => {
          const first = journal.occurrenceWorkIds(definitionId)[0];
          if (first === undefined) throw new Error("expected an occurrence work");
          commitOrThrow(journal.cancelWork(first, dayAt(0, "02:00")));
          return commitOrThrow(journal.release(definitionId, dayAt(0, "02:30")));
        },
      ],
      [
        "steward cancel cascade",
        () =>
          commitOrThrow(
            journal.onWork(
              stewardId,
              { kind: "cancel_work", origin: vaultOrigin(journal.deps) },
              dayAt(0, "03:00"),
              { actorSource: "human_local" },
            ),
          ),
      ],
    ];
    for (const [label, step] of steps) {
      const commit = step();
      // 정의 이벤트 — 페이로드 최상위에 definitionId 를 싣는 이벤트(정의 전이·건너뜀·보류·발화).
      const definitionEvents = commit.events.filter((e) =>
        Object.hasOwn(e.payload as object, "definitionId"),
      );
      expect(definitionEvents.length, label).toBeGreaterThan(0);
      for (const e of definitionEvents)
        expect(e.workId as WorkId | undefined, label).toBe(stewardId);
      expect(
        commit.events.some((e) => e.workId === other),
        label,
      ).toBe(false);
      expect(journal.folded(), label).toEqual(journal.state);
    }
    expect(journal.definition(definitionId).state).toBe("STOPPED");
  });
});
