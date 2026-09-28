/**
 * Task 상태 이름·분류·종결 판정·의존 충족 판정(FR-003, FR-014) — the workflow contract "Task state set"·
 * "Terminal semantics and completion aggregation" 그대로.
 */
import { type Result, ok, err } from "./result.js";
import { TASK_STATE_NAMES, TASK_STATE_CLASS_ROWS } from "./contract/index.js";

export type TaskStateName = (typeof TASK_STATE_NAMES)[number];

export type TaskStateClass =
  | "nonterminal_no_wait"
  | "nonterminal_waiting"
  | "terminal_satisfied"
  | "terminal_unsatisfied"
  | "terminal_withdrawn";

export interface UnknownNameError {
  readonly kind: "unknown_name";
  readonly domain: "task_state" | "work_state" | "event_type";
  readonly raw: string;
}

const CLASS_TEXT_TO_CLASS: Readonly<Record<string, TaskStateClass>> = {
  "Non-terminal, no external wait": "nonterminal_no_wait",
  "Non-terminal, waiting on a human or an external actor": "nonterminal_waiting",
  "Terminal, requirement satisfied": "terminal_satisfied",
  "Terminal, requirement unsatisfied": "terminal_unsatisfied",
  "Terminal, requirement withdrawn": "terminal_withdrawn",
};

const STATE_TO_CLASS: ReadonlyMap<TaskStateName, TaskStateClass> = new Map(
  TASK_STATE_CLASS_ROWS.flatMap((row) => {
    const cls = CLASS_TEXT_TO_CLASS[row.classText];
    if (cls === undefined) {
      throw new Error(`계약 분류 텍스트를 인식하지 못했다: ${row.classText}`);
    }
    return row.states.map((state) => [state, cls] as const);
  }),
);

const STATE_NAME_SET: ReadonlySet<string> = new Set(TASK_STATE_NAMES);

export function parseTaskStateName(raw: string): Result<TaskStateName, UnknownNameError> {
  if (!STATE_NAME_SET.has(raw)) {
    return err({ kind: "unknown_name", domain: "task_state", raw });
  }
  return ok(raw as TaskStateName);
}

export function taskStateClass(state: TaskStateName): TaskStateClass {
  const cls = STATE_TO_CLASS.get(state);
  if (cls === undefined) {
    throw new Error(`분류되지 않은 Task 상태: ${state}`);
  }
  return cls;
}

export function isTerminalTaskState(state: TaskStateName): boolean {
  return (
    taskStateClass(state) !== "nonterminal_no_wait" &&
    taskStateClass(state) !== "nonterminal_waiting"
  );
}

/** COMPLETED, SKIPPED */
export function isSatisfyingTerminal(state: TaskStateName): boolean {
  return taskStateClass(state) === "terminal_satisfied";
}

/** REJECTED, EXPIRED, FAILED */
export function isUnsatisfyingTerminal(state: TaskStateName): boolean {
  return taskStateClass(state) === "terminal_unsatisfied";
}

/** unsatisfied = 불충족 종결 + CANCELED */
export function dependencySatisfaction(
  state: TaskStateName,
): "satisfied" | "unsatisfied" | "pending" {
  if (isSatisfyingTerminal(state)) return "satisfied";
  if (isUnsatisfyingTerminal(state) || taskStateClass(state) === "terminal_withdrawn")
    return "unsatisfied";
  return "pending";
}
