/**
 * 신호 dedup key 파생(FR-022) — the workflow contract "Signal deduplication key" 표 9행 그대로.
 * 외부 신호 튜플은 구분자 충돌 불가·짝 없는 대리 문자 무효(research.md §4).
 */
import { type Result, ok, err } from "../result.js";
import { sha256, utf8 } from "./hash.js";
import type { DerivationError } from "./occurrence-id.js";
import type {
  ConfirmationId,
  DecisionId,
  DispatchId,
  TaskId,
  WorkId,
  WorkDefinitionId,
  OccurrenceId,
} from "../ids.js";

export type { DerivationError } from "./occurrence-id.js";

declare const signalDedupKeyBrand: unique symbol;
export type SignalDedupKey = string & { readonly [signalDedupKeyBrand]: "SignalDedupKey" };

declare const contentHashBrand: unique symbol;
export type ContentHash = string & { readonly [contentHashBrand]: "ContentHash" };

export type SignalDedupInput =
  | {
      readonly signalType: "confirmation_decision";
      readonly confirmationId: ConfirmationId;
      readonly expectedRevision: number;
      readonly decision: "accept" | "reject" | "cancel";
    }
  | {
      readonly signalType: "input_provided";
      readonly subjectId: TaskId | WorkId;
      readonly questionId: string;
      readonly answerContentHash: ContentHash;
    }
  | {
      readonly signalType: "cancel_requested";
      readonly subjectId: TaskId | WorkId;
      readonly expectedRevision: number;
    }
  | {
      readonly signalType: "human_decision";
      readonly decisionId: DecisionId;
      readonly expectedRevision: number;
      readonly choice: "grant" | "deny";
    }
  | {
      readonly signalType: "delegation_response";
      readonly taskId: TaskId;
      readonly expectedRevision: number;
      readonly occurrenceId: OccurrenceId;
      readonly responseContentHash: ContentHash;
    }
  | {
      readonly signalType: "replan_requested";
      readonly workId: WorkId;
      readonly expectedRevision: number;
    }
  | {
      readonly signalType: "definition_control";
      readonly definitionId: WorkDefinitionId;
      readonly expectedRevision: number;
      readonly action: "pause" | "resume" | "stop";
    }
  | {
      readonly signalType: "agent_result";
      readonly dispatchId: DispatchId;
      readonly resultContentHash: ContentHash;
    }
  | {
      readonly signalType: "external_signal";
      readonly subjectId: TaskId | WorkDefinitionId;
      readonly sourceId: string;
      readonly signalName: string;
      readonly sourceOccurrenceId: string;
    };

const UNPAIRED_SURROGATE_RE = /\p{Cs}/u;

function hasUnpairedSurrogate(text: string): boolean {
  return UNPAIRED_SURROGATE_RE.test(text);
}

function nonEmpty(field: string, value: string): Result<string, DerivationError> {
  if (value.length === 0) return err({ kind: "derivation_input", field, reason: "empty" });
  return ok(value);
}

export function deriveSignalDedupKey(
  input: SignalDedupInput,
): Result<SignalDedupKey, DerivationError> {
  switch (input.signalType) {
    case "confirmation_decision":
      return ok(
        `confirmation_decision:${input.confirmationId}:${input.expectedRevision}:${input.decision}` as SignalDedupKey,
      );
    case "input_provided": {
      const q = nonEmpty("questionId", input.questionId);
      if (!q.ok) return q;
      return ok(
        `input_provided:${input.subjectId}:${input.questionId}:${input.answerContentHash}` as SignalDedupKey,
      );
    }
    case "cancel_requested":
      return ok(`cancel_requested:${input.subjectId}:${input.expectedRevision}` as SignalDedupKey);
    case "human_decision":
      return ok(
        `human_decision:${input.decisionId}:${input.expectedRevision}:${input.choice}` as SignalDedupKey,
      );
    case "delegation_response":
      return ok(
        `delegation_response:${input.taskId}:${input.expectedRevision}:${input.occurrenceId}:${input.responseContentHash}` as SignalDedupKey,
      );
    case "replan_requested":
      return ok(`replan_requested:${input.workId}:${input.expectedRevision}` as SignalDedupKey);
    case "definition_control":
      return ok(
        `definition_control:${input.definitionId}:${input.expectedRevision}:${input.action}` as SignalDedupKey,
      );
    case "agent_result":
      return ok(`agent_result:${input.dispatchId}:${input.resultContentHash}` as SignalDedupKey);
    case "external_signal": {
      const sourceId = nonEmpty("sourceId", input.sourceId);
      if (!sourceId.ok) return sourceId;
      const signalName = nonEmpty("signalName", input.signalName);
      if (!signalName.ok) return signalName;
      const sourceOccurrenceId = nonEmpty("sourceOccurrenceId", input.sourceOccurrenceId);
      if (!sourceOccurrenceId.ok) return sourceOccurrenceId;
      for (const [field, value] of [
        ["sourceId", input.sourceId],
        ["signalName", input.signalName],
        ["sourceOccurrenceId", input.sourceOccurrenceId],
      ] as const) {
        if (hasUnpairedSurrogate(value)) {
          return err({ kind: "derivation_input", field, reason: "unpaired_surrogate" });
        }
      }
      const tuple = JSON.stringify([input.sourceId, input.signalName, input.sourceOccurrenceId]);
      return ok(`external_signal:${input.subjectId}:${tuple}` as SignalDedupKey);
    }
    default: {
      const exhaustive: never = input;
      throw new Error(`알 수 없는 신호 dedup 입력 종류: ${String(exhaustive)}`);
    }
  }
}

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;

export function contentHashOf(content: string): ContentHash {
  const digest = sha256(utf8(content));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex as ContentHash;
}

export function parseContentHash(raw: string): Result<ContentHash, DerivationError> {
  if (!CONTENT_HASH_RE.test(raw)) {
    return err({ kind: "derivation_input", field: "contentHash", reason: "not_sha256_hex" });
  }
  return ok(raw as ContentHash);
}
