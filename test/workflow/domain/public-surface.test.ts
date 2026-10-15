// 공개 배럴 표면·커밋 표식·재생 API·결정 이벤트 workId 귀속. 공개 표면 단언은 공개 배럴 이름공간으로만 하고,
// 내부 진입 이름공간은 대조와 조립 함수 직접 호출에만 쓴다.
import { describe, expect, it } from "vitest";
import * as publicDomain from "../../../src/workflow/domain/index.js";
import * as internalDomain from "../../../src/workflow/domain/internal.js";
import type {
  CommitMeta,
  DomainCommit,
  DomainDeps,
  DomainEvent,
  SignalJudgement,
  WorkAggregate,
} from "../../../src/workflow/domain/index.js";
import {
  at,
  draft,
  entityId,
  meta,
  mustCommit,
  mustOk,
  patchWork,
  planned,
  plannedWithCommits,
  reachTaskState,
  reachWorkState,
  requireTaskFor,
  testDeps,
} from "./helpers/fixtures.js";
import {
  dayAt,
  definitionDeps,
  registerAndMaterializeFirst,
  registerDefinition,
} from "./helpers/definition-fixtures.js";

const NOW = at("2026-01-01T00:00:00Z");

/** 공개 배럴에서 빠지고 내부 진입으로만 닿는 14 개 함수. */
const MOVED_NAMES = [
  "mkEvent",
  "assembleCommit",
  "decideTaskCommand",
  "decideWorkCommand",
  "decideCreateWork",
  "decideWorkCancellationCascade",
  "decideReplanDroppedCancellations",
  "decidePendingProposalRevalidation",
  "decideDependencyCascadeRound",
  "decideDerivedWorkStateEvent",
  "preExecutionApprovalPark",
  "checkReportedOutputs",
  "planPreconditionRejection",
  "validatePlanProposal",
] as const;

const PUBLIC_ENTRY_NAMES = [
  "executeCommand",
  "createWork",
  "executeDefinitionCommand",
  "judgeSignal",
  "judgeDelegationResponseStaleness",
  "judgeDefinitionSignal",
  "judgeTaskExternalSignal",
] as const;

const REPLAY_NAMES = ["evolveCommit", "foldEvents", "foldWorkflowEvents"] as const;

const EVENT_OR_COMMIT_BUILDERS = [
  "mkEvent",
  "assembleCommit",
  "decideTaskCommand",
  "decideWorkCommand",
  "decideCreateWork",
  "decideWorkCancellationCascade",
  "decideReplanDroppedCancellations",
  "decidePendingProposalRevalidation",
  "decideDependencyCascadeRound",
  "decideDerivedWorkStateEvent",
  "preExecutionApprovalPark",
] as const;

function commitMeta(): CommitMeta {
  return { now: NOW, actorSource: "adde_self" };
}

function newWork(deps: DomainDeps, seed: string) {
  return publicDomain.createWork(deps, {
    kind: "create_work",
    meta: meta(NOW),
    projectId: mustOk(publicDomain.parseProjectId(`prj_${seed}`)),
    title: "surface work",
    objective: "surface work",
    source: { kind: "markdown", documentId: `doc-${seed}` },
  });
}

/** 대기 제안 본문의 첫 초안 제목만 바꾼 WAITING_APPROVAL Work — grant 재검증이 내용 digest 불일치로 무효다. */
function driftedWaitingApproval(): { deps: DomainDeps; aggregate: WorkAggregate } {
  const { deps, aggregate } = reachWorkState("WAITING_APPROVAL");
  const held = aggregate.work.pendingProposal;
  if (held === undefined) throw new Error("expected held proposal");
  const [first, ...rest] = held.tasks;
  if (first === undefined) throw new Error("expected a proposed draft");
  return {
    deps,
    aggregate: patchWork(aggregate, {
      pendingProposal: { ...held, tasks: [{ ...first, title: "drifted title" }, ...rest] },
    }),
  };
}

function grantPlan(deps: DomainDeps, aggregate: WorkAggregate): SignalJudgement {
  const decisionId = aggregate.work.pendingDecision?.id;
  if (decisionId === undefined) throw new Error("expected pending plan decision");
  return publicDomain.judgeSignal(
    deps,
    aggregate,
    {
      type: "human_decision",
      decisionId,
      choice: "grant",
      signalId: publicDomain.nextEntityId(deps.ids, "signal"),
      expectedRevision: aggregate.work.revision,
      actorSource: "human_local",
      receivedAt: NOW,
    },
    { kind: "plan_grant" },
    NOW,
  );
}

function expectSealed(commit: DomainCommit): void {
  expect(publicDomain.isEngineCommit(commit)).toBe(true);
  expect(Object.isFrozen(commit)).toBe(true);
  expect(Object.isFrozen(commit.events)).toBe(true);
  const first = commit.events[0];
  expect(first).toBeDefined();
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first?.payload)).toBe(true);
}

describe("SC-014: 공개 배럴은 엔진 검사를 거치지 않는 조립 함수를 내보내지 않는다", () => {
  it("Happy: 공개 배럴 이름에 옮긴 14 개 이름이 없다 (test_SC014_public_barrel_lacks_moved_names)", () => {
    const names = new Set(Object.keys(publicDomain));
    expect(MOVED_NAMES.filter((n) => names.has(n))).toEqual([]);
  });

  it("Edge: 내부 진입은 옮긴 14 개 이름을 모두 가진다 (test_SC014_internal_barrel_has_moved_names)", () => {
    const names = new Set(Object.keys(internalDomain));
    expect(MOVED_NAMES.filter((n) => !names.has(n))).toEqual([]);
  });

  it("Error: 공개 진입 일곱과 재생 API 셋은 공개 배럴에 남는다 (test_SC014_public_entries_and_replay_remain)", () => {
    const names = new Set(Object.keys(publicDomain));
    const required = [...PUBLIC_ENTRY_NAMES, ...REPLAY_NAMES];
    expect(required).toHaveLength(10);
    expect(required.filter((n) => !names.has(n))).toEqual([]);
    for (const name of required) expect(typeof publicDomain[name], name).toBe("function");
  });
});

describe("SC-015: 정의 이벤트·결정 이벤트·커밋은 공개 진입을 거쳐서만 만들어진다", () => {
  it("Happy: 공개 함수 가운데 이벤트·커밋 조립 함수가 없고 내부 진입에서는 함수로 닿는다 (test_SC015_no_public_event_or_commit_builder)", () => {
    const publicRecord = publicDomain as unknown as Record<string, unknown>;
    const internalRecord = internalDomain as unknown as Record<string, unknown>;
    for (const name of EVENT_OR_COMMIT_BUILDERS) {
      expect(name in publicRecord, name).toBe(false);
      expect(publicRecord[name], name).toBeUndefined();
      expect(typeof internalRecord[name], name).toBe("function");
    }
  });

  it("Edge: 재생 API 결과는 커밋이 아니다 (test_SC015_replay_results_not_commits)", () => {
    const registered = registerDefinition(definitionDeps("surf015e"));
    const events = registered.commits.flatMap((c) => c.events);
    const workflow = publicDomain.foldWorkflowEvents(events);
    expect(workflow.ok).toBe(true);
    const stewardEvents = events.filter((e) => e.workId === registered.stewardId);
    const folded = publicDomain.foldEvents(stewardEvents);
    expect(folded.ok).toBe(true);
    const evolved = publicDomain.evolveCommit(undefined, stewardEvents);
    const results: unknown[] = [workflow, folded, evolved];
    if (workflow.ok) results.push(workflow.value);
    if (folded.ok) results.push(folded.value);
    for (const result of results) {
      expect(result).not.toHaveProperty("events");
      expect(publicDomain.isEngineCommit(result)).toBe(false);
    }
  });

  it("Error: 공개 진입을 거친 정의 생성 커밋만 표식을 가진다 (test_SC015_definition_event_commit_only_via_entry)", () => {
    const registered = registerDefinition(definitionDeps("surf015r"));
    expect(registered.grant.events.map((e) => e.type)).toContain("work_definition_created");
    expect(publicDomain.isEngineCommit(registered.grant)).toBe(true);
    const replayed = { id: registered.grant.id, events: [...registered.grant.events] };
    expect(publicDomain.isEngineCommit(replayed)).toBe(false);
  });
});

describe("SC-016: 시험은 내부 진입으로 옮긴 함수에 닿는다", () => {
  it("Happy: 내부 진입의 옮긴 이름은 모두 함수다 (test_SC016_internal_moved_names_are_functions)", () => {
    const internalRecord = internalDomain as unknown as Record<string, unknown>;
    for (const name of MOVED_NAMES) expect(typeof internalRecord[name], name).toBe("function");
  });

  it("Edge: 내부 진입은 공개 배럴의 모든 이름을 같은 값으로 다시 내보낸다 (test_SC016_internal_reexports_public_identically)", () => {
    const publicRecord = publicDomain as unknown as Record<string, unknown>;
    const internalRecord = internalDomain as unknown as Record<string, unknown>;
    const publicNames = Object.keys(publicRecord);
    expect(publicNames.length).toBeGreaterThanOrEqual(150);
    expect(publicNames.filter((n) => internalRecord[n] !== publicRecord[n])).toEqual([]);
    expect(Object.keys(internalRecord).sort()).toEqual([...publicNames, ...MOVED_NAMES].sort());
  });

  it("Error: 공개 배럴 이름공간에는 옮긴 이름이 없다 (test_SC016_public_namespace_lacks_moved_name)", () => {
    // @ts-expect-error 공개 배럴은 옮긴 조립 함수를 수출하지 않는다.
    const moved: unknown = publicDomain.assembleCommit;
    expect(moved).toBeUndefined();
    expect(Reflect.has(publicDomain, "decideTaskCommand")).toBe(false);
  });
});

describe("SC-018: 공개 진입이 돌려준 커밋은 모두 엔진 표식을 가진다", () => {
  it("Happy: 수용 커밋 — 명령·Work 생성·정의 명령·결정 신호·정의 신호 — 이 표식되고 깊게 동결된다 (test_SC018_accepted_commits_marked)", () => {
    const { deps, aggregate, taskId } = reachTaskState("DRAFT");
    const command = mustCommit(
      publicDomain.executeCommand(deps, aggregate, {
        kind: "begin_validation",
        taskId,
        expectedRevision: requireTaskFor(aggregate, taskId).revision,
        meta: meta(NOW),
      }),
    ).commit;
    const created = mustCommit(newWork(testDeps("surf018w"), "surf018w")).commit;
    const registered = registerAndMaterializeFirst(definitionDeps("surf018d"));
    const materialized = registered.journal.lastCommit();
    const paused = registered.journal.control(registered.definitionId, "pause", dayAt(0, "08:00"));
    expect(paused.kind).toBe("accepted");
    const waiting = reachWorkState("WAITING_APPROVAL");
    const granted = grantPlan(waiting.deps, waiting.aggregate);
    expect(granted.kind).toBe("accepted");
    const signalCommit = mustCommit(granted).commit;
    for (const commit of [command, created, materialized, registered.grant, signalCommit])
      expectSealed(commit);
    if (paused.kind === "accepted") expectSealed(paused.commit);
  });

  it("Edge: 거절 기록 커밋 — 종결 Task 명령·낡은 결정 신호·정의 신호 출처 거절 — 이 표식된다 (test_SC018_rejection_record_commits_marked)", () => {
    const done = reachTaskState("COMPLETED");
    const terminal = publicDomain.executeCommand(done.deps, done.aggregate, {
      kind: "begin_validation",
      taskId: done.taskId,
      expectedRevision: requireTaskFor(done.aggregate, done.taskId).revision,
      meta: meta(NOW),
    });
    expect(terminal.kind).toBe("rejected");
    if (terminal.kind !== "rejected" || terminal.record === undefined)
      throw new Error("expected terminal record");
    expectSealed(terminal.record);

    const waiting = reachWorkState("WAITING_APPROVAL");
    const decisionId = waiting.aggregate.work.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("expected decision");
    const stale = publicDomain.judgeSignal(
      waiting.deps,
      waiting.aggregate,
      {
        type: "human_decision",
        decisionId,
        choice: "grant",
        signalId: publicDomain.nextEntityId(waiting.deps.ids, "signal"),
        expectedRevision: waiting.aggregate.work.revision + 7,
        actorSource: "human_local",
        receivedAt: NOW,
      },
      { kind: "plan_grant" },
      NOW,
    );
    expect(stale.kind).toBe("rejected_stale");
    if (stale.kind !== "rejected_stale") throw new Error("expected stale record");
    expectSealed(stale.commit);

    const registered = registerDefinition(definitionDeps("surf018e"));
    const refused = registered.journal.control(registered.definitionId, "pause", dayAt(0), {
      actorSource: "agent_session",
    });
    expect(refused.kind).toBe("rejected");
    if (refused.kind !== "rejected") throw new Error("expected provenance record");
    expectSealed(refused.commit);
  });

  it("Error: 무효 grant 의 정렬된 커밋 목록 두 커밋이 모두 표식된다 (test_SC018_ordered_commits_marked)", () => {
    const { deps, aggregate } = driftedWaitingApproval();
    const judged = grantPlan(deps, aggregate);
    expect(judged.kind).toBe("stale_after_withdrawal");
    if (judged.kind !== "stale_after_withdrawal") throw new Error("expected ordered commits");
    expect(judged.commits).toHaveLength(2);
    for (const commit of judged.commits) expectSealed(commit);
  });

  it("Edge: 결과 객체와 커밋 목록 배열은 동결되고 애그리거트는 동결되지 않는다 (test_SC018_outcome_and_commits_array_frozen)", () => {
    const waiting = reachWorkState("WAITING_APPROVAL");
    const accepted = grantPlan(waiting.deps, waiting.aggregate);
    expect(accepted.kind).toBe("accepted");
    expect(Object.isFrozen(accepted)).toBe(true);
    if (accepted.kind === "accepted") expect(Object.isFrozen(accepted.aggregate)).toBe(false);

    const { deps, aggregate } = driftedWaitingApproval();
    const ordered = grantPlan(deps, aggregate);
    if (ordered.kind !== "stale_after_withdrawal") throw new Error("expected ordered commits");
    expect(Object.isFrozen(ordered)).toBe(true);
    expect(Object.isFrozen(ordered.commits)).toBe(true);
    expect(Object.isFrozen(ordered.aggregate)).toBe(false);
  });
});

describe("SC-019: 엔진 표식은 같은 모양의 다른 객체로 위조되지 않는다", () => {
  it("Happy: 같은 필드를 가진 일반 객체는 표식이 없다 (test_SC019_same_field_plain_object_unmarked)", () => {
    const commit = mustCommit(newWork(testDeps("surf019h"), "surf019h")).commit;
    expect(publicDomain.isEngineCommit(commit)).toBe(true);
    const clone: DomainCommit = { id: commit.id, events: commit.events };
    expect(publicDomain.isEngineCommit(clone)).toBe(false);
    expect(publicDomain.isEngineCommit(null)).toBe(false);
    expect(publicDomain.isEngineCommit("cmt_x")).toBe(false);
  });

  it("Edge: JSON 왕복 객체와 펼침 사본은 표식이 없다 (test_SC019_round_trip_and_spread_copy_unmarked)", () => {
    const commit = mustCommit(newWork(testDeps("surf019e"), "surf019e")).commit;
    const roundTripped = JSON.parse(JSON.stringify(commit)) as unknown;
    expect(roundTripped).toEqual(commit);
    expect(publicDomain.isEngineCommit(roundTripped)).toBe(false);
    expect(publicDomain.isEngineCommit({ ...commit })).toBe(false);
  });

  it("Error: 내부 진입 조립 함수의 커밋은 표식이 없다 (test_SC019_internal_assembled_commit_unmarked)", () => {
    const { deps, aggregate } = reachWorkState("DRAFT");
    const assembled = internalDomain.assembleCommit(
      deps,
      aggregate,
      [internalDomain.mkEvent("work_planning_started", {}, { workId: aggregate.work.id })],
      commitMeta(),
    );
    expect(assembled.commit.events.map((e) => e.type)).toEqual(["work_planning_started"]);
    expect(publicDomain.isEngineCommit(assembled.commit)).toBe(false);
  });
});

describe("SC-020: 재생 API 는 엔진 커밋 이벤트 열을 엔진 결과와 같게 접는다", () => {
  it("Happy: Task·Work 시나리오 이벤트 열을 foldEvents·evolveCommit 으로 접으면 엔진 애그리거트와 같다 (test_SC020_fold_equals_engine_aggregate)", () => {
    const base = plannedWithCommits([draft("one"), draft("two")], testDeps("surf020h"));
    const taskId = base.taskIds["one"];
    if (taskId === undefined) throw new Error("expected task");
    const validated = mustCommit(
      publicDomain.executeCommand(base.deps, base.aggregate, {
        kind: "begin_validation",
        taskId,
        expectedRevision: requireTaskFor(base.aggregate, taskId).revision,
        meta: meta(NOW),
      }),
    );
    const commits = [...base.commits, validated.commit];
    const folded = publicDomain.foldEvents(commits.flatMap((c) => c.events));
    expect(folded.ok).toBe(true);
    if (folded.ok) expect(folded.value).toEqual(validated.aggregate);
    const evolved = commits.reduce<WorkAggregate | undefined>(
      (current, commit) => publicDomain.evolveCommit(current, commit.events),
      undefined,
    );
    expect(evolved).toEqual(validated.aggregate);
  });

  it("Edge: 회차 materialize 를 포함한 다중 Work 정의 시나리오를 foldWorkflowEvents 로 접으면 엔진 상태와 같다 (test_SC020_workflow_fold_equals_engine_state)", () => {
    const registered = registerAndMaterializeFirst(definitionDeps("surf020e"));
    expect(Object.keys(registered.journal.state.works).length).toBeGreaterThanOrEqual(2);
    const folded = publicDomain.foldWorkflowEvents(
      registered.journal.commits.flatMap((c) => c.events),
    );
    expect(folded.ok).toBe(true);
    if (folded.ok) expect(folded.value).toEqual(registered.journal.state);
  });

  it("Error: 재생 API 는 표식을 요구하지 않아 JSON 왕복 이벤트도 같은 결과로 접는다 (test_SC020_replay_accepts_round_tripped_events)", () => {
    const base = plannedWithCommits([draft("one")], testDeps("surf020r"));
    const events = base.commits.flatMap((c) => c.events);
    const roundTripped = JSON.parse(JSON.stringify(events)) as readonly DomainEvent[];
    const direct = publicDomain.foldEvents(events);
    const replayed = publicDomain.foldEvents(roundTripped);
    expect(replayed.ok).toBe(true);
    expect(replayed).toEqual(direct);
    expect(publicDomain.evolveCommit(undefined, roundTripped)).toEqual(
      publicDomain.evolveCommit(undefined, events),
    );
  });
});

describe("SC-022: 단일 Work 조립은 다른 Work 를 가리키는 결정 이벤트를 막는다", () => {
  const OTHER_WORK = entityId("work", "wrk_otherwork1");

  it("Happy: 조립 대상과 다른 workId 를 실은 결정 이벤트는 DomainInvariantError (test_SC022_other_work_id_decided_event_invariant)", () => {
    const { deps, aggregate } = reachWorkState("DRAFT");
    expect(aggregate.work.id).not.toBe(OTHER_WORK);
    expect(() =>
      internalDomain.assembleCommit(
        deps,
        aggregate,
        [internalDomain.mkEvent("work_planning_started", {}, { workId: OTHER_WORK })],
        commitMeta(),
      ),
    ).toThrow(publicDomain.DomainInvariantError);
  });

  it("Edge: work_created 의 결정 workId 가 페이로드 workId 와 다르면 DomainInvariantError (test_SC022_work_created_other_work_id_invariant)", () => {
    const deps = testDeps("surf022e");
    const created = mustCommit(newWork(deps, "surf022e")).commit;
    const payload = created.events[0]?.payload;
    expect(created.events[0]?.type).toBe("work_created");
    expect(() =>
      internalDomain.assembleCommit(
        deps,
        undefined,
        [internalDomain.mkEvent("work_created", payload as never, { workId: OTHER_WORK })],
        commitMeta(),
      ),
    ).toThrow(publicDomain.DomainInvariantError);
  });

  it("Error: 조립 대상과 같은 workId 를 실으면 정상 조립된다 (test_SC022_same_work_id_assembles)", () => {
    const { deps, aggregate } = reachWorkState("DRAFT");
    const assembled = internalDomain.assembleCommit(
      deps,
      aggregate,
      [internalDomain.mkEvent("work_planning_started", {}, { workId: aggregate.work.id })],
      commitMeta(),
    );
    expect(assembled.commit.events.map((e) => e.workId)).toEqual([aggregate.work.id]);
    expect(assembled.aggregate.work.state).toBe("PLANNING");
  });
});

describe("SC-023: workId 없는 결정 이벤트의 귀속은 조립 대상 Work 다", () => {
  it("Happy: workId 없이 taskId 만 실은 결정 이벤트의 envelope workId 는 대상 Work 다 (test_SC023_absent_work_id_attributed_to_target)", () => {
    const { deps, aggregate, taskId } = reachTaskState("DRAFT");
    const assembled = internalDomain.assembleCommit(
      deps,
      aggregate,
      [internalDomain.mkEvent("task_validation_started", {}, { taskId })],
      commitMeta(),
    );
    expect(assembled.commit.events.map((e) => e.workId)).toEqual([aggregate.work.id]);
  });

  it("Edge: work_created 의 envelope workId 는 페이로드 workId 다 (test_SC023_work_created_attributed_to_payload)", () => {
    const deps = testDeps("surf023e");
    const created = mustCommit(newWork(deps, "surf023e")).commit;
    const payload = created.events[0]?.payload as unknown as { readonly workId: string };
    const assembled = internalDomain.assembleCommit(
      deps,
      undefined,
      [internalDomain.mkEvent("work_created", payload as never)],
      commitMeta(),
    );
    expect(assembled.commit.events.map((e) => e.workId)).toEqual([payload.workId]);
  });

  it("Error: workId 없는 것과 같은 것을 섞은 묶음은 모두 대상 Work 로 귀속된다 (test_SC023_mixed_batch_attributed_to_target)", () => {
    const { deps, aggregate, taskIds } = planned([draft("a"), draft("b")], testDeps("surf023r"));
    const a = taskIds["a"];
    const b = taskIds["b"];
    if (a === undefined || b === undefined) throw new Error("expected tasks");
    const assembled = internalDomain.assembleCommit(
      deps,
      aggregate,
      [
        internalDomain.mkEvent("task_validation_started", {}, { taskId: a }),
        internalDomain.mkEvent(
          "task_validation_started",
          {},
          { taskId: b, workId: aggregate.work.id },
        ),
      ],
      commitMeta(),
    );
    expect(assembled.commit.events.map((e) => e.workId)).toEqual([
      aggregate.work.id,
      aggregate.work.id,
    ]);
  });
});
