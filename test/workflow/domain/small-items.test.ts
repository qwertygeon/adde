// 작은 하드닝 항목 — 보유 제안 재검증 대조·보존 레코드 누락·시작 검사 순서·Task 입력 금지 키·이슈의 정규 JSON·
// 무효 grant 의 정렬된 커밋 목록.
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  createWork,
  decidePendingProposalRevalidation,
  deriveOccurrenceId,
  evolveCommit,
  executeCommand,
  judgeSignal,
  nextEntityId,
  parseProjectId,
  planPreconditionRejection,
  planProposalDigest,
  validatePlanProposal,
  validateTask,
} from "../../../src/workflow/domain/internal.js";
import type {
  CommandOutcome,
  DomainCommit,
  DomainDeps,
  PlanProposal,
  SignalJudgement,
  TaskId,
  WorkAggregate,
} from "../../../src/workflow/domain/index.js";
import {
  at,
  basePolicy,
  deadLetterDecision,
  draft,
  entityId,
  meta,
  mustCommit,
  mustOk,
  patchTask,
  patchWork,
  planInput,
  reachTaskState,
  reachWorkState,
  requireTaskFor,
  taskSubjectPendingDecision,
  testDeps,
} from "./helpers/fixtures.js";
import { eventTypes, payloadOf } from "./helpers/commits.js";
import {
  Journal,
  atTrigger,
  replanSignal,
  start,
  startJournal,
  validate,
} from "./helpers/scenario.js";

const NOW = at("2026-01-01T00:00:00Z");
const GHOST_TASK = entityId("task", "tsk_ghostretained01");

type Issue = Readonly<Record<string, unknown>>;

function grant(deps: DomainDeps, aggregate: WorkAggregate): SignalJudgement {
  const decisionId = aggregate.work.pendingDecision?.id;
  if (decisionId === undefined) throw new Error("expected pending plan decision");
  return judgeSignal(
    deps,
    aggregate,
    {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: nextEntityId(deps.ids, "signal"),
      expectedRevision: aggregate.work.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    },
    { kind: "plan_grant" },
    NOW,
  );
}

function heldOf(aggregate: WorkAggregate): PlanProposal {
  const held = aggregate.work.pendingProposal;
  if (held === undefined) throw new Error("expected held proposal");
  return held;
}

function digestOf(workId: WorkAggregate["work"]["id"], content: PlanProposal): string {
  return mustOk(
    planProposalDigest(workId, {
      basePlanRevision: content.basePlanRevision,
      source: content.source,
      tasks: content.tasks,
      retain: content.retain,
      ...(content.definition !== undefined ? { definition: content.definition } : {}),
    }),
  );
}

/** grant 판정이 정렬된 커밋 목록이면 첫 커밋(철회)의 이슈. */
function withdrawnIssues(judged: SignalJudgement): readonly Issue[] {
  if (judged.kind !== "stale_after_withdrawal")
    throw new Error(`expected stale_after_withdrawal, got ${judged.kind}`);
  const [withdrawal] = judged.commits;
  return payloadOf(withdrawal, "work_plan_withdrawn")["issues"] as readonly Issue[];
}

/** 진행 중 member g 를 보존하는 재계획 승인 대기 — 대기 제안 재검증 조건(member 종결)을 만들 수 있다. */
function replanWaiting(seed: string): { deps: DomainDeps; before: WorkAggregate; g: TaskId } {
  const { journal, ids } = startJournal([draft("g")], testDeps(seed));
  const g = ids["g"] as TaskId;
  validate(journal, g);
  start(journal, g);
  journal.apply(replanSignal(journal));
  journal.apply(
    executeCommand(journal.deps, journal.aggregate, {
      kind: "propose_plan",
      expectedRevision: journal.aggregate.work.revision,
      meta: meta(NOW),
      plan: planInput([], { basePlanRevision: journal.aggregate.work.planRevision, retain: [g] }),
      summary: "replan approval",
    }),
  );
  expect(journal.aggregate.work.state).toBe("WAITING_APPROVAL");
  return { deps: journal.deps, before: journal.aggregate, g };
}

/** 보유 제안 ID 만 다른 제안 ID 로 바꾼 레코드 패치(내용·두 digest 그대로). */
function withOtherHeldId(aggregate: WorkAggregate): WorkAggregate {
  const held = heldOf(aggregate);
  return patchWork(aggregate, {
    pendingProposal: { ...held, id: entityId("planProposal", "pln_notheld0001") },
  });
}

/** 재계획 Work(PLANNING) — 기준 member g 를 둔다. */
function replanPlanning(seed: string): { journal: Journal; g: TaskId } {
  const { journal, ids } = startJournal([draft("g")], testDeps(seed));
  const g = ids["g"] as TaskId;
  validate(journal, g);
  journal.apply(replanSignal(journal));
  expect(journal.aggregate.work.state).toBe("PLANNING");
  return { journal, g };
}

function invalidIssuesOf(outcome: CommandOutcome): readonly Issue[] {
  if (outcome.kind !== "committed") throw new Error(`expected committed, got ${outcome.kind}`);
  return payloadOf(outcome.commit, "work_plan_invalid")["issues"] as readonly Issue[];
}

/** 시작 명령 대상 — 레코드 패치로 실행 전 승인 요구만 켠 READY Task. */
function approvalRequiredReady(trigger?: Parameters<typeof reachTaskState>[1]) {
  const { deps, aggregate, taskId } = reachTaskState("READY", trigger);
  const patched = patchTask(aggregate, taskId, {
    policy: basePolicy({ approvalRequiredBeforeExecute: true }),
    preExecutionApproved: false,
  });
  return { deps, aggregate: patched, taskId };
}

function startAttempt(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  taskId: TaskId,
  firedOccurrenceId?: string,
): CommandOutcome {
  return executeCommand(deps, aggregate, {
    kind: "start_attempt",
    taskId,
    expectedRevision: requireTaskFor(aggregate, taskId).revision,
    meta: meta(NOW),
    ...(firedOccurrenceId !== undefined ? { firedOccurrenceId: firedOccurrenceId as never } : {}),
  });
}

function protoInput(json: string): unknown {
  return JSON.parse(json) as unknown;
}

function structuralIssues(issues: readonly Issue[]): readonly Issue[] {
  return issues.flatMap((issue) => {
    const reason = issue["reason"] as Issue | undefined;
    return issue["kind"] === "draft_invalid" && reason?.["kind"] === "structurally_invalid"
      ? (reason["issues"] as readonly Issue[])
      : [];
  });
}

function recordOutcome(outcome: unknown) {
  const { deps, aggregate, taskId } = reachTaskState("RUNNING");
  const task = requireTaskFor(aggregate, taskId);
  const attemptId = task.openAttempt?.attemptId;
  if (attemptId === undefined) throw new Error("expected open attempt");
  const result = executeCommand(deps, aggregate, {
    kind: "record_attempt_outcome",
    taskId,
    expectedRevision: task.revision,
    meta: meta(NOW),
    attemptId,
    outcome: outcome as never,
  });
  const { commit, aggregate: after } = mustCommit(result);
  return { commit, after, taskId };
}

function failedIssues(commit: DomainCommit): readonly Issue[] {
  const reason = payloadOf(commit, "task_failed")["reason"] as Issue;
  return (reason["outcome"] as Issue)["outputIssues"] as readonly Issue[];
}

function expectCanonical(commit: DomainCommit): void {
  expect(canonicalJson(commit.events.map((e) => e.payload)).ok).toBe(true);
}

describe("SC-048: 보유 제안 재검증은 제안 ID 를 Work 가 보유한 대기 제안과 대조한다", () => {
  it("Happy: 연쇄 재검증 — 보유 ID 와 다른 제안은 proposal_not_held 로 철회된다 (test_SC048_held_id_mismatch_invalid)", () => {
    const { deps, before, g } = replanWaiting("small048h");
    const patched = withOtherHeldId(before);
    const scratch = patchTask(patched, g, { state: "COMPLETED" });
    const withdrawal = decidePendingProposalRevalidation(deps, patched, scratch, "evt_cause");
    expect(withdrawal?.event.type).toBe("work_plan_withdrawn");
    expect((withdrawal?.event.payload as unknown as Issue)["issues"]).toEqual([
      { kind: "proposal_not_held" },
    ]);
  });

  it("Edge: grant 경로 — 같은 패치 상태의 사람 grant 는 정렬된 커밋 목록으로 철회된다 (test_SC048_grant_withdraws_not_held)", () => {
    const { deps, before } = replanWaiting("small048e");
    expect(withdrawnIssues(grant(deps, withOtherHeldId(before)))).toEqual([
      { kind: "proposal_not_held" },
    ]);
  });

  it("Error: 대조 — 같은 ID 면 연쇄 재검증이 통과하고 grant 는 수용된다 (test_SC048_same_id_valid)", () => {
    const { deps, before, g } = replanWaiting("small048r");
    const scratch = patchTask(before, g, { state: "COMPLETED" });
    expect(decidePendingProposalRevalidation(deps, before, scratch, "evt_cause")).toBeUndefined();
    expect(grant(deps, before).kind).toBe("accepted");
  });
});

describe("SC-049: 보유 제안 digest 가 Work 의 보유 digest 와 다르면 무효다", () => {
  it("Happy: 같은 ID·내용과 맞춘 다른 digest 는 proposal_not_held 다 (test_SC049_held_digest_mismatch_not_held)", () => {
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    const held = heldOf(aggregate);
    const [first, ...rest] = held.tasks;
    if (first === undefined) throw new Error("expected draft");
    const content = { ...held, tasks: [{ ...first, title: "patched title" }, ...rest] };
    const patched = patchWork(aggregate, {
      pendingProposal: { ...content, digest: digestOf(aggregate.work.id, content) as never },
    });
    expect(patched.work.pendingProposalDigest).toBe(held.digest);
    expect(withdrawnIssues(grant(deps, patched))).toEqual([{ kind: "proposal_not_held" }]);
  });

  it("Edge: 내용만 바꾸면 digest 대조가 먼저라 proposal_digest_mismatch 다 (test_SC049_content_change_digest_mismatch)", () => {
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    const held = heldOf(aggregate);
    const [first, ...rest] = held.tasks;
    if (first === undefined) throw new Error("expected draft");
    const patched = patchWork(aggregate, {
      pendingProposal: { ...held, tasks: [{ ...first, title: "patched title" }, ...rest] },
    });
    expect(withdrawnIssues(grant(deps, patched))).toEqual([{ kind: "proposal_digest_mismatch" }]);
  });

  it("Error: Work 의 보유 digest 만 다르면 proposal_not_held 다 (test_SC049_work_digest_only_not_held)", () => {
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    const patched = patchWork(aggregate, { pendingProposalDigest: "0".repeat(64) });
    expect(withdrawnIssues(grant(deps, patched))).toEqual([{ kind: "proposal_not_held" }]);
  });
});

describe("SC-050: 보유 제안 재검증은 새 제안과 같은 사전 거절 조건을 적용한다", () => {
  /** 보유 제안 본문을 바꾸고 두 digest 를 모두 바뀐 본문에 맞춘 레코드 패치. */
  function patchedHeld(change: (held: PlanProposal) => PlanProposal) {
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    const content = change(heldOf(aggregate));
    const digest = digestOf(aggregate.work.id, content);
    const patched = patchWork(aggregate, {
      pendingProposal: { ...content, digest: digest as never },
      pendingProposalDigest: digest,
    });
    return { deps, patched };
  }

  it("Happy: 열거 밖 출처는 proposal_precondition_unmet{source_unknown} 이다 (test_SC050_unknown_source_precondition_unmet)", () => {
    const { deps, patched } = patchedHeld((held) => ({ ...held, source: "imported" as never }));
    expect(withdrawnIssues(grant(deps, patched))).toEqual([
      { kind: "proposal_precondition_unmet", reason: "source_unknown" },
    ]);
  });

  it("Edge: 예약 출처 definition_template 은 proposal_precondition_unmet{source_reserved} 다 (test_SC050_reserved_source_precondition_unmet)", () => {
    const { deps, patched } = patchedHeld((held) => ({
      ...held,
      source: "definition_template" as never,
    }));
    expect(withdrawnIssues(grant(deps, patched))).toEqual([
      { kind: "proposal_precondition_unmet", reason: "source_reserved" },
    ]);
  });

  it("Error: 초안 틀 위반은 proposal_precondition_unmet{draft_frame_invalid} 다 (test_SC050_draft_frame_precondition_unmet)", () => {
    const { deps, patched } = patchedHeld((held) => {
      const [first, ...rest] = held.tasks;
      if (first === undefined) throw new Error("expected draft");
      return { ...held, tasks: [{ ...first, dependsOn: "x" as never }, ...rest] };
    });
    expect(withdrawnIssues(grant(deps, patched))).toEqual([
      { kind: "proposal_precondition_unmet", reason: "draft_frame_invalid" },
    ]);
  });
});

describe("SC-051: 레코드 없는 기준 member 를 보존하는 계획은 무효다", () => {
  it("Happy: 레코드 없는 보존 member 는 retained_record_missing 이슈로 무효다 (test_SC051_retained_record_missing_invalid)", () => {
    const { journal, g } = replanPlanning("small051h");
    const aggregate = patchWork(journal.aggregate, {
      memberTaskIds: [...journal.aggregate.work.memberTaskIds, GHOST_TASK],
    });
    const check = validatePlanProposal(
      journal.deps,
      aggregate,
      planInput([], { basePlanRevision: aggregate.work.planRevision, retain: [g, GHOST_TASK] }),
    );
    expect(check.valid).toBe(false);
    if (!check.valid)
      expect(check.issues).toContainEqual({ kind: "retained_record_missing", taskId: GHOST_TASK });
  });

  it("Edge: 직접 커밋 경로는 work_plan_invalid 에 같은 이슈를 싣는다 (test_SC051_commit_plan_records_issue)", () => {
    const { journal, g } = replanPlanning("small051e");
    const aggregate = patchWork(journal.aggregate, {
      memberTaskIds: [...journal.aggregate.work.memberTaskIds, GHOST_TASK],
    });
    const outcome = executeCommand(journal.deps, aggregate, {
      kind: "commit_plan",
      expectedRevision: aggregate.work.revision,
      meta: meta(NOW),
      plan: planInput([], {
        basePlanRevision: aggregate.work.planRevision,
        retain: [g, GHOST_TASK],
      }),
    });
    expect(invalidIssuesOf(outcome)).toContainEqual({
      kind: "retained_record_missing",
      taskId: GHOST_TASK,
    });
  });

  it("Error: 대조 — 레코드가 있는 보존 member 는 그 이슈가 없다 (test_SC051_record_present_no_issue)", () => {
    const { journal, g } = replanPlanning("small051r");
    const check = validatePlanProposal(
      journal.deps,
      journal.aggregate,
      planInput([], { basePlanRevision: journal.aggregate.work.planRevision, retain: [g] }),
    );
    const issues = check.valid ? [] : check.issues;
    expect(issues.filter((i) => i.kind === "retained_record_missing")).toEqual([]);
  });
});

describe("SC-052: READY 시작은 Trigger 등록·발화 선언을 실행 전 승인 주차보다 먼저 검사한다", () => {
  it("Happy: 승인 필요 + 준비 즉시 발화가 아닌 Trigger 는 결정 없이 condition_not_met 이다 (test_SC052_non_on_ready_start_condition_not_met)", () => {
    const { deps, aggregate, taskId } = approvalRequiredReady({
      trigger: atTrigger("fixture_task", { kind: "skip" }),
    });
    const outcome = startAttempt(deps, aggregate, taskId);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.rejection.reason).toBe("condition_not_met");
    expect(outcome.record).toBeUndefined();
  });

  it("Edge: 미등록 Trigger + 승인 필요는 descriptor_unknown 으로 거절된다 (test_SC052_unknown_trigger_start_condition_not_met)", () => {
    const ready = approvalRequiredReady();
    const task = requireTaskFor(ready.aggregate, ready.taskId);
    const aggregate = patchTask(ready.aggregate, ready.taskId, {
      trigger: { ...task.trigger, kind: "probe_trigger_missing" } as never,
    });
    expect(startAttempt(ready.deps, aggregate, ready.taskId)).toEqual({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "descriptor_unknown" },
    });
  });

  it("Error: 대조 — 준비 즉시 발화 Trigger + 승인 필요는 승인 대기로 주차한다 (test_SC052_on_ready_start_parks_for_approval)", () => {
    const { deps, aggregate, taskId } = approvalRequiredReady();
    const { commit, aggregate: after } = mustCommit(startAttempt(deps, aggregate, taskId));
    expect(eventTypes(commit)).toContain("task_awaiting_human");
    expect(requireTaskFor(after, taskId).pendingDecision?.kind).toBe("pre_execution_approval");
  });

  it("Error: READY 시작에 발화 occurrence 를 실으면 거절되고, 대조로 SCHEDULED 의 예약 occurrence 는 시작된다 (test_SC052_ready_start_with_fired_occurrence_rejected)", () => {
    const ready = reachTaskState("READY");
    const task = requireTaskFor(ready.aggregate, ready.taskId);
    const fired = mustOk(
      deriveOccurrenceId({
        kind: "schedule",
        ownerId: ready.taskId,
        triggerId: task.trigger.triggerId,
        scheduledForUtc: at("2026-01-01T01:00:00Z"),
        recurrenceIndex: 0,
      }),
    );
    expect(startAttempt(ready.deps, ready.aggregate, ready.taskId, fired)).toEqual({
      kind: "rejected",
      rejection: { reason: "invalid_input", detail: "fired_occurrence_not_allowed_for_ready" },
    });
    const scheduled = reachTaskState("SCHEDULED");
    const occurrence = requireTaskFor(scheduled.aggregate, scheduled.taskId).scheduledOccurrenceId;
    expect(occurrence).toBeDefined();
    const { commit } = mustCommit(
      startAttempt(scheduled.deps, scheduled.aggregate, scheduled.taskId, occurrence),
    );
    expect(payloadOf(commit, "task_started")["firedOccurrenceId"]).toBe(occurrence);
  });
});

describe("SC-053: Task 입력 최상위의 own __proto__ 키는 계획을 무효로 만든다", () => {
  it("Happy: JSON.parse 입력의 최상위 own __proto__ 는 input_forbidden_key 로 계획 무효다 (test_SC053_top_level_proto_key_plan_invalid)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const check = validatePlanProposal(
      deps,
      aggregate,
      planInput([draft("t", { input: protoInput('{"__proto__":{"note":"x"}}') })]),
    );
    expect(check.valid).toBe(false);
    if (check.valid) return;
    expect(structuralIssues(check.issues as readonly Issue[])).toContainEqual({
      area: "input",
      path: ["__proto__"],
      code: "input_forbidden_key",
    });
  });

  it("Edge: 명령 경로 propose_plan 도 같은 초안을 work_plan_invalid 로 기록한다 (test_SC053_propose_plan_proto_key_invalid)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const outcome = executeCommand(deps, aggregate, {
      kind: "propose_plan",
      expectedRevision: aggregate.work.revision,
      meta: meta(NOW),
      plan: planInput([draft("t", { input: protoInput('{"__proto__":{"note":"x"}}') })]),
      summary: "forbidden key",
    });
    expect(structuralIssues(invalidIssuesOf(outcome))).toContainEqual({
      area: "input",
      path: ["__proto__"],
      code: "input_forbidden_key",
    });
  });

  it("Error: 대조 — 금지 키 없는 같은 입력은 유효하다 (test_SC053_plain_input_valid)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const check = validatePlanProposal(
      deps,
      aggregate,
      planInput([draft("t", { input: protoInput('{"note":"x"}') })]),
    );
    expect(check.valid).toBe(true);
  });
});

describe("SC-054: Task 입력 어느 깊이의 own __proto__ 키든 Task 검증 실패다", () => {
  const declaration = (input: unknown) => ({
    type: { id: "generic_task", version: 1 },
    input,
    trigger: { kind: "immediate", version: 1, triggerId: "t" },
    policy: basePolicy(),
  });

  function forbidden(input: unknown): readonly Issue[] {
    const result = validateTask(testDeps().registries, declaration(input));
    if (result.exit !== "validation_failed") return [];
    return (result.issues as unknown as readonly Issue[]).filter(
      (i) => i["code"] === "input_forbidden_key",
    );
  }

  it("Happy: 중첩 own __proto__ 는 그 위치 경로로 검증 실패다 (test_SC054_nested_proto_key_validation_fails)", () => {
    const input = protoInput('{"note":{"inner":{"__proto__":1}}}');
    expect(validateTask(testDeps().registries, declaration(input)).exit).toBe("validation_failed");
    expect(forbidden(input)).toEqual([
      { area: "input", path: ["note", "inner", "__proto__"], code: "input_forbidden_key" },
    ]);
  });

  it("Edge: 배열 안 객체의 own __proto__ 는 경로에 색인을 싣는다 (test_SC054_array_nested_proto_key_path)", () => {
    expect(forbidden(protoInput('{"note":[{"ok":1},{"__proto__":1}]}'))).toEqual([
      { area: "input", path: ["note", 1, "__proto__"], code: "input_forbidden_key" },
    ]);
  });

  it("Error: 대조 — __proto__ 가 값이면 검증을 통과한다 (test_SC054_proto_string_value_passes)", () => {
    const result = validateTask(testDeps().registries, declaration({ note: "__proto__" }));
    expect(result.exit).toBe("valid");
  });
});

describe("SC-055: 실패 attempt 이슈는 외톨이 surrogate 키에서도 정규 JSON 이다", () => {
  it("Happy: 출력 data 키의 외톨이 surrogate 는 정규화된 위치로 기록되고 페이로드가 정규 JSON 이다 (test_SC055_output_data_lone_surrogate_payload_canonical)", () => {
    const { commit, after, taskId } = recordOutcome({
      kind: "completed",
      evidence: {},
      outputs: { data: { "\uD800": 1 } },
    });
    expect(requireTaskFor(after, taskId).state).toBe("FAILED");
    expect(failedIssues(commit)).toEqual([
      { code: "outputs_not_json", reason: "lone_surrogate", path: ["data", "�"] },
    ]);
    expectCanonical(commit);
  });

  it("Edge: 출력 이름 자체의 외톨이 surrogate 도 같다 (test_SC055_output_name_lone_surrogate_payload_canonical)", () => {
    const { commit } = recordOutcome({
      kind: "completed",
      evidence: {},
      outputs: { "sum\uDC00": "x" },
    });
    expect(failedIssues(commit)).toEqual([
      { code: "outputs_not_json", reason: "lone_surrogate", path: ["sum�"] },
    ]);
    expectCanonical(commit);
  });

  it("Error: evidence 키의 외톨이 surrogate 는 evidence_not_json 으로 같다 (test_SC055_evidence_lone_surrogate_payload_canonical)", () => {
    const { commit } = recordOutcome({ kind: "completed", evidence: { "\uD800": 1 } });
    expect(failedIssues(commit)).toEqual([
      { code: "evidence_not_json", reason: "lone_surrogate", path: ["�"] },
    ]);
    expectCanonical(commit);
  });
});

describe("SC-056: 무효 제안 grant 는 저장 순서대로 정렬된 커밋 목록 하나로 두 커밋을 낸다", () => {
  /** 대기 제안 본문의 제목만 바꿔 grant 재검증이 무효인 WAITING_APPROVAL Work. */
  function drifted() {
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    const held = heldOf(aggregate);
    const [first, ...rest] = held.tasks;
    if (first === undefined) throw new Error("expected draft");
    return {
      deps,
      aggregate: patchWork(aggregate, {
        pendingProposal: { ...held, tasks: [{ ...first, title: "drifted" }, ...rest] },
      }),
    };
  }

  it("Happy: commits 는 [철회, 낡음] 이고 preceding 이 없으며 순서대로 적용하면 aggregate 다 (test_SC056_invalid_grant_ordered_commits)", () => {
    const { deps, aggregate } = drifted();
    const judged = grant(deps, aggregate);
    expect(judged.kind).toBe("stale_after_withdrawal");
    if (judged.kind !== "stale_after_withdrawal") return;
    expect("preceding" in judged).toBe(false);
    expect(judged.commits).toHaveLength(2);
    const [withdrawal, stale] = judged.commits;
    expect(eventTypes(withdrawal)).toEqual(["work_plan_withdrawn"]);
    expect(eventTypes(stale)).toEqual(["signal_rejected_stale"]);
    expect(evolveCommit(evolveCommit(aggregate, withdrawal.events), stale.events)).toEqual(
      judged.aggregate,
    );
  });

  it("Edge: 둘째 커밋은 첫 커밋을 적용한 상태를 기준으로 token_mismatch 를 기록한다 (test_SC056_second_commit_based_on_first)", () => {
    const { deps, aggregate } = drifted();
    const judged = grant(deps, aggregate);
    if (judged.kind !== "stale_after_withdrawal") throw new Error(`got ${judged.kind}`);
    expect(judged.reason).toBe("token_mismatch");
    const [withdrawal, stale] = judged.commits;
    const afterWithdrawal = evolveCommit(aggregate, withdrawal.events);
    expect(afterWithdrawal.work.state).toBe("PLANNING");
    const recorded = payloadOf(stale, "signal_rejected_stale");
    expect(recorded["observedState"]).toBe(afterWithdrawal.work.state);
    expect(recorded["currentRevision"]).toBe(afterWithdrawal.work.revision);
    expect(recorded["currentRevision"]).not.toBe(aggregate.work.revision);
  });

  it("Error: 대조 — 유효 제안 grant 는 accepted 커밋 하나다 (test_SC056_valid_grant_single_accepted)", () => {
    const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
    const judged = grant(deps, aggregate);
    expect(judged.kind).toBe("accepted");
    expect("commits" in judged).toBe(false);
  });
});

describe("계획 사전 거절은 호출마다 새 거절 값을 돌려준다", () => {
  it("Error: 받은 거절 객체를 바꿔도 다음 거절은 원래 값이다", () => {
    const { aggregate } = reachWorkState("PLANNING");
    const first = planPreconditionRejection(aggregate.work, "not a plan" as never);
    if (first === undefined) throw new Error("expected precondition rejection");
    (first as { detail?: string }).detail = "changed by caller";
    (first as { reason: string }).reason = "condition_not_met";
    const second = planPreconditionRejection(aggregate.work, "not a plan" as never);
    expect(second).toEqual({ reason: "invalid_input", detail: "plan 이 객체가 아님" });
    expect(second).not.toBe(first);
  });

  it("Edge: 명령 경로의 거절도 앞선 거절 객체를 바꾼 영향을 받지 않는다", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const propose = (): CommandOutcome =>
      executeCommand(deps, aggregate, {
        kind: "propose_plan",
        expectedRevision: aggregate.work.revision,
        meta: meta(NOW),
        plan: planInput([draft("a")], { basePlanRevision: aggregate.work.planRevision + 1 }),
        summary: "stale base",
      });
    const first = propose();
    if (first.kind !== "rejected") throw new Error(`expected rejected, got ${first.kind}`);
    (first.rejection as { detail?: string }).detail = "changed by caller";
    const second = propose();
    expect(second).toMatchObject({
      kind: "rejected",
      rejection: {
        reason: "condition_not_met",
        detail: "basePlanRevision 이 Work.planRevision 과 다름",
      },
    });
  });
});

describe("blocked 결과의 주차 원인은 blocked 원인 표로만 조회한다", () => {
  function report(outcome: unknown): CommandOutcome {
    const { deps, aggregate, taskId } = reachTaskState("RUNNING");
    const task = requireTaskFor(aggregate, taskId);
    const attemptId = task.openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    return executeCommand(deps, aggregate, {
      kind: "record_attempt_outcome",
      taskId,
      expectedRevision: task.revision,
      meta: meta(NOW),
      attemptId,
      outcome: (typeof outcome === "function"
        ? (outcome as (d: DomainDeps, t: TaskId) => unknown)(deps, taskId)
        : outcome) as never,
    });
  }

  it("Error: 결과 종류 이름을 원인으로 적은 blocked 결과는 dead-letter 결정이어도 커밋 없이 거절된다", () => {
    for (const cause of ["dispatch_orphaned", "dispatch_withdrawn", "effect_dead_lettered"]) {
      expect(
        report((deps: DomainDeps, taskId: TaskId) => ({
          kind: "blocked",
          cause,
          decision: deadLetterDecision(deps, taskId, NOW),
        })),
        cause,
      ).toEqual({
        kind: "rejected",
        rejection: { reason: "invalid_input", detail: "주차 원인과 결정 종류가 맞지 않음" },
      });
    }
  });

  it("Happy: 대조 — blocked 원인 표 안의 세 원인은 그 원인으로 주차한다", () => {
    for (const cause of ["gate_denied", "executor_blocked", "dispatcher_refused"]) {
      const outcome = report((deps: DomainDeps, taskId: TaskId) => ({
        kind: "blocked",
        cause,
        decision: {
          ...taskSubjectPendingDecision(deps, taskId, NOW),
          kind: "tool_permission_denied_unattended",
        },
      }));
      const { commit } = mustCommit(outcome);
      expect(payloadOf(commit, "task_awaiting_human")["cause"], cause).toBe(cause);
    }
  });

  it("Edge: 대조 — blocked 밖 effect_dead_lettered 결과는 결과 종류 표로 그 원인에 주차한다", () => {
    const outcome = report((deps: DomainDeps, taskId: TaskId) => ({
      kind: "effect_dead_lettered",
      decision: deadLetterDecision(deps, taskId, NOW),
    }));
    const { commit } = mustCommit(outcome);
    expect(payloadOf(commit, "task_awaiting_human")["cause"]).toBe("effect_dead_lettered");
  });
});

describe("계획 초안의 title·draftRef 가 문자열이 아니면 초안 틀 위반으로 사전 거절된다", () => {
  const frameRejection = { reason: "invalid_input", detail: "계획 초안 틀이 아님" };

  it("Error: 숫자 title 과 숫자 draftRef 는 각각 초안 틀 위반이다", () => {
    const { aggregate } = reachWorkState("PLANNING");
    for (const broken of [
      { ...draft("a"), title: 7 },
      { ...draft("a"), draftRef: 1 },
      { ...draft("a"), title: undefined },
    ]) {
      expect(
        planPreconditionRejection(aggregate.work, planInput([broken as never])),
        JSON.stringify(broken),
      ).toEqual(frameRejection);
    }
    expect(planPreconditionRejection(aggregate.work, planInput([draft("a")]))).toBeUndefined();
  });

  it("Edge: 명령 경로 propose_plan 은 숫자 title 초안을 커밋 없이 거절한다", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const outcome = executeCommand(deps, aggregate, {
      kind: "propose_plan",
      expectedRevision: aggregate.work.revision,
      meta: meta(NOW),
      plan: planInput([{ ...draft("a"), title: 7 } as never], {
        basePlanRevision: aggregate.work.planRevision,
      }),
      summary: "numeric title",
    });
    expect(outcome).toEqual({ kind: "rejected", rejection: frameRejection });
  });
});

describe("Work 생성 출처는 종류 열거와 종류별 필드 형을 검사한다", () => {
  function createWith(seed: string, source: unknown): CommandOutcome {
    return createWork(testDeps(seed), {
      kind: "create_work",
      meta: meta(NOW),
      projectId: mustOk(parseProjectId("prj_smallitems01")),
      title: "source shape",
      objective: "source shape",
      source: source as never,
    });
  }
  const malformed = {
    kind: "rejected",
    rejection: { reason: "invalid_input", detail: "work_source_malformed" },
  };

  it("Error: 알 수 없는 종류·종류 없음·종류별 필드 형 위반은 work_source_malformed 다", () => {
    const sources: readonly unknown[] = [
      { kind: "email" },
      { kind: "email", documentId: "doc-1" },
      { kind: "email", causingTaskId: "tsk_srccause0001" },
      { kind: "toString" },
      {},
      { kind: "markdown" },
      { kind: "markdown", documentId: 7 },
      { kind: "spawn" },
      { kind: "spawn", causingTaskId: 1 },
    ];
    for (const source of sources) {
      expect(createWith("srcbad", source), JSON.stringify(source)).toEqual(malformed);
    }
  });

  it("Edge: 정의 회차 출처는 기존 상세 그대로 거절된다", () => {
    expect(createWith("srcdef", { kind: "definition_occurrence" })).toEqual({
      kind: "rejected",
      rejection: {
        reason: "invalid_input",
        detail: "definition_occurrence_by_materialization_only",
      },
    });
  });

  it("Happy: 대조 — 형이 맞는 세 종류는 커밋된다", () => {
    for (const source of [
      { kind: "cli" },
      { kind: "markdown", documentId: "doc-1" },
      { kind: "spawn", causingTaskId: "tsk_srccause0001" },
    ]) {
      const { aggregate } = mustCommit(createWith("srcok", source));
      expect(aggregate.work.source, source.kind).toEqual(source);
    }
  });
});
