/**
 * createWork·executeCommand(커밋 조립·envelope·순서) — design.md §2 "실행 모델"·§3 "커밋 파이프라인"
 * 그대로. 공개 진입은 명령을 정규 JSON 동결 사본으로 한 번 뜨고 진입 형(최상위·meta·명령 종류·Task ID 형식)을
 * 본 뒤 그 사본으로 판정하며, 결과의 커밋을 표식·동결한다. 사전 검사 순서: 대상 존재 → (Task 명령) 종결 여부 →
 * `expectedRevision` 일치 → 명령 kind 가 현재 상태에서 가질 수 있는 행 존재 → (Task 명령) 재계획 게이트 →
 * 행 조건.
 */
import type { IdGenerator, EventId, CommitId } from "./ids.js";
import { nextEntityId } from "./ids.js";
import type { UtcInstant, ActorSource, ActorRef } from "./values.js";
import type { WorkAggregate } from "./aggregate.js";
import { taskOf } from "./aggregate.js";
import { isTerminalTaskState } from "./task-state.js";
import { isTerminalWorkState } from "./work-state.js";
import type { CreateWorkCommand, WorkflowCommand, TaskCommand, WorkCommand } from "./commands.js";
import { TASK_COMMAND_ROWS, TASK_NON_ROW_COMMANDS, WORK_COMMAND_ROWS } from "./commands.js";
import type { DomainRegistries } from "./registry/registries.js";
import type { PlanValidationIssue } from "./plan-graph.js";
import type { DecidedEvent, DomainEvent } from "./events.js";
import {
  DEFINITION_TRANSITION_EVENT_TYPES,
  WORKFLOW_EVENT_SCHEMA_VERSION,
  mkEvent,
} from "./events.js";
import { evolveCommit } from "./evolve.js";
import { decideTaskCommand } from "./task-decide.js";
import { decideCreateWork, decideWorkCommand } from "./work-decide.js";
import {
  decideDependencyCascadeRound,
  decideDerivedWorkStateEvent,
  decidePendingProposalRevalidation,
  decideReplanDroppedCancellations,
  decideWorkCancellationCascade,
} from "./cascade.js";
import { isReplanGatedTaskCommand, isReplanWaitHeld } from "./plan/replan.js";
import type { RecurrenceExpander } from "./definition/model.js";
import { decideStop, workCascadeStopOrigin } from "./definition/resolution.js";
import type { CausingEventRef } from "./derivation/occurrence-id.js";
import type { IsolatedCopyFailure } from "./derivation/canonical-json.js";
import { DomainInvariantError } from "./result.js";
import { COMMAND_COPY_RULES, copyEntry } from "./entry/copy.js";
import {
  isCommandMetaShape,
  isEntityIdText,
  isOwnMember,
  isPlainRecord,
  withCanonicalNow,
} from "./entry/shape.js";
import { sealOutcome } from "./entry/seal.js";

export interface OperationalDefaults {
  readonly agentDispatchDeadlineMs: number;
  /** 결과 크기 상한(정규 JSON UTF-8 바이트). 결과 기록 시점에 양의 안전 정수가 아니면 DomainInvariantError. */
  readonly resultInlineMaxBytes?: number;
}
export type OutputRedactor = (
  outputs: Readonly<Record<string, unknown>>,
) => Readonly<Record<string, unknown>>;
/** 검증·발화 방식 조회·연쇄가 같은 등록부를 쓴다. */
export interface DomainDeps {
  readonly ids: IdGenerator;
  readonly operationalDefaults: OperationalDefaults;
  readonly registries: DomainRegistries;
  /** 출력 마스킹. 결과 기록 시점에 부재면 DomainInvariantError. 결정적이어야 한다. */
  readonly redactOutputs?: OutputRedactor;
  /** 반복 전개 포트. 일정 활성화를 다루는 시점에 부재면 DomainInvariantError. 결정적이어야 한다. */
  readonly recurrence?: RecurrenceExpander;
}
export interface DomainCommit {
  readonly id: CommitId;
  readonly events: readonly DomainEvent[];
}
export type CommandRejectionReason =
  | "terminal_subject"
  | "revision_mismatch"
  | "transition_not_in_table"
  | "condition_not_met"
  | "invalid_input"
  | "unknown_subject"
  | "unsupported_in_this_phase"
  | "replan_open";
export interface CommandRejection {
  readonly reason: CommandRejectionReason;
  readonly detail?: string;
  /** 계획 재검증 무효로 거절할 때만 — 수집 순서 그대로의 이슈 전부. */
  readonly planIssues?: readonly PlanValidationIssue[];
}
export type CommandOutcome =
  | { readonly kind: "committed"; readonly commit: DomainCommit; readonly aggregate: WorkAggregate }
  | {
      readonly kind: "rejected";
      readonly rejection: CommandRejection;
      readonly record?: DomainCommit;
    };

export type StaleReason = "revision_mismatch" | "token_mismatch" | "terminal_subject";
export type NonStaleReason =
  "provenance_not_human" | "unexpected_state" | "trigger_mismatch" | "validity_passed";

export interface CommitMeta {
  readonly now: UtcInstant;
  readonly actorSource: ActorSource;
  readonly actor?: ActorRef;
  readonly causationId?: string;
}

/**
 * 지연 head 주 이벤트 — 신호 수용 이벤트(head)의 ID·시각이 정해진 뒤 그 이벤트에서 파생하는 나머지 주
 * 이벤트를 만든다. 나머지의 판정 단계 ID 는 head 이벤트 ID 뒤에 소비된다.
 */
export interface DeferredMain {
  readonly head: DecidedEvent;
  readonly then: (head: CausingEventRef) => readonly DecidedEvent[];
}

const DEFINITION_TRANSITION_SET: ReadonlySet<string> = new Set(DEFINITION_TRANSITION_EVENT_TYPES);

interface Staged {
  readonly id: EventId;
  readonly decided: DecidedEvent;
  readonly causationId?: string;
}

function buildEnvelope(
  work: WorkAggregate["work"] | undefined,
  commitId: CommitId,
  index: number,
  count: number,
  meta: CommitMeta,
  staged: Staged,
): DomainEvent {
  const isWorkCreated = staged.decided.type === "work_created";
  const payload = staged.decided.payload as Record<string, unknown>;
  const projectId = isWorkCreated
    ? (payload["projectId"] as string)
    : (work as WorkAggregate["work"]).projectId;
  // 단일 Work 조립 — 결정 이벤트가 다른 Work 를 가리키면 그 Work 의 스트림에 섞이므로 막는다.
  const workId = isWorkCreated ? (payload["workId"] as string) : (work as WorkAggregate["work"]).id;
  const decidedWorkId = staged.decided.workId;
  if (decidedWorkId !== undefined && decidedWorkId !== workId) {
    throw new DomainInvariantError(
      `결정 이벤트 ${staged.decided.type} 의 workId ${decidedWorkId} 가 조립 대상 Work ${workId} 와 다르다`,
    );
  }
  const correlationId = isWorkCreated
    ? (payload["correlationId"] as string)
    : (work as WorkAggregate["work"]).correlationId;
  return {
    schemaVersion: WORKFLOW_EVENT_SCHEMA_VERSION,
    id: staged.id,
    type: staged.decided.type,
    occurredAt: meta.now,
    projectId,
    workId,
    ...(staged.decided.taskId !== undefined ? { taskId: staged.decided.taskId } : {}),
    correlationId,
    ...(staged.causationId !== undefined ? { causationId: staged.causationId } : {}),
    ...(meta.actor !== undefined ? { actor: meta.actor } : {}),
    actorSource: meta.actorSource,
    commit: { id: commitId, index, count },
    payload: staged.decided.payload,
  } as unknown as DomainEvent;
}

function isDeferredMain(main: readonly DecidedEvent[] | DeferredMain): main is DeferredMain {
  return !Array.isArray(main);
}

/**
 * 커밋 조립 — §3 단계 2~7. 주 이벤트는 배열(신호 수용이면 맨 앞에 `signal_accepted`) 또는 지연 head.
 * `aggregateBefore` 가 `undefined` 면 `work_created` 로 새 애그리거트를 만든다.
 */
export function assembleCommit(
  deps: DomainDeps,
  aggregateBefore: WorkAggregate | undefined,
  main: readonly DecidedEvent[] | DeferredMain,
  meta: CommitMeta,
): { readonly commit: DomainCommit; readonly aggregate: WorkAggregate } {
  const commitId = nextEntityId(deps.ids, "commit");
  const staged: Staged[] = [];
  let scratch: WorkAggregate | undefined = aggregateBefore;
  let lastStateChangingId: string | undefined;

  function applyBatch(
    batch: readonly { readonly decided: DecidedEvent; readonly causationId?: string }[],
  ): void {
    if (batch.length === 0) return;
    const startIndex = staged.length;
    const newStaged: Staged[] = batch.map((b) => ({
      id: nextEntityId(deps.ids, "event"),
      decided: b.decided,
      ...(b.causationId !== undefined ? { causationId: b.causationId } : {}),
    }));
    for (const item of newStaged) staged.push(item);
    const envs = newStaged.map((s, i) =>
      buildEnvelope(scratch?.work, commitId, startIndex + i + 1, 0, meta, s),
    );
    scratch = evolveCommit(scratch, envs);
    for (const s of newStaged) {
      if (
        s.decided.taskId !== undefined ||
        s.decided.type === "work_plan_committed" ||
        DEFINITION_TRANSITION_SET.has(s.decided.type)
      )
        lastStateChangingId = s.id;
    }
  }

  // 2. 주 이벤트
  if (isDeferredMain(main)) {
    applyBatch([
      {
        decided: main.head,
        ...(meta.causationId !== undefined ? { causationId: meta.causationId } : {}),
      },
    ]);
    const head = staged[0] as Staged;
    const rest = main.then({ id: head.id, occurredAt: meta.now });
    applyBatch(rest.map((d) => ({ decided: d, causationId: head.id })));
  } else if (main.length > 0 && main[0]?.type === "signal_accepted") {
    applyBatch([
      {
        decided: main[0],
        ...(meta.causationId !== undefined ? { causationId: meta.causationId } : {}),
      },
    ]);
    const signalAcceptedId = staged[0]?.id as string;
    applyBatch(main.slice(1).map((d) => ({ decided: d, causationId: signalAcceptedId })));
  } else {
    applyBatch(
      main.map((d) => ({
        decided: d,
        ...(meta.causationId !== undefined ? { causationId: meta.causationId } : {}),
      })),
    );
  }

  // 2a. 재계획 탈락 취소 — 커밋 이벤트 ID 를 출처에 싣는다.
  const committedStaged = staged.find((s) => s.decided.type === "work_plan_committed");
  if (committedStaged !== undefined && scratch !== undefined) {
    const committed = committedStaged.decided as Extract<
      DecidedEvent,
      { readonly type: "work_plan_committed" }
    >;
    if (committed.payload.dropped.length > 0) {
      const cancellations = decideReplanDroppedCancellations(
        scratch,
        committedStaged.id,
        committed.payload.dropped,
        meta.actorSource,
      );
      applyBatch(
        cancellations.map((c) => ({
          decided: c.event,
          ...(c.causationEventId !== undefined ? { causationId: c.causationEventId } : {}),
        })),
      );
    }
  }

  // 3. Work 취소 연쇄
  const workCanceledStaged = staged.find((s) => s.decided.type === "work_canceled");
  if (workCanceledStaged !== undefined && scratch !== undefined) {
    const cascadeEvents = decideWorkCancellationCascade(
      scratch,
      workCanceledStaged.id,
      meta.actorSource,
    );
    applyBatch(
      cascadeEvents.map((c) => ({
        decided: c.event,
        ...(c.causationEventId !== undefined ? { causationId: c.causationEventId } : {}),
      })),
    );
    // 관리 Work 취소는 살아 있는 정의를 같은 커밋에서 멈춘다(회차 Work 는 다른 애그리거트라 그대로).
    const definition = scratch?.definition;
    if (definition !== undefined && definition.state !== "STOPPED") {
      const canceled = workCanceledStaged.decided as Extract<
        DecidedEvent,
        { readonly type: "work_canceled" }
      >;
      const stopEvents = decideStop(
        deps,
        definition,
        workCascadeStopOrigin(canceled.payload.origin, meta.actorSource),
        meta.now,
      );
      applyBatch(stopEvents.map((d) => ({ decided: d, causationId: workCanceledStaged.id })));
    }
  }

  // 4. 의존 연쇄 고정점
  for (;;) {
    if (scratch === undefined) break;
    const round = decideDependencyCascadeRound(deps.registries, scratch);
    if (round.length === 0) break;
    applyBatch(
      round.map((c) => ({
        decided: c.event,
        ...(c.causationEventId !== undefined ? { causationId: c.causationEventId } : {}),
      })),
    );
  }

  // 4a. 대기 제안 재검증 — 의존 연쇄의 종결까지 본 뒤 판정한다.
  if (scratch !== undefined) {
    const withdrawal = decidePendingProposalRevalidation(
      deps,
      aggregateBefore,
      scratch,
      lastStateChangingId,
    );
    if (withdrawal !== undefined) {
      applyBatch([
        {
          decided: withdrawal.event,
          ...(withdrawal.causationEventId !== undefined
            ? { causationId: withdrawal.causationEventId }
            : {}),
        },
      ]);
    }
  }

  // 5. 파생 Work 상태
  if (scratch !== undefined) {
    const derived = decideDerivedWorkStateEvent(scratch, lastStateChangingId);
    if (derived !== undefined) {
      applyBatch([
        {
          decided: derived.event,
          ...(derived.causationEventId !== undefined
            ? { causationId: derived.causationEventId }
            : {}),
        },
      ]);
    }
  }

  // 6~7. envelope 최종 확정(count 보정) + 단일 evolve
  const total = staged.length;
  const finalEvents = staged.map((s, i) =>
    buildEnvelope(aggregateBefore?.work, commitId, i + 1, total, meta, s),
  );
  const finalAggregate = evolveCommit(aggregateBefore, finalEvents);
  return { commit: { id: commitId, events: finalEvents }, aggregate: finalAggregate };
}

function invalidInput(detail?: string): {
  readonly kind: "rejected";
  readonly rejection: CommandRejection;
} {
  return {
    kind: "rejected",
    rejection: { reason: "invalid_input", ...(detail !== undefined ? { detail } : {}) },
  };
}

/**
 * Work 생성. 명령을 정규 JSON 동결 사본으로 한 번 뜨고 최상위·meta 형을 본 뒤 그 사본으로 판정한다 — 형
 * 위반은 커밋 없는 invalid_input 이다. 결과의 커밋은 표식·동결된다.
 */
export function createWork(deps: DomainDeps, received: CreateWorkCommand): CommandOutcome {
  const copied = copyEntry(received);
  if (!copied.ok || !isPlainRecord(copied.value) || !isCommandMetaShape(copied.value.meta)) {
    return sealOutcome(invalidInput());
  }
  return sealOutcome(createWorkOn(deps, withCanonicalNow(copied.value)));
}

function createWorkOn(deps: DomainDeps, command: CreateWorkCommand): CommandOutcome {
  const decided = decideCreateWork(deps, command);
  if (decided.kind === "rejected") return { kind: "rejected", rejection: decided.rejection };
  const { commit, aggregate } = assembleCommit(deps, undefined, decided.events, {
    now: command.meta.now,
    actorSource: command.meta.actorSource,
    ...(command.meta.actor !== undefined ? { actor: command.meta.actor } : {}),
    ...(command.meta.causationId !== undefined ? { causationId: command.meta.causationId } : {}),
  });
  return { kind: "committed", commit, aggregate };
}

function isTaskCommand(command: WorkflowCommand): command is TaskCommand {
  return "taskId" in command;
}

/**
 * Task·Work 명령 실행. 명령을 정규 JSON 동결 사본으로 한 번 뜬다 — 접근자·Proxy 가 읽을 때마다 다른 값을 내도
 * 재계획 게이트·판정·기록이 같은 값을 본다. 계획은 깊이 루트, 완료 보고의 출력·evidence 는 격리 경로다. 진입 형
 * (최상위·meta·명령 종류·Task ID 형식) 위반과 사본 실패는 커밋 없는 invalid_input 이고, 격리 실패는 완료 보고일
 * 때만 판정으로 넘어가 출력 위반 실패 attempt 가 된다. 결과의 커밋은 표식·동결된다.
 */
export function executeCommand(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  received: WorkflowCommand,
): CommandOutcome {
  const copied = copyEntry(received, COMMAND_COPY_RULES);
  if (!copied.ok || !isPlainRecord(copied.value) || !isCommandMetaShape(copied.value.meta)) {
    return sealOutcome(invalidInput());
  }
  const command = withCanonicalNow(copied.value);
  if (isTaskCommand(command)) {
    if (!isOwnMember(TASK_COMMAND_ROWS, command.kind)) {
      return sealOutcome(invalidInput("unknown_command"));
    }
    if (!isEntityIdText("task", command.taskId)) return sealOutcome(invalidInput());
  } else {
    // Work 생성은 createWork 진입만 받는다 — 행 표에는 있지만 명령 실행의 종류가 아니다.
    const kind: string = command.kind;
    if (!isOwnMember(WORK_COMMAND_ROWS, kind) || kind === "create_work") {
      return sealOutcome(invalidInput("unknown_command"));
    }
  }
  const isolated = copied.isolated;
  if (isolated.length > 0 && !isCompletedOutcomeReport(command)) {
    return sealOutcome(invalidInput());
  }
  return sealOutcome(executeCommandOn(deps, aggregate, command, isolated));
}

function isCompletedOutcomeReport(command: WorkflowCommand): boolean {
  if (command.kind !== "record_attempt_outcome") return false;
  const outcome: unknown = command.outcome;
  return isPlainRecord(outcome) && outcome["kind"] === "completed";
}

function executeCommandOn(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  command: WorkflowCommand,
  isolated: readonly IsolatedCopyFailure[],
): CommandOutcome {
  const meta = {
    now: command.meta.now,
    actorSource: command.meta.actorSource,
    ...(command.meta.actor !== undefined ? { actor: command.meta.actor } : {}),
    ...(command.meta.causationId !== undefined ? { causationId: command.meta.causationId } : {}),
  };

  if (isTaskCommand(command)) {
    const task = taskOf(aggregate, command.taskId);
    if (task === undefined) return { kind: "rejected", rejection: { reason: "unknown_subject" } };

    if (isTerminalTaskState(task.state)) {
      const { commit } = assembleCommit(
        deps,
        aggregate,
        [
          mkEvent(
            "stale_transition_rejected",
            {
              commandKind: command.kind,
              reason: "terminal_subject",
              observedState: task.state,
              currentRevision: task.revision,
              expectedRevision: command.expectedRevision,
            },
            { taskId: task.id },
          ),
        ],
        meta,
      );
      return { kind: "rejected", rejection: { reason: "terminal_subject" }, record: commit };
    }
    if (task.revision !== command.expectedRevision) {
      const { commit } = assembleCommit(
        deps,
        aggregate,
        [
          mkEvent(
            "stale_transition_rejected",
            {
              commandKind: command.kind,
              reason: "revision_mismatch",
              observedState: task.state,
              currentRevision: task.revision,
              expectedRevision: command.expectedRevision,
            },
            { taskId: task.id },
          ),
        ],
        meta,
      );
      return { kind: "rejected", rejection: { reason: "revision_mismatch" }, record: commit };
    }
    const reachableRows = TASK_COMMAND_ROWS[command.kind];
    if (
      (reachableRows === undefined || reachableRows.length === 0) &&
      !TASK_NON_ROW_COMMANDS.includes(command.kind)
    ) {
      return { kind: "rejected", rejection: { reason: "transition_not_in_table" } };
    }
    if (
      isReplanWaitHeld(aggregate.work) &&
      isReplanGatedTaskCommand(deps.registries, task, command)
    ) {
      return { kind: "rejected", rejection: { reason: "replan_open" } };
    }
    const decided = decideTaskCommand(deps, task, command, aggregate, isolated);
    if (decided.kind === "rejected") return { kind: "rejected", rejection: decided.rejection };
    const { commit, aggregate: nextAggregate } = assembleCommit(
      deps,
      aggregate,
      decided.events,
      meta,
    );
    return { kind: "committed", commit, aggregate: nextAggregate };
  }

  const workCommand = command as WorkCommand;
  const work = aggregate.work;
  if (isTerminalWorkState(work.state)) {
    return { kind: "rejected", rejection: { reason: "terminal_subject" } };
  }
  if (work.revision !== workCommand.expectedRevision) {
    return { kind: "rejected", rejection: { reason: "revision_mismatch" } };
  }
  const reachableRows = WORK_COMMAND_ROWS[workCommand.kind];
  if (reachableRows === undefined || reachableRows.length === 0) {
    return { kind: "rejected", rejection: { reason: "transition_not_in_table" } };
  }
  const decided = decideWorkCommand(deps, aggregate, workCommand);
  if (decided.kind === "rejected") return { kind: "rejected", rejection: decided.rejection };
  const { commit, aggregate: nextAggregate } = assembleCommit(
    deps,
    aggregate,
    decided.events,
    meta,
  );
  return { kind: "committed", commit, aggregate: nextAggregate };
}
