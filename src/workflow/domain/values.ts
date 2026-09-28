/**
 * 이벤트 envelope 가 요구하는 값 타입(FR-002) — the workflow contract "Actor provenance contract"·
 * "Confirmation lifecycle contract" 그대로. 시계 호출 없음(NFR-001) — 시각은 입력으로만 받는다.
 */
import { type Result, ok, err } from "./result.js";
import { ACTOR_SOURCES, CANCEL_ORIGIN_KINDS } from "./contract/index.js";
import type { SignalId, EventId, ControlRequestId } from "./ids.js";

export type ActorSource = (typeof ACTOR_SOURCES)[number];

export type ActorRef =
  | { readonly kind: "user"; readonly id: string }
  | { readonly kind: "session"; readonly sid: string }
  | { readonly kind: "binding"; readonly surface: string; readonly address: string }
  | { readonly kind: "external"; readonly provider: string; readonly externalId: string };

export type CancelOriginKind = (typeof CANCEL_ORIGIN_KINDS)[number];

export interface ProvenanceEvidence {
  readonly determinedAs: ActorSource;
  readonly path: string;
  readonly observedAt: UtcInstant;
  readonly contentHash: string;
  readonly selfWriteTokenMatched: boolean;
  readonly matchingSessionWindows: readonly {
    readonly sid: string;
    readonly startedAt: UtcInstant;
    readonly endedAt?: UtcInstant;
  }[];
  readonly writeRadiusMatch: boolean;
  readonly reason: string;
}

export interface CancelOrigin {
  readonly kind: CancelOriginKind;
  readonly actorSource: ActorSource;
  readonly actor?: ActorRef;
  readonly signalId?: SignalId;
  readonly provenance?: ProvenanceEvidence;
  readonly workEventId?: EventId;
  readonly controlRequestId?: ControlRequestId;
  readonly keyId?: string;
  readonly reason?: string;
}

declare const utcInstantBrand: unique symbol;
export type UtcInstant = string & { readonly [utcInstantBrand]: true };

export interface ValueFormatError {
  readonly kind: "value_format";
  readonly field: string;
  readonly reason: string;
}

function isActorSourceValue(raw: unknown): raw is ActorSource {
  return typeof raw === "string" && (ACTOR_SOURCES as readonly string[]).includes(raw);
}

export function parseActorSource(raw: unknown): Result<ActorSource, ValueFormatError> {
  if (!isActorSourceValue(raw)) {
    return err({ kind: "value_format", field: "actorSource", reason: "unknown_actor_source" });
  }
  return ok(raw);
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

export function parseActorRef(raw: unknown): Result<ActorRef, ValueFormatError> {
  if (!isPlainObject(raw))
    return err({ kind: "value_format", field: "actor", reason: "not_an_object" });
  const kind = raw["kind"];
  switch (kind) {
    case "user": {
      const id = raw["id"];
      if (typeof id !== "string")
        return err({ kind: "value_format", field: "actor.id", reason: "not_a_string" });
      return ok({ kind: "user", id });
    }
    case "session": {
      const sid = raw["sid"];
      if (typeof sid !== "string")
        return err({ kind: "value_format", field: "actor.sid", reason: "not_a_string" });
      return ok({ kind: "session", sid });
    }
    case "binding": {
      const surface = raw["surface"];
      const address = raw["address"];
      if (typeof surface !== "string" || typeof address !== "string") {
        return err({
          kind: "value_format",
          field: "actor.surface|address",
          reason: "not_a_string",
        });
      }
      return ok({ kind: "binding", surface, address });
    }
    case "external": {
      const provider = raw["provider"];
      const externalId = raw["externalId"];
      if (typeof provider !== "string" || typeof externalId !== "string") {
        return err({
          kind: "value_format",
          field: "actor.provider|externalId",
          reason: "not_a_string",
        });
      }
      return ok({ kind: "external", provider, externalId });
    }
    default:
      return err({ kind: "value_format", field: "actor.kind", reason: "unknown_kind" });
  }
}

function isCancelOriginKindValue(raw: unknown): raw is CancelOriginKind {
  return typeof raw === "string" && (CANCEL_ORIGIN_KINDS as readonly string[]).includes(raw);
}

/**
 * kind·actorSource 열거 검증 + kind 별 필수 필드: vault_signal→signalId, work_cascade·replan_dropped→workEventId,
 * control_request→controlRequestId 와 actorSource "unknown".
 */
export function parseCancelOrigin(raw: unknown): Result<CancelOrigin, ValueFormatError> {
  if (!isPlainObject(raw))
    return err({ kind: "value_format", field: "cancelOrigin", reason: "not_an_object" });
  const kindRaw = raw["kind"];
  if (!isCancelOriginKindValue(kindRaw)) {
    return err({ kind: "value_format", field: "cancelOrigin.kind", reason: "unknown_kind" });
  }
  const actorSourceRaw = raw["actorSource"];
  if (!isActorSourceValue(actorSourceRaw)) {
    return err({
      kind: "value_format",
      field: "cancelOrigin.actorSource",
      reason: "unknown_actor_source",
    });
  }
  const base: { kind: CancelOriginKind; actorSource: ActorSource } = {
    kind: kindRaw,
    actorSource: actorSourceRaw,
  };
  switch (kindRaw) {
    case "vault_signal": {
      const signalId = raw["signalId"];
      if (typeof signalId !== "string") {
        return err({
          kind: "value_format",
          field: "cancelOrigin.signalId",
          reason: "required_for_vault_signal",
        });
      }
      break;
    }
    case "work_cascade":
    case "replan_dropped": {
      const workEventId = raw["workEventId"];
      if (typeof workEventId !== "string") {
        return err({
          kind: "value_format",
          field: "cancelOrigin.workEventId",
          reason: "required_for_kind",
        });
      }
      break;
    }
    case "control_request": {
      const controlRequestId = raw["controlRequestId"];
      if (typeof controlRequestId !== "string") {
        return err({
          kind: "value_format",
          field: "cancelOrigin.controlRequestId",
          reason: "required_for_control_request",
        });
      }
      if (actorSourceRaw !== "unknown") {
        return err({
          kind: "value_format",
          field: "cancelOrigin.actorSource",
          reason: "control_request_requires_unknown_actor_source",
        });
      }
      break;
    }
    default:
      break;
  }
  const result: CancelOrigin = {
    ...base,
    ...(raw["actor"] !== undefined ? { actor: raw["actor"] as ActorRef } : {}),
    ...(typeof raw["signalId"] === "string" ? { signalId: raw["signalId"] as SignalId } : {}),
    ...(raw["provenance"] !== undefined
      ? { provenance: raw["provenance"] as ProvenanceEvidence }
      : {}),
    ...(typeof raw["workEventId"] === "string"
      ? { workEventId: raw["workEventId"] as EventId }
      : {}),
    ...(typeof raw["controlRequestId"] === "string"
      ? { controlRequestId: raw["controlRequestId"] as ControlRequestId }
      : {}),
    ...(typeof raw["keyId"] === "string" ? { keyId: raw["keyId"] } : {}),
    ...(typeof raw["reason"] === "string" ? { reason: raw["reason"] } : {}),
  };
  return ok(result);
}

const UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/;

/** `YYYY-MM-DDTHH:MM:SS(.f{1,3})?Z` + 달력 유효성(왕복 비교). 반환은 `toISOString()` 정규형. */
export function parseUtcInstant(raw: string): Result<UtcInstant, ValueFormatError> {
  const match = UTC_INSTANT_RE.exec(raw);
  if (!match) return err({ kind: "value_format", field: "instant", reason: "not_utc_rfc3339" });
  const ms = Date.parse(raw);
  if (Number.isNaN(ms))
    return err({ kind: "value_format", field: "instant", reason: "unparseable" });
  const normalized = new Date(ms).toISOString();
  const [year, month, day, hour, minute, second] = [
    match[1] ?? "",
    match[2] ?? "",
    match[3] ?? "",
    match[4] ?? "",
    match[5] ?? "",
    match[6] ?? "",
  ];
  const roundTrip = new Date(ms);
  const fieldsMatch =
    roundTrip.getUTCFullYear() === Number(year) &&
    roundTrip.getUTCMonth() + 1 === Number(month) &&
    roundTrip.getUTCDate() === Number(day) &&
    roundTrip.getUTCHours() === Number(hour) &&
    roundTrip.getUTCMinutes() === Number(minute) &&
    roundTrip.getUTCSeconds() === Number(second);
  if (!fieldsMatch)
    return err({ kind: "value_format", field: "instant", reason: "invalid_calendar_date" });
  return ok(normalized as UtcInstant);
}

export function instantMs(instant: UtcInstant): number {
  return Date.parse(instant);
}

export function addMs(instant: UtcInstant, ms: number): UtcInstant {
  return new Date(instantMs(instant) + ms).toISOString() as UtcInstant;
}

/** now >= limit */
export function hasPassed(limit: UtcInstant, now: UtcInstant): boolean {
  return instantMs(now) >= instantMs(limit);
}
