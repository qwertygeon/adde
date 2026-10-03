/** 내장 Trigger 다섯 종 — 스키마는 TriggerSpec 변형 전체(strict, 기본값 없음). */
import * as z from "zod";
import type { TriggerDescriptor } from "../registry/descriptors.js";
import {
  misfirePolicySchema,
  recurrenceRuleSchema,
  timeZoneSchema,
  triggerIdSchema,
  utcInstantSchema,
} from "./schemas.js";

const SCHEDULE_INPUTS = ["ownerId", "triggerId", "scheduledForUtc", "recurrenceIndex"] as const;
const EVENT_CAUSED_INPUTS = ["ownerId", "triggerId", "causingEvent.id"] as const;

export const IMMEDIATE_TRIGGER: TriggerDescriptor = {
  kind: "immediate",
  version: 1,
  title: "Immediate",
  schema: z.strictObject({
    kind: z.literal("immediate"),
    version: z.literal(1),
    triggerId: triggerIdSchema,
  }),
  firing: "on_ready",
  occurrenceDerivation: { kind: "none" },
};

/** `recurrence` 는 형태로만 받는다 — Task 가 싣는 것은 Task 검증이 거절한다. */
export const AT_TRIGGER: TriggerDescriptor = {
  kind: "at",
  version: 1,
  title: "At",
  schema: z.strictObject({
    kind: z.literal("at"),
    version: z.literal(1),
    triggerId: triggerIdSchema,
    scheduledForUtc: utcInstantSchema,
    timezone: timeZoneSchema,
    expressionText: z.string(),
    recurrence: recurrenceRuleSchema.optional(),
    misfire: misfirePolicySchema,
  }),
  firing: "schedule",
  occurrenceDerivation: { kind: "schedule", inputs: SCHEDULE_INPUTS },
};

export const AFTER_TRIGGER: TriggerDescriptor = {
  kind: "after",
  version: 1,
  title: "After",
  schema: z.strictObject({
    kind: z.literal("after"),
    version: z.literal(1),
    triggerId: triggerIdSchema,
    durationMs: z.number().int().min(0),
    scheduledForUtc: utcInstantSchema,
    misfire: misfirePolicySchema,
  }),
  firing: "schedule",
  occurrenceDerivation: { kind: "schedule", inputs: SCHEDULE_INPUTS },
};

export const DEPENDENCIES_COMPLETE_TRIGGER: TriggerDescriptor = {
  kind: "dependencies_complete",
  version: 1,
  title: "Dependencies complete",
  schema: z.strictObject({
    kind: z.literal("dependencies_complete"),
    version: z.literal(1),
    triggerId: triggerIdSchema,
  }),
  firing: "dependencies_satisfied",
  occurrenceDerivation: { kind: "event_caused", inputs: EVENT_CAUSED_INPUTS },
};

export const SIGNAL_TRIGGER: TriggerDescriptor = {
  kind: "signal",
  version: 1,
  title: "Signal",
  schema: z.strictObject({
    kind: z.literal("signal"),
    version: z.literal(1),
    triggerId: triggerIdSchema,
    sourceId: z.string().min(1),
    signal: z.string().min(1),
  }),
  firing: "external_signal",
  occurrenceDerivation: { kind: "event_caused", inputs: EVENT_CAUSED_INPUTS },
};
