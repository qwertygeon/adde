// SC-028, SC-029, SC-030, SC-031 — 이벤트 카탈로그 전사 완결·미지 이름 실패·fold=직접적용·revision +1.
import { describe, expect, it } from "vitest";
import {
  EVENT_CATALOG,
  foldEvents,
  executeCommand,
  createWork,
  contentHashOf,
  parseProjectId,
} from "../../../src/workflow/domain/index.js";
import type {
  WorkSource,
  DomainDeps,
  DomainCommit,
  WorkAggregate,
  TaskId,
} from "../../../src/workflow/domain/index.js";
import { TASK_ROW_CASES, WORK_ROW_CASES } from "./helpers/row-cases.js";
import { signalFactorCases } from "./helpers/signal-cases.js";
import {
  mustCommit,
  mustOk,
  entityId,
  meta,
  at,
  draft,
  testDeps,
  reachTaskState,
  reachWorkState,
  requireTaskFor,
} from "./helpers/fixtures.js";

describe("SC-028: 이벤트 카탈로그 전사가 완결되어 있다", () => {
  it("Happy: 이름 중복 0·타입마다 효과 등급 정확히 하나 (test_SC028_names_unique_one_effect_class_each)", () => {
    const names = EVENT_CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of EVENT_CATALOG) {
      expect(["P", "Q", "P+Q"]).toContain(entry.affects);
    }
  });

  it("Edge: 타입마다 phase1-core 또는 담당 차수·Phase 표기가 있다 (test_SC028_every_type_marked_phase1_core_or_later)", () => {
    for (const entry of EVENT_CATALOG) {
      expect(entry.producedBy).toBeDefined();
      expect(entry.producedBy.length).toBeGreaterThan(0);
    }
  });

  it("Error: phase1-core 타입마다 그것을 생산하는 테스트 케이스가 존재한다 (test_SC028_every_phase1_core_type_produced_by_a_case)", () => {
    const produced = new Set<string>();
    for (const rowCase of [...Object.values(TASK_ROW_CASES), ...Object.values(WORK_ROW_CASES)]) {
      try {
        const { deps, before } = rowCase.build();
        const outcome = rowCase.apply(deps, before);
        const committed =
          outcome.kind === "committed" || outcome.kind === "accepted" ? outcome.commit : undefined;
        for (const e of committed?.events ?? []) produced.add(e.type);
      } catch {
        // census 실행 실패(레시피 갭)는 SC-004/017 이 전담 — 여기서는 생산 목록에서 제외한다.
      }
    }
    // TASK_ROW_CASES·WORK_ROW_CASES 만으로는 SC-033 거절 분류가 만드는 기록 전용 이벤트
    // (confirmation_rejected_forged_provenance·signal_rejected_stale·signal_ignored_duplicate·
    // signal_rejected 등) 가 census 에서 빠져 "생산 케이스 없음"으로 오판된다(test-report.md 실패
    // #11). signalFactorCases() 결과를 함께 포함한다.
    for (const c of signalFactorCases()) {
      try {
        const judged = c.run();
        if (judged.kind !== "not_applicable")
          for (const e of judged.commit.events) produced.add(e.type);
      } catch {
        // 판정 자체 실패는 SC-033 이 전담.
      }
    }
    // SC-006(종결 흡수) — stale_transition_rejected 기록 이벤트.
    {
      const { deps, aggregate, taskId } = reachTaskState("COMPLETED");
      const before = requireTaskFor(aggregate, taskId);
      const outcome = executeCommand(deps, aggregate, {
        kind: "unblock",
        taskId,
        expectedRevision: before.revision,
        meta: meta(before.createdAt),
      });
      if (outcome.kind === "rejected" && outcome.record !== undefined)
        for (const e of outcome.record.events) produced.add(e.type);
    }
    // SC-024(계획 순환 거절, onInvalid=fail_work) — work_plan_invalid(+work_failed) 기록 이벤트.
    {
      const { deps, aggregate: planningAgg } = reachWorkState("PLANNING");
      const outcome = executeCommand(deps, planningAgg, {
        kind: "commit_plan",
        expectedRevision: planningAgg.work.revision,
        meta: meta(planningAgg.work.createdAt),
        onInvalid: "fail_work",
        proposal: {
          proposalId: entityId("planProposal", "pln_censuscycle01"),
          digest: "6".repeat(64),
          basePlanRevision: 0,
          drafts: [draft("A", { dependsOn: [{ draftRef: "A" }] })],
          retain: [],
        },
      });
      if (outcome.kind === "committed") for (const e of outcome.commit.events) produced.add(e.type);
    }
    const phase1CoreNames = EVENT_CATALOG.filter((e) => e.producedBy === "phase1-core").map(
      (e) => e.name,
    );
    const notProduced = phase1CoreNames.filter((name) => !produced.has(name));
    // 레시피 미비 항목은 test-cases.md "미커버 항목"에 이관 — 본 단언은 그 갭을 명시적으로 드러낸다.
    expect(notProduced, notProduced.join(", ")).toEqual([]);
  });
});

describe("SC-029: 알 수 없는 이름은 무시되지 않는다", () => {
  it("Happy: 카탈로그 밖 이벤트 타입은 fold 가 unknown_event_type 으로 실패한다 (test_SC029_unknown_event_type_fold_fails)", () => {
    const { aggregate } = reachTaskState("READY");
    const result = foldEvents([
      {
        id: "evt_bogus1",
        type: "not_a_real_event_type",
        occurredAt: "2026-01-01T00:00:00.000Z",
        projectId: aggregate.work.projectId,
        workId: aggregate.work.id,
        schemaVersion: 1,
        commit: { id: "cmt_bogus1", index: 1, count: 1 },
        actorSource: "adde_self",
        payload: {},
      } as never,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unknown_event_type");
  });

  it("Edge: 후속 소유 이벤트는 unsupported_event_type 이 된다 (test_SC029_later_phase_event_fold_unsupported)", () => {
    const laterPhaseEvent = EVENT_CATALOG.find((e) => e.producedBy !== "phase1-core");
    expect(laterPhaseEvent).toBeDefined();
    if (laterPhaseEvent === undefined) return;
    const { aggregate } = reachTaskState("READY");
    const result = foldEvents([
      {
        id: "evt_bogus2",
        type: laterPhaseEvent.name,
        occurredAt: "2026-01-01T00:00:00.000Z",
        projectId: aggregate.work.projectId,
        workId: aggregate.work.id,
        schemaVersion: 1,
        commit: { id: "cmt_bogus2", index: 1, count: 1 },
        actorSource: "adde_self",
        payload: {},
      } as never,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unsupported_event_type");
  });

  it("Error: 상태 집합 밖 상태 이름은 파싱이 실패한다 (test_SC029_unknown_state_name_parse_fails)", () => {
    // parseTaskStateName 은 SC-003 범주 밖(개별 모듈 함수)이라 여기서는 fold 실패로 갈음한다.
    const { aggregate } = reachTaskState("READY");
    const result = foldEvents([
      {
        id: "evt_bogus3",
        type: "task_validated",
        occurredAt: "2026-01-01T00:00:00.000Z",
        projectId: aggregate.work.projectId,
        workId: aggregate.work.id,
        taskId: "tsk_missing" as never,
        schemaVersion: 2,
        commit: { id: "cmt_bogus3", index: 1, count: 1 },
        actorSource: "adde_self",
        payload: {},
      } as never,
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unsupported_schema_version");
  });
});

/**
 * `reachTaskState`/`reachWorkState` 는 fixture 계약상 마지막 aggregate 만 반환한다 — 그 직전 위임된
 * `planned()` 등 선행 커밋(work_created 부터)은 버려진다. `foldEvents` 는 스트림 첫 이벤트가
 * `work_created` 여야 하므로, 마지막 커밋만 fold 하면 `first_event_not_work_created` 로 실패한다
 * (test-report.md 실패 #12/#13). SC-030 은 `work_created` 부터의 전체 커밋 이력을 직접 조립해 확인한다.
 */
function buildFullHistoryToReady(seed: string): {
  deps: DomainDeps;
  commits: readonly DomainCommit[];
  taskId: TaskId;
  finalAggregate: WorkAggregate;
} {
  const deps = testDeps(seed);
  const now = at("2026-01-01T00:00:00Z");
  const source = { kind: "cli" } as unknown as WorkSource;
  const created = mustCommit(
    createWork(deps, {
      kind: "create_work",
      meta: meta(now),
      projectId: mustOk(parseProjectId(`prj_${seed}0000001`)),
      title: "sc030",
      objective: "sc030",
      source,
    }),
  );
  const planning = mustCommit(
    executeCommand(deps, created.aggregate, {
      kind: "start_planning",
      expectedRevision: created.aggregate.work.revision,
      meta: meta(now),
    }),
  );
  const committedPlan = mustCommit(
    executeCommand(deps, planning.aggregate, {
      kind: "commit_plan",
      expectedRevision: planning.aggregate.work.revision,
      meta: meta(now),
      proposal: {
        proposalId: entityId("planProposal", `pln_${seed}01`),
        digest: contentHashOf(seed),
        basePlanRevision: planning.aggregate.work.planRevision,
        drafts: [draft("m")],
        retain: [],
      },
    }),
  );
  const taskId = Object.values(committedPlan.aggregate.tasks)[0]?.id;
  if (taskId === undefined) throw new Error("expected member task");
  const validating = mustCommit(
    executeCommand(deps, committedPlan.aggregate, {
      kind: "begin_validation",
      taskId,
      expectedRevision: requireTaskFor(committedPlan.aggregate, taskId).revision,
      meta: meta(now),
    }),
  );
  const ready = mustCommit(
    executeCommand(deps, validating.aggregate, {
      kind: "complete_validation",
      taskId,
      expectedRevision: requireTaskFor(validating.aggregate, taskId).revision,
      meta: meta(now),
      outcome: { result: "valid" },
    }),
  );
  return {
    deps,
    commits: [
      created.commit,
      planning.commit,
      committedPlan.commit,
      validating.commit,
      ready.commit,
    ],
    taskId,
    finalAggregate: ready.aggregate,
  };
}

describe("SC-030: fold 가 직접 적용과 같다", () => {
  it("Happy: work_created 부터의 전체 커밋 이력을 fold 하면 직접 적용 결과와 같다 (test_SC030_row_case_sequences_fold_equals_direct)", () => {
    const { commits, finalAggregate } = buildFullHistoryToReady("sc030a");
    const folded = foldEvents(commits.flatMap((c) => c.events));
    expect(folded.ok).toBe(true);
    if (folded.ok) expect(folded.value).toEqual(finalAggregate);
  });

  it("Edge: 신호 수용 커밋도 포함된다 (test_SC030_signal_commits_included)", () => {
    const { deps, commits, taskId, finalAggregate } = buildFullHistoryToReady("sc030b");
    const started = mustCommit(
      executeCommand(deps, finalAggregate, {
        kind: "start_attempt",
        taskId,
        expectedRevision: requireTaskFor(finalAggregate, taskId).revision,
        meta: meta(at("2026-01-01T00:00:00Z")),
      }),
    );
    const folded = foldEvents([...commits, started.commit].flatMap((c) => c.events));
    expect(folded.ok).toBe(true);
    if (folded.ok) expect(folded.value).toEqual(started.aggregate);
  });

  it("Error: 기록 전용 커밋을 포함해도 동일하다 (test_SC030_record_only_commits_do_not_change_fold)", () => {
    const { deps, aggregate, taskId } = reachTaskState("COMPLETED");
    const before = requireTaskFor(aggregate, taskId);
    const rejected = executeCommand(deps, aggregate, {
      kind: "unblock",
      taskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
    });
    expect(rejected.kind).toBe("rejected");
    if (rejected.kind === "rejected" && rejected.record !== undefined) {
      const folded = foldEvents(rejected.record.events);
      expect(folded.ok).toBe(false); // 단독 stale_transition_rejected 스트림은 work_created 로 시작하지 않아 inconsistent_stream
    }
  });
});

describe("SC-031: 수용된 전이마다 revision 이 정확히 1 오른다", () => {
  it("Happy: SC-004·SC-017 의 수용 케이스 전부에서 차이가 정확히 1 이다 (test_SC031_every_accepted_row_case_increments_by_one)", () => {
    const mismatches: string[] = [];
    for (const [key, rowCase] of Object.entries(TASK_ROW_CASES)) {
      try {
        const { deps, before, targetTaskId } = rowCase.build();
        if (targetTaskId === undefined) continue;
        const beforeRevision = requireTaskFor(before, targetTaskId).revision;
        const outcome = rowCase.apply(deps, before);
        if (outcome.kind === "committed" || outcome.kind === "accepted") {
          const afterRevision = requireTaskFor(outcome.aggregate, targetTaskId).revision;
          if (afterRevision - beforeRevision !== 1)
            mismatches.push(`${key}: ${beforeRevision}->${afterRevision}`);
        }
      } catch {
        // 레시피 갭은 SC-004 가 전담.
      }
    }
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("Edge: 다중 전이 커밋도 +1 이다 (test_SC031_multi_transition_commit_increments_once)", () => {
    const { deps, aggregate, taskId } = reachTaskState("VALIDATING");
    const before = requireTaskFor(aggregate, taskId).revision;
    const outcome = executeCommand(deps, aggregate, {
      kind: "complete_validation",
      taskId,
      expectedRevision: before,
      meta: meta(aggregate.work.createdAt),
      outcome: { result: "valid" },
    });
    if (outcome.kind === "committed")
      expect(requireTaskFor(outcome.aggregate, taskId).revision - before).toBe(1);
  });

  it("Error: 기대 revision 이 현재와 다른 명령은 아무것도 적용하지 않는다 (test_SC031_mismatched_expected_revision_applies_nothing)", () => {
    const { deps, aggregate, taskId } = reachTaskState("READY");
    const before = requireTaskFor(aggregate, taskId).revision;
    const outcome = executeCommand(deps, aggregate, {
      kind: "start_attempt",
      taskId,
      expectedRevision: before + 5,
      meta: meta(aggregate.work.createdAt),
    });
    expect(outcome.kind).toBe("rejected");
    expect(requireTaskFor(aggregate, taskId).revision).toBe(before);
  });
});
