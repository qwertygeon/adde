/**
 * Work 상태 이름·종결 판정(FR-010) — the workflow contract "Work state set and transitions" 그대로.
 */
import { type Result, ok, err } from "./result.js";
import { WORK_STATE_NAMES, WORK_TERMINAL_STATE_NAMES } from "./contract/index.js";
import type { UnknownNameError } from "./task-state.js";

export type WorkStateName = (typeof WORK_STATE_NAMES)[number];

const STATE_NAME_SET: ReadonlySet<string> = new Set(WORK_STATE_NAMES);
const TERMINAL_STATE_SET: ReadonlySet<string> = new Set(WORK_TERMINAL_STATE_NAMES);

export function parseWorkStateName(raw: string): Result<WorkStateName, UnknownNameError> {
  if (!STATE_NAME_SET.has(raw)) {
    return err({ kind: "unknown_name", domain: "work_state", raw });
  }
  return ok(raw as WorkStateName);
}

export function isTerminalWorkState(state: WorkStateName): boolean {
  return TERMINAL_STATE_SET.has(state);
}
