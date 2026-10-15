// 공개 진입 일곱의 예외 종류 — 명령·신호 필드 하나를 임의 JSON 으로 바꿔도 결과 값 아니면 불변식 예외뿐이다.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DomainInvariantError,
  createWork,
  executeCommand,
  executeDefinitionCommand,
  judgeDefinitionSignal,
  judgeDelegationResponseStaleness,
  judgeSignal,
  judgeTaskExternalSignal,
  nextEntityId,
} from "../../../../src/workflow/domain/index.js";
import type {
  CreateWorkCommand,
  DecisionApplication,
  DecisionSignal,
  DefinitionCommand,
  DefinitionControlSignal,
  DelegationResponseSignal,
  DomainDeps,
  ExternalSignal,
  TaskCommand,
  TaskId,
  TriggerSpec,
  WorkAggregate,
  WorkCommand,
} from "../../../../src/workflow/domain/index.js";
import {
  at,
  deadLetterDecision,
  draft,
  meta,
  planInput,
  reachDeadLetterParked,
  reachTaskState,
  reachWorkState,
  requireTaskFor,
  taskSubjectPendingDecision,
  testDeps,
} from "../helpers/fixtures.js";
import { COMPLETION_NOTIFY_REACTION } from "../helpers/registry-fixtures.js";
import {
  DEF_NOW,
  FIXTURE_SIGNAL_NAME,
  FIXTURE_SIGNAL_SOURCE,
  controlSignal,
  dayAt,
  definitionDeps,
  definitionDraft,
  externalSignal,
  markdownWorkInPlanning,
  registerAndMaterializeFirst,
  registerDefinition,
  signalDefinitionDraft,
} from "../helpers/definition-fixtures.js";
import { startJournal, validate } from "../helpers/scenario.js";

const NOW = at("2026-01-01T00:00:00Z");
const HASH = "9f2c" + "0".repeat(60);
const OCCURRENCE = "occ_" + "A".repeat(26);
const RUNS = 200;
const EXPECTED_BASE_KINDS: Record<string, string> = {
  park_awaiting_human: "committed",
  "record_attempt_outcome:completed": "committed",
  "record_attempt_outcome:failed": "committed",
  "record_attempt_outcome:blocked": "committed",
  "record_attempt_outcome:effect_dead_lettered": "committed",
  cancel_task: "committed",
  skip_task: "committed",
  start_attempt: "committed",
  fail_planning: "committed",
  request_work_input: "committed",
  propose_plan: "committed",
  cancel_work: "committed",
  "propose_plan:definition": "committed",
  create_work: "committed",
  resolve_due_schedule: "committed",
  confirmation_decision: "accepted",
  human_decision: "accepted",
  cancel_requested: "accepted",
  replan_requested: "accepted",
  delegation_response: "staleness_passed",
  definition_control: "accepted",
  definition_external: "accepted",
  task_external: "accepted",
};

const COMMAND_KINDS = ["committed", "rejected"];
const SIGNAL_KINDS = [
  "accepted",
  "duplicate",
  "rejected_stale",
  "stale_after_withdrawal",
  "rejected",
  "forged_provenance",
  "not_applicable",
];
const DELEGATION_KINDS = ["duplicate", "rejected_stale", "staleness_passed", "not_applicable"];
const DEFINITION_SIGNAL_KINDS = [
  "accepted",
  "duplicate",
  "rejected_stale",
  "rejected",
  "not_applicable",
];

type Path = readonly (string | number)[];

interface Sample {
  readonly label: string;
  readonly input: unknown;
  readonly kinds: readonly string[];
  /** 최상위 대체 대상 — 대부분은 입력 전체, 결정 신호는 신호와 적용 입력 각각. */
  readonly roots: readonly Path[];
  readonly call: (input: unknown) => unknown;
}

const LISTENER: TriggerSpec = {
  kind: "signal",
  version: 1,
  triggerId: "listener",
  sourceId: FIXTURE_SIGNAL_SOURCE,
  signal: FIXTURE_SIGNAL_NAME,
} as TriggerSpec;

function taskSample(
  label: string,
  f: { deps: DomainDeps; aggregate: WorkAggregate; taskId: TaskId },
  body: Record<string, unknown>,
  actorSource: "adde_self" | "human_local" = "adde_self",
): Sample {
  return {
    label,
    input: {
      taskId: f.taskId,
      expectedRevision: requireTaskFor(f.aggregate, f.taskId).revision,
      meta: meta(NOW, actorSource),
      ...body,
    },
    kinds: COMMAND_KINDS,
    roots: [[]],
    call: (input) => executeCommand(f.deps, f.aggregate, input as TaskCommand),
  };
}

function workSample(
  label: string,
  w: { deps: DomainDeps; aggregate: WorkAggregate },
  body: Record<string, unknown>,
  actorSource: "adde_self" | "human_local" = "adde_self",
): Sample {
  return {
    label,
    input: { expectedRevision: w.aggregate.work.revision, meta: meta(NOW, actorSource), ...body },
    kinds: COMMAND_KINDS,
    roots: [[]],
    call: (input) => executeCommand(w.deps, w.aggregate, input as WorkCommand),
  };
}

function decisionSample(
  label: string,
  f: { deps: DomainDeps; aggregate: WorkAggregate },
  signal: Record<string, unknown>,
  application: Record<string, unknown>,
): Sample {
  return {
    label,
    input: { signal, application },
    kinds: SIGNAL_KINDS,
    roots: [["signal"], ["application"]],
    call: (input) => {
      const pair = input as { signal: unknown; application: unknown };
      return judgeSignal(
        f.deps,
        f.aggregate,
        pair.signal as DecisionSignal,
        pair.application as DecisionApplication,
        NOW,
      );
    },
  };
}

/** 진입 일곱의 유효 입력 표본 — 시험 본문마다 새로 만든다. */
function buildSamples(): readonly Sample[] {
  const ready = reachTaskState("READY");
  const running = reachTaskState("RUNNING");
  const attemptId = requireTaskFor(running.aggregate, running.taskId).openAttempt?.attemptId;
  if (attemptId === undefined) throw new Error("expected open attempt");
  const outcome = (body: Record<string, unknown>) =>
    taskSample(`record_attempt_outcome:${String(body["kind"])}`, running, {
      kind: "record_attempt_outcome",
      attemptId,
      outcome: body,
    });
  const planning = reachWorkState("PLANNING");
  const active = reachWorkState("ACTIVE");
  const waiting = reachTaskState("WAITING_CONFIRMATION");
  const parked = reachDeadLetterParked();
  const listenerJournal = startJournal(
    [draft("listener", { trigger: LISTENER })],
    testDeps("proplistener"),
  );
  const listenerId = listenerJournal.ids["listener"] as TaskId;
  validate(listenerJournal.journal, listenerId);
  const listener = listenerJournal.journal;
  const scheduled = registerAndMaterializeFirst(definitionDeps("propschedule"));
  const signalDefinition = registerDefinition(definitionDeps("propsignal"), {
    draft: signalDefinitionDraft({ maxOpenOccurrences: 2 }),
  });
  const markdown = markdownWorkInPlanning(definitionDeps("propmarkdown"), DEF_NOW);
  const markdownWork = markdown.journal.work(markdown.workId);
  const waitingTask = requireTaskFor(waiting.aggregate, waiting.taskId);
  const parkedTask = requireTaskFor(parked.aggregate, parked.taskId);

  return [
    taskSample("park_awaiting_human", ready, {
      kind: "park_awaiting_human",
      cause: "unattended_eligibility_refused",
      decision: taskSubjectPendingDecision(ready.deps, ready.taskId, NOW),
    }),
    outcome({ kind: "completed", evidence: { notes: ["a"] }, outputs: {} }),
    outcome({ kind: "failed", code: "fixture_retryable" }),
    outcome({
      kind: "blocked",
      cause: "gate_denied",
      decision: taskSubjectPendingDecision(running.deps, running.taskId, NOW),
    }),
    outcome({
      kind: "effect_dead_lettered",
      decision: deadLetterDecision(running.deps, running.taskId, NOW),
    }),
    taskSample(
      "cancel_task",
      ready,
      {
        kind: "cancel_task",
        origin: {
          kind: "vault_signal",
          actorSource: "human_local",
          signalId: nextEntityId(ready.deps.ids, "signal"),
        },
      },
      "human_local",
    ),
    taskSample("skip_task", ready, { kind: "skip_task", reason: { kind: "misfire_skip" } }),
    taskSample("start_attempt", ready, { kind: "start_attempt" }),
    workSample("fail_planning", planning, {
      kind: "fail_planning",
      invalidPlan: { issues: [{ kind: "draft_invalid", draftRef: "a" }] },
    }),
    workSample("request_work_input", planning, { kind: "request_work_input", requests: [] }),
    workSample("propose_plan", planning, {
      kind: "propose_plan",
      summary: "property plan",
      plan: planInput([
        draft("root"),
        draft("child", {
          parent: { draftRef: "root" },
          reactions: [COMPLETION_NOTIFY_REACTION],
          inputBindings: { note: { from: "task", task: { draftRef: "root" }, output: "note" } },
          dependsOn: [{ draftRef: "root" }],
        }),
      ]),
    }),
    workSample(
      "cancel_work",
      planning,
      {
        kind: "cancel_work",
        origin: {
          kind: "vault_signal",
          actorSource: "human_local",
          signalId: nextEntityId(planning.deps.ids, "signal"),
        },
      },
      "human_local",
    ),
    {
      label: "propose_plan:definition",
      input: {
        kind: "propose_plan",
        expectedRevision: markdownWork.work.revision,
        meta: meta(DEF_NOW),
        summary: "property definition",
        plan: {
          basePlanRevision: 0,
          source: "planner",
          tasks: [],
          retain: [],
          definition: definitionDraft(),
        },
      },
      kinds: COMMAND_KINDS,
      roots: [[]],
      call: (input) => executeCommand(markdown.journal.deps, markdownWork, input as WorkCommand),
    },
    {
      label: "create_work",
      input: {
        kind: "create_work",
        meta: meta(NOW),
        projectId: "prj_property1",
        title: "property",
        objective: "property",
        source: { kind: "markdown", documentId: "doc-property" },
      },
      kinds: COMMAND_KINDS,
      roots: [[]],
      call: (input) => createWork(testDeps("propcreate"), input as CreateWorkCommand),
    },
    {
      label: "resolve_due_schedule",
      input: {
        kind: "resolve_due_schedule",
        definitionId: scheduled.definitionId,
        occurrenceId: scheduled.journal.definition(scheduled.definitionId).pendingSchedule
          ?.occurrenceId,
        meta: meta(dayAt(1)),
      },
      kinds: COMMAND_KINDS,
      roots: [[]],
      call: (input) =>
        executeDefinitionCommand(
          scheduled.journal.deps,
          scheduled.journal.state,
          input as DefinitionCommand,
        ),
    },
    decisionSample(
      "confirmation_decision",
      waiting,
      {
        type: "confirmation_decision",
        taskId: waiting.taskId,
        confirmationId: waitingTask.confirmationId,
        decision: "accept",
        signalId: nextEntityId(waiting.deps.ids, "signal"),
        expectedRevision: waitingTask.revision,
        actorSource: "human_local",
        receivedAt: NOW,
      },
      { kind: "none" },
    ),
    decisionSample(
      "human_decision",
      parked,
      {
        type: "human_decision",
        decisionId: parkedTask.pendingDecision?.id,
        choice: "grant",
        signalId: nextEntityId(parked.deps.ids, "signal"),
        expectedRevision: parkedTask.revision,
        actorSource: "human_local",
        receivedAt: NOW,
      },
      {
        kind: "task_grant",
        resume: { to: "SCHEDULED", occurrence: { kind: "dead_letter_retry" } },
      },
    ),
    decisionSample(
      "cancel_requested",
      ready,
      {
        type: "cancel_requested",
        subject: { taskId: ready.taskId },
        reason: "property",
        signalId: nextEntityId(ready.deps.ids, "signal"),
        expectedRevision: requireTaskFor(ready.aggregate, ready.taskId).revision,
        actorSource: "human_local",
        receivedAt: NOW,
      },
      { kind: "none" },
    ),
    decisionSample(
      "replan_requested",
      active,
      {
        type: "replan_requested",
        workId: active.aggregate.work.id,
        signalId: nextEntityId(active.deps.ids, "signal"),
        expectedRevision: active.aggregate.work.revision,
        actorSource: "human_local",
        receivedAt: NOW,
      },
      { kind: "none" },
    ),
    {
      label: "delegation_response",
      input: {
        type: "delegation_response",
        signalId: nextEntityId(running.deps.ids, "signal"),
        taskId: running.taskId,
        expectedRevision: requireTaskFor(running.aggregate, running.taskId).revision,
        occurrenceId: OCCURRENCE,
        responseContentHash: HASH,
        actorSource: "human_local",
        receivedAt: NOW,
      },
      kinds: DELEGATION_KINDS,
      roots: [[]],
      call: (input) =>
        judgeDelegationResponseStaleness(
          running.deps,
          running.aggregate,
          input as DelegationResponseSignal,
          undefined,
          NOW,
        ),
    },
    {
      label: "definition_control",
      input: controlSignal(scheduled.journal.deps, {
        definitionId: scheduled.definitionId,
        expectedRevision: scheduled.journal.definition(scheduled.definitionId).revision,
        action: "pause",
      }),
      kinds: DEFINITION_SIGNAL_KINDS,
      roots: [[]],
      call: (input) =>
        judgeDefinitionSignal(
          scheduled.journal.deps,
          scheduled.journal.state,
          input as DefinitionControlSignal,
          DEF_NOW,
        ),
    },
    {
      label: "definition_external",
      input: externalSignal(signalDefinition.journal.deps, {
        subject: { definitionId: signalDefinition.definitionId },
        sourceOccurrenceId: "prop-s1",
        payload: { note: "x", list: [1, 2] },
      }),
      kinds: DEFINITION_SIGNAL_KINDS,
      roots: [[]],
      call: (input) =>
        judgeDefinitionSignal(
          signalDefinition.journal.deps,
          signalDefinition.journal.state,
          input as ExternalSignal,
          dayAt(0),
        ),
    },
    {
      label: "task_external",
      input: externalSignal(listener.deps, {
        subject: { taskId: listenerId },
        sourceOccurrenceId: "prop-t1",
        payload: { note: "x" },
        receivedAt: NOW,
      }),
      kinds: SIGNAL_KINDS,
      roots: [[]],
      call: (input) =>
        judgeTaskExternalSignal(listener.deps, listener.aggregate, input as ExternalSignal, NOW),
    },
  ];
}

/** 표본의 모든 잎·중간 경로(루트 제외). */
function pathsOf(value: unknown, prefix: Path = []): Path[] {
  if (typeof value !== "object" || value === null) return [];
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((child, index): [number, unknown] => [index, child])
    : Object.entries(value);
  const out: Path[] = [];
  for (const [key, child] of entries) {
    const path = [...prefix, key];
    out.push(path);
    for (const nested of pathsOf(child, path)) out.push(nested);
  }
  return out;
}

/** 사본에서 경로 하나를 대체한다. 빈 경로는 값 전체를 바꾼다. */
function replaceAt(input: unknown, path: Path, replacement: unknown): unknown {
  if (path.length === 0) return replacement;
  const copy = structuredClone(input) as Record<string | number, unknown>;
  let cursor = copy;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
  cursor[path[path.length - 1] as string | number] = replacement;
  return copy;
}

type Observation =
  | { readonly kind: "returned"; readonly value: unknown }
  | { readonly kind: "invariant" }
  | { readonly kind: "other"; readonly error: unknown };

function observe(sample: Sample, input: unknown): Observation {
  try {
    return { kind: "returned", value: sample.call(input) };
  } catch (error) {
    if (error instanceof DomainInvariantError) return { kind: "invariant" };
    return { kind: "other", error };
  }
}

/** 결과 값이면 그 진입의 결과 갈래 중 하나이고, 예외면 불변식 예외뿐이다. */
function allowed(sample: Sample, observation: Observation): boolean {
  if (observation.kind === "invariant") return true;
  if (observation.kind === "other") return false;
  const value = observation.value as { kind?: unknown } | null | undefined;
  return typeof value?.kind === "string" && sample.kinds.includes(value.kind);
}

function describeFailure(sample: Sample, path: Path, observation: Observation): string {
  const error = observation.kind === "other" ? observation.error : undefined;
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return `${sample.label} @ ${JSON.stringify(path)} → ${observation.kind} ${name}`;
}

/** 대체 전 표본의 결과 — 표본이 진입 판정 본체까지 닿는지(입력 형 거절에서 멈추지 않는지) 확인한다. */
function baseKinds(samples: readonly Sample[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sample of samples) {
    const observation = observe(sample, structuredClone(sample.input));
    const value =
      observation.kind === "returned" ? (observation.value as { kind: string }) : undefined;
    out[sample.label] = value?.kind ?? observation.kind;
  }
  return out;
}

const DANGEROUS = fc.oneof(
  fc.constantFrom("__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "", "tsk_"),
  fc.constant({ toString: 1 }),
  fc.constant(null),
);
const REPLACEMENT = fc.oneof(fc.jsonValue({ maxDepth: 3 }), DANGEROUS);

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("SC-064: 진입 예외 종류 — 필드 하나를 임의 JSON 으로 바꿔도 TypeError·RangeError 가 없다", () => {
  it("Happy: 표본 필드 하나를 임의 JSON 으로 바꾸면 결과 갈래 아니면 불변식 예외다 (test_SC064_property_field_replacement_no_type_or_range_error)", () => {
    const samples = buildSamples();
    expect(baseKinds(samples)).toEqual(EXPECTED_BASE_KINDS);
    fc.assert(
      fc.property(fc.nat(), fc.nat(), REPLACEMENT, (sampleIndex, pathIndex, replacement) => {
        const sample = samples[sampleIndex % samples.length] as Sample;
        const paths = pathsOf(sample.input);
        const path = paths[pathIndex % paths.length] as Path;
        const observation = observe(sample, replaceAt(sample.input, path, replacement));
        expect(allowed(sample, observation), describeFailure(sample, path, observation)).toBe(true);
      }),
      { seed: 20_260_101, numRuns: RUNS },
    );
  }, 15_000);

  it("Edge: 위험 문자열과 {toString: 1} 만으로 바꿔도 결과 갈래 아니면 불변식 예외다 (test_SC064_property_dangerous_strings_no_type_or_range_error)", () => {
    const samples = buildSamples();
    fc.assert(
      fc.property(fc.nat(), fc.nat(), DANGEROUS, (sampleIndex, pathIndex, replacement) => {
        const sample = samples[sampleIndex % samples.length] as Sample;
        const paths = pathsOf(sample.input);
        const path = paths[pathIndex % paths.length] as Path;
        const observation = observe(sample, replaceAt(sample.input, path, replacement));
        expect(allowed(sample, observation), describeFailure(sample, path, observation)).toBe(true);
      }),
      { seed: 20_260_102, numRuns: RUNS },
    );
  }, 15_000);

  it("Error: 명령·신호 자체를 임의 JSON 으로 바꾸면 평범한 객체가 아닌 값은 invalid_input 이다 (test_SC064_property_root_replacement_invalid_input)", () => {
    const samples = buildSamples();
    fc.assert(
      fc.property(fc.nat(), fc.nat(), REPLACEMENT, (sampleIndex, rootIndex, replacement) => {
        const sample = samples[sampleIndex % samples.length] as Sample;
        const root = sample.roots[rootIndex % sample.roots.length] as Path;
        const observation = observe(sample, replaceAt(sample.input, root, replacement));
        expect(allowed(sample, observation), describeFailure(sample, root, observation)).toBe(true);
        const replacesEntryValue = root.length === 0 || root[0] === "signal";
        if (replacesEntryValue && !isPlainObject(replacement)) {
          expect(observation.kind).toBe("returned");
          if (observation.kind !== "returned") return;
          const value = observation.value as {
            kind: string;
            rejection?: { reason?: unknown };
          };
          expect(["rejected", "not_applicable"]).toContain(value.kind);
          expect(value.rejection?.reason).toBe("invalid_input");
        }
      }),
      { seed: 20_260_103, numRuns: RUNS },
    );
  }, 15_000);
});
