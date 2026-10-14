/**
 * 정의 제어 신호 판정 — 검사 순서: 동작·정의 ID 형 → 키 파생 → 관리 Work → 출처(채널 형 포함) → revision 형
 * → 중복 → 종결 → revision → 상태. 정의 이벤트는 Work 참조를 싣지 않는다 — 조립이 관리 Work 의 work.id 로 채운다.
 * 거절은 기록 전용 이벤트만 남기고 정의 상태·revision 을 바꾸지 않는다. 수용 커밋은 관리 Work 의 단일 Work
 * 커밋이라 대기 개정 제안 철회·관리 Work 완료가 같은 커밋에서 평가된다.
 *
 * 이 판정이 보증하는 범위의 한계:
 * - revision 비교-교체는 멱등 통제이지 신원 통제가 아니다. 한 revision 에 효과 있는 결정을 하나로 묶고
 *   대체된 결정의 재생을 거절할 뿐, 누가 신호를 냈는지는 말하지 않는다 — 현재 revision 을 실은 위조
 *   신호도 진짜 신호와 똑같이 통과한다. 수용 키 색인도 효과 있는 전이의 수를 묶을 뿐 원인 주체를 정하지
 *   않는다.
 * - 행위자 출처는 시간 창·경로 기반 추론이다. 암호학적 보증이 아니고, 달성 수준은 위협 등급마다 계약 표가
 *   정한 수준을 넘지 않는다. 출처 판정은 위조 자기승인 경로를 좁힐 뿐 닫지 않는다 — 재개를 `human_local`
 *   로 묶는 것은 그 수준의 보증이다.
 * - 제어 큐 인증은 같은 사용자 프로세스 사이의 신뢰 경계를 만들지 않는다. 키 파일은 에이전트와 같은 uid
 *   소유라 임의 파일을 읽을 수 있는 행위자는 인증된 요청을 낼 수 있다. 인증은 키를 읽지 못하는 프로세스의
 *   대리 요청을 막고 미인증 시도를 기록할 뿐, 인증된 요청을 누가 작성했는지 확립하지 않는다 — 그래서 제어
 *   요청 출처는 `unknown` 이다. 인증 자체와 동작 ↔ 인증 op 대응은 제어 큐가 확인한 요청만 이 채널로
 *   넘긴다는 전제다.
 */
import type { WorkAggregate } from "../aggregate.js";
import type { DefinitionControlSignal } from "../commands.js";
import type { DecidedEvent, SignalSubjectRef } from "../events.js";
import { mkEvent } from "../events.js";
import type { UtcInstant } from "../values.js";
import { hasControlRequestAuthShape, instantMs } from "../values.js";
import type { CommitMeta, DomainDeps, NonStaleReason, StaleReason } from "../engine.js";
import { assembleCommit } from "../engine.js";
import { deriveSignalDedupKey } from "../derivation/dedup-key.js";
import type { SignalDedupKey } from "../derivation/dedup-key.js";
import type { DefinitionPauseOrigin, DefinitionRecord, DefinitionStopOrigin } from "./model.js";
import { decideStop } from "./resolution.js";
import type { WorkflowState } from "./commit.js";
import { findSteward, withWork } from "./commit.js";
import type { WorkflowSignalJudgement } from "./engine.js";

const CONTROL_ACTIONS: ReadonlySet<string> = new Set(["pause", "resume", "stop"]);

type ControlAction = DefinitionControlSignal["action"];

function metaOf(signal: DefinitionControlSignal, now: UtcInstant): CommitMeta {
  return {
    now,
    actorSource: signal.actorSource,
    ...(signal.actor !== undefined ? { actor: signal.actor } : {}),
  };
}

/**
 * 재개는 vault ∧ `human_local` 만. 일시정지·중지는 그것 또는 인증 형태를 갖춘 제어 요청(`unknown`·ctl_ ID·
 * `keyId`). 객체가 아닌 채널은 인증되지 않은 채널이다. `actorSource` 는 열거 값과의 엄격한 같음 비교라 형이
 * 틀린 값은 어느 조건도 통과하지 못한다.
 */
function provenanceAllowed(signal: DefinitionControlSignal, action: ControlAction): boolean {
  if (typeof signal.channel !== "object" || signal.channel === null) return false;
  const channel = signal.channel as { readonly kind?: unknown };
  if (channel.kind === "vault_signal") return signal.actorSource === "human_local";
  if (action === "resume" || channel.kind !== "control_request") return false;
  const request = signal.channel as {
    readonly controlRequestId?: unknown;
    readonly keyId?: unknown;
  };
  return hasControlRequestAuthShape({
    actorSource: signal.actorSource,
    controlRequestId: request.controlRequestId,
    keyId: request.keyId,
  });
}

/** 수용된 신호의 전이 출처 — 제어 요청이면 요청 ID 와 키 ID 를 모두 기록한다. */
function originOf(signal: DefinitionControlSignal): DefinitionPauseOrigin & DefinitionStopOrigin {
  const channel = signal.channel;
  return {
    kind: channel.kind,
    actorSource: signal.actorSource,
    signalId: signal.signalId,
    ...(channel.kind === "control_request"
      ? { controlRequestId: channel.controlRequestId, keyId: channel.keyId }
      : {}),
  };
}

function stateAllows(definition: DefinitionRecord, action: ControlAction): boolean {
  switch (action) {
    case "pause":
      return definition.state === "ACTIVE";
    case "resume":
      return definition.state === "PAUSED";
    case "stop":
      return definition.state === "ACTIVE" || definition.state === "PAUSED";
    default: {
      const exhaustive: never = action;
      throw new Error(`정의 제어: 알 수 없는 동작 ${String(exhaustive)}`);
    }
  }
}

function transitionEvents(
  deps: DomainDeps,
  definition: DefinitionRecord,
  signal: DefinitionControlSignal,
  action: ControlAction,
  now: UtcInstant,
): readonly DecidedEvent[] {
  switch (action) {
    case "pause":
      return [
        mkEvent("work_definition_paused", {
          definitionId: definition.id,
          pauseOrigin: originOf(signal),
        }),
      ];
    case "resume": {
      const pending = definition.pendingSchedule;
      return [
        mkEvent("work_definition_resumed", {
          definitionId: definition.id,
          signalId: signal.signalId,
          pendingScheduleOverdue:
            pending !== undefined && instantMs(pending.scheduledForUtc) <= instantMs(now),
        }),
      ];
    }
    case "stop":
      return decideStop(deps, definition, originOf(signal), now);
    default: {
      const exhaustive: never = action;
      throw new Error(`정의 제어: 알 수 없는 동작 ${String(exhaustive)}`);
    }
  }
}

export function judgeDefinitionControl(
  deps: DomainDeps,
  state: WorkflowState,
  signal: DefinitionControlSignal,
  now: UtcInstant,
): WorkflowSignalJudgement {
  if (!CONTROL_ACTIONS.has(signal.action) || typeof signal.definitionId !== "string") {
    return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
  }
  const action = signal.action;
  const keyResult = deriveSignalDedupKey({
    signalType: "definition_control",
    definitionId: signal.definitionId,
    expectedRevision: signal.expectedRevision,
    action,
  });
  if (!keyResult.ok) return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
  const candidateKey = keyResult.value;
  const steward = findSteward(state, signal.definitionId);
  if (steward === undefined) {
    return { kind: "not_applicable", rejection: { reason: "unknown_subject" } };
  }
  const definition = steward.definition;

  const subject: SignalSubjectRef = { definitionId: definition.id };
  const ref = { workId: steward.work.id };
  const meta = metaOf(signal, now);
  function commitOf(events: readonly DecidedEvent[]) {
    const assembled = assembleCommit(deps, steward as WorkAggregate, events, meta);
    return { commit: assembled.commit, state: withWork(state, assembled.aggregate) };
  }
  function rejected(reason: NonStaleReason): WorkflowSignalJudgement {
    const event = mkEvent(
      "signal_rejected",
      {
        signalId: signal.signalId,
        signalType: "definition_control",
        candidateKey,
        subject,
        reason,
        observedState: (definition as DefinitionRecord).state,
      },
      ref,
    );
    return { kind: "rejected", reason, ...commitOf([event]) };
  }
  function stale(reason: StaleReason): WorkflowSignalJudgement {
    const event = mkEvent(
      "signal_rejected_stale",
      {
        signalId: signal.signalId,
        signalType: "definition_control",
        candidateKey,
        subject,
        reason,
        observedState: (definition as DefinitionRecord).state,
        comparedRevision: signal.expectedRevision,
        currentRevision: (definition as DefinitionRecord).revision,
      },
      ref,
    );
    return { kind: "rejected_stale", reason, ...commitOf([event]) };
  }

  if (!provenanceAllowed(signal, action)) return rejected("provenance_not_human");
  // 출처를 통과한 신호의 revision 형 — 형이 틀린 값은 중복 색인과 revision 비교에 닿지 않는다(거절 기록의
  // 후보 키에만 실림). 이 거절을 실을 계약 거절 이벤트가 없어 기록 없는 invalid_input 이다.
  if (!Number.isSafeInteger(signal.expectedRevision) || signal.expectedRevision < 0) {
    return { kind: "not_applicable", rejection: { reason: "invalid_input" } };
  }
  if (steward.acceptedSignalKeys.includes(candidateKey)) {
    const event = mkEvent(
      "signal_ignored_duplicate",
      {
        signalId: signal.signalId,
        signalType: "definition_control",
        dedupKey: candidateKey,
        subject,
      },
      ref,
    );
    return { kind: "duplicate", dedupKey: candidateKey, ...commitOf([event]) };
  }
  if (definition.state === "STOPPED") return stale("terminal_subject");
  if (signal.expectedRevision !== definition.revision) return stale("revision_mismatch");
  if (!stateAllows(definition, action)) return rejected("unexpected_state");

  const accepted = mkEvent(
    "signal_accepted",
    {
      signalId: signal.signalId,
      signalType: "definition_control",
      dedupKey: candidateKey,
      subject,
    },
    ref,
  );
  return {
    kind: "accepted",
    dedupKey: candidateKey satisfies SignalDedupKey,
    ...commitOf([accepted, ...transitionEvents(deps, definition, signal, action, now)]),
  };
}
