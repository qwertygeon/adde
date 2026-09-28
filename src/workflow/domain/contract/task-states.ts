/**
 * Task 상태 집합 전사(FR-003, FR-023) — the workflow contract "Task state set" 코드 블록·분류 표 원문.
 */

export const TASK_STATE_NAMES = [
  "DRAFT",
  "VALIDATING",
  "WAITING_INPUT",
  "READY",
  "SCHEDULED",
  "RUNNING",
  "WAITING_CONFIRMATION",
  "RETRY_WAIT",
  "BLOCKED",
  "BLOCKED_AWAITING_HUMAN",
  "COMPLETED",
  "REJECTED",
  "EXPIRED",
  "FAILED",
  "CANCELED",
  "SKIPPED",
] as const;

export interface TaskStateClassRow {
  readonly classText: string;
  readonly states: readonly (typeof TASK_STATE_NAMES)[number][];
}

export const TASK_STATE_CLASS_ROWS = [
  {
    classText: "Non-terminal, no external wait",
    states: ["DRAFT", "VALIDATING", "READY", "SCHEDULED", "RUNNING", "RETRY_WAIT"],
  },
  {
    classText: "Non-terminal, waiting on a human or an external actor",
    states: ["WAITING_INPUT", "WAITING_CONFIRMATION", "BLOCKED", "BLOCKED_AWAITING_HUMAN"],
  },
  {
    classText: "Terminal, requirement satisfied",
    states: ["COMPLETED", "SKIPPED"],
  },
  {
    classText: "Terminal, requirement unsatisfied",
    states: ["REJECTED", "EXPIRED", "FAILED"],
  },
  {
    classText: "Terminal, requirement withdrawn",
    states: ["CANCELED"],
  },
] as const satisfies readonly TaskStateClassRow[];
