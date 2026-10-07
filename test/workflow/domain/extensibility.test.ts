// SC-051 — 새 TaskType 이 등록만으로 종결까지 간다(확장성 수용).
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeCommand } from "../../../src/workflow/domain/index.js";
import type { TaskId } from "../../../src/workflow/domain/index.js";
import {
  at,
  meta,
  draft,
  planned,
  mustCommit,
  reachWorkState,
  requireTaskFor,
  testDeps,
} from "./helpers/fixtures.js";
import { testRegistries, probeTaskType } from "./helpers/registry-fixtures.js";
import { eventTypes, payloadOf } from "./helpers/commits.js";

const NOW = at("2026-01-01T00:00:00Z");
// vitest 는 저장소 루트를 작업 디렉터리로 실행한다(vitest.config.ts 의 include 기준).
const TEST_DIR = path.join(process.cwd(), "test/workflow/domain");
const PROBE = { id: probeTaskType().id, version: probeTaskType().version };

describe("SC-051: 새 TaskType 이 등록만으로 종결까지 간다", () => {
  it("Happy: 등록한 시험 유형이 계획·검증·시작·완료를 거쳐 COMPLETED 에 이른다 (test_SC051_new_task_type_reaches_completed_by_registration)", () => {
    const deps = testDeps("sc051", testRegistries({ taskTypes: [probeTaskType()] }));
    const { aggregate, taskIds } = planned(
      [draft("probe", { type: PROBE, input: { subject: "extension" } })],
      deps,
    );
    const taskId = taskIds["probe"];
    if (taskId === undefined) throw new Error("expected task");
    let current = aggregate;
    const step = (
      kind: "begin_validation" | "complete_validation" | "start_attempt",
      id: TaskId,
    ) => {
      current = mustCommit(
        executeCommand(deps, current, {
          kind,
          taskId: id,
          expectedRevision: requireTaskFor(current, id).revision,
          meta: meta(NOW),
        }),
      ).aggregate;
    };
    step("begin_validation", taskId);
    step("complete_validation", taskId);
    expect(requireTaskFor(current, taskId).state).toBe("READY");
    step("start_attempt", taskId);
    const attemptId = requireTaskFor(current, taskId).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    const completed = mustCommit(
      executeCommand(deps, current, {
        kind: "record_attempt_outcome",
        taskId,
        expectedRevision: requireTaskFor(current, taskId).revision,
        meta: meta(NOW),
        attemptId,
        outcome: { kind: "completed", evidence: { result: "done" }, outputs: { result: "done" } },
      }),
    ).aggregate;
    expect(requireTaskFor(completed, taskId).state).toBe("COMPLETED");
    expect(completed.work.state).toBe("COMPLETED");
  });

  it("Edge: 등록이 유일한 차이 — 내장 등록부만이면 같은 계획이 무효다 (test_SC051_same_flow_without_registration_plan_invalid)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    expect(deps.registries.taskTypes.get(PROBE.id, PROBE.version)).toBeUndefined();
    const outcome = executeCommand(deps, aggregate, {
      kind: "commit_plan",
      expectedRevision: aggregate.work.revision,
      meta: meta(NOW),
      plan: {
        basePlanRevision: aggregate.work.planRevision,
        source: "planner",
        tasks: [draft("probe", { type: PROBE, input: { subject: "extension" } })],
        retain: [],
      },
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(eventTypes(outcome.commit)).not.toContain("task_created");
    expect(payloadOf(outcome.commit, "work_plan_invalid")["issues"]).toContainEqual({
      kind: "draft_invalid",
      draftRef: "probe",
      reason: {
        kind: "descriptor_unknown",
        descriptors: [{ axis: "task_type", id: PROBE.id, version: PROBE.version }],
      },
    });
  });

  it("Error: 도메인 테스트는 공개 배럴로만 도메인을 가져온다 (test_SC051_test_imports_barrel_only)", () => {
    const testDir = TEST_DIR;
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(testDir);
    expect(files.length).toBeGreaterThan(10);
    const specifierRe = /from\s+["']([^"']+)["']/g;
    const classify = (content: string) => {
      const barrel: string[] = [];
      const other: string[] = [];
      for (const match of content.matchAll(specifierRe)) {
        const spec = match[1] ?? "";
        if (!spec.includes("/src/")) continue;
        (spec.endsWith("/src/workflow/domain/index.js") ? barrel : other).push(spec);
      }
      return { barrel, other };
    };
    const offending: string[] = [];
    let barrelImports = 0;
    for (const file of files) {
      const { barrel, other } = classify(fs.readFileSync(file, "utf8"));
      barrelImports += barrel.length;
      for (const spec of other) offending.push(`${path.relative(testDir, file)}: ${spec}`);
    }
    // 스캐너 자기 점검: 배럴 import 를 실제로 포착하고, 개별 모듈 경로를 위반으로 분류한다.
    expect(barrelImports).toBeGreaterThanOrEqual(files.length / 2);
    expect(
      // 이 파일 자신이 스캔 대상이므로 합성 지정자는 이어 붙여 만든다.
      classify(
        [
          "imp",
          "ort { decideRetry } fr",
          'om "../../../src/workflow/domain/policy/retry.js";',
        ].join(""),
      ).other,
    ).toHaveLength(1);
    expect(offending).toEqual([]);
  });
});
