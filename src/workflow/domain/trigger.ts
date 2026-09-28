/**
 * Trigger 형태(FR-009) — the workflow contract "Trigger specification" 그대로. 타입만(검증·전개는
 * 둘째 차수, CUT-002).
 */
import type { UtcInstant } from "./values.js";

export type MisfirePolicy =
  | { readonly kind: "fire_once_now" }
  | { readonly kind: "skip" }
  | { readonly kind: "catch_up_bounded"; readonly maxCatchUp: number };

export interface RecurrenceRule {
  readonly rule: string;
  readonly anchorUtc: UtcInstant;
  readonly until?: UtcInstant;
  readonly maxOccurrences?: number;
}

export type TriggerSpec =
  | { readonly kind: "immediate"; readonly version: 1; readonly triggerId: string }
  | { readonly kind: "dependencies_complete"; readonly version: 1; readonly triggerId: string }
  | {
      readonly kind: "signal";
      readonly version: 1;
      readonly triggerId: string;
      readonly sourceId: string;
      readonly signal: string;
    }
  | {
      readonly kind: "at";
      readonly version: 1;
      readonly triggerId: string;
      readonly scheduledForUtc: UtcInstant;
      readonly timezone: string;
      readonly expressionText: string;
      readonly recurrence?: RecurrenceRule;
      readonly misfire: MisfirePolicy;
    }
  | {
      readonly kind: "after";
      readonly version: 1;
      readonly triggerId: string;
      readonly durationMs: number;
      readonly scheduledForUtc: UtcInstant;
      readonly misfire: MisfirePolicy;
    };
