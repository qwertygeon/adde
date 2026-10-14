// property: 정의 revision 은 전이 커밋마다 정확히 1 오르고 STOPPED 뒤 불변이다.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { dayAt, definitionDeps, registerDefinition } from "../helpers/definition-fixtures.js";
import { STEWARD_MEMBER } from "../helpers/definition-row-cases.js";

const TRANSITIONS: ReadonlySet<string> = new Set([
  "work_definition_created",
  "work_definition_revised",
  "work_definition_paused",
  "work_definition_resumed",
  "work_definition_stopped",
]);

const ACTIONS = ["pause", "resume", "stop", "stale_pause", "amend", "due"] as const;

describe("정의 revision — property: 커밋별 revision 차 = 전이 이벤트 유무", () => {
  it("임의 제어·개정·회차 순서열에서 revision 차가 전이 커밋 수와 같고 STOPPED 뒤 불변이다 (test_SC063_property_definition_revision_per_transition_commit)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...ACTIONS), { minLength: 1, maxLength: 10 }),
        (steps) => {
          const { journal, definitionId } = registerDefinition(definitionDeps("proprev"), {
            tasks: STEWARD_MEMBER,
          });
          let k = 0;
          for (const action of steps) {
            const before = journal.definition(definitionId);
            const commitsBefore = journal.commits.length;
            const now = dayAt(k, "06:00");
            try {
              if (action === "pause" || action === "resume" || action === "stop")
                journal.control(definitionId, action, now);
              else if (action === "stale_pause")
                journal.control(definitionId, "pause", now, {
                  expectedRevision: before.revision + 7,
                });
              else if (action === "amend" && before.state !== "STOPPED")
                journal.amend(definitionId, { title: `t${k}` }, now);
              else if (
                action === "due" &&
                before.state === "ACTIVE" &&
                before.pendingSchedule !== undefined
              ) {
                const due = journal.resolveDue(
                  definitionId,
                  before.pendingSchedule.scheduledForUtc,
                );
                if (due.kind === "committed") k += 1;
              }
            } catch {
              // 개정 경로의 진행기 전제(재계획 열기 등)가 이 순서열에서 성립하지 않으면 그 단계를 건너뛴다.
            }
            const after = journal.definition(definitionId);
            const transitionCommits = journal.commits
              .slice(commitsBefore)
              .filter((c) => c.events.some((e) => TRANSITIONS.has(e.type))).length;
            expect(after.revision - before.revision).toBe(transitionCommits);
            expect(transitionCommits).toBeLessThanOrEqual(1);
            if (before.state === "STOPPED") expect(after).toEqual(before);
            k += 1;
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
