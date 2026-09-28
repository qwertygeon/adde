/**
 * createWork·executeCommand(커밋 조립·envelope·순서) — design.md §2 "실행 모델"·§3 "커밋 파이프라인"
 * 그대로. 사전 검사 순서: 대상 존재 → (Task 명령) 종결 여부 → `expectedRevision` 일치 → 명령 kind 가
 * 현재 상태에서 가질 수 있는 행 존재 → 행 조건.
 */
import type { IdGenerator, EventId, CommitId } from "./ids.js";
import { nextEntityId } from "./ids.js";
import type { UtcInstant, ActorSource, ActorRef } from "./values.js";
import type { WorkAggregate } from "./aggregate.js";
import { taskOf } from "./aggregate.js";
import { isTerminalTaskState } from "./task-state.js";
import { isTerminalWorkState } from "./work-state.js";
import type { CreateWorkCommand, WorkflowCommand, TaskCommand, WorkCommand } from "./commands.js";
import { TASK_COMMAND_ROWS, WORK_COMMAND_ROWS } from "./commands.js";
import type { DecidedEvent, DomainEvent } from "./events.js";
import { WORKFLOW_EVENT_SCHEMA_VERSION, mkEvent } from "./events.js";
import { evolveCommit } from "./evolve.js";
import { decideTaskCommand } from "./task-decide.js";
import { decideCreateWork, decideWorkCommand } from "./work-decide.js";
import {
  decideDependencyCascadeRound,
  decideDerivedWorkStateEvent,
  decideWorkCancellationCascade,
} from "./cascade.js";

export interface OperationalDefaults {
  readonly agentDispatchDeadlineMs: number;
}
export interface DomainDeps {
  readonly ids: IdGenerator;
  readonly operationalDefaults: OperationalDefaults;
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
  | "unsupported_in_this_phase";
export interface CommandRejection {
  readonly reason: CommandRejectionReason;
  readonly detail?: string;
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

interface CommitMeta {
  readonly now: UtcInstant;
  readonly actorSource: ActorSource;
  readonly actor?: ActorRef;
  readonly causationId?: string;
}

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
  const workId =
    staged.decided.workId ??
    (isWorkCreated ? (payload["workId"] as string) : (work as WorkAggregate["work"]).id);
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

/**
 * 커밋 조립 — §3 단계 2~7. `mainDecided` 는 주 이벤트(신호 수용이면 맨 앞에 `signal_accepted`).
 * `aggregateBefore` 가 `undefined` 면 `work_created` 로 새 애그리거트를 만든다.
 */
export function assembleCommit(
  deps: DomainDeps,
  aggregateBefore: WorkAggregate | undefined,
  mainDecided: readonly DecidedEvent[],
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
    staged.push(...newStaged);
    const envs = newStaged.map((s, i) =>
      buildEnvelope(scratch?.work, commitId, startIndex + i + 1, 0, meta, s),
    );
    scratch = evolveCommit(scratch, envs);
    for (const s of newStaged) {
      if (s.decided.taskId !== undefined || s.decided.type === "work_plan_committed")
        lastStateChangingId = s.id;
    }
  }

  // 2. 주 이벤트
  const isSignalPath = mainDecided.length > 0 && mainDecided[0]?.type === "signal_accepted";
  if (isSignalPath) {
    applyBatch([
      {
        decided: mainDecided[0] as DecidedEvent,
        ...(meta.causationId !== undefined ? { causationId: meta.causationId } : {}),
      },
    ]);
    const signalAcceptedId = staged[0]?.id as string;
    applyBatch(mainDecided.slice(1).map((d) => ({ decided: d, causationId: signalAcceptedId })));
  } else {
    applyBatch(
      mainDecided.map((d) => ({
        decided: d,
        ...(meta.causationId !== undefined ? { causationId: meta.causationId } : {}),
      })),
    );
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
  }

  // 4. 의존 연쇄 고정점
  for (;;) {
    if (scratch === undefined) break;
    const round = decideDependencyCascadeRound(scratch);
    if (round.length === 0) break;
    applyBatch(
      round.map((c) => ({
        decided: c.event,
        ...(c.causationEventId !== undefined ? { causationId: c.causationEventId } : {}),
      })),
    );
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

export function createWork(deps: DomainDeps, command: CreateWorkCommand): CommandOutcome {
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

export function executeCommand(
  deps: DomainDeps,
  aggregate: WorkAggregate,
  command: WorkflowCommand,
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
    if (reachableRows === undefined || reachableRows.length === 0) {
      return { kind: "rejected", rejection: { reason: "transition_not_in_table" } };
    }
    const decided = decideTaskCommand(deps, task, command);
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
  const decided = decideWorkCommand(deps, work, workCommand);
  if (decided.kind === "rejected") return { kind: "rejected", rejection: decided.rejection };
  const { commit, aggregate: nextAggregate } = assembleCommit(
    deps,
    aggregate,
    decided.events,
    meta,
  );
  return { kind: "committed", commit, aggregate: nextAggregate };
}
