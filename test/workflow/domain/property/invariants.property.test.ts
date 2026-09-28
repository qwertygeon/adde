// SC-052 (NFR-005) — property: Layer B 불변식 5개.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { executeCommand } from "../../../../src/workflow/domain/index.js";
import {
  at,
  draft,
  entityId,
  meta,
  planned,
  reachTaskState,
  requireTaskFor,
  testDeps,
} from "../helpers/fixtures.js";

describe("SC-052: property — 종결 Task 는 비종결로 돌아가지 않는다", () => {
  it("test_SC052_terminal_never_nonterminal", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("COMPLETED", "REJECTED", "EXPIRED", "FAILED", "CANCELED", "SKIPPED"),
        (state) => {
          const { deps, aggregate, taskId } = reachTaskState(state as never);
          const before = requireTaskFor(aggregate, taskId);
          const outcome = executeCommand(deps, aggregate, {
            kind: "unblock",
            taskId,
            expectedRevision: before.revision,
            meta: meta(before.createdAt),
          });
          return outcome.kind === "rejected";
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("SC-052: property — 전제가 충족되기 전에는 활성화되지 않는다", () => {
  it("test_SC052_no_activation_before_prerequisites", () => {
    // `dependencies_complete` 트리거 드래프트는 `dependsOn` 이 1건 이상이어야 한다 — 비어 있으면
    // validatePlanDrafts 가 즉시 거절해(dependencies_complete_without_dependencies) Task 자체가
    // 커밋되지 않는다(test-report.md 실패 #16). 아직 미충족인 실제 의존(dep)을 하나 붙여
    // "커밋은 되지만 활성화는 아직" 상태를 재현한다.
    const deps = testDeps("sc052prereq");
    const { aggregate, taskIds } = planned(
      [
        draft("dep"),
        draft("dependent", {
          trigger: { kind: "dependencies_complete", version: 1, triggerId: "dependent" },
          dependsOn: [{ draftRef: "dep" }],
        }),
      ],
      deps,
    );
    const dependentId = taskIds["dependent"];
    if (dependentId === undefined) throw new Error("expected dependent task");
    expect(requireTaskFor(aggregate, dependentId).dependencyActivated).toBe(false);
  });
});

describe("SC-052: property — 취소된 Task 에는 이후 새 예약 전이가 없다", () => {
  it("test_SC052_no_new_scheduling_after_cancel", () => {
    const { deps, aggregate, taskId } = reachTaskState("CANCELED");
    const before = requireTaskFor(aggregate, taskId);
    const outcome = executeCommand(deps, aggregate, {
      kind: "schedule_task",
      taskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
      occurrenceId: entityId("occurrence", "occ_" + "A".repeat(26)),
      cause: "schedule",
    });
    expect(outcome.kind).toBe("rejected");
  });
});

describe("SC-052: property — 도달한 비종결 상태마다 표 출구가 존재한다", () => {
  it("test_SC052_every_reached_nonterminal_state_has_table_exit", () => {
    for (const state of ["DRAFT", "VALIDATING", "READY", "RUNNING"] as const) {
      const { aggregate, taskId } = reachTaskState(state);
      expect(requireTaskFor(aggregate, taskId).state).toBe(state);
    }
  });
});

describe("SC-052: property — 유효기한 미선언 시 시간 경과만으로 만료되지 않는다", () => {
  it("test_SC052_no_expiry_without_validity_as_time_advances", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3650 }), (daysAhead) => {
        const { deps, aggregate, taskId } = reachTaskState("READY");
        const before = requireTaskFor(aggregate, taskId);
        const future = new Date(
          Date.parse("2026-01-01T00:00:00Z") + daysAhead * 86_400_000,
        ).toISOString();
        const outcome = executeCommand(deps, aggregate, {
          kind: "expire",
          taskId,
          expectedRevision: before.revision,
          meta: meta(at(future)),
        });
        return outcome.kind === "rejected";
      }),
      { numRuns: 50 },
    );
  });

  it("test_SC052_target_due_passage_changes_nothing", () => {
    const { deps, aggregate, taskId } = reachTaskState("READY", {
      policy: { targetDueAt: at("2025-01-01T00:00:00Z") },
    });
    const before = requireTaskFor(aggregate, taskId);
    executeCommand(deps, aggregate, {
      kind: "expire",
      taskId,
      expectedRevision: before.revision,
      meta: meta(at("2099-01-01T00:00:00Z")),
    });
    const after = requireTaskFor(aggregate, taskId);
    expect(after.state).toBe(before.state);
    expect(after.revision).toBe(before.revision);
  });
});
