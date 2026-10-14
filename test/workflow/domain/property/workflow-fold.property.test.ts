// property: 다중 Work fold = 직접 적용, 결정성, 취소 ID 재발급 없음, 상태 변경 커밋 누락 검출.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  RECORD_ONLY_EVENT_TYPES,
  foldWorkflowEvents,
} from "../../../../src/workflow/domain/index.js";
import type {
  DomainCommit,
  RecurrenceStep,
  WorkflowState,
} from "../../../../src/workflow/domain/index.js";
import {
  dailyActivation,
  dayAt,
  definitionDeps,
  payloadsOf,
  registerDefinition,
  signalDefinitionDraft,
  stepActivation,
  testStepRecurrence,
} from "../helpers/definition-fixtures.js";
import type { StepPeriod, WorkflowJournal } from "../helpers/definition-fixtures.js";

const RECORD_ONLY: ReadonlySet<string> = new Set(RECORD_ONLY_EVENT_TYPES);
const STEPS = [
  "due",
  "complete",
  "release",
  "signal",
  "duplicate",
  "pause",
  "resume",
  "stop",
] as const;
const AMENDS = ["amend_title", "amend_multi", "amend_daily"] as const;
type Amend = (typeof AMENDS)[number];
type Step = (typeof STEPS)[number] | Amend;

const MULTI_RULE = "test-multi";
// 하루 세 번 회차 — 07:00 회차는 일일 규칙의 같은 날 회차와 시각·회차 번호·triggerId 가 같아 같은 occurrence ID 다.
const MULTI_STEPS: readonly RecurrenceStep[] = Array.from({ length: 40 }, (_, d) => [
  { scheduledForUtc: dayAt(d, "05:00"), recurrenceIndex: d },
  { scheduledForUtc: dayAt(d), recurrenceIndex: d },
  { scheduledForUtc: dayAt(d, "20:00"), recurrenceIndex: d },
]).flat();

/**
 * 개정 단계를 하나 이상 담은 순서열 — 생성한 순서열의 첫 중지 앞 임의 위치에 개정 하나를 끼운다
 * (중지한 정의는 개정하지 않으므로 중지 앞이어야 개정 커밋이 생긴다).
 */
const withAmendment = fc
  .tuple(
    fc.array(fc.constantFrom<Step>(...STEPS, ...AMENDS), { maxLength: 12 }),
    fc.constantFrom<Amend>(...AMENDS),
    fc.nat(),
    fc.constantFrom<StepPeriod>("local_date", "utc_hour"),
  )
  .map(([steps, amend, pos, period]) => {
    const stop = steps.indexOf("stop");
    const at = pos % ((stop === -1 ? steps.length : stop) + 1);
    return { steps: [...steps.slice(0, at), amend, ...steps.slice(at)], period };
  });

/** 정의마다 대기 행·보류·materialize 의 occurrence ID 가 취소 목록에 없어야 한다. */
function retiredIdsInUse(state: WorkflowState): string[] {
  return Object.values(state.works).flatMap((w) => {
    const d = w.definition;
    if (d === undefined) return [];
    const inUse = [
      ...d.materialized.map((m) => m.occurrenceId),
      ...d.held.map((h) => h.occurrenceId),
      ...(d.pendingSchedule !== undefined ? [d.pendingSchedule.occurrenceId] : []),
    ];
    return inUse.filter((id) => d.retiredOccurrenceIds.includes(id));
  });
}

/** 일정 정의와 신호 정의를 한 진행기에 두고 생성 순서열을 적용한다 — 정의 생성 커밋을 언제나 포함한다. */
function run(
  seed: string,
  steps: readonly Step[],
  period: StepPeriod = "local_date",
): WorkflowJournal {
  const port = testStepRecurrence({ rule: MULTI_RULE, steps: MULTI_STEPS, period });
  const scheduled = registerDefinition(definitionDeps(seed, undefined, port));
  const journal = scheduled.journal;
  const daily = scheduled.definitionId;
  const markdown = journal.createMarkdownWork(dayAt(-1), "doc-signal");
  journal.propose(
    markdown,
    {
      basePlanRevision: 0,
      source: "planner",
      tasks: [],
      retain: [],
      definition: signalDefinitionDraft(),
    },
    dayAt(-1),
  );
  journal.decidePlan(markdown, "grant", dayAt(-1));
  const onSignal = journal.work(markdown).definition?.id;
  if (onSignal === undefined) throw new Error("expected signal definition");
  let k = 0;
  let source = 0;
  for (const step of steps) {
    const now = dayAt(k, "07:30");
    const definition = journal.definition(daily);
    if (
      step === "due" &&
      definition.pendingSchedule !== undefined &&
      definition.state === "ACTIVE"
    ) {
      journal.resolveDue(daily, definition.pendingSchedule.scheduledForUtc);
      k += 1;
    } else if (step === "complete") {
      const open = [
        ...journal.occurrenceWorkIds(daily),
        ...journal.occurrenceWorkIds(onSignal),
      ].find((w) => journal.work(w).work.state === "READY");
      if (open !== undefined) journal.completeWork(open, now);
    } else if (step === "release" && definition.held.length > 0) {
      journal.release(daily, now);
    } else if (step === "signal") {
      source += 1;
      journal.external(onSignal, `src-${source}`, now);
    } else if (step === "duplicate") {
      journal.external(onSignal, `src-${source}`, now);
    } else if (step === "pause" || step === "resume" || step === "stop") {
      journal.control(daily, step, now);
    } else if (
      (step === "amend_title" || step === "amend_multi" || step === "amend_daily") &&
      definition.state !== "STOPPED"
    ) {
      const overrides =
        step === "amend_title"
          ? { title: `renamed ${k}` }
          : { activation: step === "amend_multi" ? stepActivation(MULTI_RULE) : dailyActivation() };
      journal.amend(daily, overrides, now);
    }
    const reissued = retiredIdsInUse(journal.state);
    if (reissued.length > 0) {
      throw new Error(`retired occurrence id in use after ${step}: ${reissued.join(", ")}`);
    }
  }
  return journal;
}

function amendmentCommits(journal: WorkflowJournal): number {
  return journal.commits.filter((c) => payloadsOf(c, "work_definition_revised").length > 0).length;
}

function digests(journal: WorkflowJournal): unknown[] {
  return journal.commits.flatMap((c: DomainCommit) =>
    payloadsOf(c, "work_plan_committed").map((p) => p["digest"]),
  );
}

describe("SC-063: property — 다중 Work fold", () => {
  it("Happy: 생성 명령 순서열의 fold 가 직접 적용 상태와 같다 (test_SC063_property_fold_equals_direct)", () => {
    fc.assert(
      fc.property(withAmendment, ({ steps, period }) => {
        const journal = run("propfold", steps, period);
        expect(amendmentCommits(journal)).toBeGreaterThanOrEqual(1);
        const folded = foldWorkflowEvents(journal.commits.flatMap((c) => c.events));
        expect(folded.ok).toBe(true);
        if (folded.ok) expect(folded.value).toEqual(journal.state);
      }),
      { numRuns: 40 },
    );
  });

  it("Edge: 같은 순서열을 두 번 실행하면 occurrence ID·템플릿 digest 가 같다 (test_SC063_property_two_runs_same_ids_and_digests)", () => {
    fc.assert(
      fc.property(withAmendment, ({ steps, period }) => {
        const a = run("proptwice", steps, period);
        const b = run("proptwice", steps, period);
        expect(amendmentCommits(a)).toBeGreaterThanOrEqual(1);
        const ids = (j: WorkflowJournal) =>
          Object.values(j.state.works).flatMap(
            (w) => w.definition?.materialized.map((m) => m.occurrenceId) ?? [],
          );
        expect(ids(b)).toEqual(ids(a));
        expect(digests(b)).toEqual(digests(a));
      }),
      { numRuns: 30 },
    );
  });

  it("Error: 기록 전용이 아닌 이벤트가 있는 커밋 하나를 뺀 로그는 fold 실패이거나 직접 적용과 다르다 (test_SC063_property_dropped_mutating_commit_detected)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...STEPS), { maxLength: 10 }),
        fc.nat(),
        (steps, pick) => {
          const journal = run("propdrop", steps);
          const mutating = journal.commits
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => c.events.some((e) => !RECORD_ONLY.has(e.type)));
          // 정의 생성 커밋이 언제나 있으므로 고를 커밋이 있다.
          expect(mutating.length).toBeGreaterThan(0);
          const target = mutating[pick % mutating.length];
          if (target === undefined) return;
          const events = journal.commits.filter((_, i) => i !== target.i).flatMap((c) => c.events);
          // fold 실패는 오류 결과이거나, 접는 중 장부 불일치로 던진 오류다.
          let folded: ReturnType<typeof foldWorkflowEvents> | undefined;
          try {
            folded = foldWorkflowEvents(events);
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            return;
          }
          if (folded.ok) expect(folded.value).not.toEqual(journal.state);
        },
      ),
      { numRuns: 40 },
    );
  });
});
