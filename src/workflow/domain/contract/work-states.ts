/**
 * Work 상태 집합 전사(FR-010, FR-023) — the workflow contract "Work state set and transitions" 코드 블록.
 */

export const WORK_STATE_NAMES = [
  "DRAFT",
  "PLANNING",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "READY",
  "ACTIVE",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "CANCELED",
] as const;

export const WORK_TERMINAL_STATE_NAMES = ["COMPLETED", "FAILED", "CANCELED"] as const;
