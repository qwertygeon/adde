// SC-055 — property: 재계획 커밋 뒤 fold 한 member 집합 = 보존(작성 순) ∪ 새 Task, 커밋 전 종결 Task 는 그대로.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { executeCommand } from "../../../../src/workflow/domain/index.js";
import type { TaskId } from "../../../../src/workflow/domain/index.js";
import { draft, meta, planInput, testDeps } from "../helpers/fixtures.js";
import {
  Journal,
  NOW,
  beginConfirmation,
  complete,
  confirmationDraft,
  confirmationSignal,
  nonRequiredPolicy,
  planDecision,
  replanSignal,
  skip,
  start,
  startJournal,
  validate,
} from "../helpers/scenario.js";

/** 완료·건너뜀·거절 종결 member 와 READY member 들을 가진 재계획 Work(커밋 이력 포함). */
function baseReplan() {
  const { journal, ids } = startJournal(
    [
      draft("done"),
      draft("skipped"),
      confirmationDraft("rej"),
      draft("r1"),
      draft("r2"),
      draft("opt", { policy: nonRequiredPolicy() }),
    ],
    testDeps("propmember"),
  );
  const id = (ref: string) => ids[ref] as TaskId;
  for (const ref of ["done", "skipped", "rej", "r1", "r2", "opt"]) validate(journal, id(ref));
  start(journal, id("done"));
  complete(journal, id("done"));
  skip(journal, id("skipped"));
  beginConfirmation(journal, id("rej"));
  journal.apply(confirmationSignal(journal, id("rej"), "reject"));
  journal.apply(replanSignal(journal));
  return { journal, id };
}

describe("SC-055: property — 재계획 membership fold", () => {
  const base = baseReplan();
  // 보존 가능한 member(만족 종결·비종결) — 거절 종결 보존은 계획 무효라 생성하지 않는다.
  const retainable = ["done", "skipped", "r1", "r2", "opt"].map(base.id);
  const terminalBefore = ["done", "skipped", "rej"].map(base.id);

  it("Happy: 커밋 뒤 fold member 가 보존 ∪ 새 Task 이고 커밋 전 종결 Task 의 상태·revision 이 그대로다 (test_SC055_property_membership_fold_equals_retained_plus_new_and_terminal_unchanged)", () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(retainable),
        fc.integer({ min: 1, max: 2 }),
        (retain, newCount) => {
          const journal = new Journal(
            base.journal.deps,
            base.journal.aggregate,
            base.journal.commits,
          );
          const drafts = Array.from({ length: newCount }, (_, i) => draft(`new${i}`));
          journal.apply(
            executeCommand(journal.deps, journal.aggregate, {
              kind: "propose_plan",
              expectedRevision: journal.aggregate.work.revision,
              meta: meta(NOW),
              plan: planInput(drafts, {
                basePlanRevision: journal.aggregate.work.planRevision,
                retain,
              }),
              summary: "property replan",
            }),
          );
          journal.apply(planDecision(journal, "grant"));
          const newIds = drafts.map((d) => {
            const created = Object.values(journal.aggregate.tasks).find(
              (t) =>
                t.draftRef === d.draftRef && !Object.hasOwn(base.journal.aggregate.tasks, t.id),
            );
            if (created === undefined) throw new Error(`expected new task ${d.draftRef}`);
            return created.id;
          });
          const folded = journal.folded();
          expect(folded.work.memberTaskIds).toEqual([...retain, ...newIds]);
          expect(folded).toEqual(journal.aggregate);
          for (const taskId of terminalBefore) {
            const before = base.journal.aggregate.tasks[taskId];
            const after = folded.tasks[taskId];
            expect(after?.state).toBe(before?.state);
            expect(after?.revision).toBe(before?.revision);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
