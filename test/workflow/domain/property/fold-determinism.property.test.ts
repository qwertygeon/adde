// SC-046 (NFR-002) — property: 임의 명령 순서열에서 fold 가 직접 적용과 같다.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { executeCommand, foldEvents } from "../../../../src/workflow/domain/index.js";
import { meta, plannedWithCommits, draft, testDeps, requireTaskFor } from "../helpers/fixtures.js";

/** 명령 종류를 몇 가지로 좁혀 생성한다 — Work 1·Task 1~4·명령 ≤ 30 (design.md 테스트 전략 SC-046 비고). */
const COMMAND_STEP_ARB = fc.constantFrom<
  "begin_validation" | "complete_validation_valid" | "start_attempt" | "complete_and_advance"
>("begin_validation", "complete_validation_valid", "start_attempt", "complete_and_advance");

describe("SC-046: property — 임의 명령 순서열에서 fold 가 직접 적용과 같다", () => {
  it("Happy: 생성된 명령열에서 직접 적용 결과와 fold 결과가 같다 (test_SC046_generated_sequences_fold_equals_direct)", () => {
    fc.assert(
      fc.property(fc.array(COMMAND_STEP_ARB, { minLength: 0, maxLength: 30 }), (steps) => {
        const deps = testDeps("propertyfold");
        const initial = plannedWithCommits([draft("p1")], deps);
        let aggregate = initial.aggregate;
        // `foldEvents` 는 스트림 첫 이벤트가 `work_created` 여야 한다 — steps 가 빈 배열이어도
        // fold 대상은 이 초기 구성 커밋들부터 시작해야 한다(test-report.md 류 실패 — 빈 events 로
        // fold 하면 무조건 실패한다).
        const events: unknown[] = [...initial.commits.flatMap((c) => c.events)];
        const taskId = Object.values(aggregate.tasks)[0]?.id;
        if (taskId === undefined) throw new Error("expected task");
        for (const step of steps) {
          const task = requireTaskFor(aggregate, taskId);
          let outcome;
          if (step === "begin_validation" && task.state === "DRAFT") {
            outcome = executeCommand(deps, aggregate, {
              kind: "begin_validation",
              taskId,
              expectedRevision: task.revision,
              meta: meta(task.createdAt),
            });
          } else if (step === "complete_validation_valid" && task.state === "VALIDATING") {
            outcome = executeCommand(deps, aggregate, {
              kind: "complete_validation",
              taskId,
              expectedRevision: task.revision,
              meta: meta(task.createdAt),
              outcome: { result: "valid" },
            });
          } else if (step === "start_attempt" && task.state === "READY") {
            outcome = executeCommand(deps, aggregate, {
              kind: "start_attempt",
              taskId,
              expectedRevision: task.revision,
              meta: meta(task.createdAt),
            });
          } else if (step === "complete_and_advance" && task.state === "RUNNING") {
            const attemptId = task.openAttempt?.attemptId;
            if (attemptId !== undefined) {
              outcome = executeCommand(deps, aggregate, {
                kind: "record_attempt_outcome",
                taskId,
                expectedRevision: task.revision,
                meta: meta(task.createdAt),
                attemptId,
                outcome: { kind: "completed", evidence: {} },
              });
            }
          }
          if (outcome !== undefined && outcome.kind === "committed") {
            events.push(...outcome.commit.events);
            aggregate = outcome.aggregate;
          }
        }
        const folded = foldEvents(events as never);
        expect(folded.ok).toBe(true);
        if (folded.ok) expect(folded.value).toEqual(aggregate);
      }),
      { numRuns: 100 },
    );
  });

  it("Edge: 같은 순서열을 두 번 적용한 이벤트가 바이트 단위로 같다 (test_SC046_double_application_byte_identical)", () => {
    const deps1 = testDeps("propertyfoldb");
    const deps2 = testDeps("propertyfoldb");
    const a = plannedWithCommits([draft("p1")], deps1);
    const b = plannedWithCommits([draft("p1")], deps2);
    expect(JSON.stringify(a.aggregate)).toBe(JSON.stringify(b.aggregate));
  });
});
