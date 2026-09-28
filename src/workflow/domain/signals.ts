/**
 * 신호 판정(FR-017, FR-018, FR-019, NFR-003) — design.md §7 적용표·세부 규칙 그대로. 검사 순서
 * provenance → 중복(`acceptedSignalKeys`) → 종결 → 토큰 → revision → 유효기한 → 적격 상태.
 * revision 비교-교체는 신원을 검증하지 않는다(FR-019) — 현재 revision 을 실은 위조 신호도 같은 결과로
 * 통과한다.
 */
import type { WorkAggregate, TaskRecord, WorkRecord } from "./aggregate.js";
import { taskOf } from "./aggregate.js";
import type { UtcInstant } from "./values.js";
import { isTerminalTaskState } from "./task-state.js";
import { isTerminalWorkState } from "./work-state.js";
import { evaluateTime } from "./task-decide.js";
import type { DecisionSignal, DelegationResponseSignal, DecisionApplication } from "./commands.js";
import type { DecidedEvent } from "./events.js";
import { mkEvent } from "./events.js";
import { decidePlanCommit } from "./work-decide.js";
import { deriveSignalDedupKey } from "./derivation/dedup-key.js";
import type { SignalDedupKey } from "./derivation/dedup-key.js";
import { deriveOccurrenceId } from "./derivation/occurrence-id.js";
import type {
  DomainDeps,
  DomainCommit,
  CommandRejection,
  StaleReason,
  NonStaleReason,
} from "./engine.js";
import { assembleCommit } from "./engine.js";

export type SignalJudgement =
  | {
      readonly kind: "accepted";
      readonly dedupKey: SignalDedupKey;
      readonly commit: DomainCommit;
      readonly aggregate: WorkAggregate;
    }
  | { readonly kind: "duplicate"; readonly dedupKey: SignalDedupKey; readonly commit: DomainCommit }
  | { readonly kind: "rejected_stale"; readonly reason: StaleReason; readonly commit: DomainCommit }
  | { readonly kind: "rejected"; readonly reason: NonStaleReason; readonly commit: DomainCommit }
  | { readonly kind: "forged_provenance"; readonly commit: DomainCommit }
  | { readonly kind: "not_applicable"; readonly rejection: CommandRejection };

export type DelegationStalenessJudgement =
  | { readonly kind: "duplicate"; readonly dedupKey: SignalDedupKey; readonly commit: DomainCommit }
  | { readonly kind: "rejected_stale"; readonly reason: StaleReason; readonly commit: DomainCommit }
  | { readonly kind: "staleness_passed"; readonly candidateKey: SignalDedupKey }
  | { readonly kind: "not_applicable"; readonly rejection: CommandRejection };

type Subject = { readonly taskId: TaskRecord["id"] } | { readonly workId: WorkRecord["id"] };

function baseMeta(signal: DecisionSignal | DelegationResponseSignal, now: UtcInstant) {
  return {
    now,
    actorSource: signal.actorSource,
    ...(signal.actor !== undefined ? { actor: signal.actor } : {}),
  };
}

function record(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  event: DecidedEvent,
  now: UtcInstant,
  signal: DecisionSignal | DelegationResponseSignal,
): DomainCommit {
  return assembleCommit(deps, aggregate, [event], baseMeta(signal, now)).commit;
}

function isAccepted(aggregate: WorkAggregate, key: SignalDedupKey): boolean {
  return aggregate.acceptedSignalKeys.includes(key);
}

export function judgeSignal(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  signal: DecisionSignal,
  application: DecisionApplication,
  now: UtcInstant,
): SignalJudgement {
  switch (signal.type) {
    case "confirmation_decision":
      return judgeConfirmationDecision(deps, aggregate, signal, now);
    case "human_decision":
      return judgeHumanDecision(deps, aggregate, signal, application, now);
    case "cancel_requested":
      return judgeCancelRequested(deps, aggregate, signal, now);
    case "replan_requested":
      return judgeReplanRequested(deps, aggregate, signal, now);
    default: {
      const exhaustive: never = signal;
      throw new Error(`judgeSignal: 알 수 없는 신호 ${String(exhaustive)}`);
    }
  }
}

function judgeConfirmationDecision(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  signal: Extract<DecisionSignal, { type: "confirmation_decision" }>,
  now: UtcInstant,
): SignalJudgement {
  const task = taskOf(aggregate, signal.taskId);
  if (task === undefined)
    return { kind: "not_applicable", rejection: { reason: "unknown_subject" } };
  const subject: Subject = { taskId: task.id };

  if (signal.actorSource !== "human_local") {
    return {
      kind: "forged_provenance",
      commit: record(
        deps,
        aggregate,
        mkEvent(
          "confirmation_rejected_forged_provenance",
          {
            signalId: signal.signalId,
            signalType: "confirmation_decision",
            candidateKey: candidateKeyOrEmpty(signal, task),
            subject,
            determinedActorSource: signal.actorSource,
            ...(signal.provenance !== undefined ? { provenance: signal.provenance } : {}),
          },
          { taskId: task.id },
        ),
        now,
        signal,
      ),
    };
  }

  const keyResult = deriveSignalDedupKey({
    signalType: "confirmation_decision",
    confirmationId: signal.confirmationId,
    expectedRevision: signal.expectedRevision,
    decision: signal.decision,
  });
  if (!keyResult.ok) return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
  const candidateKey = keyResult.value;

  if (isAccepted(aggregate, candidateKey)) {
    return {
      kind: "duplicate",
      dedupKey: candidateKey,
      commit: record(
        deps,
        aggregate,
        mkEvent(
          "signal_ignored_duplicate",
          {
            signalId: signal.signalId,
            signalType: "confirmation_decision",
            dedupKey: candidateKey,
            subject,
          },
          { taskId: task.id },
        ),
        now,
        signal,
      ),
    };
  }
  if (isTerminalTaskState(task.state)) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "terminal_subject",
      candidateKey,
      task.state,
      signal.expectedRevision,
      task.revision,
      subject,
    );
  }
  if (signal.confirmationId !== task.confirmationId) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "token_mismatch",
      candidateKey,
      task.state,
      signal.expectedRevision,
      task.revision,
      subject,
    );
  }
  if (signal.expectedRevision !== task.revision) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "revision_mismatch",
      candidateKey,
      task.state,
      signal.expectedRevision,
      task.revision,
      subject,
    );
  }
  if (signal.decision !== "cancel") {
    const time = evaluateTime(task, now);
    if (time.validityPassed) {
      return nonStaleCommit(
        deps,
        aggregate,
        signal,
        now,
        "validity_passed",
        candidateKey,
        task.state,
        subject,
      );
    }
  }
  if (task.state !== "WAITING_CONFIRMATION") {
    return nonStaleCommit(
      deps,
      aggregate,
      signal,
      now,
      "unexpected_state",
      candidateKey,
      task.state,
      subject,
    );
  }

  const signalAccepted = mkEvent(
    "signal_accepted",
    {
      signalId: signal.signalId,
      signalType: "confirmation_decision",
      dedupKey: candidateKey,
      subject,
    },
    { taskId: task.id },
  );
  const transitionEvent =
    signal.decision === "accept"
      ? mkEvent(
          "confirmation_accepted",
          { confirmationId: signal.confirmationId, signalId: signal.signalId },
          { taskId: task.id },
        )
      : signal.decision === "reject"
        ? mkEvent(
            "confirmation_rejected",
            { confirmationId: signal.confirmationId, signalId: signal.signalId },
            { taskId: task.id },
          )
        : mkEvent(
            "confirmation_cancelled",
            {
              confirmationId: signal.confirmationId,
              origin: {
                kind: "vault_signal",
                actorSource: "human_local",
                signalId: signal.signalId,
              },
            },
            { taskId: task.id },
          );
  const { commit, aggregate: nextAggregate } = assembleCommit(
    deps,
    aggregate,
    [signalAccepted, transitionEvent],
    baseMeta(signal, now),
  );
  return { kind: "accepted", dedupKey: candidateKey, commit, aggregate: nextAggregate };
}

function judgeHumanDecision(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  signal: Extract<DecisionSignal, { type: "human_decision" }>,
  application: DecisionApplication,
  now: UtcInstant,
): SignalJudgement {
  const subjectRef = aggregate.decisionSubjects[signal.decisionId];
  if (subjectRef === undefined)
    return { kind: "not_applicable", rejection: { reason: "unknown_subject" } };

  if (signal.actorSource !== "human_local") {
    const subject: Subject = subjectRef;
    return {
      kind: "rejected",
      reason: "provenance_not_human",
      commit: record(
        deps,
        aggregate,
        mkEvent(
          "signal_rejected",
          {
            signalId: signal.signalId,
            signalType: "human_decision",
            candidateKey: emptyKey(),
            subject,
            reason: "provenance_not_human",
            observedState: "",
          },
          "taskId" in subject ? { taskId: subject.taskId } : { workId: subject.workId },
        ),
        now,
        signal,
      ),
    };
  }

  if ("taskId" in subjectRef) {
    return judgeHumanDecisionForTask(deps, aggregate, signal, application, now, subjectRef.taskId);
  }
  return judgeHumanDecisionForWork(deps, aggregate, signal, application, now, subjectRef.workId);
}

function judgeHumanDecisionForTask(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  signal: Extract<DecisionSignal, { type: "human_decision" }>,
  application: DecisionApplication,
  now: UtcInstant,
  taskId: TaskRecord["id"],
): SignalJudgement {
  const task = taskOf(aggregate, taskId);
  if (task === undefined)
    return { kind: "not_applicable", rejection: { reason: "unknown_subject" } };
  const subject: Subject = { taskId };

  const keyResult = deriveSignalDedupKey({
    signalType: "human_decision",
    decisionId: signal.decisionId,
    expectedRevision: signal.expectedRevision,
    choice: signal.choice,
  });
  if (!keyResult.ok) return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
  const candidateKey = keyResult.value;

  if (isAccepted(aggregate, candidateKey)) {
    return {
      kind: "duplicate",
      dedupKey: candidateKey,
      commit: record(
        deps,
        aggregate,
        mkEvent(
          "signal_ignored_duplicate",
          {
            signalId: signal.signalId,
            signalType: "human_decision",
            dedupKey: candidateKey,
            subject,
          },
          { taskId },
        ),
        now,
        signal,
      ),
    };
  }
  if (isTerminalTaskState(task.state)) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "terminal_subject",
      candidateKey,
      task.state,
      signal.expectedRevision,
      task.revision,
      subject,
    );
  }
  if (task.pendingDecision === undefined || task.pendingDecision.id !== signal.decisionId) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "token_mismatch",
      candidateKey,
      task.state,
      signal.expectedRevision,
      task.revision,
      subject,
    );
  }
  if (signal.expectedRevision !== task.revision) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "revision_mismatch",
      candidateKey,
      task.state,
      signal.expectedRevision,
      task.revision,
      subject,
    );
  }
  const time = evaluateTime(task, now);
  if (time.validityPassed || time.decisionExpired) {
    return nonStaleCommit(
      deps,
      aggregate,
      signal,
      now,
      "validity_passed",
      candidateKey,
      task.state,
      subject,
    );
  }
  if (task.state !== "BLOCKED_AWAITING_HUMAN") {
    return nonStaleCommit(
      deps,
      aggregate,
      signal,
      now,
      "unexpected_state",
      candidateKey,
      task.state,
      subject,
    );
  }

  const signalAccepted = mkEvent(
    "signal_accepted",
    { signalId: signal.signalId, signalType: "human_decision", dedupKey: candidateKey, subject },
    { taskId },
  );
  let transitionEvents: DecidedEvent[];
  if (signal.choice === "grant") {
    if (application.kind !== "task_grant")
      return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
    if (application.resume.to === "READY") {
      transitionEvents = [
        mkEvent(
          "human_decision_granted",
          { decisionId: signal.decisionId, resumedTo: "READY" },
          { taskId },
        ),
      ];
    } else {
      const occurrenceId =
        application.resume.occurrence.kind === "given"
          ? application.resume.occurrence.occurrenceId
          : deriveOccurrenceId({
              kind: "execution_retry",
              ownerId: taskId,
              triggerId: task.trigger.triggerId,
              // grant 이벤트(자신)를 원인으로 삼는다 — 파생은 occurredAt·attemptNo 만 쓴다(GAP-012).
              causingEvent: { occurredAt: now },
              attemptNo: task.lastAttemptNo + 1,
            });
      const occId =
        typeof occurrenceId === "string"
          ? occurrenceId
          : occurrenceId.ok
            ? occurrenceId.value
            : undefined;
      if (occId === undefined)
        return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
      transitionEvents = [
        mkEvent(
          "human_decision_granted",
          { decisionId: signal.decisionId, resumedTo: "SCHEDULED", occurrenceId: occId },
          { taskId },
        ),
      ];
    }
  } else {
    if (application.kind !== "task_deny")
      return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
    if (application.resolution === "declined") {
      transitionEvents = [
        mkEvent(
          "human_decision_denied",
          { decisionId: signal.decisionId, role: "transition" },
          { taskId },
        ),
      ];
    } else {
      transitionEvents = [
        mkEvent(
          "task_failed",
          { reason: { kind: "decision_discarded", decisionId: signal.decisionId } },
          { taskId },
        ),
        mkEvent(
          "human_decision_denied",
          { decisionId: signal.decisionId, role: "companion" },
          { taskId },
        ),
      ];
    }
  }
  const { commit, aggregate: nextAggregate } = assembleCommit(
    deps,
    aggregate,
    [signalAccepted, ...transitionEvents],
    baseMeta(signal, now),
  );
  return { kind: "accepted", dedupKey: candidateKey, commit, aggregate: nextAggregate };
}

function judgeHumanDecisionForWork(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  signal: Extract<DecisionSignal, { type: "human_decision" }>,
  application: DecisionApplication,
  now: UtcInstant,
  workId: WorkRecord["id"],
): SignalJudgement {
  const work = aggregate.work;
  if (work.id !== workId)
    return { kind: "not_applicable", rejection: { reason: "unknown_subject" } };
  const subject: Subject = { workId };

  const keyResult = deriveSignalDedupKey({
    signalType: "human_decision",
    decisionId: signal.decisionId,
    expectedRevision: signal.expectedRevision,
    choice: signal.choice,
  });
  if (!keyResult.ok) return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
  const candidateKey = keyResult.value;

  if (isAccepted(aggregate, candidateKey)) {
    return {
      kind: "duplicate",
      dedupKey: candidateKey,
      commit: record(
        deps,
        aggregate,
        mkEvent(
          "signal_ignored_duplicate",
          {
            signalId: signal.signalId,
            signalType: "human_decision",
            dedupKey: candidateKey,
            subject,
          },
          { workId },
        ),
        now,
        signal,
      ),
    };
  }
  if (isTerminalWorkState(work.state)) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "terminal_subject",
      candidateKey,
      work.state,
      signal.expectedRevision,
      work.revision,
      subject,
    );
  }
  if (work.pendingDecision === undefined || work.pendingDecision.id !== signal.decisionId) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "token_mismatch",
      candidateKey,
      work.state,
      signal.expectedRevision,
      work.revision,
      subject,
    );
  }
  if (signal.expectedRevision !== work.revision) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "revision_mismatch",
      candidateKey,
      work.state,
      signal.expectedRevision,
      work.revision,
      subject,
    );
  }
  if (work.state !== "WAITING_APPROVAL") {
    return nonStaleCommit(
      deps,
      aggregate,
      signal,
      now,
      "unexpected_state",
      candidateKey,
      work.state,
      subject,
    );
  }

  const signalAccepted = mkEvent(
    "signal_accepted",
    { signalId: signal.signalId, signalType: "human_decision", dedupKey: candidateKey, subject },
    { workId },
  );
  let transitionEvents: DecidedEvent[];
  if (signal.choice === "grant") {
    if (application.kind !== "plan_grant")
      return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
    const proposal = application.proposal;
    // design.md §6 "신호 human_decision grant (plan 주체)" 행: 적용 입력의 제안 ID·digest 가
    // 대기 제안과 같아야 한다.
    if (
      proposal.proposalId !== work.pendingProposalId ||
      proposal.digest !== work.pendingProposalDigest
    ) {
      return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
    }
    // 초안 검증·task_created·draftRefMap 생성은 work-decide.ts::decidePlanCommit 재사용(복제 금지).
    const planDecision = decidePlanCommit(deps, work, proposal, { decisionId: signal.decisionId });
    if (planDecision.kind === "rejected") {
      // design.md 는 grant 커밋 규칙 위반(basePlanRevision 불일치 등)의 신호 판정 결과를 명시하지
      // 않는다 — 임시로 not_applicable 로 표면화(구현 이탈 아님, 명령 경로와 같은 거절 사유 전달).
      return { kind: "not_applicable", rejection: planDecision.rejection };
    }
    transitionEvents = [...planDecision.events];
  } else {
    if (application.kind !== "plan_deny")
      return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
    const closesReplan = work.planRevision >= 1;
    transitionEvents = [
      mkEvent(
        "work_plan_rejected",
        {
          proposalId: work.pendingProposalId as import("./ids.js").PlanProposalId,
          decisionId: signal.decisionId,
          closesReplan,
        },
        { workId },
      ),
      ...(closesReplan ? [mkEvent("work_ready", {}, { workId })] : []),
    ];
  }
  const { commit, aggregate: nextAggregate } = assembleCommit(
    deps,
    aggregate,
    [signalAccepted, ...transitionEvents],
    baseMeta(signal, now),
  );
  return { kind: "accepted", dedupKey: candidateKey, commit, aggregate: nextAggregate };
}

function judgeCancelRequested(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  signal: Extract<DecisionSignal, { type: "cancel_requested" }>,
  now: UtcInstant,
): SignalJudgement {
  const isTaskSubject = "taskId" in signal.subject;
  const task = isTaskSubject ? taskOf(aggregate, signal.subject.taskId) : undefined;
  if (isTaskSubject && task === undefined)
    return { kind: "not_applicable", rejection: { reason: "unknown_subject" } };
  if (!isTaskSubject && signal.subject.workId !== aggregate.work.id) {
    return { kind: "not_applicable", rejection: { reason: "unknown_subject" } };
  }
  const subject: Subject = isTaskSubject
    ? { taskId: (task as TaskRecord).id }
    : { workId: aggregate.work.id };

  if (signal.actorSource !== "human_local") {
    const isWaitingConfirmation =
      isTaskSubject && (task as TaskRecord).state === "WAITING_CONFIRMATION";
    const eventName = isWaitingConfirmation
      ? "confirmation_rejected_forged_provenance"
      : "signal_rejected";
    const observedState = isTaskSubject ? (task as TaskRecord).state : aggregate.work.state;
    const decided: DecidedEvent =
      eventName === "confirmation_rejected_forged_provenance"
        ? mkEvent(
            "confirmation_rejected_forged_provenance",
            {
              signalId: signal.signalId,
              signalType: "cancel_requested",
              candidateKey: emptyKey(),
              subject,
              determinedActorSource: signal.actorSource,
            },
            isTaskSubject ? { taskId: (task as TaskRecord).id } : { workId: aggregate.work.id },
          )
        : mkEvent(
            "signal_rejected",
            {
              signalId: signal.signalId,
              signalType: "cancel_requested",
              candidateKey: emptyKey(),
              subject,
              reason: "provenance_not_human",
              observedState,
            },
            isTaskSubject ? { taskId: (task as TaskRecord).id } : { workId: aggregate.work.id },
          );
    return {
      kind:
        eventName === "confirmation_rejected_forged_provenance" ? "forged_provenance" : "rejected",
      ...(eventName === "signal_rejected"
        ? { reason: "provenance_not_human" as NonStaleReason }
        : {}),
      commit: record(deps, aggregate, decided, now, signal),
    } as SignalJudgement;
  }

  const keyResult = deriveSignalDedupKey({
    signalType: "cancel_requested",
    subjectId: isTaskSubject ? (task as TaskRecord).id : aggregate.work.id,
    expectedRevision: signal.expectedRevision,
  });
  if (!keyResult.ok) return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
  const candidateKey = keyResult.value;

  if (isAccepted(aggregate, candidateKey)) {
    return {
      kind: "duplicate",
      dedupKey: candidateKey,
      commit: record(
        deps,
        aggregate,
        mkEvent(
          "signal_ignored_duplicate",
          {
            signalId: signal.signalId,
            signalType: "cancel_requested",
            dedupKey: candidateKey,
            subject,
          },
          isTaskSubject ? { taskId: (task as TaskRecord).id } : { workId: aggregate.work.id },
        ),
        now,
        signal,
      ),
    };
  }

  const currentState = isTaskSubject ? (task as TaskRecord).state : aggregate.work.state;
  const currentRevision = isTaskSubject ? (task as TaskRecord).revision : aggregate.work.revision;
  const isTerminal = isTaskSubject
    ? isTerminalTaskState(currentState as never)
    : isTerminalWorkState(currentState as never);
  if (isTerminal) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "terminal_subject",
      candidateKey,
      currentState,
      signal.expectedRevision,
      currentRevision,
      subject,
    );
  }
  if (signal.expectedRevision !== currentRevision) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "revision_mismatch",
      candidateKey,
      currentState,
      signal.expectedRevision,
      currentRevision,
      subject,
    );
  }

  const origin = {
    kind: "vault_signal" as const,
    actorSource: "human_local" as const,
    signalId: signal.signalId,
  };
  const signalAccepted = mkEvent(
    "signal_accepted",
    { signalId: signal.signalId, signalType: "cancel_requested", dedupKey: candidateKey, subject },
    isTaskSubject ? { taskId: (task as TaskRecord).id } : { workId: aggregate.work.id },
  );
  const transitionEvent = isTaskSubject
    ? (task as TaskRecord).state === "WAITING_CONFIRMATION"
      ? mkEvent(
          "confirmation_cancelled",
          {
            confirmationId: (task as TaskRecord)
              .confirmationId as import("./ids.js").ConfirmationId,
            origin,
          },
          { taskId: (task as TaskRecord).id },
        )
      : mkEvent("task_canceled", { origin }, { taskId: (task as TaskRecord).id })
    : mkEvent("work_canceled", { origin }, { workId: aggregate.work.id });
  const { commit, aggregate: nextAggregate } = assembleCommit(
    deps,
    aggregate,
    [signalAccepted, transitionEvent],
    baseMeta(signal, now),
  );
  return { kind: "accepted", dedupKey: candidateKey, commit, aggregate: nextAggregate };
}

function judgeReplanRequested(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  signal: Extract<DecisionSignal, { type: "replan_requested" }>,
  now: UtcInstant,
): SignalJudgement {
  const work = aggregate.work;
  if (work.id !== signal.workId)
    return { kind: "not_applicable", rejection: { reason: "unknown_subject" } };
  const subject: Subject = { workId: work.id };

  if (signal.actorSource !== "human_local") {
    return {
      kind: "rejected",
      reason: "provenance_not_human",
      commit: record(
        deps,
        aggregate,
        mkEvent(
          "signal_rejected",
          {
            signalId: signal.signalId,
            signalType: "replan_requested",
            candidateKey: emptyKey(),
            subject,
            reason: "provenance_not_human",
            observedState: work.state,
          },
          { workId: work.id },
        ),
        now,
        signal,
      ),
    };
  }

  const keyResult = deriveSignalDedupKey({
    signalType: "replan_requested",
    workId: work.id,
    expectedRevision: signal.expectedRevision,
  });
  if (!keyResult.ok) return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
  const candidateKey = keyResult.value;

  if (isAccepted(aggregate, candidateKey)) {
    return {
      kind: "duplicate",
      dedupKey: candidateKey,
      commit: record(
        deps,
        aggregate,
        mkEvent(
          "signal_ignored_duplicate",
          {
            signalId: signal.signalId,
            signalType: "replan_requested",
            dedupKey: candidateKey,
            subject,
          },
          { workId: work.id },
        ),
        now,
        signal,
      ),
    };
  }
  if (isTerminalWorkState(work.state)) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "terminal_subject",
      candidateKey,
      work.state,
      signal.expectedRevision,
      work.revision,
      subject,
    );
  }
  if (signal.expectedRevision !== work.revision) {
    return staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "revision_mismatch",
      candidateKey,
      work.state,
      signal.expectedRevision,
      work.revision,
      subject,
    );
  }
  if (work.state !== "ACTIVE" && work.state !== "BLOCKED") {
    return nonStaleCommit(
      deps,
      aggregate,
      signal,
      now,
      "unexpected_state",
      candidateKey,
      work.state,
      subject,
    );
  }

  const signalAccepted = mkEvent(
    "signal_accepted",
    { signalId: signal.signalId, signalType: "replan_requested", dedupKey: candidateKey, subject },
    { workId: work.id },
  );
  const transitionEvent = mkEvent(
    "work_replanning_started",
    { signalId: signal.signalId },
    { workId: work.id },
  );
  const { commit, aggregate: nextAggregate } = assembleCommit(
    deps,
    aggregate,
    [signalAccepted, transitionEvent],
    baseMeta(signal, now),
  );
  return { kind: "accepted", dedupKey: candidateKey, commit, aggregate: nextAggregate };
}

/**
 * `judgeDelegationResponseStaleness` 는 중복 → 종결 → 토큰(인자가 `undefined` 면 생략) → revision 까지만
 * 판정한다(ADR-012, DEC-004). 통과(`staleness_passed`)는 이벤트·키 claim 없이 후보 키만 돌려준다(CUT-003).
 */
export function judgeDelegationResponseStaleness(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  signal: DelegationResponseSignal,
  currentDelegationOccurrenceId: import("./ids.js").OccurrenceId | undefined,
  now: UtcInstant,
): DelegationStalenessJudgement {
  const task = taskOf(aggregate, signal.taskId);
  if (task === undefined)
    return { kind: "not_applicable", rejection: { reason: "unknown_subject" } };
  const subject: Subject = { taskId: task.id };

  const keyResult = deriveSignalDedupKey({
    signalType: "delegation_response",
    taskId: task.id,
    expectedRevision: signal.expectedRevision,
    occurrenceId: signal.occurrenceId,
    responseContentHash: signal.responseContentHash,
  });
  if (!keyResult.ok) return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
  const candidateKey = keyResult.value;

  if (isAccepted(aggregate, candidateKey)) {
    return {
      kind: "duplicate",
      dedupKey: candidateKey,
      commit: record(
        deps,
        aggregate,
        mkEvent(
          "signal_ignored_duplicate",
          {
            signalId: signal.signalId,
            signalType: "delegation_response",
            dedupKey: candidateKey,
            subject,
          },
          { taskId: task.id },
        ),
        now,
        signal,
      ),
    };
  }
  if (isTerminalTaskState(task.state)) {
    const staled = staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "terminal_subject",
      candidateKey,
      task.state,
      signal.expectedRevision,
      task.revision,
      subject,
    );
    return staled as DelegationStalenessJudgement;
  }
  if (
    currentDelegationOccurrenceId !== undefined &&
    signal.occurrenceId !== currentDelegationOccurrenceId
  ) {
    const staled = staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "token_mismatch",
      candidateKey,
      task.state,
      signal.expectedRevision,
      task.revision,
      subject,
    );
    return staled as DelegationStalenessJudgement;
  }
  if (signal.expectedRevision !== task.revision) {
    const staled = staleCommit(
      deps,
      aggregate,
      signal,
      now,
      "revision_mismatch",
      candidateKey,
      task.state,
      signal.expectedRevision,
      task.revision,
      subject,
    );
    return staled as DelegationStalenessJudgement;
  }
  return { kind: "staleness_passed", candidateKey };
}

function emptyKey(): SignalDedupKey {
  return "" as SignalDedupKey;
}
function candidateKeyOrEmpty(_signal: unknown, _task: TaskRecord): SignalDedupKey {
  return emptyKey();
}

function staleCommit(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  signal: DecisionSignal | DelegationResponseSignal,
  now: UtcInstant,
  reason: StaleReason,
  candidateKey: SignalDedupKey,
  observedState: string,
  comparedRevision: number,
  currentRevision: number,
  subject: Subject,
): SignalJudgement {
  return {
    kind: "rejected_stale",
    reason,
    commit: record(
      deps,
      aggregate,
      mkEvent(
        "signal_rejected_stale",
        {
          signalId: signal.signalId,
          signalType: signal.type,
          candidateKey,
          subject,
          reason,
          observedState,
          comparedRevision,
          currentRevision,
        },
        "taskId" in subject ? { taskId: subject.taskId } : { workId: subject.workId },
      ),
      now,
      signal,
    ),
  };
}

function nonStaleCommit(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  signal: DecisionSignal,
  now: UtcInstant,
  reason: NonStaleReason,
  candidateKey: SignalDedupKey,
  observedState: string,
  subject: Subject,
): SignalJudgement {
  return {
    kind: "rejected",
    reason,
    commit: record(
      deps,
      aggregate,
      mkEvent(
        "signal_rejected",
        {
          signalId: signal.signalId,
          signalType: signal.type,
          candidateKey,
          subject,
          reason,
          observedState,
        },
        "taskId" in subject ? { taskId: subject.taskId } : { workId: subject.workId },
      ),
      now,
      signal,
    ),
  };
}
