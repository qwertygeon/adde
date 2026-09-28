/**
 * idempotency key 파생(FR-021) — the workflow contract "Idempotency key derivation" 그대로.
 * 시도 번호는 키에 넣지 않는다 — 전이가 원인인 반응은 `transition_reaction` occurrence 로 키를 만든다.
 */
import { type Result, ok, err } from "../result.js";
import type { TaskId } from "../ids.js";
import type { OccurrenceId } from "../ids.js";
import { deriveOccurrenceId, type CausingEventRef, type DerivationError } from "./occurrence-id.js";

export type { DerivationError } from "./occurrence-id.js";

declare const idempotencyKeyBrand: unique symbol;
export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: "IdempotencyKey" };

export function deriveIdempotencyKey(input: {
  readonly taskId: TaskId;
  readonly reactionLogicalId: string;
  readonly occurrenceId: OccurrenceId;
}): Result<IdempotencyKey, DerivationError> {
  if (input.reactionLogicalId.length === 0) {
    return err({ kind: "derivation_input", field: "reactionLogicalId", reason: "empty" });
  }
  return ok(`${input.taskId}:${input.reactionLogicalId}:${input.occurrenceId}` as IdempotencyKey);
}

export function deriveTransitionReactionKey(input: {
  readonly taskId: TaskId;
  readonly reactionLogicalId: string;
  readonly causingEvent: CausingEventRef & { readonly type: string };
}): Result<IdempotencyKey, DerivationError> {
  const occurrence = deriveOccurrenceId({
    kind: "transition_reaction",
    ownerId: input.taskId,
    causingEvent: input.causingEvent,
  });
  if (!occurrence.ok) return occurrence;
  return deriveIdempotencyKey({
    taskId: input.taskId,
    reactionLogicalId: input.reactionLogicalId,
    occurrenceId: occurrence.value,
  });
}
