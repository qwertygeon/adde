/**
 * 내장 descriptor 공용 스키마 — ActorRef, 정규 UTC 시각, 타임존, MisfirePolicy, Trigger 식별자.
 * 모두 strict 이고 기본값이 없다. 시각·타임존은 정규화한 값을 출력한다.
 */
import * as z from "zod";
import { parseUtcInstant } from "../values.js";
import { normalizeTimeZoneIdentifier } from "../timezone.js";

export const actorRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), id: z.string() }),
  z.strictObject({ kind: z.literal("session"), sid: z.string() }),
  z.strictObject({ kind: z.literal("binding"), surface: z.string(), address: z.string() }),
  z.strictObject({ kind: z.literal("external"), provider: z.string(), externalId: z.string() }),
]);

export const utcInstantSchema = z.string().transform((raw, ctx) => {
  const parsed = parseUtcInstant(raw);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.error.reason });
    return z.NEVER;
  }
  return parsed.value;
});

export const timeZoneSchema = z.string().transform((raw, ctx) => {
  const normalized = normalizeTimeZoneIdentifier(raw);
  if (!normalized.ok) {
    ctx.addIssue({ code: "custom", message: normalized.error.reason });
    return z.NEVER;
  }
  return normalized.value;
});

export const misfirePolicySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fire_once_now") }),
  z.strictObject({ kind: z.literal("skip") }),
  z.strictObject({
    kind: z.literal("catch_up_bounded"),
    maxCatchUp: z.number().int().min(0),
  }),
]);

/** occurrence 파생 입력이므로 비어 있지 않고 단위 구분자(U+001F)를 담지 않는다. */
export const triggerIdSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\u001f"), { message: "unit_separator_not_allowed" });

export const recurrenceRuleSchema = z.strictObject({
  rule: z.string(),
  anchorUtc: utcInstantSchema,
  until: utcInstantSchema.optional(),
  maxOccurrences: z.number().int().min(1).optional(),
});
