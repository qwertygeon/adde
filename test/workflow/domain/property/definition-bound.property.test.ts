// property: 상한·보류 해소 불변식.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { openOccurrenceCount } from "../../../../src/workflow/domain/index.js";
import type {
  UtcInstant,
  WorkDefinitionId,
  WorkId,
} from "../../../../src/workflow/domain/index.js";
import {
  dailyActivation,
  dayAt,
  definitionDeps,
  definitionDraft,
  payloadsOf,
  registerDefinition,
  signalDefinitionDraft,
} from "../helpers/definition-fixtures.js";
import type { MisfireSpec, WorkflowJournal } from "../helpers/definition-fixtures.js";
import { STEWARD_MEMBER } from "../helpers/definition-row-cases.js";

const MISFIRES: readonly MisfireSpec[] = [
  { kind: "skip" },
  { kind: "fire_once_now" },
  { kind: "catch_up_bounded", maxCatchUp: 1 },
  { kind: "catch_up_bounded", maxCatchUp: 2 },
];

function heldBound(misfire: MisfireSpec): number {
  return misfire.kind === "skip" ? 0 : misfire.kind === "fire_once_now" ? 1 : misfire.maxCatchUp;
}

function oldestOpen(journal: WorkflowJournal, definitionId: WorkDefinitionId): WorkId | undefined {
  return journal
    .occurrenceWorkIds(definitionId)
    .find((w) => !["COMPLETED", "FAILED", "CANCELED"].includes(journal.work(w).work.state));
}

function later(a: UtcInstant, b: UtcInstant): UtcInstant {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

describe("상한·보류 해소 — property: 열린 회차 상한·보류 수·순서·중복 없음", () => {
  it("일정 정의: 임의 상한·정책·도래·완료·해제 순서열에서 불변식이 성립한다 (test_SC063_property_schedule_bound_invariants)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.constantFrom(...MISFIRES),
        fc.array(
          fc.record({
            action: fc.constantFrom("due", "complete", "release"),
            lag: fc.integer({ min: 0, max: 2 }),
          }),
          {
            minLength: 1,
            maxLength: 12,
          },
        ),
        (maxOpen, misfire, steps) => {
          const { journal, definitionId } = registerDefinition(definitionDeps("propbound"), {
            draft: definitionDraft({
              maxOpenOccurrences: maxOpen,
              activation: dailyActivation({ misfire }),
            }),
            tasks: STEWARD_MEMBER,
          });
          let now: UtcInstant = dayAt(0, "06:00");
          for (const { action, lag } of steps) {
            const definition = journal.definition(definitionId);
            if (action === "due" && definition.pendingSchedule !== undefined) {
              now = later(now, dayAt(lag, "00:00"));
              now = later(now, definition.pendingSchedule.scheduledForUtc);
              const open = openOccurrenceCount(journal.state, definition);
              const outcome = journal.resolveDue(definitionId, now);
              if (definition.held.length > 0 && open < definition.maxOpenOccurrences) {
                // 보류와 빈 자리가 함께 있으면 도래 처리는 커밋하지 않는다.
                expect(outcome).toEqual({
                  kind: "rejected",
                  rejection: { reason: "condition_not_met", detail: "held_release_pending" },
                });
              } else {
                expect(outcome.kind).toBe("committed");
              }
            } else if (action === "complete") {
              const workId = oldestOpen(journal, definitionId);
              if (workId !== undefined) journal.completeWork(workId, now);
            } else if (action === "release" && definition.held.length > 0) {
              const expected = definition.held[0]?.occurrenceId;
              const outcome = journal.release(definitionId, now);
              if (outcome.kind === "committed") {
                expect(
                  payloadsOf(outcome.commit, "trigger_fired").map((f) => f["occurrenceId"]),
                ).toEqual([expected]);
              }
            }
            const after = journal.definition(definitionId);
            expect(openOccurrenceCount(journal.state, after)).toBeLessThanOrEqual(maxOpen);
            expect(after.held.length).toBeLessThanOrEqual(heldBound(misfire));
            const ids = after.materialized.map((m) => m.occurrenceId);
            expect(new Set(ids).size).toBe(ids.length);
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it("신호 정의: 신호 보류는 건너뛰지 않고 수용 순으로 해제되며 materialize 수는 maxOccurrences 이하다 (test_SC063_property_signal_bound_invariants)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.option(fc.integer({ min: 1, max: 6 }), { nil: undefined }),
        fc.array(fc.constantFrom("signal", "complete", "release"), { minLength: 1, maxLength: 14 }),
        (maxOpen, maxOccurrences, steps) => {
          const { journal, definitionId } = registerDefinition(definitionDeps("propsignal"), {
            draft: signalDefinitionDraft({
              maxOpenOccurrences: maxOpen,
              ...(maxOccurrences !== undefined ? { maxOccurrences } : {}),
            }),
            tasks: STEWARD_MEMBER,
          });
          const now = dayAt(0);
          let source = 0;
          for (const action of steps) {
            const definition = journal.definition(definitionId);
            const commitsBefore = journal.commits.length;
            if (action === "signal") {
              source += 1;
              journal.external(definitionId, `src-${source}`, now);
            } else if (action === "complete") {
              const workId = oldestOpen(journal, definitionId);
              if (workId !== undefined) journal.completeWork(workId, now);
            } else if (definition.held.length > 0 && definition.state === "ACTIVE") {
              const expected = definition.held[0]?.occurrenceId;
              const outcome = journal.release(definitionId, now);
              if (outcome.kind === "committed") {
                expect(
                  payloadsOf(outcome.commit, "trigger_fired").map((f) => f["occurrenceId"]),
                ).toEqual([expected]);
              }
            }
            const after = journal.definition(definitionId);
            // 신호 보류는 중지 밖에서 건너뛰지 않는다.
            for (const commit of journal.commits.slice(commitsBefore)) {
              const stopped = commit.events.some((e) => e.type === "work_definition_stopped");
              if (!stopped)
                expect(payloadsOf(commit, "work_definition_occurrences_skipped")).toEqual([]);
            }
            expect(openOccurrenceCount(journal.state, after)).toBeLessThanOrEqual(maxOpen);
            if (maxOccurrences !== undefined)
              expect(after.materialized.length).toBeLessThanOrEqual(maxOccurrences);
            const sources = after.held.map((h) =>
              Number(
                (
                  h.input as { signal: { sourceOccurrenceId: string } }
                ).signal.sourceOccurrenceId.slice(4),
              ),
            );
            expect([...sources].sort((a, b) => a - b)).toEqual(sources);
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
