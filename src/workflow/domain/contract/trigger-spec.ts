/**
 * TriggerSpec `kind` 값 전사 — the workflow contract "Trigger specification" 의 `TriggerSpec` 유니온
 * 선언 순서 그대로.
 */

export const TRIGGER_SPEC_KINDS = [
  "immediate",
  "dependencies_complete",
  "signal",
  "at",
  "after",
] as const;
