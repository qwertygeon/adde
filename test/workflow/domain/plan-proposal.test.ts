// SC-022~SC-035 — 계획 제안 digest·ID·기준 revision·보유 내용·보존/참조 검증·필수 member·필수 승인·
// 승인 결정·재검증 철회·무효 grant·미지원 제안.
import { describe, expect, it } from "vitest";
import * as domain from "../../../src/workflow/domain/index.js";
import {
  executeCommand,
  judgeMandatoryPlanApproval,
  judgeSignal,
  validatePlanProposal,
} from "../../../src/workflow/domain/index.js";
import type {
  CommandOutcome,
  DecisionApplication,
  DomainDeps,
  GeneratedIdKind,
  PlanTaskDraft,
  TaskId,
  TaskRef,
  WorkAggregate,
  WorkCommand,
} from "../../../src/workflow/domain/index.js";
import {
  applyCommits,
  basePolicy,
  committedChain,
  draft,
  entityId,
  meta,
  patchWork,
  planInput,
  reachWorkState,
  testDeps,
  UNREGISTERED_TASK_TYPE,
} from "./helpers/fixtures.js";
import {
  PROBE_CONSUMER_TASK_TYPE,
  PROBE_PRODUCER_TASK_TYPE,
  probeTaskType,
  testRegistries,
} from "./helpers/registry-fixtures.js";
import { eventTypes, payloadOf } from "./helpers/commits.js";
import {
  Journal,
  NOW,
  confirmationDraft,
  beginConfirmation,
  complete,
  confirmationSignal,
  dependencyTrigger,
  fail,
  independentDigest,
  nonRequiredPolicy,
  planDecision,
  replanSignal,
  runToCompleted,
  skip,
  start,
  startJournal,
  taskEventTypes,
  taskPayload,
  validate,
} from "./helpers/scenario.js";

type Plan = ReturnType<typeof planInput>;

function commitPlanOn(deps: DomainDeps, aggregate: WorkAggregate, plan: Plan): CommandOutcome {
  return executeCommand(deps, aggregate, {
    kind: "commit_plan",
    expectedRevision: aggregate.work.revision,
    meta: meta(NOW),
    plan,
  });
}

function proposePlanOn(deps: DomainDeps, aggregate: WorkAggregate, plan: Plan): CommandOutcome {
  return executeCommand(deps, aggregate, {
    kind: "propose_plan",
    expectedRevision: aggregate.work.revision,
    meta: meta(NOW),
    plan,
    summary: "plan approval",
  });
}

function committedCommit(outcome: CommandOutcome) {
  if (outcome.kind !== "committed") throw new Error(`expected committed, got ${outcome.kind}`);
  return { commit: outcome.commit, aggregate: outcome.aggregate };
}

interface Issue {
  readonly kind: string;
  readonly [key: string]: unknown;
}

function invalidIssues(outcome: CommandOutcome): readonly Issue[] {
  const { commit } = committedCommit(outcome);
  expect(eventTypes(commit)).toContain("work_plan_invalid");
  expect(eventTypes(commit)).not.toContain("task_created");
  return payloadOf(commit, "work_plan_invalid")["issues"] as readonly Issue[];
}

function expectNoCommitRefusal(outcome: CommandOutcome, reason: string, detail?: string): void {
  expect(outcome.kind).toBe("rejected");
  if (outcome.kind !== "rejected") return;
  expect(outcome.rejection.reason).toBe(reason);
  if (detail !== undefined) expect(outcome.rejection.detail).toBe(detail);
  expect(committedChain(outcome)).toEqual([]);
}

/** 발급된 ID 를 순서대로 기록하는 생성기 — 도메인이 어느 종류를 어떤 순서로 소비했는지 본다. */
function recordingDeps(deps: DomainDeps): {
  deps: DomainDeps;
  issued: [GeneratedIdKind, string][];
} {
  const issued: [GeneratedIdKind, string][] = [];
  return {
    issued,
    deps: {
      ...deps,
      ids: {
        next(kind: GeneratedIdKind): string {
          const value = deps.ids.next(kind);
          issued.push([kind, value]);
          return value;
        },
      },
    },
  };
}

/** 한 member(즉시 Trigger) READY 인 ACTIVE Work 에서 재계획을 연 상태. */
function replanOpenWork(seed: string, drafts: readonly PlanTaskDraft[] = [draft("member")]) {
  const { journal, ids } = startJournal(drafts, testDeps(seed));
  for (const d of drafts) validate(journal, ids[d.draftRef] as TaskId);
  journal.apply(replanSignal(journal));
  expect(journal.aggregate.work.state).toBe("PLANNING");
  return { journal, ids, id: (ref: string) => ids[ref] as TaskId };
}

function replanPlan(
  journal: Journal,
  retain: readonly TaskId[],
  tasks: readonly PlanTaskDraft[] = [],
) {
  return planInput(tasks, { basePlanRevision: journal.aggregate.work.planRevision, retain });
}

const PRODUCER = { id: PROBE_PRODUCER_TASK_TYPE.id, version: PROBE_PRODUCER_TASK_TYPE.version };
const CONSUMER = { id: PROBE_CONSUMER_TASK_TYPE.id, version: PROBE_CONSUMER_TASK_TYPE.version };

/** 결합 시험 유형(생산자·소비자)을 등록한 deps. */
function bindingDeps(seed: string): DomainDeps {
  return testDeps(
    seed,
    testRegistries({ taskTypes: [PROBE_PRODUCER_TASK_TYPE, PROBE_CONSUMER_TASK_TYPE] }),
  );
}

describe("SC-022: 제안 digest 는 내용으로만 정해진다", () => {
  const KEY_ORDER_A: PlanTaskDraft = {
    draftRef: "ask",
    type: { id: "confirmation", version: 1 },
    title: "Ask",
    input: {
      prompt: "Proceed?",
      targetActor: { kind: "user", id: "u1" },
      allowedDecisions: ["accept", "reject"],
    },
    dependsOn: [],
    trigger: { kind: "immediate", version: 1, triggerId: "ask" },
    policy: basePolicy(),
  };
  // 같은 내용, 객체 키 순서만 다르다(초안·입력·중첩 객체).
  const KEY_ORDER_B = {
    policy: basePolicy(),
    trigger: { triggerId: "ask", version: 1, kind: "immediate" },
    dependsOn: [],
    input: {
      allowedDecisions: ["accept", "reject"],
      targetActor: { id: "u1", kind: "user" },
      prompt: "Proceed?",
    },
    title: "Ask",
    type: { version: 1, id: "confirmation" },
    draftRef: "ask",
  } as unknown as PlanTaskDraft;

  function proposedDigest(drafts: readonly PlanTaskDraft[]): string {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const { commit } = committedCommit(proposePlanOn(deps, aggregate, planInput(drafts)));
    return String(payloadOf(commit, "work_plan_proposed")["digest"]);
  }

  it("Happy: 키 순서만 다른 두 계획 출력의 digest 가 같다 (test_SC022_key_order_does_not_change_digest)", () => {
    expect(proposedDigest([KEY_ORDER_A])).toBe(proposedDigest([KEY_ORDER_B]));
  });

  it("Edge: 초안 하나의 제목만 다르면 digest 가 다르다 (test_SC022_title_change_changes_digest)", () => {
    expect(proposedDigest([KEY_ORDER_A])).not.toBe(
      proposedDigest([{ ...KEY_ORDER_A, title: "Asl" }]),
    );
  });

  it("Error: digest 가 제안 내용(id·digest 제외)의 독립 정규 JSON sha256 과 같다 (test_SC022_digest_equals_independent_canonical_sha256)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const { commit } = committedCommit(
      proposePlanOn(deps, aggregate, planInput([KEY_ORDER_A, draft("second")])),
    );
    const payload = payloadOf(commit, "work_plan_proposed");
    const content = { ...(payload["proposal"] as Record<string, unknown>) };
    const digest = content["digest"];
    delete content["id"];
    delete content["digest"];
    expect(Object.keys(content).sort()).toEqual(
      ["basePlanRevision", "retain", "source", "tasks", "workId"].sort(),
    );
    expect(content["workId"]).toBe(aggregate.work.id);
    expect(digest).toBe(payload["digest"]);
    expect(digest).toBe(independentDigest(content));
    // 정규 JSON 이 될 수 없는 내용(고립 서러게이트 제목)은 digest 를 만들지 않고 계획 무효다.
    const notCanonical = committedCommit(
      commitPlanOn(deps, aggregate, planInput([{ ...KEY_ORDER_A, title: "broken \uD800" }])),
    );
    const issues = payloadOf(notCanonical.commit, "work_plan_invalid")[
      "issues"
    ] as readonly Issue[];
    expect(issues.map((i) => i.kind)).toContain("proposal_not_canonical_json");
    expect(eventTypes(notCanonical.commit)).not.toContain("task_created");
  });

  it("Error: 정규 JSON 이 될 수 없는 계획 내용은 사전 거절을 지난 뒤에만 proposal_not_canonical_json 하나로 무효다 (test_SC022_non_canonical_plan_content_invalid_only_after_preconditions)", () => {
    const fn = (): string => "not data";
    const withFunction = (extra?: { basePlanRevision?: number; definition?: unknown }) =>
      planInput([draft("x", { input: { note: fn } })], extra);
    const commitWith = (plan: Plan, onInvalid?: "fail_work") => {
      const { deps, aggregate } = reachWorkState("PLANNING");
      const outcome = executeCommand(deps, aggregate, {
        kind: "commit_plan",
        expectedRevision: aggregate.work.revision,
        meta: meta(NOW),
        plan,
        ...(onInvalid !== undefined ? { onInvalid } : {}),
      });
      return { outcome, aggregate };
    };
    const ONLY_ISSUE = [
      { kind: "proposal_not_canonical_json", path: ["tasks", 0, "input", "note"] },
    ];

    const stay = commitWith(withFunction());
    expect(invalidIssues(stay.outcome)).toEqual(ONLY_ISSUE);
    const stayed = committedCommit(stay.outcome);
    expect(eventTypes(stayed.commit)).not.toContain("work_failed");
    expect(stayed.aggregate.work.state).toBe("PLANNING");

    const failed = commitWith(withFunction(), "fail_work");
    expect(invalidIssues(failed.outcome)).toEqual(ONLY_ISSUE);
    const failedCommit = committedCommit(failed.outcome);
    expect(eventTypes(failedCommit.commit)).toEqual(["work_plan_invalid", "work_failed"]);
    expect(failedCommit.aggregate.work.state).toBe("FAILED");

    // 같은 비JSON 내용이라도 사전 거절 사유가 있으면 기록 없이 거절된다.
    for (const [extra, reason] of [
      [{ basePlanRevision: 3 }, "condition_not_met"],
      [{ definition: { title: "slot" } }, "unsupported_in_this_phase"],
    ] as const) {
      for (const onInvalid of [undefined, "fail_work"] as const) {
        const refused = commitWith(withFunction(extra), onInvalid);
        expectNoCommitRefusal(refused.outcome, reason);
      }
    }

    // 대조: 함수 값만 뺀 같은 계획은 커밋된다.
    const plain = commitWith(planInput([draft("x", { input: {} })]));
    expect(eventTypes(committedCommit(plain.outcome).commit)).toContain("work_plan_committed");
  });
});

describe("SC-023: 제안 ID 는 주입 생성기에서 오고 이벤트가 ID·digest 를 싣는다", () => {
  it("Happy: 제안의 pln_ ID 가 생성기 값이고 work_plan_proposed·work_plan_committed 가 같은 ID·digest 를 싣는다 (test_SC023_proposal_id_from_injected_generator_on_proposed_and_committed)", () => {
    const { deps: base, aggregate } = reachWorkState("PLANNING");
    const { deps, issued } = recordingDeps(base);
    const { commit: proposed, aggregate: waiting } = committedCommit(
      proposePlanOn(deps, aggregate, planInput([draft("a"), draft("b")])),
    );
    const issuedProposal = issued.find(([kind]) => kind === "planProposal")?.[1];
    expect(issuedProposal).toMatch(/^pln_/);
    expect(issued.slice(0, 2).map(([kind]) => kind)).toEqual(["planProposal", "decision"]);
    const proposedPayload = payloadOf(proposed, "work_plan_proposed");
    expect(proposedPayload["proposalId"]).toBe(issuedProposal);
    expect((proposedPayload["proposal"] as Record<string, unknown>)["id"]).toBe(issuedProposal);
    const journal = new Journal(deps, waiting, []);
    const granted = journal.apply(planDecision(journal, "grant"));
    const committedPayload = payloadOf(granted, "work_plan_committed");
    expect(committedPayload["proposalId"]).toBe(issuedProposal);
    expect(committedPayload["digest"]).toBe(proposedPayload["digest"]);
  });

  it("Edge: 승인이 필요 없는 직접 커밋도 생성기 pln_ 와 같은 내용의 제안 digest 를 싣는다 (test_SC023_direct_commit_carries_generated_id_and_digest)", () => {
    const { deps: base, aggregate } = reachWorkState("PLANNING");
    const plan = planInput([draft("a"), draft("b")]);
    const proposedDigest = payloadOf(
      committedCommit(proposePlanOn(base, aggregate, plan)).commit,
      "work_plan_proposed",
    )["digest"];
    const { deps, issued } = recordingDeps(base);
    const { commit } = committedCommit(commitPlanOn(deps, aggregate, plan));
    const payload = payloadOf(commit, "work_plan_committed");
    expect(issued[0]?.[0]).toBe("planProposal");
    expect(payload["proposalId"]).toBe(issued[0]?.[1]);
    expect(String(payload["proposalId"])).toMatch(/^pln_/);
    expect(payload["digest"]).toBe(proposedDigest);
    expect(issued.map(([kind]) => kind).slice(0, 4)).toEqual([
      "planProposal",
      "task",
      "task",
      "commit",
    ]);
  });

  it("Error: 무효 계획 출력은 pln_ 를 소비하지 않고 work_plan_invalid 에 proposalId 가 없다 (test_SC023_invalid_output_consumes_no_proposal_id)", () => {
    const { deps: base, aggregate } = reachWorkState("PLANNING");
    const { deps, issued } = recordingDeps(base);
    const { commit } = committedCommit(
      commitPlanOn(deps, aggregate, planInput([draft("a", { parent: { draftRef: "a" } })])),
    );
    expect(eventTypes(commit)).toContain("work_plan_invalid");
    expect(issued.map(([kind]) => kind)).not.toContain("planProposal");
    expect(payloadOf(commit, "work_plan_invalid")).not.toHaveProperty("proposalId");
    // 대조: 유효 계획은 pln_ 를 소비한다.
    const valid = recordingDeps(base);
    committedCommit(commitPlanOn(valid.deps, aggregate, planInput([draft("a")])));
    expect(valid.issued.map(([kind]) => kind)).toContain("planProposal");
  });

  it("Edge: 승인이 필요 없는 직접 커밋의 work_plan_committed 에는 decisionId 키가 없고, grant 커밋에는 그 결정 ID 가 있다 (test_SC023_direct_commit_carries_no_decision_id)", () => {
    const { deps, aggregate: planning } = reachWorkState("PLANNING");
    const plan = planInput([draft("a")]);
    const direct = committedCommit(commitPlanOn(deps, planning, plan));
    expect(Object.hasOwn(payloadOf(direct.commit, "work_plan_committed"), "decisionId")).toBe(
      false,
    );
    const waiting = committedCommit(proposePlanOn(deps, planning, plan)).aggregate;
    const decision = waiting.work.pendingDecision;
    if (decision === undefined) throw new Error("expected plan decision");
    // 레코드 패치: 계획 단계에 계획 승인 결정이 남은 상태(다른 생성 경로 대용) — 직접 커밋은 그 결정을 승인하지 않는다.
    const leftover = patchWork(planning, { pendingDecision: decision });
    const patchedDirect = committedCommit(commitPlanOn(deps, leftover, plan));
    expect(
      Object.hasOwn(payloadOf(patchedDirect.commit, "work_plan_committed"), "decisionId"),
    ).toBe(false);
    // 대조: 사람 grant 커밋은 승인한 결정 ID 를 싣는다.
    const granted = planDecision(new Journal(deps, waiting, []), "grant");
    expect(granted.kind).toBe("accepted");
    if (granted.kind !== "accepted") return;
    const grantedPayload = payloadOf(granted.commit, "work_plan_committed");
    expect(Object.hasOwn(grantedPayload, "decisionId")).toBe(true);
    expect(grantedPayload["decisionId"]).toBe(decision.id);
  });
});

/** plan revision 2 인 재계획 PLANNING Work(첫 계획 → 재계획 커밋 → 다시 재계획). */
function planRevisionTwo(seed: string) {
  const { journal, id } = replanOpenWork(seed);
  journal.apply(commitPlanOn(journal.deps, journal.aggregate, replanPlan(journal, [id("member")])));
  expect(journal.aggregate.work.planRevision).toBe(2);
  journal.apply(replanSignal(journal));
  expect(journal.aggregate.work.state).toBe("PLANNING");
  return { journal, id };
}

describe("SC-024: 기준 revision 이 다른 제안은 커밋되지 않는다", () => {
  it("Happy: plan revision 2 인 Work 에 기준 1 직접 커밋은 condition_not_met·커밋 없음 (test_SC024_direct_commit_with_old_base_refused)", () => {
    const { journal, id } = planRevisionTwo("sc024a");
    const stale = planInput([], { basePlanRevision: 1, retain: [id("member")] });
    expectNoCommitRefusal(
      commitPlanOn(journal.deps, journal.aggregate, stale),
      "condition_not_met",
    );
    // 대조: 현재 기준이면 커밋된다.
    const current = planInput([], { basePlanRevision: 2, retain: [id("member")] });
    expect(commitPlanOn(journal.deps, journal.aggregate, current).kind).toBe("committed");
  });

  it("Edge: grant 시점에 plan revision 이 움직였으면 철회 뒤 낡음이고 work_plan_committed 가 없다 (test_SC024_grant_with_moved_plan_revision_withdraws_and_stales)", () => {
    const { deps, aggregate: planning } = reachWorkState("PLANNING");
    const waiting = committedCommit(
      proposePlanOn(deps, planning, planInput([draft("a")])),
    ).aggregate;
    // 레코드 패치: 다른 생성 경로로 plan revision 이 움직인 상태 대용.
    const moved = patchWork(waiting, { planRevision: 1 });
    const judged = planDecision(new Journal(deps, moved, []), "grant");
    expect(judged.kind).toBe("rejected_stale");
    if (judged.kind !== "rejected_stale") return;
    const chain = committedChain(judged);
    expect(chain.map(eventTypes)).toEqual([["work_plan_withdrawn"], ["signal_rejected_stale"]]);
    const [withdrawal] = chain;
    if (withdrawal === undefined) throw new Error("expected withdrawal commit");
    expect(payloadOf(withdrawal, "work_plan_withdrawn")["issues"]).toContainEqual({
      kind: "base_revision_mismatch",
      basePlanRevision: 0,
      planRevision: 1,
    });
    expect(chain.flatMap(eventTypes)).not.toContain("task_created");
    // 대조: 움직이지 않았으면 같은 grant 가 커밋된다.
    const accepted = planDecision(new Journal(deps, waiting, []), "grant");
    expect(accepted.kind).toBe("accepted");
  });

  it("Error: 제안 경로도 기준 revision 이 다르면 거절된다 (test_SC024_proposal_with_old_base_refused)", () => {
    const { journal, id } = planRevisionTwo("sc024c");
    const stale = planInput([], { basePlanRevision: 1, retain: [id("member")] });
    expectNoCommitRefusal(
      proposePlanOn(journal.deps, journal.aggregate, stale),
      "condition_not_met",
    );
    const current = planInput([], { basePlanRevision: 2, retain: [id("member")] });
    expect(proposePlanOn(journal.deps, journal.aggregate, current).kind).toBe("committed");
  });
});

describe("SC-025: 승인 대기 제안과 다른 내용은 커밋될 수 없다", () => {
  function waitingWithTwoDrafts() {
    const { deps, aggregate: planning } = reachWorkState("PLANNING");
    const waiting = committedCommit(
      proposePlanOn(deps, planning, planInput([draft("first"), draft("second")])),
    ).aggregate;
    return { deps, waiting };
  }

  function createdRefs(commit: Parameters<typeof eventTypes>[0]): string[] {
    return commit.events
      .filter((e) => e.type === "task_created")
      .map((e) => String((e.payload as unknown as Record<string, unknown>)["draftRef"]));
  }

  it("Happy: 내용 없는 grant 가 대기 제안의 초안·보존 목록을 커밋한다 (test_SC025_grant_commits_pending_content_only)", () => {
    const { deps, waiting } = waitingWithTwoDrafts();
    const pending = waiting.work.pendingProposal;
    const journal = new Journal(deps, waiting, []);
    const commit = journal.apply(planDecision(journal, "grant"));
    expect(createdRefs(commit)).toEqual(["first", "second"]);
    const payload = payloadOf(commit, "work_plan_committed");
    expect(payload["digest"]).toBe(pending?.digest);
    expect(payload["retained"]).toEqual(pending?.retain);
  });

  it("Edge: 런타임 우회로 다른 초안을 실은 grant 는 그 내용이 무시되고 대기 내용이 커밋된다 (test_SC025_grant_carrying_other_drafts_ignored)", () => {
    const { deps, waiting } = waitingWithTwoDrafts();
    const decisionId = waiting.work.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected pending decision");
    // 런타임 우회: grant 적용 입력에는 내용 필드가 없다 — 옛 형태로 다른 초안을 실어 본다.
    const smuggled = {
      kind: "plan_grant",
      proposal: { drafts: [draft("intruder")], retain: [], tasks: [draft("intruder")] },
    } as unknown as DecisionApplication;
    const judged = judgeSignal(
      deps,
      waiting,
      {
        type: "human_decision",
        decisionId,
        choice: "grant",
        signalId: entityId("signal", "sig_smuggled1"),
        expectedRevision: waiting.work.revision,
        actorSource: "human_local",
        receivedAt: NOW,
      },
      smuggled,
      NOW,
    );
    expect(judged.kind).toBe("accepted");
    if (judged.kind !== "accepted") return;
    expect(createdRefs(judged.commit)).toEqual(["first", "second"]);
  });

  it("Error: 대기 제안이 없는 grant 는 거절되고 수용 키를 선점하지 않는다 (test_SC025_grant_without_pending_proposal_refused)", () => {
    const { deps, waiting } = waitingWithTwoDrafts();
    // 레코드 패치: 결정은 열려 있으나 보유 제안이 없는 상태(다른 생성 경로 대용).
    const work = { ...waiting.work } as Record<string, unknown>;
    delete work["pendingProposal"];
    const withoutProposal = { ...waiting, work: work as unknown as WorkAggregate["work"] };
    const judged = planDecision(new Journal(deps, withoutProposal, []), "grant");
    expect(judged.kind).toBe("not_applicable");
    if (judged.kind === "not_applicable") expect(judged.rejection.reason).toBe("invalid_input");
    expect(committedChain(judged)).toEqual([]);
    expect(planDecision(new Journal(deps, waiting, []), "grant").kind).toBe("accepted");
  });

  /**
   * 재계획 제안(보존 member + 결합 초안)까지 진행한다. `mutate` 면 제안 뒤 호출자가 넘긴 객체
   * (입력·결합·의존·보존 배열)를 바꾼다. 같은 시드라 ID 가 같아 두 흐름의 커밋을 그대로 비교할 수 있다.
   */
  function proposeAndMaybeMutate(seed: string, mutate: boolean) {
    const { journal, ids } = startJournal([draft("member")], bindingDeps(seed));
    const member = ids["member"] as TaskId;
    validate(journal, member);
    journal.apply(replanSignal(journal));
    const producerInput = { seed: "original" };
    const consumerInput = { count: 1 };
    const textBinding = { from: "task" as const, task: { draftRef: "producer" }, output: "text" };
    const consumerDependsOn: TaskRef[] = [{ draftRef: "producer" }];
    const retain: TaskId[] = [member];
    const plan = planInput(
      [
        draft("producer", { type: PRODUCER, input: producerInput }),
        draft("consumer", {
          type: CONSUMER,
          input: consumerInput,
          inputBindings: { text: textBinding },
          dependsOn: consumerDependsOn,
        }),
      ],
      { basePlanRevision: journal.aggregate.work.planRevision, retain },
    );
    journal.apply(proposePlanOn(journal.deps, journal.aggregate, plan));
    const pending = journal.aggregate.work.pendingProposal;
    if (pending === undefined) throw new Error("expected held proposal");
    const heldAtProposal = JSON.stringify(pending);
    if (mutate) {
      producerInput.seed = "tampered";
      consumerInput.count = 999;
      textBinding.output = "note";
      consumerDependsOn.push({ taskId: member });
      retain.splice(0);
    }
    return { journal, heldAtProposal, member };
  }

  it("Edge: 제안 뒤 호출자가 넘긴 초안·보존 객체를 바꿔도 보유 제안과 grant 커밋 내용이 제안 시 값 그대로다 (test_SC025_caller_mutation_after_proposal_does_not_change_held_content)", () => {
    const { journal, heldAtProposal, member } = proposeAndMaybeMutate("sc025m", true);
    const held = journal.aggregate.work.pendingProposal;
    if (held === undefined) throw new Error("expected held proposal");
    expect(JSON.stringify(held)).toBe(heldAtProposal);
    expect(Object.isFrozen(held)).toBe(true);
    expect(Object.isFrozen(held.tasks)).toBe(true);
    expect(Object.isFrozen(held.retain)).toBe(true);
    for (const task of held.tasks) {
      expect(Object.isFrozen(task), task.draftRef).toBe(true);
      expect(Object.isFrozen(task.input), task.draftRef).toBe(true);
      expect(Object.isFrozen(task.dependsOn), task.draftRef).toBe(true);
    }
    const granted = journal.apply(planDecision(journal, "grant"));
    const created = granted.events.filter((e) => e.type === "task_created");
    const byRef = (ref: string) =>
      created.find((e) => (e.payload as unknown as Record<string, unknown>)["draftRef"] === ref);
    const producer = byRef("producer");
    const consumer = byRef("consumer");
    if (producer?.taskId === undefined || consumer?.taskId === undefined)
      throw new Error("expected created tasks");
    expect(taskPayload(granted, producer.taskId, "task_created")["input"]).toEqual({
      seed: "original",
    });
    const consumerPayload = taskPayload(granted, consumer.taskId, "task_created");
    expect(consumerPayload["input"]).toEqual({ count: 1 });
    expect(consumerPayload["inputBindings"]).toEqual({
      text: { from: "task", task: { taskId: producer.taskId }, output: "text" },
    });
    expect(payloadOf(granted, "work_plan_committed")["retained"]).toEqual([member]);
    // 대조: 객체를 바꾸지 않은 같은 흐름(같은 시드)의 커밋과 같다.
    const control = proposeAndMaybeMutate("sc025m", false).journal;
    expect(granted).toEqual(control.apply(planDecision(control, "grant")));
  });

  it("Edge: 보유 제안 내용이 digest 와 어긋나면 grant 는 proposal_digest_mismatch 철회 뒤 낡음이고 수용 키를 선점하지 않는다 (test_SC025_held_content_digest_mismatch_withdraws_and_stales)", () => {
    const { deps, waiting } = waitingWithTwoDrafts();
    const pending = waiting.work.pendingProposal;
    const [first, ...rest] = pending?.tasks ?? [];
    if (pending === undefined || first === undefined) throw new Error("expected held proposal");
    // 레코드 패치: 승인 대상과 다른 내용을 보유한 상태(변조 대용) — digest 는 그대로 둔다.
    const tampered = patchWork(waiting, {
      pendingProposal: { ...pending, tasks: [{ ...first, title: "tampered" }, ...rest] },
    });
    const judged = planDecision(new Journal(deps, tampered, []), "grant");
    expect(judged.kind).toBe("rejected_stale");
    const chain = committedChain(judged);
    expect(chain.map(eventTypes)).toEqual([["work_plan_withdrawn"], ["signal_rejected_stale"]]);
    const [withdrawal] = chain;
    if (withdrawal === undefined) throw new Error("expected withdrawal commit");
    expect(payloadOf(withdrawal, "work_plan_withdrawn")["issues"]).toEqual([
      { kind: "proposal_digest_mismatch" },
    ]);
    expect(chain.flatMap(eventTypes)).not.toContain("task_created");
    const after = applyCommits(tampered, chain);
    expect(after.work.state).toBe("PLANNING");
    expect(after.acceptedSignalKeys).toEqual(tampered.acceptedSignalKeys);
    // 대조: 패치하지 않은 같은 대기 제안의 grant 는 커밋된다.
    expect(planDecision(new Journal(deps, waiting, []), "grant").kind).toBe("accepted");
  });

  it("Error: 공개 배럴은 검증 없이 커밋 이벤트를 조립하는 함수를 내보내지 않는다 (test_SC025_barrel_hides_unvalidated_commit_builder)", () => {
    expect("buildPlanCommitEvents" in domain).toBe(false);
    // 대조: 검증을 거치는 제안 검증 함수는 공개돼 있다.
    expect("validatePlanProposal" in domain).toBe(true);
  });

  it("Edge: 직접 커밋은 계획 입력을 한 번만 읽고 그 값으로 검증·커밋한다 — 읽을 때마다 값이 바뀌는 접근자도 검증한 값이 커밋된다 (test_SC025_direct_commit_reads_plan_input_once_and_commits_validated_content)", () => {
    const REGISTERED = { id: "generic_task", version: 1 };
    const reads = { type: 0, dependsOn: 0 };
    // 읽을 때마다 값이 바뀌는 접근자 초안 — 호출자 객체가 검증 뒤 달라지는 경로의 대용.
    const shifting = {
      draftRef: "x",
      title: "x",
      input: {},
      trigger: { kind: "immediate", version: 1, triggerId: "x" },
      policy: basePolicy(),
      get type() {
        reads.type += 1;
        return reads.type === 1 ? REGISTERED : UNREGISTERED_TASK_TYPE;
      },
      get dependsOn() {
        reads.dependsOn += 1;
        return reads.dependsOn === 1 ? [] : [{ draftRef: "x" }];
      },
    } as unknown as PlanTaskDraft;
    const shiftingRun = reachWorkState("PLANNING");
    const outcome = commitPlanOn(shiftingRun.deps, shiftingRun.aggregate, planInput([shifting]));
    const { commit, aggregate } = committedCommit(outcome);
    expect(eventTypes(commit)).toContain("work_plan_committed");
    const created = Object.values(aggregate.tasks);
    expect(created).toHaveLength(1);
    const taskId = created[0]?.id as TaskId;
    expect(taskPayload(commit, taskId, "task_created")["type"]).toEqual(REGISTERED);
    expect(taskPayload(commit, taskId, "task_created")["dependsOn"]).toEqual([]);
    expect(reads).toEqual({ type: 1, dependsOn: 1 });

    // 대조: 같은 값의 일반 객체 계획과 커밋 내용(digest·생성 이벤트)이 같다.
    const plainRun = reachWorkState("PLANNING");
    const plain = committedCommit(
      commitPlanOn(
        plainRun.deps,
        plainRun.aggregate,
        planInput([draft("x", { type: REGISTERED, dependsOn: [] })]),
      ),
    );
    expect(payloadOf(commit, "work_plan_committed")["digest"]).toBe(
      payloadOf(plain.commit, "work_plan_committed")["digest"],
    );
    expect(taskPayload(commit, taskId, "task_created")).toEqual(
      taskPayload(plain.commit, taskId, "task_created"),
    );

    // 최상위 키 읽기를 세는 계획 객체 — 키마다 한 번만 읽힌다.
    const keyReads = new Map<string, number>();
    const counted = new Proxy(planInput([draft("x")]), {
      get(target, key, receiver) {
        if (typeof key === "string") keyReads.set(key, (keyReads.get(key) ?? 0) + 1);
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const proxyRun = reachWorkState("PLANNING");
    expect(
      eventTypes(committedCommit(commitPlanOn(proxyRun.deps, proxyRun.aggregate, counted)).commit),
    ).toContain("work_plan_committed");
    for (const key of ["basePlanRevision", "source", "tasks", "retain"])
      expect(keyReads.get(key), key).toBe(1);
    for (const [key, count] of keyReads) expect(count, key).toBe(1);
  });
});

/** 거절된 확인(rej)·완료(done)·READY(base)·base 에 의존하는 READY(dep) member 를 가진 재계획 Work. */
function retentionFixture(seed: string) {
  const { journal, ids } = startJournal(
    [
      confirmationDraft("rej"),
      draft("done"),
      draft("base"),
      draft("dep", { dependsOn: [{ draftRef: "base" }] }),
    ],
    testDeps(seed),
  );
  const id = (ref: string) => ids[ref] as TaskId;
  for (const ref of ["rej", "done", "base", "dep"]) validate(journal, id(ref));
  beginConfirmation(journal, id("rej"));
  journal.apply(confirmationSignal(journal, id("rej"), "reject"));
  start(journal, id("done"));
  complete(journal, id("done"));
  expect(journal.task(id("rej")).state).toBe("REJECTED");
  journal.apply(replanSignal(journal));
  return { journal, id };
}

function expectPlanUnchanged(journal: Journal, outcome: CommandOutcome): void {
  const { aggregate } = committedCommit(outcome);
  expect(aggregate.work.planRevision).toBe(journal.aggregate.work.planRevision);
  expect(aggregate.work.memberTaskIds).toEqual(journal.aggregate.work.memberTaskIds);
  expect(Object.keys(aggregate.tasks)).toEqual(Object.keys(journal.aggregate.tasks));
}

describe("SC-026: 보존 집합 위반은 계획 무효다", () => {
  it("Happy: 거절 종결 member 보존은 retained_terminal_unsatisfying 이다 (test_SC026_retaining_rejected_terminal_invalid)", () => {
    const { journal, id } = retentionFixture("sc026a");
    const outcome = commitPlanOn(
      journal.deps,
      journal.aggregate,
      replanPlan(journal, [id("rej"), id("done"), id("base"), id("dep")]),
    );
    expect(invalidIssues(outcome)).toContainEqual({
      kind: "retained_terminal_unsatisfying",
      taskId: id("rej"),
      state: "REJECTED",
    });
    expectPlanUnchanged(journal, outcome);
    // 대조: 거절 member 를 빼면 같은 보존은 유효하다(필수 member 를 빼므로 제안 경로로 승인 대기에 든다).
    const valid = committedCommit(
      proposePlanOn(
        journal.deps,
        journal.aggregate,
        replanPlan(journal, [id("done"), id("base"), id("dep")]),
      ),
    );
    expect(eventTypes(valid.commit)).toEqual(["work_plan_proposed"]);
  });

  it("Edge: 기준 revision 밖 보존과 탈락 Task 를 가리키는 보존 member 의존이 각각 무효다 (test_SC026_retaining_non_member_and_retained_dependency_outside_revision_invalid)", () => {
    const { journal, id } = retentionFixture("sc026b");
    const outsider = entityId("task", "tsk_outsider000001");
    const notMember = commitPlanOn(
      journal.deps,
      journal.aggregate,
      replanPlan(journal, [id("done"), id("base"), id("dep"), outsider]),
    );
    expect(invalidIssues(notMember)).toContainEqual({
      kind: "retained_not_member",
      taskId: outsider,
    });
    expectPlanUnchanged(journal, notMember);
    const danglingDependency = commitPlanOn(
      journal.deps,
      journal.aggregate,
      replanPlan(journal, [id("done"), id("dep")]),
    );
    expect(invalidIssues(danglingDependency)).toContainEqual({
      kind: "member_reference_outside_revision",
      taskId: id("dep"),
      edge: "dependency",
      ref: id("base"),
    });
    expectPlanUnchanged(journal, danglingDependency);
  });

  it("Error: 새 초안이 supersede 된 Task 에 의존하면 dependency_outside_revision 이고 Task·revision·member 가 그대로다 (test_SC026_draft_dependency_on_superseded_invalid_no_task)", () => {
    const { journal, id } = retentionFixture("sc026c");
    const outcome = commitPlanOn(
      journal.deps,
      journal.aggregate,
      replanPlan(
        journal,
        [id("base"), id("dep")],
        [draft("next", { dependsOn: [{ taskId: id("done") }] })],
      ),
    );
    expect(invalidIssues(outcome)).toContainEqual({
      kind: "dependency_outside_revision",
      draftRef: "next",
      taskId: id("done"),
    });
    expectPlanUnchanged(journal, outcome);
    // 대조: 의존 대상을 보존하면 같은 초안이 유효하다(필수 member 를 빼므로 제안 경로로 승인 대기에 든다).
    const valid = committedCommit(
      proposePlanOn(
        journal.deps,
        journal.aggregate,
        replanPlan(
          journal,
          [id("done"), id("base"), id("dep")],
          [draft("next", { dependsOn: [{ taskId: id("done") }] })],
        ),
      ),
    );
    expect(eventTypes(valid.commit)).toEqual(["work_plan_proposed"]);
  });

  /**
   * 생산자(producer)와 그 출력에 결합한 비종결 소비자(consumer)·필수 READY anchor 를 가진 Work 에서
   * 생산자를 `terminate` 로 끝낸 뒤 재계획을 연다. 소비자는 의존 충족 Trigger 라 출력 없는 종결에 BLOCKED 가 된다.
   */
  function boundPairReplan(
    seed: string,
    options: {
      readonly field: "text" | "plain";
      readonly terminate: (journal: Journal, producer: TaskId) => void;
      readonly skipConsumerFirst?: boolean;
    },
  ) {
    const output = options.field === "text" ? "text" : "note";
    const { journal, ids } = startJournal(
      [
        draft("anchor"),
        draft("producer", { type: PRODUCER }),
        draft("consumer", {
          type: CONSUMER,
          input: options.field === "text" ? {} : { text: "direct" },
          inputBindings: {
            [options.field]: { from: "task", task: { draftRef: "producer" }, output },
          },
          dependsOn: [{ draftRef: "producer" }],
          trigger: dependencyTrigger("consumer"),
        }),
      ],
      bindingDeps(seed),
    );
    const id = (ref: string) => ids[ref] as TaskId;
    for (const ref of ["anchor", "producer", "consumer"]) validate(journal, id(ref));
    if (options.skipConsumerFirst === true) skip(journal, id("consumer"));
    options.terminate(journal, id("producer"));
    journal.apply(replanSignal(journal));
    expect(journal.aggregate.work.state).toBe("PLANNING");
    return { journal, id };
  }

  const skipProducer = (journal: Journal, producer: TaskId) => {
    skip(journal, producer);
  };
  const completeWithoutNote = (journal: Journal, producer: TaskId) => {
    runToCompleted(journal, producer, { text: "produced", stamp: "s" });
  };

  it("Edge: 출력 없이 종결된 보존 생산자에 결합한 비종결 보존 소비자는 member_binding_without_output 이고 Task 가 생기지 않는다 (test_SC026_retained_consumer_bound_to_outputless_retained_producer_invalid)", () => {
    const cases = [
      { field: "text" as const, terminate: skipProducer, reason: "skipped" },
      { field: "plain" as const, terminate: completeWithoutNote, reason: "output_absent" },
    ];
    for (const [index, { field, terminate, reason }] of cases.entries()) {
      const { journal, id } = boundPairReplan(`sc026m${index}`, { field, terminate });
      expect(journal.task(id("consumer")).state, reason).toBe("BLOCKED");
      const all = [id("anchor"), id("producer"), id("consumer")];
      const outcome = commitPlanOn(journal.deps, journal.aggregate, replanPlan(journal, all));
      expect(invalidIssues(outcome), reason).toContainEqual({
        kind: "member_binding_without_output",
        taskId: id("consumer"),
        field,
        ref: id("producer"),
        reason,
      });
      expectPlanUnchanged(journal, outcome);
      // 대조: 소비자를 보존하지 않는 제안에는 이 이슈가 없다.
      const withoutConsumer = validatePlanProposal(
        journal.deps,
        journal.aggregate,
        replanPlan(journal, [id("anchor"), id("producer")]),
      );
      expect(withoutConsumer.valid, reason).toBe(true);
    }
    // 대조: 생산자가 결합 출력을 가지고 종결했으면 같은 보존이 커밋된다.
    const withOutput = boundPairReplan("sc026m2", {
      field: "plain",
      terminate: (journal, producer) => {
        runToCompleted(journal, producer, { text: "produced", stamp: "s", note: "n" });
      },
    });
    const keepAll = ["anchor", "producer", "consumer"].map(withOutput.id);
    expect(
      eventTypes(
        committedCommit(
          commitPlanOn(
            withOutput.journal.deps,
            withOutput.journal.aggregate,
            replanPlan(withOutput.journal, keepAll),
          ),
        ).commit,
      ),
    ).toContain("work_plan_committed");
    // 대조: 소비자가 이미 종결(SKIPPED)이면 같은 결합을 보존해도 이 이슈가 없다.
    const terminalConsumer = boundPairReplan("sc026m3", {
      field: "text",
      terminate: skipProducer,
      skipConsumerFirst: true,
    });
    expect(terminalConsumer.journal.task(terminalConsumer.id("consumer")).state).toBe("SKIPPED");
    const terminalCheck = validatePlanProposal(
      terminalConsumer.journal.deps,
      terminalConsumer.journal.aggregate,
      replanPlan(
        terminalConsumer.journal,
        ["anchor", "producer", "consumer"].map(terminalConsumer.id),
      ),
    );
    expect(terminalCheck.valid).toBe(true);
  });

  it("Error: 무효 계획 이슈의 Task 참조는 호출자 객체가 아닌 동결 사본이라 커밋 뒤 호출자 변경이 기록에 닿지 않는다 (test_SC026_invalid_plan_issue_refs_are_frozen_copies_not_caller_objects)", () => {
    const ghost = { draftRef: "ghost" };
    const outside = { taskId: entityId("task", "tsk_outside000001") };
    const nobody = { draftRef: "nobody" };
    const { deps, aggregate } = reachWorkState("PLANNING");
    const outcome = commitPlanOn(
      deps,
      aggregate,
      planInput([
        draft("a", { dependsOn: [ghost] }),
        draft("b", { dependsOn: [outside] }),
        draft("c", { parent: nobody }),
      ]),
    );
    const issues = invalidIssues(outcome);
    const refOf = (kind: string, draftRef: string) => {
      const found = issues.find((i) => i.kind === kind && i["draftRef"] === draftRef);
      if (found === undefined) throw new Error(`expected ${kind} issue for ${draftRef}`);
      return found["ref"] as Record<string, unknown>;
    };
    const cases: readonly [Record<string, unknown>, Record<string, unknown>][] = [
      [refOf("unknown_dependency", "a"), ghost],
      [refOf("unknown_dependency", "b"), outside],
      [refOf("unknown_parent", "c"), nobody],
    ];
    const recorded = JSON.stringify(issues);
    for (const [ref, caller] of cases) {
      expect(ref).not.toBe(caller);
      expect(Object.isFrozen(ref)).toBe(true);
      // 대조: 이슈가 가리키는 값은 호출자가 넘긴 값과 같다.
      expect(ref).toEqual(caller);
    }
    ghost.draftRef = "changed";
    (outside as { taskId: string }).taskId = "tsk_changed000001";
    nobody.draftRef = "changed";
    expect(JSON.stringify(issues)).toBe(recorded);
  });
});

describe("SC-027: 현재 member 를 가리키는 부모 간선이 커밋 수준에서 검증된다", () => {
  function fixture(seed: string) {
    const { journal, ids } = startJournal(
      [draft("keep"), draft("aux", { policy: nonRequiredPolicy() }), draft("done")],
      testDeps(seed),
    );
    const id = (ref: string) => ids[ref] as TaskId;
    validate(journal, id("keep"));
    validate(journal, id("aux"));
    runToCompleted(journal, id("done"));
    journal.apply(replanSignal(journal));
    return { journal, id };
  }

  function createdTask(aggregate: WorkAggregate, ref: string) {
    const task = Object.values(aggregate.tasks).find((t) => t.draftRef === ref);
    if (task === undefined) throw new Error(`expected task ${ref}`);
    return task;
  }

  it("Happy: 부모가 보존 member 인 초안이 커밋되고 parentTaskId 가 그 Task 다 (test_SC027_parent_retained_member_resolves)", () => {
    const { journal, id } = fixture("sc027a");
    const { aggregate } = committedCommit(
      commitPlanOn(
        journal.deps,
        journal.aggregate,
        replanPlan(
          journal,
          [id("keep"), id("aux"), id("done")],
          [draft("child", { parent: { taskId: id("keep") } })],
        ),
      ),
    );
    expect(createdTask(aggregate, "child").parentTaskId).toBe(id("keep"));
  });

  it("Edge: 부모가 보존하지 않는 기준 member 여도 커밋된다 (test_SC027_parent_non_retained_base_member_resolves)", () => {
    const { journal, id } = fixture("sc027b");
    const { commit, aggregate } = committedCommit(
      commitPlanOn(
        journal.deps,
        journal.aggregate,
        replanPlan(
          journal,
          [id("keep"), id("done")],
          [draft("child", { parent: { taskId: id("aux") } })],
        ),
      ),
    );
    expect(eventTypes(commit)).toContain("work_plan_committed");
    expect(createdTask(aggregate, "child").parentTaskId).toBe(id("aux"));
  });

  it("Error: Work 밖 부모는 unknown_parent 이고, 부모 간선은 자식의 활성화를 막지 않는다 (test_SC027_parent_outside_work_invalid_and_parent_does_not_gate)", () => {
    const { journal, id } = fixture("sc027c");
    const outsider = entityId("task", "tsk_outsider000002");
    const invalid = commitPlanOn(
      journal.deps,
      journal.aggregate,
      replanPlan(
        journal,
        [id("keep"), id("aux"), id("done")],
        [draft("child", { parent: { taskId: outsider } })],
      ),
    );
    expect(invalidIssues(invalid).map((i) => i.kind)).toContain("unknown_parent");
    // 부모(keep)가 비종결이어도 의존(done 완료)만으로 자식이 발화한다.
    journal.apply(
      commitPlanOn(
        journal.deps,
        journal.aggregate,
        replanPlan(
          journal,
          [id("keep"), id("aux"), id("done")],
          [
            draft("child", {
              parent: { taskId: id("keep") },
              dependsOn: [{ taskId: id("done") }],
              trigger: dependencyTrigger("child"),
            }),
          ],
        ),
      ),
    );
    const child = createdTask(journal.aggregate, "child").id;
    validate(journal, child);
    expect(journal.task(id("keep")).state).toBe("READY");
    expect(journal.task(child).state).toBe("SCHEDULED");
  });
});

describe("SC-028: 필수 member 가 없는 계획은 무효다", () => {
  it("Happy: 모든 초안이 비필수인 첫 계획은 no_terminal_required_member 다 (test_SC028_first_plan_without_required_member_invalid)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const outcome = commitPlanOn(
      deps,
      aggregate,
      planInput([
        draft("a", { policy: nonRequiredPolicy() }),
        draft("b", { policy: nonRequiredPolicy() }),
      ]),
    );
    expect(invalidIssues(outcome)).toContainEqual({ kind: "no_terminal_required_member" });
    // 대조: 필수 초안 하나가 있으면 커밋된다.
    const valid = committedCommit(
      commitPlanOn(
        deps,
        aggregate,
        planInput([draft("a", { policy: nonRequiredPolicy() }), draft("b")]),
      ),
    );
    expect(eventTypes(valid.commit)).toContain("work_plan_committed");
  });

  it("Edge: 필수 member 를 모두 빼고 비필수만 더하는 재계획도 같다 (test_SC028_replan_removing_all_required_invalid)", () => {
    const { journal } = replanOpenWork("sc028b");
    const outcome = commitPlanOn(
      journal.deps,
      journal.aggregate,
      replanPlan(journal, [], [draft("light", { policy: nonRequiredPolicy() })]),
    );
    expect(invalidIssues(outcome)).toContainEqual({ kind: "no_terminal_required_member" });
  });

  it("Error: 무효 계획은 Task 를 하나도 만들지 않는다 (test_SC028_invalid_plan_creates_no_task)", () => {
    const { journal } = replanOpenWork("sc028c");
    const outcome = commitPlanOn(
      journal.deps,
      journal.aggregate,
      replanPlan(journal, [], [draft("light", { policy: nonRequiredPolicy() })]),
    );
    invalidIssues(outcome);
    expectPlanUnchanged(journal, outcome);
    const { deps, aggregate } = reachWorkState("PLANNING");
    const first = committedCommit(
      commitPlanOn(deps, aggregate, planInput([draft("a", { policy: nonRequiredPolicy() })])),
    );
    expect(Object.keys(first.aggregate.tasks)).toEqual([]);
  });
});

describe("SC-029: 필수 member 를 빼는 제안은 승인 없이 커밋되지 않는다", () => {
  const DETAIL = "mandatory_plan_approval_required";

  it("Happy: 비종결 필수 member 를 보존하지 않는 직접 커밋은 거절된다 (test_SC029_direct_commit_dropping_nonterminal_required_refused)", () => {
    const { journal, id } = replanOpenWork("sc029a");
    expectNoCommitRefusal(
      commitPlanOn(journal.deps, journal.aggregate, replanPlan(journal, [], [draft("new")])),
      "condition_not_met",
      DETAIL,
    );
    // 대조: 필수 member 를 보존하면 같은 초안이 직접 커밋된다.
    expect(
      commitPlanOn(
        journal.deps,
        journal.aggregate,
        replanPlan(journal, [id("member")], [draft("new")]),
      ).kind,
    ).toBe("committed");
  });

  it("Edge: 실패로 끝난 필수 member 를 보존하지 않는 직접 커밋도 거절된다 (test_SC029_direct_commit_superseding_failed_required_refused)", () => {
    const { journal, ids } = startJournal(
      [draft("member"), draft("aux", { policy: nonRequiredPolicy() })],
      testDeps("sc029b"),
    );
    const member = ids["member"] as TaskId;
    const aux = ids["aux"] as TaskId;
    validate(journal, member);
    validate(journal, aux);
    start(journal, member);
    fail(journal, member, "fixture_fatal");
    expect(journal.task(member).state).toBe("FAILED");
    journal.apply(replanSignal(journal));
    expectNoCommitRefusal(
      commitPlanOn(journal.deps, journal.aggregate, replanPlan(journal, [aux], [draft("new")])),
      "condition_not_met",
      DETAIL,
    );
  });

  it("Error: 같은 제안을 제안 경로로 내면 승인 대기에 들어간다 (test_SC029_same_plan_proposed_waits_for_approval)", () => {
    const { journal } = replanOpenWork("sc029c");
    const outcome = proposePlanOn(
      journal.deps,
      journal.aggregate,
      replanPlan(journal, [], [draft("new")]),
    );
    const { commit, aggregate } = committedCommit(outcome);
    expect(eventTypes(commit)).toEqual(["work_plan_proposed"]);
    expect(aggregate.work.state).toBe("WAITING_APPROVAL");
  });

  it("Edge: 직접 커밋의 보존 목록은 한 번만 읽혀 digest·membership·필수 승인 판정이 같은 목록에서 나온다 (test_SC029_retain_read_once_for_digest_membership_and_mandatory_approval)", () => {
    /** 첫 읽기와 그 뒤 읽기의 보존 목록이 다른 계획 — 호출자 객체가 검증 뒤 달라지는 경로의 대용. */
    function shiftingRetain(journal: Journal, first: readonly TaskId[], later: readonly TaskId[]) {
      const base = replanPlan(journal, [], [draft("new")]);
      const counter = { reads: 0 };
      const plan = {
        basePlanRevision: base.basePlanRevision,
        source: base.source,
        tasks: base.tasks,
        get retain() {
          counter.reads += 1;
          return counter.reads === 1 ? first : later;
        },
      } as unknown as Plan;
      return { plan, counter };
    }

    // (a) 첫 읽기 = 필수 member 보존 → 보존 커밋.
    const kept = replanOpenWork("sc029k");
    const member = kept.id("member");
    const keep = shiftingRetain(kept.journal, [member], []);
    const committed = committedCommit(
      commitPlanOn(kept.journal.deps, kept.journal.aggregate, keep.plan),
    );
    const payload = payloadOf(committed.commit, "work_plan_committed");
    expect(payload["retained"]).toEqual([member]);
    expect(payload["dropped"]).toEqual([]);
    expect(keep.counter.reads).toBe(1);
    const control = committedCommit(
      commitPlanOn(
        kept.journal.deps,
        kept.journal.aggregate,
        replanPlan(kept.journal, [member], [draft("new")]),
      ),
    );
    expect(payload["digest"]).toBe(payloadOf(control.commit, "work_plan_committed")["digest"]);

    // (b) 첫 읽기 = 보존 없음 → 필수 승인 없이 커밋되지 않는다.
    const dropped = replanOpenWork("sc029d");
    const drop = shiftingRetain(dropped.journal, [], [dropped.id("member")]);
    expectNoCommitRefusal(
      commitPlanOn(dropped.journal.deps, dropped.journal.aggregate, drop.plan),
      "condition_not_met",
      "mandatory_plan_approval_required",
    );
    expect(drop.counter.reads).toBe(1);
    // 대조: 같은 값의 일반 배열도 같은 거절이다.
    expectNoCommitRefusal(
      commitPlanOn(
        dropped.journal.deps,
        dropped.journal.aggregate,
        replanPlan(dropped.journal, [], [draft("new")]),
      ),
      "condition_not_met",
      "mandatory_plan_approval_required",
    );
  });
});

describe("SC-030: 필수 승인 판정의 두 조건", () => {
  function fixture(seed: string) {
    return replanOpenWork(seed, [draft("req"), draft("opt", { policy: nonRequiredPolicy() })]);
  }

  it("Happy: 필수 member 를 모두 보존하고 정의 초안이 없으면 필수가 아니다(비필수 제거는 무관) (test_SC030_all_required_retained_no_definition_not_mandatory)", () => {
    const { journal, id } = fixture("sc030a");
    expect(judgeMandatoryPlanApproval(journal.aggregate, { retain: [id("req")] })).toEqual({
      required: false,
      reasons: [],
      removedTerminalRequiredTaskIds: [],
    });
  });

  it("Edge: 정의 초안 자리를 채우면 carries_definition 으로 필수다 (test_SC030_definition_slot_mandatory)", () => {
    const { journal, id } = fixture("sc030b");
    expect(
      judgeMandatoryPlanApproval(journal.aggregate, {
        retain: [id("req"), id("opt")],
        definition: { name: "draft definition" },
      }),
    ).toEqual({
      required: true,
      reasons: ["carries_definition"],
      removedTerminalRequiredTaskIds: [],
    });
  });

  it("Error: 필수 member 제거와 정의 초안이 함께면 이유가 둘이다 (test_SC030_both_reasons_reported)", () => {
    const { journal, id } = fixture("sc030c");
    expect(
      judgeMandatoryPlanApproval(journal.aggregate, { retain: [id("opt")], definition: {} }),
    ).toEqual({
      required: true,
      reasons: ["removes_terminal_required_member", "carries_definition"],
      removedTerminalRequiredTaskIds: [id("req")],
    });
  });
});

describe("SC-031: 계획 승인 결정은 Work 와 제안을 가리키고 member 진행이 그 revision 을 낡게 하지 않는다", () => {
  function waitingWithRunningMember(seed: string) {
    const { journal, ids } = startJournal([draft("runner"), draft("idle")], testDeps(seed));
    const runner = ids["runner"] as TaskId;
    const idle = ids["idle"] as TaskId;
    validate(journal, runner);
    validate(journal, idle);
    start(journal, runner);
    journal.apply(replanSignal(journal));
    journal.apply(
      proposePlanOn(
        journal.deps,
        journal.aggregate,
        replanPlan(journal, [runner], [draft("next")]),
      ),
    );
    expect(journal.aggregate.work.state).toBe("WAITING_APPROVAL");
    return { journal, runner, idle };
  }

  it("Happy: 대기 결정은 plan_approval_required·Work·pln_ 제안 ID 를 싣고 Task ID 가 없다 (test_SC031_plan_decision_names_work_and_proposal_without_task)", () => {
    const { journal } = waitingWithRunningMember("sc031a");
    const decision = journal.aggregate.work.pendingDecision as unknown as Record<string, unknown>;
    expect(decision["kind"]).toBe("plan_approval_required");
    expect(decision["workId"]).toBe(journal.aggregate.work.id);
    expect(String(decision["planProposalId"])).toMatch(/^pln_/);
    expect(decision["planProposalId"]).toBe(journal.aggregate.work.pendingProposal?.id);
    expect(decision).not.toHaveProperty("taskId");
  });

  it("Edge: 보존 member 가 Task 이벤트만 붙이는 진행 뒤 Work revision 이 그대로이고 진행 전 revision 의 사람 grant 가 커밋된다 (test_SC031_member_progress_keeps_work_revision_and_human_grant_commits)", () => {
    const { journal, runner } = waitingWithRunningMember("sc031b");
    const revisionBefore = journal.aggregate.work.revision;
    const progress = complete(journal, runner);
    expect(progress.events.every((e) => e.taskId !== undefined)).toBe(true);
    expect(journal.aggregate.work.revision).toBe(revisionBefore);
    expect(journal.aggregate.work.state).toBe("WAITING_APPROVAL");
    const granted = journal.apply(
      planDecision(journal, "grant", { expectedRevision: revisionBefore }),
    );
    expect(eventTypes(granted)).toContain("work_plan_committed");
    expect(eventTypes(granted)).not.toContain("human_decision_granted");
  });

  it("Error: 사람 아닌 출처 grant 는 아무것도 커밋하지 않는다 (test_SC031_non_human_grant_commits_nothing)", () => {
    const { journal } = waitingWithRunningMember("sc031c");
    const before = journal.aggregate;
    const judged = planDecision(journal, "grant", { actorSource: "adde_self" });
    expect(judged.kind).toBe("rejected");
    const chain = committedChain(judged);
    expect(chain.map(eventTypes)).toEqual([["signal_rejected"]]);
    const after = applyCommits(before, chain);
    expect(after.work.state).toBe("WAITING_APPROVAL");
    expect(after.work.revision).toBe(before.work.revision);
    expect(planDecision(new Journal(journal.deps, after, []), "grant").kind).toBe("accepted");
  });
});

describe("SC-032: 보존 member 가 실패로 끝나면 같은 커밋에서 제안이 철회된다", () => {
  function fixture(seed: string) {
    const { journal, ids } = startJournal([draft("runner"), draft("idle")], testDeps(seed));
    const runner = ids["runner"] as TaskId;
    validate(journal, runner);
    validate(journal, ids["idle"] as TaskId);
    start(journal, runner);
    journal.apply(replanSignal(journal));
    journal.apply(
      proposePlanOn(
        journal.deps,
        journal.aggregate,
        replanPlan(journal, [runner, ids["idle"] as TaskId]),
      ),
    );
    const waiting = journal.aggregate;
    const failure = fail(journal, runner, "fixture_fatal");
    return { journal, runner, waiting, failure };
  }

  it("Happy: 실패 커밋에 work_plan_withdrawn{no_longer_validates, issues} 가 붙고 결정이 닫히며 PLANNING 이다 (test_SC032_retained_member_failure_withdraws_in_same_commit)", () => {
    const { journal, runner, waiting, failure } = fixture("sc032a");
    expect(taskEventTypes(failure, runner)).toEqual(["task_failed"]);
    const withdrawn = payloadOf(failure, "work_plan_withdrawn");
    expect(withdrawn["cause"]).toBe("no_longer_validates");
    expect(withdrawn["proposalId"]).toBe(waiting.work.pendingProposal?.id);
    expect(withdrawn["decisionId"]).toBe(waiting.work.pendingDecision?.id);
    expect(withdrawn["issues"]).toContainEqual({
      kind: "retained_terminal_unsatisfying",
      taskId: runner,
      state: "FAILED",
    });
    expect(journal.aggregate.work.state).toBe("PLANNING");
    expect(journal.aggregate.work.pendingDecision).toBeUndefined();
    expect(journal.aggregate.work.pendingProposal).toBeUndefined();
  });

  it("Edge: 옛 grant 는 signal_rejected_stale 로 기록되고 아무것도 바꾸지 않는다 (test_SC032_old_grant_after_withdrawal_is_stale)", () => {
    const { journal, waiting } = fixture("sc032b");
    const decisionId = waiting.work.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected decision");
    const judged = judgeSignal(
      journal.deps,
      journal.aggregate,
      {
        type: "human_decision",
        decisionId,
        choice: "grant",
        signalId: entityId("signal", "sig_oldgrant00001"),
        expectedRevision: waiting.work.revision,
        actorSource: "human_local",
        receivedAt: NOW,
      },
      { kind: "plan_grant" },
      NOW,
    );
    expect(judged.kind).toBe("rejected_stale");
    const chain = committedChain(judged);
    expect(chain.map(eventTypes)).toEqual([["signal_rejected_stale"]]);
    const after = applyCommits(journal.aggregate, chain);
    expect(after.work.state).toBe("PLANNING");
    expect(after.work.revision).toBe(journal.aggregate.work.revision);
    expect(after.acceptedSignalKeys).toEqual(journal.aggregate.acceptedSignalKeys);
  });

  it("Error: 철회 커밋은 Work revision 을 1 올린다 (test_SC032_withdrawal_increments_work_revision)", () => {
    const { journal, waiting } = fixture("sc032c");
    expect(journal.aggregate.work.revision).toBe(waiting.work.revision + 1);
  });

  it("Error: 철회 명령은 도메인 재검증 전용 원인을 거절하고 원문 변경 원인만 철회한다 (test_SC032_withdraw_command_rejects_domain_only_cause)", () => {
    const { deps, aggregate: planning } = reachWorkState("PLANNING");
    const waiting = committedCommit(
      proposePlanOn(deps, planning, planInput([draft("a")])),
    ).aggregate;
    const withdraw = (cause: string) =>
      // 런타임 우회: 명령 타입은 원문 변경 원인만 허용한다 — 다른 원인을 실어 본다.
      executeCommand(deps, waiting, {
        kind: "withdraw_plan_proposal",
        expectedRevision: waiting.work.revision,
        meta: meta(NOW),
        cause,
      } as unknown as WorkCommand);
    expectNoCommitRefusal(
      withdraw("no_longer_validates"),
      "invalid_input",
      "withdraw_cause_not_allowed",
    );
    // 대조: 원문 변경 원인은 철회 커밋이다.
    const withdrawn = committedCommit(withdraw("source_changed"));
    expect(eventTypes(withdrawn.commit)).toEqual(["work_plan_withdrawn"]);
    expect(payloadOf(withdrawn.commit, "work_plan_withdrawn")["cause"]).toBe("source_changed");
    expect(withdrawn.aggregate.work.state).toBe("PLANNING");
  });
});

describe("SC-033: 제안을 무효로 만들지 않는 member 종결은 철회하지 않는다", () => {
  function fixture(seed: string) {
    const { journal, ids } = startJournal([draft("keep"), draft("leaving")], testDeps(seed));
    const keep = ids["keep"] as TaskId;
    const leaving = ids["leaving"] as TaskId;
    validate(journal, keep);
    validate(journal, leaving);
    start(journal, leaving);
    journal.apply(replanSignal(journal));
    journal.apply(proposePlanOn(journal.deps, journal.aggregate, replanPlan(journal, [keep])));
    return { journal, keep, leaving, revision: journal.aggregate.work.revision };
  }

  it("Happy: 탈락 예정 member 가 완료돼도 철회가 없고 WAITING_APPROVAL 에 남는다 (test_SC033_dropped_member_completion_keeps_waiting_approval)", () => {
    const { journal, leaving, revision } = fixture("sc033a");
    const commit = complete(journal, leaving);
    expect(eventTypes(commit)).not.toContain("work_plan_withdrawn");
    expect(journal.aggregate.work.state).toBe("WAITING_APPROVAL");
    expect(journal.aggregate.work.revision).toBe(revision);
  });

  it("Edge: 탈락 예정 member 가 실패해도 철회가 없다 (test_SC033_dropped_member_failure_keeps_waiting_approval)", () => {
    const { journal, leaving } = fixture("sc033b");
    const commit = fail(journal, leaving, "fixture_fatal");
    expect(eventTypes(commit)).not.toContain("work_plan_withdrawn");
    expect(journal.aggregate.work.state).toBe("WAITING_APPROVAL");
  });

  it("Error: 이어진 grant 가 수용되고 종결한 탈락 예정 member 는 superseded 다 (test_SC033_grant_after_non_invalidating_terminal_accepted)", () => {
    const { journal, leaving } = fixture("sc033c");
    complete(journal, leaving);
    const granted = journal.apply(planDecision(journal, "grant"));
    const payload = payloadOf(granted, "work_plan_committed");
    expect(payload["superseded"]).toEqual([leaving]);
    expect(payload["dropped"]).toEqual([]);
  });
});

describe("SC-034: 무효 제안에 대한 grant 는 철회 커밋 뒤 낡음으로 기록된다", () => {
  function driftedWaiting() {
    const { deps, aggregate: planning } = reachWorkState("PLANNING");
    // 등록부 drift 대용: 제안 시점에는 시험 유형을 등록했고, 판정 시점 등록부에는 없다.
    const proposingDeps = { ...deps, registries: testRegistries({ taskTypes: [probeTaskType()] }) };
    const probe = draft("probe", {
      type: { id: probeTaskType().id, version: probeTaskType().version },
      input: { subject: "drift" },
    });
    const waiting = committedCommit(
      proposePlanOn(proposingDeps, planning, planInput([probe])),
    ).aggregate;
    return { deps, waiting };
  }

  it("Happy: 결과 커밋이 둘(철회, 낡음)이고 최종 Work 가 PLANNING 이다 (test_SC034_invalid_grant_yields_withdrawal_then_stale)", () => {
    const { deps, waiting } = driftedWaiting();
    const judged = planDecision(new Journal(deps, waiting, []), "grant");
    expect(judged.kind).toBe("rejected_stale");
    if (judged.kind !== "rejected_stale") return;
    expect(judged.reason).toBe("token_mismatch");
    const chain = committedChain(judged);
    expect(chain.map(eventTypes)).toEqual([["work_plan_withdrawn"], ["signal_rejected_stale"]]);
    const [withdrawal] = chain;
    if (withdrawal === undefined) throw new Error("expected withdrawal commit");
    const withdrawn = payloadOf(withdrawal, "work_plan_withdrawn");
    expect(withdrawn["cause"]).toBe("no_longer_validates");
    expect((withdrawn["issues"] as readonly Issue[]).map((i) => i.kind)).toContain("draft_invalid");
    const after = applyCommits(waiting, chain);
    expect(after.work.state).toBe("PLANNING");
    expect(judged.preceding?.aggregate.work.state).toBe("PLANNING");
  });

  it("Edge: 수용 키가 선점되지 않아 같은 키의 다음 신호가 duplicate 가 아니다 (test_SC034_invalid_grant_reserves_no_key)", () => {
    const { deps, waiting } = driftedWaiting();
    const decisionId = waiting.work.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected decision");
    const signal = (signalId: string) => ({
      type: "human_decision" as const,
      decisionId,
      choice: "grant" as const,
      signalId: entityId("signal", signalId),
      expectedRevision: waiting.work.revision,
      actorSource: "human_local" as const,
      receivedAt: NOW,
    });
    const first = judgeSignal(
      deps,
      waiting,
      signal("sig_driftgrant001"),
      { kind: "plan_grant" },
      NOW,
    );
    const after = applyCommits(waiting, committedChain(first));
    expect(after.acceptedSignalKeys).toEqual(waiting.acceptedSignalKeys);
    const second = judgeSignal(
      deps,
      after,
      signal("sig_driftgrant002"),
      { kind: "plan_grant" },
      NOW,
    );
    expect(second.kind).not.toBe("duplicate");
    expect(second.kind).toBe("rejected_stale");
  });

  it("Error: 무효 grant 결과에 not_applicable 이 없다 (test_SC034_no_not_applicable_for_invalid_grant)", () => {
    const { deps, waiting } = driftedWaiting();
    const judged = planDecision(new Journal(deps, waiting, []), "grant");
    expect(judged.kind).not.toBe("not_applicable");
    expect(committedChain(judged).length).toBe(2);
  });
});

describe("SC-035: 반복 정의에 걸친 제안은 미지원으로 거절된다", () => {
  it("Happy: 정의 초안을 실은 제안·직접 커밋이 모두 unsupported_in_this_phase 다 (test_SC035_definition_draft_refused_on_both_paths)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const plan = planInput([draft("a")], { definition: { title: "recurring" } });
    expectNoCommitRefusal(proposePlanOn(deps, aggregate, plan), "unsupported_in_this_phase");
    expectNoCommitRefusal(commitPlanOn(deps, aggregate, plan), "unsupported_in_this_phase");
  });

  it("Edge: definition_template 출처도 같다 (test_SC035_definition_template_source_refused)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const plan = planInput([draft("a")], { source: "definition_template" });
    expectNoCommitRefusal(proposePlanOn(deps, aggregate, plan), "unsupported_in_this_phase");
    expectNoCommitRefusal(commitPlanOn(deps, aggregate, plan), "unsupported_in_this_phase");
  });

  it("Error: 거절은 Work 상태·revision 을 바꾸지 않고, 같은 계획에서 정의만 빼면 수용된다 (test_SC035_refusal_keeps_state_and_revision)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const refused = commitPlanOn(deps, aggregate, planInput([draft("a")], { definition: {} }));
    expect(committedChain(refused)).toEqual([]);
    expect(aggregate.work.state).toBe("PLANNING");
    const accepted = committedCommit(commitPlanOn(deps, aggregate, planInput([draft("a")])));
    expect(accepted.aggregate.work.revision).toBe(aggregate.work.revision + 1);
    // 출처가 두 값 밖이면 미지원이 아니라 invalid_input 이다(런타임 우회 입력).
    const unknownSource = planInput([draft("a")], {
      source: "imported" as unknown as "planner",
    });
    expectNoCommitRefusal(proposePlanOn(deps, aggregate, unknownSource), "invalid_input");
    expectNoCommitRefusal(commitPlanOn(deps, aggregate, unknownSource), "invalid_input");
  });
});
