/**
 * 여러 Work 에 걸친 커밋 — 정의 회차의 materialize 는 관리 Work 의 정의 이벤트와 새 회차 Work 의 이벤트를
 * 한 커밋에 담는다. 조립기는 Work 별 구간을 순서대로 스테이징해 그 Work 의 scratch 에 적용하고, 기존 커밋
 * 연쇄(재계획 탈락·Work 취소·의존·대기 제안 재검증·파생 상태)를 Work 별로 부른다 — 새 회차 Work 는 자기
 * 구간 직후, 이미 있던 Work 는 커밋 끝. 최종 envelope 은 커밋 전체에 index 1..count 를 매기고 Work 별로
 * 나눠 `evolveCommit` 을 한 번씩 적용한다. `foldWorkflowEvents` 가 같은 `evolveCommit` 으로 로그를 접으므로
 * 접은 상태는 조립 결과와 같다.
 */
import { type Result, ok, err, DomainInvariantError } from "../result.js";
import type { CommitId, EventId, WorkId, WorkDefinitionId } from "../ids.js";
import { nextEntityId } from "../ids.js";
import type { WorkAggregate } from "../aggregate.js";
import { isTerminalWorkState } from "../work-state.js";
import type { DecidedEvent, DomainEvent, WorkflowEventEnvelope } from "../events.js";
import {
  DEFINITION_TRANSITION_EVENT_TYPES,
  DOMAIN_EVENT_PRODUCERS,
  WORKFLOW_EVENT_SCHEMA_VERSION,
} from "../events.js";
import { EVENT_CATALOG } from "../contract/index.js";
import { evolveCommit } from "../evolve.js";
import type { FoldError } from "../fold.js";
import type { CommitMeta, DomainCommit, DomainDeps } from "../engine.js";
import type { CausingEventRef } from "../derivation/occurrence-id.js";
import {
  decideDependencyCascadeRound,
  decideDerivedWorkStateEvent,
  decidePendingProposalRevalidation,
  decideReplanDroppedCancellations,
  decideWorkCancellationCascade,
} from "../cascade.js";
import type { DefinitionRecord } from "./model.js";
import { decideStop, workCascadeStopOrigin } from "./resolution.js";

/** 여러 Work 의 상태. 키: WorkId. */
export interface WorkflowState {
  readonly works: Readonly<Record<string, WorkAggregate>>;
}

export function workflowStateOf(aggregates: readonly WorkAggregate[]): WorkflowState {
  const works: Record<string, WorkAggregate> = {};
  for (const aggregate of aggregates) {
    if (works[aggregate.work.id] !== undefined) {
      throw new DomainInvariantError(`WorkflowState: 같은 Work 가 둘이다 ${aggregate.work.id}`);
    }
    works[aggregate.work.id] = aggregate;
  }
  return { works };
}

export function withWork(state: WorkflowState, aggregate: WorkAggregate): WorkflowState {
  return { works: { ...state.works, [aggregate.work.id]: aggregate } };
}

/** 정의를 관리하는 Work — 정의 값이 있는 애그리거트. */
export type StewardWork = WorkAggregate & { readonly definition: DefinitionRecord };

function stewardsDefinition(
  aggregate: WorkAggregate,
  definitionId: WorkDefinitionId,
): aggregate is StewardWork {
  const definition = aggregate.definition;
  return definition !== undefined && definition.id === definitionId;
}

/**
 * 정의를 관리하는 Work. 정의가 없는 Work 는 어떤 ID 와도 맞지 않는다. 같은 정의를 둘 이상의 Work 가
 * 가지거나, 찾은 Work 의 상태 키가 그 work.id 와 다르면 불변식 위반이다 — 판정 결과는 work.id 로 기록·저장되므로
 * 키가 다르면 같은 Work 가 상태에 둘로 남는다.
 */
export function findSteward(
  state: WorkflowState,
  definitionId: WorkDefinitionId,
): StewardWork | undefined {
  let found: StewardWork | undefined;
  for (const [key, aggregate] of Object.entries(state.works)) {
    if (!stewardsDefinition(aggregate, definitionId)) continue;
    if (key !== aggregate.work.id) {
      throw new DomainInvariantError(
        `정의 ${definitionId} 의 관리 Work 상태 키 ${key} 가 work.id ${aggregate.work.id} 와 다르다`,
      );
    }
    if (found !== undefined) {
      throw new DomainInvariantError(
        `정의 ${definitionId} 를 관리하는 Work 가 둘 이상이다(${found.work.id}, ${aggregate.work.id})`,
      );
    }
    found = aggregate;
  }
  return found;
}

/** 정의가 materialize 한 회차 Work 중 비종결인 것의 수. 목록의 Work 가 상태에 없으면 불변식 위반이다. */
export function openOccurrenceCount(state: WorkflowState, definition: DefinitionRecord): number {
  let open = 0;
  for (const materialized of definition.materialized) {
    const aggregate = state.works[materialized.workId];
    if (aggregate === undefined) {
      throw new DomainInvariantError(
        `정의 ${definition.id} 의 회차 Work ${materialized.workId} 가 WorkflowState 에 없다`,
      );
    }
    if (!isTerminalWorkState(aggregate.work.state)) open += 1;
  }
  return open;
}

/** 커밋 한 구간 — 이미 있는 Work 의 이벤트, 또는 `work_created` 로 시작하는 새 Work 의 이벤트. */
export type WorkflowPiece =
  | { readonly kind: "existing"; readonly workId: WorkId; readonly events: readonly DecidedEvent[] }
  | { readonly kind: "new"; readonly events: readonly DecidedEvent[] };

/** 지연 head — 신호 수용 이벤트의 ID·시각이 정해진 뒤 나머지 구간을 만든다. */
export interface DeferredWorkflowMain {
  readonly head: { readonly workId: WorkId; readonly event: DecidedEvent };
  readonly then: (head: CausingEventRef) => readonly WorkflowPiece[];
}

interface Staged {
  readonly id: EventId;
  readonly workId: WorkId;
  readonly decided: DecidedEvent;
  readonly causationId?: string;
}

const DEFINITION_TRANSITION_SET: ReadonlySet<string> = new Set(DEFINITION_TRANSITION_EVENT_TYPES);

/** envelope 의 Work 정체 — 프로젝트·상관 ID. */
interface WorkIdentity {
  readonly projectId: string;
  readonly correlationId: string;
}

function newPieceIdentity(events: readonly DecidedEvent[]): {
  readonly workId: WorkId;
  readonly identity: WorkIdentity;
} {
  const first = events[0];
  if (first === undefined || first.type !== "work_created") {
    throw new DomainInvariantError("새 Work 구간은 work_created 로 시작해야 한다");
  }
  return {
    workId: first.payload.workId,
    identity: { projectId: first.payload.projectId, correlationId: first.payload.correlationId },
  };
}

function buildEnvelope(
  identity: WorkIdentity,
  commitId: CommitId,
  index: number,
  count: number,
  meta: CommitMeta,
  staged: Staged,
): DomainEvent {
  const decided = staged.decided;
  return {
    schemaVersion: WORKFLOW_EVENT_SCHEMA_VERSION,
    id: staged.id,
    type: decided.type,
    occurredAt: meta.now,
    projectId: identity.projectId,
    workId: staged.workId,
    ...(decided.taskId !== undefined ? { taskId: decided.taskId } : {}),
    correlationId: identity.correlationId,
    ...(staged.causationId !== undefined ? { causationId: staged.causationId } : {}),
    ...(meta.actor !== undefined ? { actor: meta.actor } : {}),
    actorSource: meta.actorSource,
    commit: { id: commitId, index, count },
    payload: decided.payload,
  } as unknown as DomainEvent;
}

function isDeferred(
  main: readonly WorkflowPiece[] | DeferredWorkflowMain,
): main is DeferredWorkflowMain {
  return !Array.isArray(main);
}

/**
 * 다중 Work 커밋 조립. 배열 입력은 판정 단계 ID 를 이미 소비한 구간들이고, 지연 head 는 커밋 ID → head
 * 이벤트 ID 뒤에 나머지 구간을 만든다. 이벤트 ID 는 스테이징 순이다.
 */
export function assembleWorkflowCommit(
  deps: DomainDeps,
  state: WorkflowState,
  main: readonly WorkflowPiece[] | DeferredWorkflowMain,
  meta: CommitMeta,
): { readonly commit: DomainCommit; readonly state: WorkflowState } {
  const commitId = nextEntityId(deps.ids, "commit");
  const staged: Staged[] = [];
  const scratch = new Map<string, WorkAggregate | undefined>();
  const touchedOrder: WorkId[] = [];
  const lastStateChanging = new Map<string, string>();
  const identities = new Map<string, WorkIdentity>();

  function scratchOf(workId: WorkId): WorkAggregate | undefined {
    return scratch.has(workId) ? scratch.get(workId) : state.works[workId];
  }

  function identityOf(workId: WorkId): WorkIdentity {
    const known = identities.get(workId);
    if (known !== undefined) return known;
    const work = state.works[workId]?.work;
    if (work === undefined) {
      throw new DomainInvariantError(`다중 Work 커밋: Work ${workId} 의 레코드가 없다`);
    }
    const identity = { projectId: work.projectId, correlationId: work.correlationId };
    identities.set(workId, identity);
    return identity;
  }

  function applyBatch(
    workId: WorkId,
    batch: readonly { readonly decided: DecidedEvent; readonly causationId?: string }[],
  ): void {
    if (batch.length === 0) return;
    if (!touchedOrder.includes(workId)) touchedOrder.push(workId);
    const startIndex = staged.length;
    const newStaged: Staged[] = batch.map((b) => ({
      id: nextEntityId(deps.ids, "event"),
      workId,
      decided: b.decided,
      ...(b.causationId !== undefined ? { causationId: b.causationId } : {}),
    }));
    staged.push(...newStaged);
    const current = scratchOf(workId);
    const identity = identityOf(workId);
    const envs = newStaged.map((s, i) =>
      buildEnvelope(identity, commitId, startIndex + i + 1, 0, meta, s),
    );
    scratch.set(workId, evolveCommit(current, envs));
    for (const s of newStaged) {
      if (
        s.decided.taskId !== undefined ||
        s.decided.type === "work_plan_committed" ||
        DEFINITION_TRANSITION_SET.has(s.decided.type)
      ) {
        lastStateChanging.set(workId, s.id);
      }
    }
  }

  function withCausation(
    decided: readonly DecidedEvent[],
    causationId: string | undefined,
  ): readonly { readonly decided: DecidedEvent; readonly causationId?: string }[] {
    return decided.map((d) => ({
      decided: d,
      ...(causationId !== undefined ? { causationId } : {}),
    }));
  }

  /** Work 하나의 커밋 연쇄 — 기존 단일 Work 커밋과 같은 단계 순서. */
  function runCascade(workId: WorkId): void {
    const before = state.works[workId];
    const ownStaged = (): Staged[] => staged.filter((s) => s.workId === workId);

    const committedStaged = ownStaged().find((s) => s.decided.type === "work_plan_committed");
    const afterCommit = scratchOf(workId);
    if (committedStaged !== undefined && afterCommit !== undefined) {
      const committed = committedStaged.decided as Extract<
        DecidedEvent,
        { readonly type: "work_plan_committed" }
      >;
      if (committed.payload.dropped.length > 0) {
        const cancellations = decideReplanDroppedCancellations(
          afterCommit,
          committedStaged.id,
          committed.payload.dropped,
          meta.actorSource,
        );
        applyBatch(
          workId,
          cancellations.map((c) => ({
            decided: c.event,
            ...(c.causationEventId !== undefined ? { causationId: c.causationEventId } : {}),
          })),
        );
      }
    }

    const canceledStaged = ownStaged().find((s) => s.decided.type === "work_canceled");
    const afterCancel = scratchOf(workId);
    if (canceledStaged !== undefined && afterCancel !== undefined) {
      const cascadeEvents = decideWorkCancellationCascade(
        afterCancel,
        canceledStaged.id,
        meta.actorSource,
      );
      applyBatch(
        workId,
        cascadeEvents.map((c) => ({
          decided: c.event,
          ...(c.causationEventId !== undefined ? { causationId: c.causationEventId } : {}),
        })),
      );
      // 관리 Work 취소는 살아 있는 정의를 같은 커밋에서 멈춘다(단일 Work 커밋 경로와 같은 규칙).
      const definition = scratchOf(workId)?.definition;
      if (definition !== undefined && definition.state !== "STOPPED") {
        const canceled = canceledStaged.decided as Extract<
          DecidedEvent,
          { readonly type: "work_canceled" }
        >;
        const stopEvents = decideStop(
          deps,
          definition,
          workCascadeStopOrigin(canceled.payload.origin, meta.actorSource),
          meta.now,
        );
        applyBatch(workId, withCausation(stopEvents, canceledStaged.id));
      }
    }

    for (;;) {
      const current = scratchOf(workId);
      if (current === undefined) break;
      const round = decideDependencyCascadeRound(deps.registries, current);
      if (round.length === 0) break;
      applyBatch(
        workId,
        round.map((c) => ({
          decided: c.event,
          ...(c.causationEventId !== undefined ? { causationId: c.causationEventId } : {}),
        })),
      );
    }

    const forRevalidation = scratchOf(workId);
    if (forRevalidation !== undefined) {
      const withdrawal = decidePendingProposalRevalidation(
        deps,
        before,
        forRevalidation,
        lastStateChanging.get(workId),
      );
      if (withdrawal !== undefined) {
        applyBatch(workId, [
          {
            decided: withdrawal.event,
            ...(withdrawal.causationEventId !== undefined
              ? { causationId: withdrawal.causationEventId }
              : {}),
          },
        ]);
      }
    }

    const forDerivation = scratchOf(workId);
    if (forDerivation !== undefined) {
      const derived = decideDerivedWorkStateEvent(forDerivation, lastStateChanging.get(workId));
      if (derived !== undefined) {
        applyBatch(workId, [
          {
            decided: derived.event,
            ...(derived.causationEventId !== undefined
              ? { causationId: derived.causationEventId }
              : {}),
          },
        ]);
      }
    }
  }

  function stagePieces(pieces: readonly WorkflowPiece[], causationId: string | undefined): void {
    for (const piece of pieces) {
      if (piece.kind === "existing") {
        if (state.works[piece.workId] === undefined && !scratch.has(piece.workId)) {
          throw new DomainInvariantError(`다중 Work 커밋: 상태에 없는 Work ${piece.workId}`);
        }
        applyBatch(piece.workId, withCausation(piece.events, causationId));
      } else {
        const { workId, identity } = newPieceIdentity(piece.events);
        if (state.works[workId] !== undefined || scratch.has(workId)) {
          throw new DomainInvariantError(`다중 Work 커밋: 이미 있는 Work 를 새로 만든다 ${workId}`);
        }
        identities.set(workId, identity);
        applyBatch(workId, withCausation(piece.events, causationId));
        runCascade(workId);
      }
    }
  }

  if (isDeferred(main)) {
    applyBatch(main.head.workId, [
      {
        decided: main.head.event,
        ...(meta.causationId !== undefined ? { causationId: meta.causationId } : {}),
      },
    ]);
    const head = staged[0] as Staged;
    stagePieces(main.then({ id: head.id, occurredAt: meta.now }), head.id);
  } else {
    stagePieces(main, meta.causationId);
  }

  const newWorkIds = new Set<string>(
    staged.filter((s) => s.decided.type === "work_created").map((s) => s.workId),
  );
  for (const workId of [...touchedOrder]) {
    if (!newWorkIds.has(workId)) runCascade(workId);
  }

  // 최종 envelope(커밋 전체 index·count) + Work 별 단일 evolve
  const total = staged.length;
  const finalEvents = staged.map((s, i) =>
    buildEnvelope(identityOf(s.workId), commitId, i + 1, total, meta, s),
  );
  let works: Record<string, WorkAggregate> = { ...state.works };
  for (const workId of touchedOrder) {
    const ofWork = finalEvents.filter((e) => e.workId === workId);
    works = { ...works, [workId]: evolveCommit(state.works[workId], ofWork) };
  }
  return { commit: { id: commitId, events: finalEvents }, state: { works } };
}

const CATALOG_BY_NAME = new Map<string, (typeof EVENT_CATALOG)[number]>(
  EVENT_CATALOG.map((row) => [row.name, row]),
);

/**
 * 이벤트 전체 로그를 접는다. 이벤트마다 카탈로그 이름·도메인 생산 표기·스키마 버전 1·`workId` 를 검사하고,
 * 커밋 그룹(index 1..count 연속·count 일치)을 확인한 뒤 커밋마다 `workId` 로 나눠 Work 별로 적용한다.
 * 처음 보는 Work 의 구간은 `work_created` 로 시작해야 한다.
 */
export function foldWorkflowEvents(
  events: readonly WorkflowEventEnvelope[],
): Result<WorkflowState, FoldError> {
  for (const event of events) {
    const catalogRow = CATALOG_BY_NAME.get(event.type);
    if (catalogRow === undefined) {
      return err({ kind: "unknown_event_type", eventId: event.id, type: event.type });
    }
    if (!DOMAIN_EVENT_PRODUCERS.includes(catalogRow.producedBy)) {
      return err({
        kind: "unsupported_event_type",
        eventId: event.id,
        type: event.type,
        producedBy: catalogRow.producedBy,
      });
    }
    if (event.schemaVersion !== 1) {
      return err({
        kind: "unsupported_schema_version",
        eventId: event.id,
        schemaVersion: event.schemaVersion,
      });
    }
    if (event.workId === undefined) {
      return err({ kind: "inconsistent_stream", eventId: event.id, reason: "missing_work_id" });
    }
  }

  const groups: WorkflowEventEnvelope[][] = [];
  let i = 0;
  while (i < events.length) {
    const commitId = (events[i] as WorkflowEventEnvelope).commit.id;
    const count = (events[i] as WorkflowEventEnvelope).commit.count;
    const group: WorkflowEventEnvelope[] = [];
    let expectedIndex = 1;
    while (i < events.length && (events[i] as WorkflowEventEnvelope).commit.id === commitId) {
      const event = events[i] as WorkflowEventEnvelope;
      if (event.commit.count !== count) {
        return err({ kind: "malformed_commit", commitId, reason: "inconsistent_count" });
      }
      if (event.commit.index !== expectedIndex) {
        return err({ kind: "malformed_commit", commitId, reason: "non_consecutive_index" });
      }
      group.push(event);
      expectedIndex += 1;
      i += 1;
    }
    if (group.length !== count) {
      return err({ kind: "malformed_commit", commitId, reason: "count_mismatch" });
    }
    groups.push(group);
  }

  let works: Record<string, WorkAggregate> = {};
  for (const group of groups) {
    const order: string[] = [];
    const byWork = new Map<string, WorkflowEventEnvelope[]>();
    for (const event of group) {
      const workId = event.workId as string;
      const list = byWork.get(workId);
      if (list === undefined) {
        order.push(workId);
        byWork.set(workId, [event]);
      } else {
        list.push(event);
      }
    }
    for (const workId of order) {
      const ofWork = byWork.get(workId) as WorkflowEventEnvelope[];
      const current = works[workId];
      const first = ofWork[0] as WorkflowEventEnvelope;
      if (current === undefined && first.type !== "work_created") {
        return err({
          kind: "inconsistent_stream",
          eventId: first.id,
          reason: "first_event_not_work_created",
        });
      }
      const duplicate = ofWork.find(
        (e, index) => e.type === "work_created" && (current !== undefined || index > 0),
      );
      if (duplicate !== undefined) {
        return err({
          kind: "inconsistent_stream",
          eventId: duplicate.id,
          reason: "duplicate_work_created",
        });
      }
      works = {
        ...works,
        [workId]: evolveCommit(current, ofWork as unknown as readonly DomainEvent[]),
      };
    }
  }
  return ok({ works });
}
