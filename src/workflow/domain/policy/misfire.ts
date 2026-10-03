/**
 * Task Trigger 의 지연 발화 판정 — 늦게 발견한 경로(복구 등)가 부른다. 사건이 원인인 occurrence 는
 * 정책 없이 발화하고, 예약 occurrence 만 misfire 정책으로 정한다. occurrence ID 는 원래 예약 시각으로
 * 파생하므로 현재 시각이 들어가지 않는다. `catch_up_bounded` 상한 0 은 건너뛰기로 소비한다.
 */
import { type Result, ok, err } from "../result.js";
import type { TaskId, OccurrenceId } from "../ids.js";
import type { UtcInstant } from "../values.js";
import { instantMs, parseUtcInstant } from "../values.js";
import type { TriggerSpec } from "../trigger.js";
import type { TriggerRegistry } from "../registry/registries.js";
import { deriveOccurrenceId } from "../derivation/occurrence-id.js";
import type { DerivationError } from "../derivation/occurrence-id.js";

export type TaskTriggerOccurrence =
  | { readonly kind: "schedule" }
  | { readonly kind: "event_caused"; readonly occurrenceId: OccurrenceId };

export type MisfireDecision =
  | {
      readonly kind: "fire";
      readonly occurrenceId: OccurrenceId;
      readonly policyApplied: boolean;
      readonly scheduledForUtc?: UtcInstant;
    }
  | {
      readonly kind: "skip";
      readonly occurrenceId: OccurrenceId;
      readonly scheduledForUtc: UtcInstant;
    }
  | {
      readonly kind: "not_due";
      readonly occurrenceId: OccurrenceId;
      readonly scheduledForUtc: UtcInstant;
    };

export type MisfireError =
  | { readonly kind: "trigger_descriptor_unknown" }
  | { readonly kind: "not_schedule_trigger" }
  | { readonly kind: "derivation"; readonly error: DerivationError };

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null;
}

export function decideTaskTriggerMisfire(
  triggers: TriggerRegistry,
  input: {
    readonly taskId: TaskId;
    readonly trigger: TriggerSpec;
    readonly occurrence: TaskTriggerOccurrence;
    readonly now: UtcInstant;
  },
): Result<MisfireDecision, MisfireError> {
  const descriptor = triggers.get(input.trigger.kind, input.trigger.version);
  if (descriptor === undefined) return err({ kind: "trigger_descriptor_unknown" });
  if (input.occurrence.kind === "event_caused") {
    return ok({ kind: "fire", occurrenceId: input.occurrence.occurrenceId, policyApplied: false });
  }
  if (descriptor.occurrenceDerivation.kind !== "schedule") {
    return err({ kind: "not_schedule_trigger" });
  }
  const trigger = input.trigger as unknown as Record<string, unknown>;
  const rawScheduled = trigger["scheduledForUtc"];
  const misfire = trigger["misfire"];
  const scheduled = typeof rawScheduled === "string" ? parseUtcInstant(rawScheduled) : undefined;
  if (scheduled === undefined || !scheduled.ok || !isRecord(misfire)) {
    return err({
      kind: "derivation",
      error: { kind: "derivation_input", field: "scheduledForUtc", reason: "not_schedule_trigger" },
    });
  }
  const scheduledForUtc = scheduled.value;
  const occurrence = deriveOccurrenceId({
    kind: "schedule",
    ownerId: input.taskId,
    triggerId: input.trigger.triggerId,
    scheduledForUtc,
    recurrenceIndex: 0,
  });
  if (!occurrence.ok) return err({ kind: "derivation", error: occurrence.error });
  const occurrenceId = occurrence.value;

  if (instantMs(input.now) < instantMs(scheduledForUtc)) {
    return ok({ kind: "not_due", occurrenceId, scheduledForUtc });
  }
  const fire = (): MisfireDecision => ({
    kind: "fire",
    occurrenceId,
    policyApplied: true,
    scheduledForUtc,
  });
  switch (misfire["kind"]) {
    case "fire_once_now":
      return ok(fire());
    case "skip":
      return ok({ kind: "skip", occurrenceId, scheduledForUtc });
    case "catch_up_bounded": {
      const maxCatchUp = misfire["maxCatchUp"];
      return typeof maxCatchUp === "number" && maxCatchUp >= 1
        ? ok(fire())
        : ok({ kind: "skip", occurrenceId, scheduledForUtc });
    }
    default:
      return err({
        kind: "derivation",
        error: { kind: "derivation_input", field: "misfire", reason: "unknown_misfire_policy" },
      });
  }
}
