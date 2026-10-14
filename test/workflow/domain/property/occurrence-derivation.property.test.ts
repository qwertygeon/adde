// property: 회차 파생은 결정적이고 소유자·신호 출처 회차로 분리된다.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { deriveOccurrenceId } from "../../../../src/workflow/domain/index.js";
import {
  dayAt,
  definitionDeps,
  registerDefinition,
  signalDefinitionDraft,
} from "../helpers/definition-fixtures.js";
import { at, entityId, mustOk } from "../helpers/fixtures.js";

const OCC_FORMAT = /^occ_[A-Z2-7]{26}$/;
const body = fc.stringMatching(/^[a-z0-9]{6,12}$/);
const instant = fc
  .integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2100, 0, 1) })
  .map((ms) => at(new Date(ms).toISOString()));

describe("회차 파생 — property: 결정성·소유자 분리·신호 출처 회차 분리", () => {
  it("같은 입력은 같은 ID·형식이고 Task·정의 소유자는 분리된다 (test_SC063_property_occurrence_derivation_deterministic_and_owner_separated)", () => {
    fc.assert(
      fc.property(
        body,
        fc.stringMatching(/^[a-z_]{1,10}$/),
        instant,
        fc.nat({ max: 10_000 }),
        (raw, triggerId, scheduledForUtc, recurrenceIndex) => {
          const definitionOwned = {
            kind: "schedule" as const,
            ownerId: entityId("workDefinition", `wdf_${raw}`),
            triggerId,
            scheduledForUtc,
            recurrenceIndex,
          };
          const first = mustOk(deriveOccurrenceId(definitionOwned));
          expect(mustOk(deriveOccurrenceId({ ...definitionOwned }))).toBe(first);
          expect(first).toMatch(OCC_FORMAT);
          const taskOwned = mustOk(
            deriveOccurrenceId({ ...definitionOwned, ownerId: entityId("task", `tsk_${raw}`) }),
          );
          expect(taskOwned).not.toBe(first);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("신호 출처 회차 튜플이 다르면 회차 ID 가 다르다 (test_SC063_property_signal_tuple_distinct_ids)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9-]{1,8}$/), { minLength: 2, maxLength: 5 }),
        (sources) => {
          const { journal, definitionId } = registerDefinition(definitionDeps("propderiv"), {
            draft: signalDefinitionDraft({ maxOpenOccurrences: 10 }),
          });
          for (const source of sources) {
            expect(journal.external(definitionId, source, dayAt(0)).kind).toBe("accepted");
          }
          const ids = journal.definition(definitionId).materialized.map((m) => m.occurrenceId);
          expect(ids).toHaveLength(sources.length);
          expect(new Set(ids).size).toBe(sources.length);
        },
      ),
      { numRuns: 30 },
    );
  });
});
