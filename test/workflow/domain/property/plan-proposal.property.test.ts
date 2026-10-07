// SC-055 — property: 제안 digest 의 키 순서 불변·내용 민감, 계획 검증의 결정성·포착 멱등·보존 규칙
// 오라클 일치, 필수 승인 판정의 규칙 오라클 일치.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  canonicalJsonFrozenCopy,
  executeCommand,
  judgeMandatoryPlanApproval,
  validatePlanProposal,
} from "../../../../src/workflow/domain/index.js";
import type {
  PlanTaskDraft,
  TaskId,
  WorkAggregate,
  DomainDeps,
} from "../../../../src/workflow/domain/index.js";
import { draft, entityId, meta, planInput, reachWorkState, testDeps } from "../helpers/fixtures.js";
import { payloadOf } from "../helpers/commits.js";
import {
  NOW,
  beginConfirmation,
  complete,
  confirmationDraft,
  confirmationSignal,
  fail,
  independentCanonicalJson,
  nonRequiredPolicy,
  replanSignal,
  skip,
  start,
  startJournal,
  validate,
} from "../helpers/scenario.js";

/** 객체 키 순서를 뒤집은 깊은 사본(배열 순서는 내용이므로 유지). */
function reverseKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(reverseKeys);
  const entries = Object.entries(value as Record<string, unknown>).reverse();
  return Object.fromEntries(entries.map(([k, v]) => [k, reverseKeys(v)]));
}

const titleArb = fc.string({ minLength: 1, maxLength: 12 });
const draftSetArb = fc
  .uniqueArray(fc.constantFrom("a", "b", "c", "d"), { minLength: 1, maxLength: 4 })
  .chain((refs) =>
    fc.tuple(
      fc.constant(refs),
      fc.array(titleArb, { minLength: refs.length, maxLength: refs.length }),
      fc.array(fc.option(fc.string({ maxLength: 8 }), { nil: undefined }), {
        minLength: refs.length,
        maxLength: refs.length,
      }),
    ),
  )
  .map(([refs, titles, notes]) =>
    refs.map((ref, i) =>
      draft(ref, {
        title: titles[i] ?? ref,
        input: notes[i] === undefined ? {} : { note: notes[i] },
      }),
    ),
  );

function proposedDigest(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  drafts: readonly PlanTaskDraft[],
) {
  const outcome = executeCommand(deps, aggregate, {
    kind: "propose_plan",
    expectedRevision: aggregate.work.revision,
    meta: meta(NOW),
    plan: planInput(drafts),
    summary: "property",
  });
  if (outcome.kind !== "committed") throw new Error(`expected committed, got ${outcome.kind}`);
  return String(payloadOf(outcome.commit, "work_plan_proposed")["digest"]);
}

/**
 * 재계획 Work: 완료(done)·거절(rej)·실패(failed)·건너뜀(skipped)·READY 필수(ready)·READY 비필수(optional).
 * member 사이 의존이 없어 보존 위반 외 이슈가 생기지 않는다.
 */
function replanMembers() {
  const { journal, ids } = startJournal(
    [
      draft("done"),
      confirmationDraft("rej"),
      draft("failed"),
      draft("skipped"),
      draft("ready"),
      draft("optional", { policy: nonRequiredPolicy() }),
    ],
    testDeps("propprop"),
  );
  const id = (ref: string) => ids[ref] as TaskId;
  for (const ref of ["done", "rej", "failed", "skipped", "ready", "optional"])
    validate(journal, id(ref));
  start(journal, id("done"));
  complete(journal, id("done"));
  beginConfirmation(journal, id("rej"));
  journal.apply(confirmationSignal(journal, id("rej"), "reject"));
  start(journal, id("failed"));
  fail(journal, id("failed"), "fixture_fatal");
  skip(journal, id("skipped"));
  journal.apply(replanSignal(journal));
  return { journal, id };
}

const UNSATISFYING = new Set(["REJECTED", "EXPIRED", "FAILED", "CANCELED"]);

describe("SC-055: property — 계획 제안 digest·검증·필수 승인", () => {
  const { deps: planningDeps, aggregate: planning } = reachWorkState("PLANNING");

  it("Happy: 키 순서 순열은 digest 를 바꾸지 않고 제목 1글자 변경은 바꾼다 (test_SC055_property_digest_invariant_under_key_permutation)", () => {
    fc.assert(
      fc.property(draftSetArb, fc.nat(), (drafts, pick) => {
        const reversed = drafts.map((d) => reverseKeys(d) as PlanTaskDraft);
        const original = proposedDigest(planningDeps, planning, drafts);
        expect(proposedDigest(planningDeps, planning, reversed)).toBe(original);
        const index = pick % drafts.length;
        const target = drafts[index] as PlanTaskDraft;
        const changedTitle = `${target.title.slice(0, -1)}${target.title.endsWith("x") ? "y" : "x"}`;
        const changed = drafts.map((d, i) => (i === index ? { ...d, title: changedTitle } : d));
        expect(proposedDigest(planningDeps, planning, changed)).not.toBe(original);
      }),
    );
  });

  it("Edge: 같은 입력의 계획 검증은 같은 결과이고 보존 위반 판정이 오라클과 같다 (test_SC055_property_plan_validation_deterministic_and_matches_oracle)", () => {
    const { journal } = replanMembers();
    const members = journal.aggregate.work.memberTaskIds;
    const outsider = entityId("task", "tsk_propoutsider01");
    const candidate = fc.constantFrom(...members, outsider);
    fc.assert(
      fc.property(
        fc.array(candidate, { maxLength: 8 }),
        fc.option(fc.string({ maxLength: 8 }), { nil: undefined }),
        (retain, note) => {
          const input = planInput([draft("fresh", { input: note === undefined ? {} : { note } })], {
            basePlanRevision: journal.aggregate.work.planRevision,
            retain,
          });
          const first = validatePlanProposal(journal.deps, journal.aggregate, input);
          expect(validatePlanProposal(journal.deps, journal.aggregate, input)).toEqual(first);
          // 포착 멱등: 입력을 정규 JSON 동결 사본으로 바꿔 넣어도 판정이 같다.
          const captured = canonicalJsonFrozenCopy(input);
          expect(captured.ok).toBe(true);
          if (captured.ok)
            expect(
              validatePlanProposal(journal.deps, journal.aggregate, captured.value as typeof input),
            ).toEqual(first);
          const expected = new Set<string>();
          const seen = new Map<string, number>();
          for (const taskId of retain) seen.set(taskId, (seen.get(taskId) ?? 0) + 1);
          for (const [taskId, count] of seen) {
            if (count > 1) expected.add(`retained_duplicate:${taskId}`);
            const task = journal.aggregate.tasks[taskId];
            if (!members.includes(taskId as TaskId)) expected.add(`retained_not_member:${taskId}`);
            else if (task !== undefined && UNSATISFYING.has(task.state))
              expected.add(`retained_terminal_unsatisfying:${taskId}`);
          }
          const actual = new Set<string>(
            first.valid
              ? []
              : first.issues
                  .filter((i) => i.kind.startsWith("retained_"))
                  .map((i) => `${i.kind}:${String((i as { taskId?: string }).taskId)}`),
          );
          expect([...actual].sort()).toEqual([...expected].sort());
          expect(first.valid).toBe(expected.size === 0);
        },
      ),
    );
  });

  it("Error: 필수 승인 판정이 (a)(b) 규칙 오라클과 같다 (test_SC055_property_mandatory_approval_matches_rule_oracle)", () => {
    const { journal } = replanMembers();
    const members = journal.aggregate.work.memberTaskIds;
    fc.assert(
      fc.property(
        fc.subarray([...members]),
        fc.option(fc.dictionary(fc.string({ maxLength: 4 }), fc.nat()), { nil: undefined }),
        (retain, definition) => {
          const judged = judgeMandatoryPlanApproval(journal.aggregate, {
            retain,
            ...(definition !== undefined ? { definition } : {}),
          });
          const removed = members.filter(
            (m) =>
              journal.aggregate.tasks[m]?.policy.terminalRequired === true && !retain.includes(m),
          );
          const reasons = [
            ...(removed.length > 0 ? ["removes_terminal_required_member"] : []),
            ...(definition !== undefined ? ["carries_definition"] : []),
          ];
          expect(judged).toEqual({
            required: reasons.length > 0,
            reasons,
            removedTerminalRequiredTaskIds: removed,
          });
        },
      ),
    );
  });
});

/** 배열·객체를 모든 깊이에서 동결했는지 확인한다. */
function expectDeeplyFrozen(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value), path).toBe(true);
  for (const [key, child] of Object.entries(value)) expectDeeplyFrozen(child, `${path}.${key}`);
}

/** 원본 값의 배열·객체를 모든 깊이에서 바꾼다(사본이 원본을 참조하면 드러난다). */
function mutateDeep(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) mutateDeep(child);
  if (Array.isArray(value)) value.push("mutated");
  else (value as Record<string, unknown>)["mutated_key"] = "mutated";
}

describe("SC-055: property — 정규 JSON 동결 사본", () => {
  it("Happy: 생성 JSON 값의 동결 사본은 정규 JSON 이 원본과 같고 모든 깊이에서 동결이며 원본 변경이 반영되지 않는다 (test_SC055_property_canonical_frozen_copy_round_trips)", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 3 }), (value) => {
        const expected = independentCanonicalJson(value);
        const copied = canonicalJsonFrozenCopy(value);
        expect(copied.ok).toBe(true);
        if (!copied.ok) return;
        expect(independentCanonicalJson(copied.value)).toBe(expected);
        expectDeeplyFrozen(copied.value);
        mutateDeep(value);
        expect(independentCanonicalJson(copied.value)).toBe(expected);
      }),
    );
  });
});
