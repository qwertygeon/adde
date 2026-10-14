// 이벤트 생산·상태 도달 집계 레시피 — 이벤트 카탈로그 전사 시험과 Phase 1 종료 자동 집계가
// 같은 레시피를 쓴다. 공개 배럴만 import 한다.
import {
  executeCommand,
  contentHashOf,
  DEFINITION_STATE_NAMES,
  DEFINITION_TERMINAL_STATE_NAMES,
  TASK_STATE_NAMES,
  WORK_STATE_NAMES,
  isTerminalTaskState,
  isTerminalWorkState,
} from "../../../../src/workflow/domain/index.js";
import type {
  CommandOutcome,
  DomainCommit,
  SignalJudgement,
  TaskId,
  TaskStateName,
  WorkStateName,
} from "../../../../src/workflow/domain/index.js";
import { TASK_ROW_CASES, WORK_ROW_CASES } from "./row-cases.js";
import { signalFactorCases } from "./signal-cases.js";
import {
  basePolicy,
  draft,
  meta,
  mustCommit,
  patchTask,
  reachDeadLetterParked,
  reachTaskState,
  reachWorkState,
  requireTaskFor,
  STRUCTURALLY_INVALID_INPUT,
  testDeps,
} from "./fixtures.js";
import {
  Journal,
  NOW,
  planDecision,
  replanSignal,
  runToCompleted,
  startJournal,
  taskCommand,
} from "./scenario.js";
import { buildDefinitionRowCases } from "./definition-row-cases.js";
import { definitionDeps, definitionTour } from "./definition-fixtures.js";

function committedEvents(outcome: CommandOutcome | SignalJudgement): readonly string[] {
  const commit =
    outcome.kind === "committed" || outcome.kind === "accepted" ? outcome.commit : undefined;
  return (commit?.events ?? []).map((e) => e.type);
}

/**
 * 003·004 레시피가 생산하는 이벤트 타입 — 행 케이스(Task·Work), 신호 요인 케이스, 종결 흡수·계획 순환
 * 거절·승인 채널 거절·늦은 결과 표시.
 */
export function collectCoreProducedTypes(): ReadonlySet<string> {
  const produced = new Set<string>();
  for (const rowCase of [...Object.values(TASK_ROW_CASES), ...Object.values(WORK_ROW_CASES)]) {
    try {
      const { deps, before } = rowCase.build();
      for (const type of committedEvents(rowCase.apply(deps, before))) produced.add(type);
    } catch {
      // 행 케이스 실행 실패(레시피 갭)는 전이 표 시험이 전담 — 여기서는 생산 목록에서 제외한다.
    }
  }
  // 행 케이스만으로는 거절 분류가 만드는 기록 전용 이벤트(confirmation_rejected_forged_provenance·
  // signal_rejected_stale·signal_ignored_duplicate·signal_rejected 등)가 빠진다 — 신호 요인 케이스를 더한다.
  for (const c of signalFactorCases()) {
    try {
      const judged = c.run();
      if (judged.kind !== "not_applicable")
        for (const e of judged.commit.events) produced.add(e.type);
    } catch {
      // 판정 자체 실패는 신호 판정 시험이 전담.
    }
  }
  // 종결 흡수 — stale_transition_rejected 기록 이벤트.
  {
    const { deps, aggregate, taskId } = reachTaskState("COMPLETED");
    const before = requireTaskFor(aggregate, taskId);
    const outcome = executeCommand(deps, aggregate, {
      kind: "unblock",
      taskId,
      expectedRevision: before.revision,
      meta: meta(before.createdAt),
    });
    if (outcome.kind === "rejected" && outcome.record !== undefined)
      for (const e of outcome.record.events) produced.add(e.type);
  }
  // 계획 순환 거절(onInvalid=fail_work) — work_plan_invalid(+work_failed) 기록 이벤트.
  {
    const { deps, aggregate: planningAgg } = reachWorkState("PLANNING");
    const outcome = executeCommand(deps, planningAgg, {
      kind: "commit_plan",
      expectedRevision: planningAgg.work.revision,
      meta: meta(planningAgg.work.createdAt),
      onInvalid: "fail_work",
      plan: {
        basePlanRevision: 0,
        source: "planner",
        tasks: [draft("A", { dependsOn: [{ draftRef: "A" }] })],
        retain: [],
      },
    });
    for (const type of committedEvents(outcome)) produced.add(type);
  }
  // 승인 채널 거절 — 같은 등록부로 계획 커밋이 막으므로 레코드 패치(다른 생성 경로 대용)로 재현.
  {
    const { deps, aggregate, taskId } = reachTaskState("VALIDATING");
    const patched = patchTask(aggregate, taskId, {
      policy: basePolicy({ approvalSurface: "out_of_band", approvalRequiredBeforeExecute: true }),
    });
    const outcome = executeCommand(deps, patched, {
      kind: "complete_validation",
      taskId,
      expectedRevision: requireTaskFor(patched, taskId).revision,
      meta: meta(patched.work.createdAt),
    });
    for (const type of committedEvents(outcome)) produced.add(type);
  }
  // 늦은 결과 표시 — dead-letter 결정에 주차된 attempt 의 결과.
  {
    const { deps, aggregate, taskId, attemptId } = reachDeadLetterParked();
    const outcome = executeCommand(deps, aggregate, {
      kind: "present_late_result",
      taskId,
      expectedRevision: requireTaskFor(aggregate, taskId).revision,
      meta: meta(aggregate.work.createdAt),
      attemptId,
      resultContentHash: contentHashOf("late result"),
    });
    for (const type of committedEvents(outcome)) produced.add(type);
  }
  return produced;
}

/** 정의 레시피(정의 전이 표 행 케이스와 회차 해소 순회)가 생산하는 이벤트 타입. */
export function collectDefinitionProducedTypes(): ReadonlySet<string> {
  const produced = new Set<string>();
  for (const rowCase of Object.values(buildDefinitionRowCases())) {
    try {
      const result = rowCase.apply(rowCase.build());
      for (const commit of result.commits) for (const e of commit.events) produced.add(e.type);
    } catch {
      // 행 케이스 실행 실패는 정의 전이 표 시험이 전담.
    }
  }
  try {
    const tour = definitionTour(definitionDeps("census"));
    for (const journal of tour.journals)
      for (const commit of journal.commits) for (const e of commit.events) produced.add(e.type);
  } catch {
    // 순회 실패는 fold 시험이 전담.
  }
  return produced;
}

/** 카탈로그 이름 중 생산 집합에 없는 것(이름 순서 유지). */
export function unproducedTypes(
  names: readonly string[],
  produced: ReadonlySet<string>,
): readonly string[] {
  return names.filter((name) => !produced.has(name));
}

// ---- 상태 도달·출구 집계 -----------------------------------------------------

export interface StateCensus {
  readonly reached: ReadonlySet<string>;
  readonly exited: ReadonlySet<string>;
  /** 실행 실패한 케이스 키(분류용). */
  readonly failures: readonly string[];
}

/** Task 전이 표 행 케이스가 도달·이탈한 Task 상태. */
export function observeTaskStates(): StateCensus {
  const reached = new Set<string>();
  const exited = new Set<string>();
  const failures: string[] = [];
  for (const [key, rowCase] of Object.entries(TASK_ROW_CASES)) {
    try {
      const built = rowCase.build();
      const committed = mustCommit(rowCase.apply(built.deps, built.before));
      // 생성 행은 대상 Task 가 커밋 전에 없으므로 그 커밋의 task_created 에서 찾는다.
      const created = committed.commit.events.find((e) => e.type === "task_created");
      const targetTaskId =
        built.targetTaskId ?? (created?.payload as { taskId?: TaskId } | undefined)?.taskId;
      if (targetTaskId === undefined) {
        failures.push(`${key}: no target task`);
        continue;
      }
      const to = committed.aggregate.tasks[targetTaskId]?.state;
      if (to !== rowCase.row.to) {
        failures.push(`${key}: reached ${String(to)}`);
        continue;
      }
      reached.add(to);
      if (rowCase.fromState !== to && rowCase.fromState !== "NONE") exited.add(rowCase.fromState);
    } catch (error) {
      failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { reached, exited, failures };
}

/** Work 전이 표 행 케이스가 도달·이탈한 Work 상태(파생 예외 행은 계약 표의 `to` 와 다를 수 있다). */
export function observeWorkStates(
  derivedExceptions: Readonly<Record<string, string>> = {},
): StateCensus {
  const reached = new Set<string>();
  const exited = new Set<string>();
  const failures: string[] = [];
  for (const [key, rowCase] of Object.entries(WORK_ROW_CASES)) {
    try {
      const built = rowCase.build();
      const committed = mustCommit(rowCase.apply(built.deps, built.before));
      const to = committed.aggregate.work.state;
      const expected = derivedExceptions[key] ?? rowCase.row.to;
      if (to !== expected) {
        failures.push(`${key}: reached ${to}`);
        continue;
      }
      reached.add(rowCase.row.to);
      reached.add(to);
      if (rowCase.fromState !== to && rowCase.fromState !== "NONE") exited.add(rowCase.fromState);
    } catch (error) {
      failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { reached, exited, failures };
}

/** 정의 전이 표 행 케이스가 도달·이탈한 정의 상태. */
export function observeDefinitionStates(): StateCensus {
  const reached = new Set<string>();
  const exited = new Set<string>();
  const failures: string[] = [];
  for (const [key, rowCase] of Object.entries(buildDefinitionRowCases())) {
    try {
      const result = rowCase.apply(rowCase.build());
      const to = result.after?.state;
      if (result.outcome !== "accepted" || to !== rowCase.row.to) {
        failures.push(`${key}: ${result.outcome} reached ${String(to)}`);
        continue;
      }
      reached.add(to);
      if (rowCase.fromState !== to && rowCase.fromState !== "NONE") exited.add(rowCase.fromState);
    } catch (error) {
      failures.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { reached, exited, failures };
}

/** 상태 집합과 종결 집합 전사(집계 대상). */
export const STATE_SETS = {
  task: {
    states: TASK_STATE_NAMES as readonly string[],
    terminal: (TASK_STATE_NAMES as readonly TaskStateName[]).filter((s) => isTerminalTaskState(s)),
  },
  work: {
    states: WORK_STATE_NAMES as readonly string[],
    terminal: (WORK_STATE_NAMES as readonly WorkStateName[]).filter((s) => isTerminalWorkState(s)),
  },
  definition: {
    states: DEFINITION_STATE_NAMES as readonly string[],
    terminal: DEFINITION_TERMINAL_STATE_NAMES as readonly string[],
  },
} as const;

/** 집계에서 빠진 상태: 도달 케이스가 없는 상태, 출구가 시험되지 않은 비종결 상태. */
export function censusGaps(
  census: Pick<StateCensus, "reached" | "exited">,
  states: readonly string[],
  terminal: readonly string[],
): { readonly unreached: readonly string[]; readonly unexited: readonly string[] } {
  return {
    unreached: states.filter((s) => !census.reached.has(s)),
    unexited: states.filter((s) => !terminal.includes(s) && !census.exited.has(s)),
  };
}

// ---- 불만족 필수 member 를 supersede 한 재계획 뒤 완료 ------------------------

export interface SupersedeCompletion {
  readonly journal: Journal;
  readonly failedMember: TaskId;
  readonly replacement: TaskId;
  readonly stateBeforeReplan: string;
  readonly committedPlan: DomainCommit;
  readonly completion: DomainCommit;
}

/**
 * 필수 member 가 실패해 BLOCKED 인 Work 를 재계획해 그 member 를 supersede 하고(보존하지 않음), 새 필수
 * member 를 완료해 Work 가 완료되는 레시피. 실패 종결은 구조 무효 입력 레코드 패치(검증 실패 경로 대용)로 만든다.
 */
export function supersedeUnsatisfiedThenComplete(seed = "supersede"): SupersedeCompletion {
  const { journal, ids } = startJournal([draft("required")], testDeps(seed));
  const failedMember = ids["required"] as TaskId;
  journal.apply(
    taskCommand(journal.deps, journal.aggregate, failedMember, { kind: "begin_validation" }),
  );
  journal.aggregate = patchTask(journal.aggregate, failedMember, {
    input: STRUCTURALLY_INVALID_INPUT,
  });
  journal.apply(
    taskCommand(journal.deps, journal.aggregate, failedMember, { kind: "complete_validation" }),
  );
  const stateBeforeReplan = journal.aggregate.work.state;
  journal.apply(replanSignal(journal));
  journal.apply(
    executeCommand(journal.deps, journal.aggregate, {
      kind: "propose_plan",
      expectedRevision: journal.aggregate.work.revision,
      meta: meta(NOW),
      plan: {
        basePlanRevision: journal.aggregate.work.planRevision,
        source: "planner",
        tasks: [draft("replacement")],
        retain: [],
      },
      summary: "supersede the failed member",
    }),
  );
  const committedPlan = journal.apply(planDecision(journal, "grant"));
  const replacement = Object.values(journal.aggregate.tasks).find(
    (t) => t.draftRef === "replacement",
  )?.id;
  if (replacement === undefined) throw new Error("census: replacement member not committed");
  const completion = runToCompleted(journal, replacement);
  return { journal, failedMember, replacement, stateBeforeReplan, committedPlan, completion };
}
