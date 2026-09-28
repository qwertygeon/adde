/**
 * occurrence ID 파생(FR-020) — the workflow contract "Occurrence ID derivation" 그대로(ADR-009, DEC-006).
 * 시계·현재 시각·복구 시각은 입력 타입에 없다 — 원래 예약된 시각만 쓴다.
 */
import { type Result, ok, err } from "./../result.js";
import { sha256, utf8 } from "./hash.js";
import { base32Encode } from "./base32.js";
import type { TaskId, WorkDefinitionId, EventId, OccurrenceId } from "../ids.js";
import type { UtcInstant } from "../values.js";

export interface DerivationError {
  readonly kind: "derivation_input";
  readonly field: string;
  readonly reason: string;
}

export type OccurrenceOwnerId = TaskId | WorkDefinitionId;

export interface CausingEventRef {
  readonly id: EventId;
  readonly occurredAt: UtcInstant;
}

export type OccurrenceDerivationInput =
  | {
      readonly kind: "schedule";
      readonly ownerId: OccurrenceOwnerId;
      readonly triggerId: string;
      readonly scheduledForUtc: UtcInstant;
      readonly recurrenceIndex: number;
    }
  | {
      readonly kind: "event_caused";
      readonly ownerId: OccurrenceOwnerId;
      readonly triggerId: string;
      readonly causingEvent: CausingEventRef;
    }
  | {
      readonly kind: "execution_retry";
      readonly ownerId: TaskId;
      readonly triggerId: string;
      /**
       * design.md §8 산문(계약 "Occurrence ID derivation")은 execution_retry 파생 입력을 원인
       * 이벤트의 `occurredAt` + `attemptNo` 로만 규정한다 — `id` 는 파생값에 관여하지 않는다
       * (GAP-012 main 검증). 다른 변형과 달리 `CausingEventRef` 전체가 아니라 `occurredAt` 만
       * 받아 호출부가 존재하지 않는 EventId 를 위장해 채우지 않게 한다.
       */
      readonly causingEvent: Pick<CausingEventRef, "occurredAt">;
      readonly attemptNo: number;
    }
  | {
      readonly kind: "transition_reaction";
      readonly ownerId: TaskId;
      readonly causingEvent: CausingEventRef & { readonly type: string };
    };

const UNIT_SEPARATOR = "\u001f";
const OCCURRENCE_ID_PREFIX = "occ_";
const OCCURRENCE_ID_LENGTH = 26;

function hasForbiddenSeparator(text: string): boolean {
  return text.includes(UNIT_SEPARATOR);
}

function isSafeNonNegativeInteger(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && Number.isSafeInteger(n);
}

interface DerivationFields {
  readonly ownerId: string;
  readonly triggerId: string;
  readonly scheduledForUtc: string;
  readonly recurrenceIndexText: string;
}

function resolveFields(
  input: OccurrenceDerivationInput,
): Result<DerivationFields, DerivationError> {
  switch (input.kind) {
    case "schedule": {
      if (!isSafeNonNegativeInteger(input.recurrenceIndex)) {
        return err({
          kind: "derivation_input",
          field: "recurrenceIndex",
          reason: "not_nonnegative_integer",
        });
      }
      return ok({
        ownerId: input.ownerId,
        triggerId: input.triggerId,
        scheduledForUtc: input.scheduledForUtc,
        recurrenceIndexText: String(input.recurrenceIndex),
      });
    }
    case "event_caused":
      return ok({
        ownerId: input.ownerId,
        triggerId: input.triggerId,
        scheduledForUtc: input.causingEvent.occurredAt,
        recurrenceIndexText: input.causingEvent.id,
      });
    case "execution_retry": {
      if (!isSafeNonNegativeInteger(input.attemptNo) || input.attemptNo < 1) {
        return err({
          kind: "derivation_input",
          field: "attemptNo",
          reason: "not_positive_integer",
        });
      }
      return ok({
        ownerId: input.ownerId,
        triggerId: input.triggerId,
        scheduledForUtc: input.causingEvent.occurredAt,
        recurrenceIndexText: String(input.attemptNo),
      });
    }
    case "transition_reaction":
      return ok({
        ownerId: input.ownerId,
        triggerId: `transition:${input.causingEvent.type}`,
        scheduledForUtc: input.causingEvent.occurredAt,
        recurrenceIndexText: input.causingEvent.id,
      });
    default: {
      const exhaustive: never = input;
      throw new Error(`알 수 없는 occurrence 파생 입력 종류: ${String(exhaustive)}`);
    }
  }
}

export function deriveOccurrenceId(
  input: OccurrenceDerivationInput,
): Result<OccurrenceId, DerivationError> {
  const resolved = resolveFields(input);
  if (!resolved.ok) return resolved;
  const { ownerId, triggerId, scheduledForUtc, recurrenceIndexText } = resolved.value;
  if (ownerId.length === 0)
    return err({ kind: "derivation_input", field: "ownerId", reason: "empty" });
  if (triggerId.length === 0)
    return err({ kind: "derivation_input", field: "triggerId", reason: "empty" });
  for (const [field, value] of [
    ["ownerId", ownerId],
    ["triggerId", triggerId],
    ["scheduledForUtc", scheduledForUtc],
    ["recurrenceIndex", recurrenceIndexText],
  ] as const) {
    if (hasForbiddenSeparator(value)) {
      return err({ kind: "derivation_input", field, reason: "contains_unit_separator" });
    }
  }
  const digest = sha256(
    utf8(ownerId),
    utf8(UNIT_SEPARATOR),
    utf8(triggerId),
    utf8(UNIT_SEPARATOR),
    utf8(scheduledForUtc),
    utf8(UNIT_SEPARATOR),
    utf8(recurrenceIndexText),
  );
  const encoded = base32Encode(digest).slice(0, OCCURRENCE_ID_LENGTH);
  return ok(`${OCCURRENCE_ID_PREFIX}${encoded}` as OccurrenceId);
}

export interface LogPosition {
  readonly commitSeq: number;
  readonly index: number;
}

export interface DependencyTerminalRef {
  readonly eventId: EventId;
  readonly occurredAt: UtcInstant;
  readonly position: LogPosition;
}

function comparePosition(a: LogPosition, b: LogPosition): number {
  if (a.commitSeq !== b.commitSeq) return a.commitSeq - b.commitSeq;
  return a.index - b.index;
}

/** 후보(의존 Task 들의 충족 종결 이벤트) 중 로그 위치가 가장 늦은 것. */
export function selectDependencyCausingEvent(
  refs: readonly DependencyTerminalRef[],
): CausingEventRef | undefined {
  if (refs.length === 0) return undefined;
  let latest = refs[0] as DependencyTerminalRef;
  for (const ref of refs.slice(1)) {
    if (comparePosition(ref.position, latest.position) > 0) latest = ref;
  }
  return { id: latest.eventId, occurredAt: latest.occurredAt };
}
