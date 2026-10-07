// SC-007, SC-008, SC-032, SC-036 — 계획 커밋의 부모 그래프·초안 검증(전부 아니면 0).
import { describe, expect, it } from "vitest";
import {
  executeCommand,
  judgeSignal,
  validatePlanDrafts,
} from "../../../src/workflow/domain/index.js";
import type {
  DecisionSignal,
  PlanTaskDraft,
  TaskPolicy,
} from "../../../src/workflow/domain/index.js";
import {
  at,
  meta,
  basePolicy,
  draft,
  entityId,
  planned,
  mustCommit,
  planInput,
  proposePlan,
  applyCommits,
  committedChain,
  reachWorkState,
  requireTaskFor,
  testDeps,
  UNREGISTERED_TASK_TYPE,
} from "./helpers/fixtures.js";
import { eventTypes, payloadOf } from "./helpers/commits.js";
import { probeTaskType, testRegistries } from "./helpers/registry-fixtures.js";

const NOW = at("2026-01-01T00:00:00Z");
const ACTOR = { kind: "user", id: "u1" };

interface Issue {
  readonly kind: string;
  readonly draftRef?: string;
  readonly draftRefs?: readonly string[];
  readonly reason?: Record<string, unknown>;
}

function commitPlan(drafts: readonly PlanTaskDraft[], onInvalid?: "stay_planning" | "fail_work") {
  const { deps, aggregate } = reachWorkState("PLANNING");
  const outcome = executeCommand(deps, aggregate, {
    kind: "commit_plan",
    expectedRevision: aggregate.work.revision,
    meta: meta(NOW),
    ...(onInvalid !== undefined ? { onInvalid } : {}),
    plan: {
      basePlanRevision: aggregate.work.planRevision,
      source: "planner",
      tasks: drafts,
      retain: [],
    },
  });
  if (outcome.kind !== "committed")
    throw new Error(`expected plan commit outcome, got ${outcome.kind}`);
  const issues = eventTypes(outcome.commit).includes("work_plan_invalid")
    ? (payloadOf(outcome.commit, "work_plan_invalid")["issues"] as readonly Issue[])
    : [];
  return { commit: outcome.commit, aggregate: outcome.aggregate, issues };
}

function confirmationDraft(ref: string, policy: Partial<TaskPolicy>): PlanTaskDraft {
  return draft(ref, {
    type: { id: "confirmation", version: 1 },
    input: { prompt: "Ship?", targetActor: ACTOR, allowedDecisions: ["accept"] },
    policy: basePolicy(policy),
  });
}

function notificationDraft(ref: string, policy: Partial<TaskPolicy>): PlanTaskDraft {
  return draft(ref, {
    type: { id: "notification", version: 1 },
    input: { target: "owner", message: "Done", importance: "high" },
    policy: basePolicy(policy),
  });
}

describe("SC-007: 부모 순환과 자기 부모는 커밋 전에 거절된다", () => {
  it("Happy: 부모 2-순환은 parent_cycle 로 거절되고 Task 가 없다 (test_SC007_parent_two_cycle_rejected_no_task)", () => {
    const { commit, aggregate, issues } = commitPlan([
      draft("A", { parent: { draftRef: "B" } }),
      draft("B", { parent: { draftRef: "A" } }),
    ]);
    expect(issues).toContainEqual({ kind: "parent_cycle", draftRefs: ["A", "B"] });
    expect(eventTypes(commit)).not.toContain("task_created");
    expect(aggregate.work.state).toBe("PLANNING");
  });

  it("Edge: 자기 부모는 self_parent 로 거절된다 (test_SC007_self_parent_rejected)", () => {
    const { commit, issues } = commitPlan([draft("A", { parent: { draftRef: "A" } })]);
    expect(issues).toContainEqual({ kind: "self_parent", draftRef: "A" });
    expect(eventTypes(commit)).not.toContain("task_created");
  });

  it("Error: member 가 아닌 부모는 unknown_parent 로 거절된다 (test_SC007_unknown_parent_rejected)", () => {
    const stranger = entityId("task", "tsk_notamember01");
    const { commit, issues } = commitPlan([draft("A", { parent: { taskId: stranger } })]);
    expect(issues).toContainEqual({
      kind: "unknown_parent",
      draftRef: "A",
      ref: { taskId: stranger },
    });
    expect(eventTypes(commit)).not.toContain("task_created");
  });
});

describe("SC-008: 부모 간선은 의존 판정에 참여하지 않는다", () => {
  it("Happy: 부모 간선이 있는 계획이 커밋되고 자식은 의존 충족만으로 활성화된다 (test_SC008_parent_edge_commit_dependency_only_satisfaction)", () => {
    const deps = testDeps("sc008");
    const { aggregate, taskIds } = planned(
      [
        draft("parent"),
        draft("dep"),
        draft("child", {
          parent: { draftRef: "parent" },
          dependsOn: [{ draftRef: "dep" }],
          trigger: { kind: "dependencies_complete", version: 1, triggerId: "child" },
        }),
      ],
      deps,
    );
    const parentId = taskIds["parent"];
    const depId = taskIds["dep"];
    const childId = taskIds["child"];
    if (parentId === undefined || depId === undefined || childId === undefined)
      throw new Error("expected three tasks");
    expect(requireTaskFor(aggregate, childId).parentTaskId).toBe(parentId);

    let current = aggregate;
    const run = (
      taskId: typeof childId,
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
    run(childId, "begin_validation");
    run(childId, "complete_validation");
    expect(requireTaskFor(current, childId).state).toBe("READY");
    expect(requireTaskFor(current, childId).dependencyActivated).toBe(false);

    run(depId, "begin_validation");
    run(depId, "complete_validation");
    run(depId, "start_attempt");
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
    expect(completed.kind).toBe("committed");
    if (completed.kind !== "committed") return;
    expect(requireTaskFor(completed.aggregate, parentId).state).toBe("DRAFT");
    const child = requireTaskFor(completed.aggregate, childId);
    expect(child.dependencyActivated).toBe(true);
    expect(child.state).toBe("SCHEDULED");
    const scheduled = completed.commit.events.find(
      (e) => e.type === "task_scheduled" && e.taskId === childId,
    );
    expect((scheduled?.payload as { cause?: string } | undefined)?.cause).toBe(
      "dependency_satisfaction",
    );
  });

  it("Edge: 현재 member 를 부모로 지목한 초안은 그래프 이슈가 없다 (test_SC008_current_member_parent_resolves)", () => {
    const member = entityId("task", "tsk_currentmember1");
    expect(validatePlanDrafts([draft("child", { parent: { taskId: member } })], [member])).toEqual(
      [],
    );
  });

  it("Error: 의존 순환 검출은 부모로만 이어진 초안을 넣지 않는다 (test_SC008_dependency_cycle_ignores_parent_edges)", () => {
    const issues = validatePlanDrafts(
      [
        draft("D1", { dependsOn: [{ draftRef: "D2" }], parent: { draftRef: "X" } }),
        draft("D2", { dependsOn: [{ draftRef: "D1" }] }),
        draft("X", { parent: { draftRef: "D1" } }),
      ],
      [],
    ) as readonly Issue[];
    const dependencyCycles = issues.filter((i) => i.kind === "dependency_cycle");
    expect(dependencyCycles).toEqual([{ kind: "dependency_cycle", draftRefs: ["D1", "D2"] }]);
    expect(issues).toContainEqual({ kind: "parent_cycle", draftRefs: ["D1", "X"] });
  });
});

describe("SC-032: 계획의 한 초안이라도 검증에 실패하면 아무것도 커밋되지 않는다", () => {
  it("Happy: 미등록 유형 초안 하나가 계획 전체를 무효로 만든다 (test_SC032_unregistered_draft_plan_invalid_no_task)", () => {
    const { commit, aggregate, issues } = commitPlan([
      draft("ok1"),
      draft("ok2"),
      draft("missing", { type: UNREGISTERED_TASK_TYPE }),
    ]);
    expect(issues).toContainEqual({
      kind: "draft_invalid",
      draftRef: "missing",
      reason: {
        kind: "descriptor_unknown",
        descriptors: [{ axis: "task_type", id: "probe_missing", version: 1 }],
      },
    });
    expect(eventTypes(commit)).not.toContain("task_created");
    expect(Object.keys(aggregate.tasks)).toEqual([]);
    expect(aggregate.work.state).toBe("PLANNING");
  });

  it("Edge: 범위 밖 채널 선언 초안도 계획을 무효로 만든다 (test_SC032_refused_surface_draft_plan_invalid)", () => {
    const { commit, issues } = commitPlan([
      draft("ok"),
      notificationDraft("noisy", {
        approvalSurface: "out_of_band",
        approvalRequiredBeforeExecute: false,
      }),
    ]);
    const invalid = issues.find((i) => i.kind === "draft_invalid" && i.draftRef === "noisy");
    expect(invalid?.reason?.["kind"]).toBe("approval_surface_refused");
    expect(eventTypes(commit)).not.toContain("task_created");
  });

  it("Error: onInvalid fail_work 은 work_failed 를 붙이고 Task 를 만들지 않는다 (test_SC032_fail_work_option_no_task)", () => {
    const { commit, aggregate } = commitPlan(
      [draft("ok"), draft("missing", { type: UNREGISTERED_TASK_TYPE })],
      "fail_work",
    );
    expect(eventTypes(commit)).toEqual(
      expect.arrayContaining(["work_plan_invalid", "work_failed"]),
    );
    expect(eventTypes(commit)).not.toContain("task_created");
    expect(aggregate.work.state).toBe("FAILED");
  });
});

describe("SC-036: 범위 밖 선언을 실은 계획 제안은 커밋되지 않는다", () => {
  it("Happy: 외부 채널 확인 초안은 effect_records_only 로 무효다 (test_SC036_confirmation_draft_plan_invalid)", () => {
    const { issues } = commitPlan([
      confirmationDraft("confirm", {
        approvalSurface: "out_of_band",
        approvalRequiredBeforeExecute: true,
      }),
    ]);
    expect(issues).toContainEqual({
      kind: "draft_invalid",
      draftRef: "confirm",
      reason: {
        kind: "approval_surface_refused",
        reason: "effect_records_only",
        declaredSurface: "out_of_band",
      },
    });
  });

  it("Edge: 실행 전 승인 없는 외부 채널 알림 초안은 no_pre_execution_approval 로 무효다 (test_SC036_notification_draft_plan_invalid)", () => {
    const { issues } = commitPlan([
      notificationDraft("notify", {
        approvalSurface: "out_of_band",
        approvalRequiredBeforeExecute: false,
      }),
    ]);
    expect(issues).toContainEqual({
      kind: "draft_invalid",
      draftRef: "notify",
      reason: {
        kind: "approval_surface_refused",
        reason: "no_pre_execution_approval",
        declaredSurface: "out_of_band",
      },
    });
  });

  it("Error: 두 계획 모두 task_created 가 0 건이다 (test_SC036_no_task_created)", () => {
    for (const offending of [
      confirmationDraft("confirm", {
        approvalSurface: "out_of_band",
        approvalRequiredBeforeExecute: true,
      }),
      notificationDraft("notify", {
        approvalSurface: "out_of_band",
        approvalRequiredBeforeExecute: false,
      }),
    ]) {
      const { commit, aggregate } = commitPlan([draft("ok"), offending]);
      expect(eventTypes(commit)).not.toContain("task_created");
      expect(Object.keys(aggregate.tasks)).toEqual([]);
    }
  });
});

describe("SC-032: 계획 승인 grant 의 재검증 무효는 철회 뒤 낡음으로 기록되고 키를 선점하지 않는다", () => {
  it("Error: 무효가 된 대기 제안의 grant 는 철회 커밋 뒤 rejected_stale 이고, 같은 결정의 다음 grant 도 rejected_stale 이다 (test_SC032_plan_grant_invalid_revalidation_withdrawn_then_stale_no_key)", () => {
    const { deps, aggregate: planning } = reachWorkState("PLANNING");
    // 등록부 drift 대용: 제안 시점에만 시험 유형을 등록한 등록부로 판정하고, grant 는 원래 등록부로 판정한다.
    const proposingDeps = { ...deps, registries: testRegistries({ taskTypes: [probeTaskType()] }) };
    const probeDraft = draft("probe", {
      type: { id: probeTaskType().id, version: probeTaskType().version },
      input: { subject: "drift" },
    });
    const aggregate = proposePlan(proposingDeps, planning, planInput([probeDraft]));
    const decisionId = aggregate.work.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected pending plan approval");
    const grant = (signalId: string): DecisionSignal => ({
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: entityId("signal", signalId),
      expectedRevision: aggregate.work.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    });

    const judged = judgeSignal(
      deps,
      aggregate,
      grant("sig_plangrantbad1"),
      { kind: "plan_grant" },
      NOW,
    );
    expect(judged.kind).toBe("rejected_stale");
    if (judged.kind !== "rejected_stale") return;
    const preceding = judged.preceding;
    if (preceding === undefined) throw new Error("expected preceding withdrawal commit");
    expect(eventTypes(preceding.commit)).toEqual(["work_plan_withdrawn"]);
    expect(payloadOf(preceding.commit, "work_plan_withdrawn")["cause"]).toBe("no_longer_validates");
    expect(eventTypes(judged.commit)).toEqual(["signal_rejected_stale"]);
    expect(eventTypes(judged.commit)).not.toContain("work_plan_committed");
    expect(preceding.aggregate.work.state).toBe("PLANNING");
    expect(preceding.aggregate.acceptedSignalKeys).toEqual(aggregate.acceptedSignalKeys);

    const after = applyCommits(aggregate, committedChain(judged));
    expect(after.work.state).toBe("PLANNING");
    expect(after.acceptedSignalKeys).toEqual(aggregate.acceptedSignalKeys);
    const again = judgeSignal(deps, after, grant("sig_plangrantbad2"), { kind: "plan_grant" }, NOW);
    expect(again.kind).toBe("rejected_stale");
  });
});

describe("SC-032: 직접 계획 커밋은 무효면 항상 work_plan_invalid 를 커밋한다", () => {
  it("Error: 타입 밖 onInvalid reject 를 실은 commit_plan 도 무효 계획을 work_plan_invalid 로 커밋하고 PLANNING 에 머문다 (test_SC032_commit_plan_untyped_reject_still_commits_plan_invalid)", () => {
    const invalidDrafts = [draft("a", { parent: { draftRef: "a" } })];
    // 런타임 방어 시험: "reject" 는 신호 grant 경로 전용이라 명령 타입에 없다.
    const { commit, aggregate, issues } = commitPlan(
      invalidDrafts,
      "reject" as unknown as "stay_planning",
    );
    expect(eventTypes(commit)).toContain("work_plan_invalid");
    expect(eventTypes(commit)).not.toContain("task_created");
    expect(eventTypes(commit)).not.toContain("work_failed");
    expect(issues).toEqual(validatePlanDrafts(invalidDrafts, []));
    expect(aggregate.work.state).toBe("PLANNING");

    const failWork = commitPlan(invalidDrafts, "fail_work");
    expect(eventTypes(failWork.commit)).toEqual(
      expect.arrayContaining(["work_plan_invalid", "work_failed"]),
    );
  });
});
