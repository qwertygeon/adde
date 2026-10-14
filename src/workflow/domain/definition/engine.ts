/**
 * 정의 진입점 — 회차 명령과 정의 대상 신호. 진입에서 명령 최상위와 `meta` 를 한 번만 읽어 얕은 동결
 * 사본으로 판정한다(기존 명령 진입과 같은 방식).
 */
import type { DefinitionCommand, DefinitionControlSignal, ExternalSignal } from "../commands.js";
import type { UtcInstant } from "../values.js";
import type { SignalDedupKey } from "../derivation/dedup-key.js";
import type {
  CommandRejection,
  CommitMeta,
  DomainCommit,
  DomainDeps,
  NonStaleReason,
  StaleReason,
} from "../engine.js";
import { judgeDefinitionExternalSignal } from "../external-signal.js";
import type { WorkflowState } from "./commit.js";
import { assembleWorkflowCommit } from "./commit.js";
import { judgeDefinitionControl } from "./control.js";
import type { OccurrenceDecision } from "./occurrence.js";
import { releaseHeldOccurrence, resolveDueSchedule } from "./occurrence.js";

export type WorkflowOutcome =
  | { readonly kind: "committed"; readonly commit: DomainCommit; readonly state: WorkflowState }
  | { readonly kind: "rejected"; readonly rejection: CommandRejection };

export type WorkflowSignalJudgement =
  | {
      readonly kind: "accepted" | "duplicate";
      readonly dedupKey: SignalDedupKey;
      readonly commit: DomainCommit;
      readonly state: WorkflowState;
    }
  | {
      readonly kind: "rejected_stale";
      readonly reason: StaleReason;
      readonly commit: DomainCommit;
      readonly state: WorkflowState;
    }
  | {
      readonly kind: "rejected";
      readonly reason: NonStaleReason;
      readonly commit: DomainCommit;
      readonly state: WorkflowState;
    }
  | { readonly kind: "not_applicable"; readonly rejection: CommandRejection };

function captureDefinitionCommand(received: DefinitionCommand): DefinitionCommand {
  const top = { ...received };
  const captured =
    typeof top.meta === "object" && top.meta !== null
      ? { ...top, meta: Object.freeze({ ...top.meta }) }
      : top;
  return Object.freeze(captured);
}

function occurrenceCommandFieldsValid(command: {
  readonly definitionId: unknown;
  readonly occurrenceId: unknown;
}): boolean {
  return typeof command.definitionId === "string" && typeof command.occurrenceId === "string";
}

export function executeDefinitionCommand(
  deps: DomainDeps,
  state: WorkflowState,
  received: DefinitionCommand,
): WorkflowOutcome {
  const command = captureDefinitionCommand(received);
  const meta: CommitMeta = {
    now: command.meta.now,
    actorSource: command.meta.actorSource,
    ...(command.meta.actor !== undefined ? { actor: command.meta.actor } : {}),
    ...(command.meta.causationId !== undefined ? { causationId: command.meta.causationId } : {}),
  };
  let decision: OccurrenceDecision;
  switch (command.kind) {
    case "resolve_due_schedule":
      if (
        !occurrenceCommandFieldsValid(command) ||
        !(command.late === undefined || typeof command.late === "boolean")
      ) {
        return { kind: "rejected", rejection: { reason: "invalid_input" } };
      }
      decision = resolveDueSchedule(deps, state, {
        definitionId: command.definitionId,
        occurrenceId: command.occurrenceId,
        ...(command.late !== undefined ? { late: command.late } : {}),
        now: meta.now,
      });
      break;
    case "release_held_occurrence":
      if (!occurrenceCommandFieldsValid(command)) {
        return { kind: "rejected", rejection: { reason: "invalid_input" } };
      }
      decision = releaseHeldOccurrence(deps, state, {
        definitionId: command.definitionId,
        occurrenceId: command.occurrenceId,
        now: meta.now,
      });
      break;
    default: {
      const unknownKind: never = command;
      void unknownKind;
      return {
        kind: "rejected",
        rejection: { reason: "invalid_input", detail: "unknown_command" },
      };
    }
  }
  if (decision.kind === "rejected") return { kind: "rejected", rejection: decision.rejection };
  const assembled = assembleWorkflowCommit(deps, state, decision.pieces, meta);
  return { kind: "committed", commit: assembled.commit, state: assembled.state };
}

/** 정의 제어 신호와 정의 대상 외부 신호. Task 대상 외부 신호는 Work 단위 판정의 몫이다. */
export function judgeDefinitionSignal(
  deps: DomainDeps,
  state: WorkflowState,
  received: DefinitionControlSignal | ExternalSignal,
  now: UtcInstant,
): WorkflowSignalJudgement {
  const signal = Object.freeze({ ...received });
  switch (signal.type) {
    case "definition_control":
      return judgeDefinitionControl(deps, state, signal, now);
    case "external_signal":
      if (typeof signal.subject !== "object" || signal.subject === null) {
        return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
      }
      if (!("definitionId" in signal.subject)) {
        return {
          kind: "not_applicable",
          rejection: { reason: "invalid_input", detail: "task_subject_not_definition_signal" },
        };
      }
      if (typeof signal.subject.definitionId !== "string") {
        return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
      }
      return judgeDefinitionExternalSignal(deps, state, signal, signal.subject.definitionId, now);
    default: {
      const unknownType: never = signal;
      void unknownType;
      return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
    }
  }
}
