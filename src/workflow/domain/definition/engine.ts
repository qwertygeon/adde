/**
 * 정의 진입점 — 회차 명령과 정의 대상 신호. 진입에서 명령·신호를 정규 JSON 동결 사본으로 한 번 뜨고 진입
 * 형을 본 뒤 그 사본으로 판정한다(Work 명령 진입과 같은 방식). 결과의 커밋은 표식·동결된다.
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
import { EXTERNAL_SIGNAL_COPY_RULES, copyEntry } from "../entry/copy.js";
import {
  canonicalInstant,
  isActorSourceValue,
  isCommandMetaShape,
  isPlainRecord,
  soleSubjectKey,
  withCanonicalNow,
} from "../entry/shape.js";
import { sealOutcome } from "../entry/seal.js";
import type { WorkDefinitionId } from "../ids.js";

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

function invalidInput(): { readonly kind: "rejected"; readonly rejection: CommandRejection } {
  return { kind: "rejected", rejection: { reason: "invalid_input" } };
}

function invalidSignalInput(): {
  readonly kind: "not_applicable";
  readonly rejection: CommandRejection;
} {
  return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
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
  const copied = copyEntry(received);
  if (!copied.ok || !isPlainRecord(copied.value) || !isCommandMetaShape(copied.value.meta)) {
    return sealOutcome(invalidInput());
  }
  return sealOutcome(executeDefinitionCommandOn(deps, state, withCanonicalNow(copied.value)));
}

function executeDefinitionCommandOn(
  deps: DomainDeps,
  state: WorkflowState,
  command: DefinitionCommand,
): WorkflowOutcome {
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

/**
 * 정의 제어 신호와 정의 대상 외부 신호. Task 대상 외부 신호는 Work 단위 판정의 몫이다. 신호를 정규 JSON 동결
 * 사본으로 한 번 뜨고(payload 는 깊이 루트), 진입 형(최상위 객체·진입 시각·출처 열거)을 본 뒤 판정한다. 외부
 * 신호의 subject 는 정확히 definitionId 하나여야 한다.
 */
export function judgeDefinitionSignal(
  deps: DomainDeps,
  state: WorkflowState,
  received: DefinitionControlSignal | ExternalSignal,
  now: UtcInstant,
): WorkflowSignalJudgement {
  const copied = copyEntry(received, EXTERNAL_SIGNAL_COPY_RULES);
  if (!copied.ok || !isPlainRecord(copied.value)) return sealOutcome(invalidSignalInput());
  const instant = canonicalInstant(now);
  if (instant === undefined) return sealOutcome(invalidSignalInput());
  if (!isActorSourceValue(copied.value.actorSource)) return sealOutcome(invalidSignalInput());
  return sealOutcome(judgeDefinitionSignalOn(deps, state, copied.value, instant));
}

function judgeDefinitionSignalOn(
  deps: DomainDeps,
  state: WorkflowState,
  signal: DefinitionControlSignal | ExternalSignal,
  now: UtcInstant,
): WorkflowSignalJudgement {
  switch (signal.type) {
    case "definition_control":
      return judgeDefinitionControl(deps, state, signal, now);
    case "external_signal": {
      const subject = soleSubjectKey(signal.subject);
      if (subject?.key === "taskId") {
        return {
          kind: "not_applicable",
          rejection: { reason: "invalid_input", detail: "task_subject_not_definition_signal" },
        };
      }
      if (subject?.key !== "definitionId") return invalidSignalInput();
      return judgeDefinitionExternalSignal(
        deps,
        state,
        signal,
        subject.value as WorkDefinitionId,
        now,
      );
    }
    default: {
      const unknownType: never = signal;
      void unknownType;
      return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
    }
  }
}
