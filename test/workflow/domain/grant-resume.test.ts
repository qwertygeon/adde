// Task 승인 결정의 재개 형태 — SCHEDULED 재개 occurrence 는 도메인 파생뿐이고 호출자 지정 형태는 타입·런타임 모두에서 막힌다.
import { describe, expect, it } from "vitest";
import {
  deriveOccurrenceId,
  executeCommand,
  judgeSignal,
  nextEntityId,
} from "../../../src/workflow/domain/index.js";
import type {
  DecisionApplication,
  DomainDeps,
  GrantResume,
  OccurrenceId,
  SignalJudgement,
  TaskId,
  WorkAggregate,
} from "../../../src/workflow/domain/index.js";
import {
  at,
  basePolicy,
  meta,
  mustCommit,
  mustOk,
  patchTask,
  reachDeadLetterParked,
  reachTaskState,
  requireTaskFor,
} from "./helpers/fixtures.js";
import { payloadOf } from "./helpers/commits.js";

const NOW = at("2026-01-01T00:00:00Z");
const NOT_APPLICABLE_INVALID = { kind: "not_applicable", rejection: { reason: "invalid_input" } };

interface Parked {
  readonly deps: DomainDeps;
  readonly aggregate: WorkAggregate;
  readonly taskId: TaskId;
}

function grantWith(parked: Parked, application: unknown): SignalJudgement {
  const task = requireTaskFor(parked.aggregate, parked.taskId);
  const decisionId = task.pendingDecision?.id;
  if (decisionId === undefined) throw new Error("expected pending decision");
  return judgeSignal(
    parked.deps,
    parked.aggregate,
    {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: nextEntityId(parked.deps.ids, "signal"),
      expectedRevision: task.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    },
    application as DecisionApplication,
    NOW,
  );
}

function taskGrant(resume: unknown): unknown {
  return { kind: "task_grant", resume };
}

function someOccurrenceId(parked: Parked): OccurrenceId {
  const task = requireTaskFor(parked.aggregate, parked.taskId);
  return mustOk(
    deriveOccurrenceId({
      kind: "schedule",
      ownerId: parked.taskId,
      triggerId: task.trigger.triggerId,
      scheduledForUtc: at("2026-01-02T00:00:00Z"),
      recurrenceIndex: 0,
    }),
  );
}

/** 실행 전 승인 대기 — 레코드 패치로 승인 요구만 켠 READY Task 를 시작해 주차한다. */
function preExecutionParked(): Parked {
  const { deps, aggregate, taskId } = reachTaskState("READY");
  const patched = patchTask(aggregate, taskId, {
    policy: basePolicy({ approvalRequiredBeforeExecute: true }),
    preExecutionApproved: false,
  });
  const parked = mustCommit(
    executeCommand(deps, patched, {
      kind: "start_attempt",
      taskId,
      expectedRevision: requireTaskFor(patched, taskId).revision,
      meta: meta(NOW),
    }),
  ).aggregate;
  const task = requireTaskFor(parked, taskId);
  expect(task.state).toBe("BLOCKED_AWAITING_HUMAN");
  expect(task.pendingDecision?.kind).toBe("pre_execution_approval");
  return { deps, aggregate: parked, taskId };
}

describe("SC-045: 호출자 지정 occurrence 형태의 grant 는 커밋 없이 거절된다", () => {
  it("Happy: given occurrence 형태의 grant 는 not_applicable invalid_input 이다 (test_SC045_given_occurrence_grant_rejected)", () => {
    const parked = reachDeadLetterParked();
    const judged = grantWith(
      parked,
      taskGrant({
        to: "SCHEDULED",
        occurrence: { kind: "given", occurrenceId: someOccurrenceId(parked) },
      }),
    );
    expect(judged).toEqual(NOT_APPLICABLE_INVALID);
  });

  it("Edge: 객체가 아닌 resume 와 열거 밖 to 는 거절된다 (test_SC045_non_object_resume_or_unknown_target_rejected)", () => {
    const parked = reachDeadLetterParked();
    for (const resume of ["READY", null, [], { to: "RUNNING" }, { to: "constructor" }]) {
      expect(grantWith(parked, taskGrant(resume)), JSON.stringify(resume)).toEqual(
        NOT_APPLICABLE_INVALID,
      );
    }
  });

  it("Error: SCHEDULED 인데 occurrence 가 없으면 거절된다 (test_SC045_missing_occurrence_rejected)", () => {
    const parked = reachDeadLetterParked();
    expect(grantWith(parked, taskGrant({ to: "SCHEDULED" }))).toEqual(NOT_APPLICABLE_INVALID);
    expect(
      grantWith(parked, taskGrant({ to: "SCHEDULED", occurrence: { kind: "constructor" } })),
    ).toEqual(NOT_APPLICABLE_INVALID);
  });
});

describe("SC-046: 공개 타입 GrantResume 은 호출자 지정 occurrence 형태를 갖지 않는다", () => {
  it("Happy: given 형태는 타입 오류이고 같은 값은 런타임에서도 거절된다 (test_SC046_given_form_type_error)", () => {
    const parked = reachDeadLetterParked();
    const occurrenceId = someOccurrenceId(parked);
    const resume: GrantResume = {
      to: "SCHEDULED",
      // @ts-expect-error SCHEDULED 재개의 occurrence 는 dead_letter_retry 파생뿐이다.
      occurrence: { kind: "given", occurrenceId },
    };
    expect(grantWith(parked, taskGrant(resume))).toEqual(NOT_APPLICABLE_INVALID);
  });

  it("Edge: dead_letter_retry 형태는 타입 오류 없이 대입되고 수용된다 (test_SC046_dead_letter_form_type_ok)", () => {
    const parked = reachDeadLetterParked();
    const resume: GrantResume = { to: "SCHEDULED", occurrence: { kind: "dead_letter_retry" } };
    const application: DecisionApplication = { kind: "task_grant", resume };
    expect(grantWith(parked, application).kind).toBe("accepted");
  });

  it("Error: READY 형태에 occurrence 를 더하면 타입 오류다 (test_SC046_ready_with_occurrence_type_error)", () => {
    const parked = reachDeadLetterParked();
    const resume: GrantResume = {
      to: "READY",
      // @ts-expect-error READY 재개는 occurrence 를 받지 않는다.
      occurrence: { kind: "dead_letter_retry" },
    };
    const judged = grantWith(parked, taskGrant(resume));
    expect(judged.kind).toBe("accepted");
    if (judged.kind === "accepted")
      expect(payloadOf(judged.commit, "human_decision_granted")["resumedTo"]).toBe("READY");
  });
});

describe("SC-047: SCHEDULED 재개 occurrence 는 Task 기록과 grant 에서 파생한다", () => {
  it("Happy: dead-letter 주차 Task 의 재시도 재개는 파생 occurrence 로 SCHEDULED 가 된다 (test_SC047_dead_letter_retry_scheduled)", () => {
    const parked = reachDeadLetterParked();
    const task = requireTaskFor(parked.aggregate, parked.taskId);
    const expected = mustOk(
      deriveOccurrenceId({
        kind: "execution_retry",
        ownerId: parked.taskId,
        triggerId: task.trigger.triggerId,
        causingEvent: { occurredAt: NOW },
        attemptNo: task.lastAttemptNo + 1,
      }),
    );
    const judged = grantWith(
      parked,
      taskGrant({ to: "SCHEDULED", occurrence: { kind: "dead_letter_retry" } }),
    );
    const { commit, aggregate } = mustCommit(judged);
    const granted = payloadOf(commit, "human_decision_granted");
    expect(granted["resumedTo"]).toBe("SCHEDULED");
    expect(granted["occurrenceId"]).toBe(expected);
    expect(requireTaskFor(aggregate, parked.taskId).state).toBe("SCHEDULED");
  });

  it("Edge: 같은 Task 의 READY 재개는 READY 가 된다 (test_SC047_ready_resume)", () => {
    const parked = reachDeadLetterParked();
    const { aggregate } = mustCommit(grantWith(parked, taskGrant({ to: "READY" })));
    expect(requireTaskFor(aggregate, parked.taskId).state).toBe("READY");
  });

  it("Error: 실행 전 승인 결정의 SCHEDULED 재개는 거절된다 (test_SC047_pre_execution_scheduled_rejected)", () => {
    const parked = preExecutionParked();
    expect(
      grantWith(parked, taskGrant({ to: "SCHEDULED", occurrence: { kind: "dead_letter_retry" } })),
    ).toEqual(NOT_APPLICABLE_INVALID);
    expect(grantWith(parked, taskGrant({ to: "READY" })).kind).toBe("accepted");
  });
});
