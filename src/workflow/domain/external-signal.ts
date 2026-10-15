/**
 * 외부 신호 판정 — Task·정의 두 대상이 같은 검사 순서를 쓴다: 키 파생 → payload 정규 JSON 포착 → 중복 →
 * 종결 → 상태 적격 → Trigger 일치. 외부 신호는 기대 revision 이 없고 출처 요구도 없다 — 전송 인증은 사람
 * 의도를 주지 않으며 외부 신호는 아무것도 승인하지 않는다. payload 는 도메인에 들어오기 전에 마스킹된 값이어야
 * 하고 여기서 다시 마스킹하지 않는다. 어떤 거절도 occurrence 를 만들지 않고 subject 를 바꾸지 않는다.
 */
import type { TaskRecord, WorkAggregate } from "./aggregate.js";
import { taskOf } from "./aggregate.js";
import type { ExternalSignal } from "./commands.js";
import type { DecidedEvent, SignalSubjectRef, SignalTriggerRef } from "./events.js";
import { mkEvent } from "./events.js";
import type { TaskId, WorkDefinitionId, WorkId } from "./ids.js";
import type { UtcInstant } from "./values.js";
import { DomainInvariantError } from "./result.js";
import { isTerminalTaskState } from "./task-state.js";
import { requiresPreExecutionApproval } from "./policy/pre-execution-approval.js";
import { canonicalJsonFrozenCopy } from "./derivation/canonical-json.js";
import { deriveSignalDedupKey } from "./derivation/dedup-key.js";
import type { SignalDedupKey } from "./derivation/dedup-key.js";
import { deriveOccurrenceId } from "./derivation/occurrence-id.js";
import type { CommitMeta, DomainDeps, NonStaleReason } from "./engine.js";
import { assembleCommit } from "./engine.js";
import type { SignalJudgement } from "./signals.js";
import { isSignalActivation, signalActivationView } from "./definition/model.js";
import type { DefinitionRecord } from "./definition/model.js";
import type { WorkflowState } from "./definition/commit.js";
import { assembleWorkflowCommit, findSteward, withWork } from "./definition/commit.js";
import type { StewardWork } from "./definition/commit.js";
import { decideSignalOccurrence } from "./definition/occurrence.js";
import type { WorkflowSignalJudgement } from "./definition/engine.js";
import { EXTERNAL_SIGNAL_COPY_RULES, copyEntry } from "./entry/copy.js";
import {
  canonicalInstant,
  isActorSourceValue,
  isEntityIdText,
  isPlainRecord,
  soleSubjectKey,
} from "./entry/shape.js";
import { sealOutcome } from "./entry/seal.js";

/** 대상이 판정에 내놓는 관측 — 앞 검사가 통과한 뒤에만 다음 항목을 본다. */
export interface ExternalSignalSubjectView {
  readonly acceptedSignalKeys: readonly SignalDedupKey[];
  readonly terminal: boolean;
  readonly stateEligible: boolean;
  readonly triggerMatches: boolean;
}

export type ExternalSignalOutcome =
  | { readonly kind: "invalid_input" }
  | { readonly kind: "unknown_subject" }
  | { readonly kind: "duplicate"; readonly key: SignalDedupKey }
  | { readonly kind: "terminal"; readonly key: SignalDedupKey }
  | {
      readonly kind: "rejected";
      readonly key: SignalDedupKey;
      readonly reason: Extract<NonStaleReason, "unexpected_state" | "trigger_mismatch">;
    }
  | { readonly kind: "accept"; readonly key: SignalDedupKey; readonly payload: unknown };

/** 두 대상 공통 검사 순서. `view` 는 대상이 없으면 undefined. */
export function externalSignalOutcome(
  signal: ExternalSignal,
  subjectId: TaskId | WorkDefinitionId,
  view: () => ExternalSignalSubjectView | undefined,
): ExternalSignalOutcome {
  if (
    typeof signal.sourceId !== "string" ||
    typeof signal.signalName !== "string" ||
    typeof signal.sourceOccurrenceId !== "string"
  ) {
    return { kind: "invalid_input" };
  }
  const keyResult = deriveSignalDedupKey({
    signalType: "external_signal",
    subjectId,
    sourceId: signal.sourceId,
    signalName: signal.signalName,
    sourceOccurrenceId: signal.sourceOccurrenceId,
  });
  if (!keyResult.ok) return { kind: "invalid_input" };
  const key = keyResult.value;
  const payload = canonicalJsonFrozenCopy(signal.payload);
  if (!payload.ok) return { kind: "invalid_input" };
  const subject = view();
  if (subject === undefined) return { kind: "unknown_subject" };
  if (subject.acceptedSignalKeys.includes(key)) return { kind: "duplicate", key };
  if (subject.terminal) return { kind: "terminal", key };
  if (!subject.stateEligible) return { kind: "rejected", key, reason: "unexpected_state" };
  if (!subject.triggerMatches) return { kind: "rejected", key, reason: "trigger_mismatch" };
  return { kind: "accept", key, payload: payload.value };
}

function metaOf(signal: ExternalSignal, now: UtcInstant): CommitMeta {
  return {
    now,
    actorSource: signal.actorSource,
    ...(signal.actor !== undefined ? { actor: signal.actor } : {}),
  };
}

function triggerRefOf(signal: ExternalSignal): SignalTriggerRef {
  return { sourceId: signal.sourceId, signalName: signal.signalName };
}

/** 기록 전용 신호 이벤트 — 중복·종결·거절. */
function recordEvent(
  signal: ExternalSignal,
  outcome: Extract<ExternalSignalOutcome, { kind: "duplicate" | "terminal" | "rejected" }>,
  subject: SignalSubjectRef,
  observed: { readonly state: string; readonly revision: number },
  ref: { readonly taskId: TaskId } | { readonly workId: WorkId },
): DecidedEvent {
  switch (outcome.kind) {
    case "duplicate":
      return mkEvent(
        "signal_ignored_duplicate",
        {
          signalId: signal.signalId,
          signalType: "external_signal",
          dedupKey: outcome.key,
          subject,
        },
        ref,
      );
    case "terminal":
      return mkEvent(
        "signal_rejected_stale",
        {
          signalId: signal.signalId,
          signalType: "external_signal",
          candidateKey: outcome.key,
          subject,
          reason: "terminal_subject",
          observedState: observed.state,
          currentRevision: observed.revision,
          trigger: triggerRefOf(signal),
        },
        ref,
      );
    case "rejected":
      return mkEvent(
        "signal_rejected",
        {
          signalId: signal.signalId,
          signalType: "external_signal",
          candidateKey: outcome.key,
          subject,
          reason: outcome.reason,
          observedState: observed.state,
          trigger: triggerRefOf(signal),
        },
        ref,
      );
    default: {
      const exhaustive: never = outcome;
      throw new Error(`외부 신호: 알 수 없는 기록 결과 ${String(exhaustive)}`);
    }
  }
}

function acceptedEvent(
  signal: ExternalSignal,
  key: SignalDedupKey,
  subject: SignalSubjectRef,
  ref: { readonly taskId: TaskId } | { readonly workId: WorkId },
): DecidedEvent {
  return mkEvent(
    "signal_accepted",
    {
      signalId: signal.signalId,
      signalType: "external_signal",
      dedupKey: key,
      subject,
      trigger: triggerRefOf(signal),
    },
    ref,
  );
}

/** Task 의 Trigger 가 외부 신호 발화이고 출처·신호 이름이 같다. */
function taskTriggerMatches(deps: DomainDeps, task: TaskRecord, signal: ExternalSignal): boolean {
  const descriptor = deps.registries.triggers.get(task.trigger.kind, task.trigger.version);
  if (descriptor?.firing !== "external_signal") return false;
  const declared = task.trigger as { readonly sourceId?: unknown; readonly signal?: unknown };
  return declared.sourceId === signal.sourceId && declared.signal === signal.signalName;
}

/**
 * Task 대상 외부 신호. 신호를 정규 JSON 동결 사본으로 한 번 뜨고(payload 는 깊이 루트), 진입 형(최상위 객체·
 * 진입 시각·출처 열거·subject 가 정확히 taskId 하나이고 Task ID 형식)을 본 뒤 판정한다 — 형 위반은 기록 없는
 * invalid_input 이다. 수용하면 같은 커밋에서 수용 이벤트를 원인으로 예약한다 — 수용 이벤트 ID·시각이 정해진 뒤
 * occurrence 를 파생한다. 결과의 커밋은 표식·동결된다.
 */
export function judgeTaskExternalSignal(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  received: ExternalSignal,
  now: UtcInstant,
): SignalJudgement {
  const copied = copyEntry(received, EXTERNAL_SIGNAL_COPY_RULES);
  if (!copied.ok || !isPlainRecord(copied.value)) return sealOutcome(invalidExternalInput());
  const signal = copied.value;
  const instant = canonicalInstant(now);
  if (instant === undefined) return sealOutcome(invalidExternalInput());
  if (!isActorSourceValue(signal.actorSource)) return sealOutcome(invalidExternalInput());
  const subject = soleSubjectKey(signal.subject);
  if (subject === undefined || subject.key !== "taskId" || !isEntityIdText("task", subject.value)) {
    return sealOutcome(invalidExternalInput());
  }
  return sealOutcome(
    judgeTaskExternalSignalOn(deps, aggregate, signal, subject.value as TaskId, instant),
  );
}

function invalidExternalInput(): {
  readonly kind: "not_applicable";
  readonly rejection: { readonly reason: "invalid_input" };
} {
  return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
}

function judgeTaskExternalSignalOn(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  signal: ExternalSignal,
  taskId: TaskId,
  now: UtcInstant,
): SignalJudgement {
  const task = taskOf(aggregate, taskId);
  const outcome = externalSignalOutcome(signal, taskId, () =>
    task === undefined
      ? undefined
      : {
          acceptedSignalKeys: aggregate.acceptedSignalKeys,
          terminal: isTerminalTaskState(task.state),
          stateEligible: task.state === "READY" && !requiresPreExecutionApproval(task),
          triggerMatches: taskTriggerMatches(deps, task, signal),
        },
  );
  if (outcome.kind === "invalid_input" || outcome.kind === "unknown_subject") {
    return { kind: "not_applicable", rejection: { reason: outcome.kind } };
  }
  const found = task as TaskRecord;
  const subject: SignalSubjectRef = { taskId: found.id };
  const ref = { taskId: found.id };
  const meta = metaOf(signal, now);
  if (outcome.kind !== "accept") {
    const event = recordEvent(
      signal,
      outcome,
      subject,
      { state: found.state, revision: found.revision },
      ref,
    );
    const { commit } = assembleCommit(deps, aggregate, [event], meta);
    switch (outcome.kind) {
      case "duplicate":
        return { kind: "duplicate", dedupKey: outcome.key, commit };
      case "terminal":
        return { kind: "rejected_stale", reason: "terminal_subject", commit };
      case "rejected":
        return { kind: "rejected", reason: outcome.reason, commit };
      default: {
        const exhaustive: never = outcome;
        throw new Error(`외부 신호: 알 수 없는 결과 ${String(exhaustive)}`);
      }
    }
  }
  const triggerId = found.trigger.triggerId;
  const { commit, aggregate: next } = assembleCommit(
    deps,
    aggregate,
    {
      head: acceptedEvent(signal, outcome.key, subject, ref),
      then: (head) => {
        const derived = deriveOccurrenceId({
          kind: "event_caused",
          ownerId: found.id,
          triggerId,
          causingEvent: head,
        });
        if (!derived.ok) {
          throw new DomainInvariantError(
            `외부 신호 예약 occurrence 파생 실패: ${derived.error.field} ${derived.error.reason}`,
          );
        }
        return [
          mkEvent(
            "task_scheduled",
            { occurrenceId: derived.value, cause: "external_signal", causingEventId: head.id },
            ref,
          ),
        ];
      },
    },
    meta,
  );
  return { kind: "accepted", dedupKey: outcome.key, commit, aggregate: next };
}

/** 정의 활성화가 신호 활성화이고 출처·신호 이름이 같다. */
function definitionTriggerMatches(
  deps: DomainDeps,
  definition: DefinitionRecord,
  signal: ExternalSignal,
): boolean {
  if (!isSignalActivation(deps.registries, definition.activation)) return false;
  const view = signalActivationView(definition.activation);
  return (
    view !== undefined && view.sourceId === signal.sourceId && view.signal === signal.signalName
  );
}

/**
 * 정의 대상 외부 신호. 정의는 `ACTIVE`·`PAUSED` 만 남으므로 상태 거절이 없다 — 일시정지 중이면 회차를
 * 보류한다. 수용 이벤트에서 occurrence 를 파생해 materialize 하거나 보류하고, 신호 상한에 닿으면 중지한다.
 */
export function judgeDefinitionExternalSignal(
  deps: DomainDeps,
  state: WorkflowState,
  signal: ExternalSignal,
  definitionId: WorkDefinitionId,
  now: UtcInstant,
): WorkflowSignalJudgement {
  const steward = findSteward(state, definitionId);
  const outcome = externalSignalOutcome(signal, definitionId, () =>
    steward === undefined
      ? undefined
      : {
          acceptedSignalKeys: steward.acceptedSignalKeys,
          terminal: steward.definition.state === "STOPPED",
          stateEligible: true,
          triggerMatches: definitionTriggerMatches(deps, steward.definition, signal),
        },
  );
  if (outcome.kind === "invalid_input" || outcome.kind === "unknown_subject") {
    return { kind: "not_applicable", rejection: { reason: outcome.kind } };
  }
  const stewardWork = steward as StewardWork;
  const record = stewardWork.definition;
  const subject: SignalSubjectRef = { definitionId: record.id };
  const ref = { workId: stewardWork.work.id };
  const meta = metaOf(signal, now);
  if (outcome.kind !== "accept") {
    const event = recordEvent(
      signal,
      outcome,
      subject,
      { state: record.state, revision: record.revision },
      ref,
    );
    const assembled = assembleCommit(deps, stewardWork, [event], meta);
    const recorded = { commit: assembled.commit, state: withWork(state, assembled.aggregate) };
    switch (outcome.kind) {
      case "duplicate":
        return { kind: "duplicate", dedupKey: outcome.key, ...recorded };
      case "terminal":
        return { kind: "rejected_stale", reason: "terminal_subject", ...recorded };
      case "rejected":
        return { kind: "rejected", reason: outcome.reason, ...recorded };
      default: {
        const exhaustive: never = outcome;
        throw new Error(`외부 신호: 알 수 없는 결과 ${String(exhaustive)}`);
      }
    }
  }
  const payload = outcome.payload;
  const assembled = assembleWorkflowCommit(
    deps,
    state,
    {
      head: {
        workId: stewardWork.work.id,
        event: acceptedEvent(signal, outcome.key, subject, ref),
      },
      then: (head) =>
        decideSignalOccurrence(
          deps,
          state,
          stewardWork,
          {
            sourceId: signal.sourceId,
            signalName: signal.signalName,
            sourceOccurrenceId: signal.sourceOccurrenceId,
            payload,
          },
          head,
          now,
        ),
    },
    meta,
  );
  return {
    kind: "accepted",
    dedupKey: outcome.key,
    commit: assembled.commit,
    state: assembled.state,
  };
}
