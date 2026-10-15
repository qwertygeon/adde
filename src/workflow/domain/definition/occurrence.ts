/**
 * 정의 회차 결정 — 도래한 대기 행의 해소, 보류 회차 해제, 외부 신호 회차. 회차는 정의가 `ACTIVE` 이고
 * 열린 회차가 상한 미만이며 보류 회차가 없고 템플릿이 유효할 때만 materialize 되고, 아니면 보류된다(보류
 * 사유는 처음 실패한 조건). 한 커밋의 여러 후보는 앞 후보가 만든 materialize·보류를 반영한 상태로 판정한다.
 *
 * 일정 회차는 보류되는 순간 지연 발화 정책이 적용된다 — `skip` 은 보류 대신 건너뜀, `fire_once_now` 는
 * 이미 보류된 일정 회차를 대체, `catch_up_bounded(k)` 는 k 를 넘는 가장 오래된 보류 일정 회차를 건너뜀.
 * 신호 회차는 보류되어도 건너뛰지 않는다. 그래서 보류와 빈 자리가 함께 있으면 도래 처리를 거절해 해제가
 * 먼저 오게 한다. 건너뜀은 해소 하나에 이벤트 하나이고, 해소의 첫 회차 이벤트가 다음 대기 행을 싣는다.
 */
import { DomainInvariantError } from "../result.js";
import type { OccurrenceId, WorkDefinitionId, WorkId } from "../ids.js";
import { nextEntityId } from "../ids.js";
import type { UtcInstant } from "../values.js";
import { instantMs } from "../values.js";
import type { MisfirePolicy } from "../trigger.js";
import type { OccurrenceInput } from "../aggregate.js";
import type { DecidedEvent } from "../events.js";
import { mkEvent } from "../events.js";
import type { CommandRejection, DomainDeps } from "../engine.js";
import type { CausingEventRef } from "../derivation/occurrence-id.js";
import { deriveOccurrenceId } from "../derivation/occurrence-id.js";
import type { PlanValidationIssue } from "../plan-graph.js";
import type { PlanProposal } from "../plan/proposal.js";
import { buildPlanCommitEvents } from "../plan/proposal.js";
import { utcToLocal } from "../timezone-recompute.js";
import type { DefinitionStateName } from "../contract/definition-transitions.js";
import type {
  DefinitionRecord,
  HeldOccurrence,
  HoldCause,
  ScheduleRow,
  SkipReason,
} from "./model.js";
import { isSignalActivation, scheduleActivationView, signalActivationView } from "./model.js";
import { buildTemplateProposal } from "./draft.js";
import type { SkipItem } from "./resolution.js";
import { seriesExhaustedOrigin, skipEvent, skipItemOfHeld, skipItemOfRow } from "./resolution.js";
import { decideStop } from "./resolution.js";
import { dueSet, retiredIdsOf } from "./schedule.js";
import type { StewardWork, WorkflowPiece, WorkflowState } from "./commit.js";
import { findSteward, openOccurrenceCount } from "./commit.js";

export type OccurrenceDecision =
  | { readonly kind: "rejected"; readonly rejection: CommandRejection }
  | {
      readonly kind: "pieces";
      readonly stewardId: WorkId;
      readonly pieces: readonly WorkflowPiece[];
    };

/**
 * materialize 를 막는 첫 조건 — 정의 비활성 → 오래된 보류 → 열린 회차 상한. 셋이 모두 통과하면
 * undefined 이고, 그때만 템플릿을 검증한다.
 */
export function materializationBlocker(view: {
  readonly definitionState: DefinitionStateName;
  readonly heldCount: number;
  readonly openCount: number;
  readonly maxOpenOccurrences: number;
}): HoldCause | undefined {
  if (view.definitionState !== "ACTIVE") return "definition_paused";
  if (view.heldCount > 0) return "older_held";
  if (view.openCount >= view.maxOpenOccurrences) return "open_bound";
  return undefined;
}

function rejectCondition(detail: string): CommandRejection {
  return { reason: "condition_not_met", detail };
}

/** 해소 하나를 이루는 회차 동작 — 이벤트 조립은 건너뜀 이벤트를 먼저 둔 뒤 순서대로 한다. */
type OccurrenceAction =
  | {
      readonly kind: "materialize";
      readonly occurrence: HeldOccurrence;
      readonly released: boolean;
      readonly workId: WorkId;
      readonly workEvents: readonly DecidedEvent[];
    }
  | { readonly kind: "hold"; readonly occurrence: HeldOccurrence; readonly cause: HoldCause };

/** 한 커밋 안의 회차 판정 상태 — 앞 후보의 결과를 다음 후보 판정에 반영한다. */
interface RunState {
  readonly deps: DomainDeps;
  /** 관리 Work 구간의 Work — 판정이 상태에서 찾은 관리 Work 의 work.id(정의의 sourceWorkId 가 아니다). */
  readonly stewardId: WorkId;
  readonly definition: DefinitionRecord;
  definitionState: DefinitionStateName;
  openCount: number;
  materializedCount: number;
  /** 보류 큐(원래 순서) — 이 커밋의 보류·건너뜀 반영. */
  held: HeldOccurrence[];
  readonly actions: OccurrenceAction[];
  readonly skipItems: SkipItem[];
  /** 취소 ID 라 발급하지 않은 일정 회차 — 정책 건너뜀과 원인이 달라 별도 건너뜀(`definition_revised`)으로 낸다. */
  readonly lostItems: SkipItem[];
  /** 템플릿 무효 일시정지의 이슈 — 처음 한 번. */
  templateIssues?: readonly PlanValidationIssue[];
}

function startRun(deps: DomainDeps, state: WorkflowState, steward: StewardWork): RunState {
  const definition = steward.definition;
  return {
    deps,
    stewardId: steward.work.id,
    definition,
    definitionState: definition.state,
    openCount: openOccurrenceCount(state, definition),
    materializedCount: definition.materialized.length,
    held: [...definition.held],
    actions: [],
    skipItems: [],
    lostItems: [],
  };
}

function fullInput(definition: DefinitionRecord, occurrence: HeldOccurrence): OccurrenceInput {
  return { ...occurrence.input, definitionRevision: definition.revision };
}

/** 회차 Work 의 이벤트 묶음 — `work_created` → `work_planning_started` → 템플릿 첫 계획. ID: work → planProposal → task. */
function occurrenceWorkEvents(
  deps: DomainDeps,
  definition: DefinitionRecord,
  occurrence: HeldOccurrence,
  input: OccurrenceInput,
  template: { readonly content: PlanProposal["tasks"]; readonly digest: PlanProposal["digest"] },
): { readonly workId: WorkId; readonly events: readonly DecidedEvent[] } {
  const workId = nextEntityId(deps.ids, "work");
  const proposal: PlanProposal = Object.freeze({
    id: nextEntityId(deps.ids, "planProposal"),
    workId,
    basePlanRevision: 0,
    source: "definition_template",
    tasks: template.content,
    retain: [],
    digest: template.digest,
  });
  const planEvents = buildPlanCommitEvents(
    deps,
    proposal,
    { retained: [], superseded: [], dropped: [] },
    { templateSource: true },
  );
  return {
    workId,
    events: [
      mkEvent(
        "work_created",
        {
          workId,
          projectId: definition.projectId,
          title: definition.title,
          objective: definition.title,
          source: {
            kind: "definition_occurrence",
            definitionId: definition.id,
            definitionRevision: definition.revision,
            occurrenceId: occurrence.occurrenceId,
            input,
          },
          completionPolicyVersion: 1,
          correlationId: definition.correlationId,
        },
        { workId },
      ),
      mkEvent("work_planning_started", {}, { workId }),
      ...planEvents,
    ],
  };
}

function isScheduleOccurrence(occurrence: HeldOccurrence): boolean {
  return occurrence.recurrenceIndex !== undefined;
}

/** `skip` 과 `maxCatchUp < 1` 인 `catch_up_bounded` — 놓친 회차를 하나도 따라잡지 않는 정책. */
function isSkipLike(misfire: MisfirePolicy): boolean {
  return misfire.kind === "skip" || (misfire.kind === "catch_up_bounded" && misfire.maxCatchUp < 1);
}

function catchUpLimitOf(misfire: MisfirePolicy): number {
  if (misfire.kind !== "catch_up_bounded") {
    throw new DomainInvariantError(`따라잡기 상한은 catch_up_bounded 에만 있다 — ${misfire.kind}`);
  }
  return misfire.maxCatchUp;
}

/** 보류 시점의 지연 발화 정책 — 일정 회차만. 건너뛴 회차는 건너뜀 항목으로, 보류한 회차는 큐 끝으로. */
function holdWithPolicy(
  run: RunState,
  occurrence: HeldOccurrence,
  cause: HoldCause,
  misfire: MisfirePolicy | undefined,
): void {
  if (!isScheduleOccurrence(occurrence) || misfire === undefined) {
    run.held.push(occurrence);
    run.actions.push({ kind: "hold", occurrence, cause });
    return;
  }
  if (isSkipLike(misfire)) {
    run.skipItems.push(skipItemOfHeldless(occurrence));
    return;
  }
  if (misfire.kind === "fire_once_now") {
    const superseded = run.held.filter(isScheduleOccurrence);
    run.held = run.held.filter((h) => !isScheduleOccurrence(h));
    for (const prior of superseded) run.skipItems.push(skipItemOfHeld(prior));
    run.held.push(occurrence);
    run.actions.push({ kind: "hold", occurrence, cause });
    return;
  }
  run.held.push(occurrence);
  run.actions.push({ kind: "hold", occurrence, cause });
  const limit = catchUpLimitOf(misfire);
  for (;;) {
    const scheduleHeld = run.held.filter(isScheduleOccurrence);
    if (scheduleHeld.length <= limit) break;
    const oldest = scheduleHeld[0] as HeldOccurrence;
    run.held = run.held.filter((h) => h.occurrenceId !== oldest.occurrenceId);
    const ownHold = run.actions.findIndex(
      (a) => a.kind === "hold" && a.occurrence.occurrenceId === oldest.occurrenceId,
    );
    if (ownHold !== -1) {
      throw new DomainInvariantError(
        "catch_up_bounded: 같은 해소에서 보류한 회차를 건너뛰게 됐다 — 후보 수가 상한을 넘었다",
      );
    }
    run.skipItems.push(skipItemOfHeld(oldest));
  }
}

/** 큐에 들어간 적 없는 회차의 건너뜀 항목(보류 ID 없음). */
function skipItemOfHeldless(occurrence: HeldOccurrence): SkipItem {
  return {
    instant: occurrence.originalInstant,
    ...(occurrence.recurrenceIndex !== undefined
      ? { recurrenceIndex: occurrence.recurrenceIndex }
      : {}),
  };
}

/** 후보 하나 — materialize 가능하면 materialize, 아니면 보류(지연 발화 정책 적용). */
function resolveCandidate(
  run: RunState,
  occurrence: HeldOccurrence,
  misfire: MisfirePolicy | undefined,
  released: boolean,
): void {
  const blocker =
    run.templateIssues !== undefined
      ? "template_invalid"
      : materializationBlocker({
          definitionState: run.definitionState,
          heldCount: released ? 0 : run.held.length,
          openCount: run.openCount,
          maxOpenOccurrences: run.definition.maxOpenOccurrences,
        });
  if (blocker !== undefined) {
    holdWithPolicy(run, occurrence, blocker, misfire);
    return;
  }
  const input = fullInput(run.definition, occurrence);
  const template = buildTemplateProposal(run.deps, run.definition, {
    occurrenceId: occurrence.occurrenceId,
    input,
  });
  if (!template.valid) {
    run.templateIssues = template.issues;
    run.definitionState = "PAUSED";
    holdWithPolicy(run, occurrence, "template_invalid", misfire);
    return;
  }
  const work = occurrenceWorkEvents(run.deps, run.definition, occurrence, input, {
    content: template.content.tasks,
    digest: template.digest,
  });
  if (released) run.held = run.held.filter((h) => h.occurrenceId !== occurrence.occurrenceId);
  run.openCount += 1;
  run.materializedCount += 1;
  run.actions.push({
    kind: "materialize",
    occurrence,
    released,
    workId: work.workId,
    workEvents: work.events,
  });
}

/** 판정 결과를 구간으로 — 건너뜀 → 후보별 materialize 묶음 또는 보류 → 일시정지 → 계열 종료 중지. */
function assemblePieces(
  run: RunState,
  head: readonly DecidedEvent[],
  skipReason: SkipReason,
  nextSchedule: ScheduleRow | null | undefined,
  seriesEnd: boolean,
  now: UtcInstant,
): readonly WorkflowPiece[] {
  const definition = run.definition;
  const stewardId = run.stewardId;
  const pieces: WorkflowPiece[] = [];
  let stewardEvents: DecidedEvent[] = [...head];
  let pendingNext: { readonly value: ScheduleRow | null } | undefined =
    nextSchedule === undefined ? undefined : { value: nextSchedule };
  function takeNext(): { readonly nextSchedule?: ScheduleRow | null } {
    if (pendingNext === undefined) return {};
    const value = pendingNext.value;
    pendingNext = undefined;
    return { nextSchedule: value };
  }
  function flushSteward(): void {
    if (stewardEvents.length > 0) {
      pieces.push({ kind: "existing", workId: stewardId, events: stewardEvents });
      stewardEvents = [];
    }
  }

  if (run.skipItems.length > 0) {
    const skipped = skipEvent(
      definition,
      run.skipItems,
      skipReason,
      pendingNext === undefined ? undefined : takeNext().nextSchedule,
    );
    if (skipped !== undefined) stewardEvents.push(skipped);
  }
  for (const action of run.actions) {
    const occurrence = action.occurrence;
    if (action.kind === "hold") {
      stewardEvents.push(
        mkEvent(
          "work_definition_occurrence_held",
          {
            definitionId: definition.id,
            occurrenceId: occurrence.occurrenceId,
            cause: action.cause,
            occurrence,
            ...takeNext(),
          },
          { workId: stewardId },
        ),
      );
      continue;
    }
    stewardEvents.push(
      mkEvent(
        "trigger_fired",
        {
          definitionId: definition.id,
          triggerId: occurrence.triggerId,
          occurrenceId: occurrence.occurrenceId,
          workId: action.workId,
          definitionRevision: definition.revision,
          originalInstant: occurrence.originalInstant,
          ...(occurrence.recurrenceIndex !== undefined
            ? { recurrenceIndex: occurrence.recurrenceIndex }
            : {}),
          released: action.released,
          ...takeNext(),
        },
        { workId: stewardId },
      ),
    );
    flushSteward();
    pieces.push({ kind: "new", events: action.workEvents });
  }
  const lost = skipEvent(definition, run.lostItems, "definition_revised");
  if (lost !== undefined) stewardEvents.push(lost);
  if (run.templateIssues !== undefined) {
    stewardEvents.push(
      mkEvent(
        "work_definition_paused",
        {
          definitionId: definition.id,
          pauseOrigin: { kind: "template_invalid", actorSource: "adde_self" },
          templateIssues: run.templateIssues,
        },
        { workId: stewardId },
      ),
    );
  }
  if (seriesEnd) {
    const remaining: DefinitionRecord = {
      ...definition,
      held: run.held,
    };
    const withoutPending: DefinitionRecord = { ...remaining };
    delete (withoutPending as { pendingSchedule?: unknown }).pendingSchedule;
    for (const event of decideStop(run.deps, withoutPending, seriesExhaustedOrigin(), now)) {
      stewardEvents.push(event);
    }
  }
  flushSteward();
  return pieces;
}

function stewardOf(
  state: WorkflowState,
  definitionId: WorkDefinitionId,
):
  | { readonly ok: true; readonly steward: StewardWork; readonly definition: DefinitionRecord }
  | { readonly ok: false; readonly rejection: CommandRejection } {
  const steward = findSteward(state, definitionId);
  if (steward === undefined) {
    return { ok: false, rejection: { reason: "unknown_subject" } };
  }
  const definition = steward.definition;
  if (definition.state === "STOPPED") {
    return { ok: false, rejection: { reason: "terminal_subject" } };
  }
  return { ok: true, steward, definition };
}

function isMaterialized(definition: DefinitionRecord, occurrenceId: OccurrenceId): boolean {
  return definition.materialized.some((m) => m.occurrenceId === occurrenceId);
}

function scheduleHeldOf(row: ScheduleRow, definition: DefinitionRecord): HeldOccurrence {
  const view = scheduleActivationView(definition.activation);
  if (view === undefined) {
    throw new DomainInvariantError("대기 행이 있는 정의의 활성화가 일정 활성화 형태가 아니다");
  }
  const local = utcToLocal(row.scheduledForUtc, view.timezone);
  if (!local.ok) {
    throw new DomainInvariantError(
      `회차 현지 날짜 재계산 실패(${local.error.kind}) — 활성화 타임존 ${view.timezone}`,
    );
  }
  return {
    occurrenceId: row.occurrenceId,
    triggerId: row.triggerId,
    originalInstant: row.scheduledForUtc,
    recurrenceIndex: row.recurrenceIndex,
    input: {
      occurrenceId: row.occurrenceId,
      definitionId: definition.id,
      scheduledForUtc: row.scheduledForUtc,
      localDate: local.value.localDate,
      timezone: view.timezone,
    },
  };
}

/** 신호 상한 도달 — 정의 일생 누적 materialize 수가 `maxOccurrences` 에 닿았다. */
function signalSeriesEnded(deps: DomainDeps, run: RunState): boolean {
  const max = run.definition.maxOccurrences;
  return (
    max !== undefined &&
    isSignalActivation(deps.registries, run.definition.activation) &&
    run.materializedCount >= max
  );
}

/**
 * 도래한 대기 행의 해소. 대상 검사(관리 Work·종결·일시정지·이미 materialize·대기 행 유무·ID·도래·해제
 * 대기)를 통과하면 만기 집합을 회차별 지연 판정·정책 해소로 후보와 건너뜀으로 나누고 후보마다 materialize
 * 하거나 보류한다. 일정 계열이 끝나고 보류 일정 회차가 없으면 같은 커밋에서 중지한다.
 */
export function resolveDueSchedule(
  deps: DomainDeps,
  state: WorkflowState,
  command: {
    readonly definitionId: WorkDefinitionId;
    readonly occurrenceId: OccurrenceId;
    readonly late?: boolean;
    readonly now: UtcInstant;
  },
): OccurrenceDecision {
  const target = stewardOf(state, command.definitionId);
  if (!target.ok) return { kind: "rejected", rejection: target.rejection };
  const definition = target.definition;
  if (definition.state === "PAUSED") {
    return { kind: "rejected", rejection: rejectCondition("definition_paused") };
  }
  if (isMaterialized(definition, command.occurrenceId)) {
    return { kind: "rejected", rejection: rejectCondition("occurrence_already_materialized") };
  }
  const pending = definition.pendingSchedule;
  if (pending === undefined) {
    return { kind: "rejected", rejection: rejectCondition("no_pending_schedule") };
  }
  if (pending.occurrenceId !== command.occurrenceId) {
    return { kind: "rejected", rejection: rejectCondition("occurrence_not_pending") };
  }
  if (instantMs(command.now) < instantMs(pending.scheduledForUtc)) {
    return { kind: "rejected", rejection: rejectCondition("occurrence_not_due") };
  }
  const openCount = openOccurrenceCount(state, definition);
  if (definition.held.length > 0 && openCount < definition.maxOpenOccurrences) {
    return { kind: "rejected", rejection: rejectCondition("held_release_pending") };
  }

  // 대기 행이 취소 ID 면 발급할 회차가 없어 다음 대기 행을 싣는 이벤트도 없다 — 정의가 멈추므로 거부한다.
  // 도메인이 만든 커밋으로는 생기지 않고 임의 이벤트 열을 접거나 레코드를 고치면 생긴다.
  const retired = retiredIdsOf(definition);
  if (retired.has(pending.occurrenceId)) {
    throw new DomainInvariantError(
      `정의 ${definition.id} 의 대기 행 ${pending.occurrenceId} 가 취소된 occurrence ID 다`,
    );
  }

  const view = scheduleActivationView(definition.activation);
  if (view === undefined) {
    throw new DomainInvariantError("대기 행이 있는 정의의 활성화가 일정 활성화 형태가 아니다");
  }
  const misfire = view.misfire;
  const due = dueSet(deps, definition.id, definition.activation, pending, command.now, retired);
  const rows = due.due;
  // 지연 여부는 시각의 문제라 취소 ID 회차를 포함한 위치로 판정하고, 후보·건너뜀은 발급할 수 있는 회차
  // (M′)에서만 고른다 — 만기 집합의 마지막이 취소 ID 면 그것을 고르는 순간 재발급이 된다.
  const lastRow = rows[rows.length - 1] as ScheduleRow;
  const lastMissed = pending.overdue || command.late === true;
  const issuable = rows.filter((row) => !retired.has(row.occurrenceId));
  const lastIssuable = issuable[issuable.length - 1] as ScheduleRow;
  const onTime = !lastMissed && !retired.has(lastRow.occurrenceId) ? lastRow : undefined;
  const missed = issuable.filter((row) => row !== onTime);

  const run = startRun(deps, state, target.steward);
  for (const row of rows) {
    if (retired.has(row.occurrenceId)) run.lostItems.push(skipItemOfRow(row));
  }
  for (const row of due.lostAhead) run.lostItems.push(skipItemOfRow(row));
  const skipLike = isSkipLike(misfire);
  const skipReason: SkipReason = skipLike ? "misfire_skip" : "superseded_by_later";
  let candidates: readonly ScheduleRow[];
  if (missed.length === 0) {
    candidates = onTime === undefined ? [] : [onTime];
  } else if (skipLike) {
    for (const row of missed) run.skipItems.push(skipItemOfRow(row));
    candidates = onTime === undefined ? [] : [onTime];
  } else if (misfire.kind === "fire_once_now") {
    for (const row of issuable.slice(0, -1)) run.skipItems.push(skipItemOfRow(row));
    candidates = [lastIssuable];
  } else {
    const keep = Math.min(catchUpLimitOf(misfire), issuable.length);
    for (const row of issuable.slice(0, issuable.length - keep)) {
      run.skipItems.push(skipItemOfRow(row));
    }
    candidates = issuable.slice(issuable.length - keep);
  }
  for (const row of candidates) {
    resolveCandidate(run, scheduleHeldOf(row, definition), misfire, false);
  }
  const seriesEnd = due.next === undefined && !run.held.some(isScheduleOccurrence);
  return {
    kind: "pieces",
    stewardId: target.steward.work.id,
    pieces: assemblePieces(run, [], skipReason, due.next ?? null, seriesEnd, command.now),
  };
}

/**
 * 가장 오래된 보류 회차의 해제(빈 자리 하나). 템플릿이 무효면 일시정지만 커밋하고 보류는 그대로다. 일정
 * 계열 끝의 마지막 보류 해제, 신호 상한 도달이면 같은 커밋에서 중지한다.
 */
export function releaseHeldOccurrence(
  deps: DomainDeps,
  state: WorkflowState,
  command: {
    readonly definitionId: WorkDefinitionId;
    readonly occurrenceId: OccurrenceId;
    readonly now: UtcInstant;
  },
): OccurrenceDecision {
  const target = stewardOf(state, command.definitionId);
  if (!target.ok) return { kind: "rejected", rejection: target.rejection };
  const definition = target.definition;
  if (definition.state !== "ACTIVE") {
    return { kind: "rejected", rejection: rejectCondition("definition_not_active") };
  }
  if (isMaterialized(definition, command.occurrenceId)) {
    return { kind: "rejected", rejection: rejectCondition("occurrence_already_materialized") };
  }
  const oldest = definition.held[0];
  if (oldest === undefined) {
    return { kind: "rejected", rejection: rejectCondition("no_held_occurrence") };
  }
  if (oldest.occurrenceId !== command.occurrenceId) {
    return { kind: "rejected", rejection: rejectCondition("occurrence_not_oldest_held") };
  }
  if (openOccurrenceCount(state, definition) >= definition.maxOpenOccurrences) {
    return { kind: "rejected", rejection: rejectCondition("no_free_slot") };
  }

  const run = startRun(deps, state, target.steward);
  const input = fullInput(definition, oldest);
  const template = buildTemplateProposal(deps, definition, {
    occurrenceId: oldest.occurrenceId,
    input,
  });
  if (!template.valid) {
    run.templateIssues = template.issues;
    return {
      kind: "pieces",
      stewardId: target.steward.work.id,
      pieces: assemblePieces(run, [], "misfire_skip", undefined, false, command.now),
    };
  }
  resolveCandidate(run, oldest, undefined, true);
  const scheduleEnded =
    !isSignalActivation(deps.registries, definition.activation) &&
    definition.pendingSchedule === undefined &&
    !run.held.some(isScheduleOccurrence);
  const seriesEnd = scheduleEnded || signalSeriesEnded(deps, run);
  return {
    kind: "pieces",
    stewardId: target.steward.work.id,
    pieces: assemblePieces(run, [], "misfire_skip", undefined, seriesEnd, command.now),
  };
}

/**
 * 외부 신호가 수용된 뒤의 정의 회차 — 수용 이벤트에서 occurrence 를 파생해 materialize 하거나 보류한다
 * (일시정지 중이면 `definition_paused` 보류). 신호 상한에 닿으면 같은 커밋에서 중지한다. `head` 는 이
 * 커밋의 `signal_accepted`.
 */
export function decideSignalOccurrence(
  deps: DomainDeps,
  state: WorkflowState,
  steward: StewardWork,
  signal: {
    readonly sourceId: string;
    readonly signalName: string;
    readonly sourceOccurrenceId: string;
    readonly payload: unknown;
  },
  head: CausingEventRef,
  now: UtcInstant,
): readonly WorkflowPiece[] {
  const definition = steward.definition;
  const view = signalActivationView(definition.activation);
  if (view === undefined) {
    throw new DomainInvariantError("신호 활성화에 triggerId·sourceId·signal 형태가 없다");
  }
  const derived = deriveOccurrenceId({
    kind: "event_caused",
    ownerId: definition.id,
    triggerId: view.triggerId,
    causingEvent: head,
  });
  if (!derived.ok) {
    throw new DomainInvariantError(
      `정의 신호 회차 occurrence 파생 실패: ${derived.error.field} ${derived.error.reason}`,
    );
  }
  const occurrenceId = derived.value;
  const occurrence: HeldOccurrence = {
    occurrenceId,
    triggerId: view.triggerId,
    originalInstant: head.occurredAt,
    input: {
      occurrenceId,
      definitionId: definition.id,
      signal: {
        sourceId: signal.sourceId,
        signalName: signal.signalName,
        sourceOccurrenceId: signal.sourceOccurrenceId,
        payload: signal.payload,
      },
    },
  };
  const run = startRun(deps, state, steward);
  resolveCandidate(run, occurrence, undefined, false);
  return assemblePieces(run, [], "misfire_skip", undefined, signalSeriesEnded(deps, run), now);
}
