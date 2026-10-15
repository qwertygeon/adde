/**
 * 중지·개정의 대기 행 해소. 미도래 대기 행은 `trigger_canceled`, 이미 도래한 만기 집합(일시정지 중 도래분
 * 포함)과 보류 회차는 건너뜀 이벤트 하나로 기록한다. 개정은 새 활성화가 같은 출처·신호 이름을 받을 때만
 * 보류 신호 회차를 유지하고, 새 일정 활성화의 첫 대기 행을 정한다 — 그 계열이 이미 끝났으면(일정 = 첫
 * 대기 행 없음, 신호 = 상한 ≤ 일생 누적 materialize 수) 같은 커밋에서 정의를 중지한다. 열린 회차 Work 는
 * 다른 애그리거트라 바뀌지 않는다.
 */
import type { OccurrenceId, PlanProposalId } from "../ids.js";
import type { ActorSource, CancelOrigin, UtcInstant } from "../values.js";
import { instantMs } from "../values.js";
import type { TriggerSpec } from "../trigger.js";
import type { DecidedEvent } from "../events.js";
import { mkEvent } from "../events.js";
import type { DomainDeps } from "../engine.js";
import type { DefinitionDraftContent } from "./draft.js";
import type {
  DefinitionRecord,
  DefinitionStopOrigin,
  HeldOccurrence,
  ResolvedScheduleRef,
  ScheduleRow,
  SkipReason,
} from "./model.js";
import { isSignalActivation, signalActivationView } from "./model.js";
import { dueSet, firstRowAfterAmendment, retiredIdsOf } from "./schedule.js";

/** 건너뜀 하나 — 원래 시각(신호 회차는 수용 시각), 일정 회차 번호, 보류 회차면 그 ID. */
export interface SkipItem {
  readonly instant: UtcInstant;
  readonly recurrenceIndex?: number;
  readonly heldOccurrenceId?: OccurrenceId;
}

export function skipItemOfRow(row: ScheduleRow): SkipItem {
  return { instant: row.scheduledForUtc, recurrenceIndex: row.recurrenceIndex };
}

export function skipItemOfHeld(held: HeldOccurrence): SkipItem {
  return {
    instant: held.originalInstant,
    ...(held.recurrenceIndex !== undefined ? { recurrenceIndex: held.recurrenceIndex } : {}),
    heldOccurrenceId: held.occurrenceId,
  };
}

/** 건너뛴 일정 회차 중 가장 늦은 것. 없으면 undefined. */
export function latestScheduleRef(items: readonly SkipItem[]): ResolvedScheduleRef | undefined {
  let latest: ResolvedScheduleRef | undefined;
  for (const item of items) {
    if (item.recurrenceIndex === undefined) continue;
    if (latest === undefined || instantMs(item.instant) > instantMs(latest.scheduledForUtc)) {
      latest = { scheduledForUtc: item.instant, recurrenceIndex: item.recurrenceIndex };
    }
  }
  return latest;
}

/**
 * 해소 하나의 건너뜀 이벤트(없으면 undefined). 개수·처음·마지막 원래 시각·사유·건너뛴 보류 ID 와
 * 건너뛴 일정 회차의 최댓값을 싣는다. `nextSchedule` 은 회차 해소만 싣는다.
 */
export function skipEvent(
  definition: Pick<DefinitionRecord, "id">,
  items: readonly SkipItem[],
  reason: SkipReason,
  nextSchedule?: ScheduleRow | null,
): DecidedEvent | undefined {
  if (items.length === 0) return undefined;
  let first = items[0] as SkipItem;
  let last = items[0] as SkipItem;
  for (const item of items) {
    if (instantMs(item.instant) < instantMs(first.instant)) first = item;
    if (instantMs(item.instant) > instantMs(last.instant)) last = item;
  }
  const lastResolvedSchedule = latestScheduleRef(items);
  return mkEvent("work_definition_occurrences_skipped", {
    definitionId: definition.id,
    count: items.length,
    firstOriginalInstant: first.instant,
    lastOriginalInstant: last.instant,
    reason,
    heldOccurrenceIds: items.flatMap((item) =>
      item.heldOccurrenceId !== undefined ? [item.heldOccurrenceId] : [],
    ),
    ...(lastResolvedSchedule !== undefined ? { lastResolvedSchedule } : {}),
    ...(nextSchedule !== undefined ? { nextSchedule } : {}),
  });
}

function canceledEvent(
  definition: Pick<DefinitionRecord, "id">,
  row: ScheduleRow,
  reason: "definition_revised" | "definition_stopped",
): DecidedEvent {
  return mkEvent("trigger_canceled", {
    definitionId: definition.id,
    triggerId: row.triggerId,
    occurrenceId: row.occurrenceId,
    scheduledForUtc: row.scheduledForUtc,
    recurrenceIndex: row.recurrenceIndex,
    reason,
  });
}

function isDue(row: ScheduleRow, now: UtcInstant): boolean {
  return instantMs(row.scheduledForUtc) <= instantMs(now);
}

/** 도래한 대기 행부터 이전 활성화로 전개한 만기 집합(일시정지 중 도래분 포함). */
function dueRowsOf(
  deps: DomainDeps,
  definition: Pick<DefinitionRecord, "id" | "retiredOccurrenceIds">,
  activation: TriggerSpec,
  row: ScheduleRow,
  now: UtcInstant,
): readonly ScheduleRow[] {
  return dueSet(deps, definition.id, activation, row, now, retiredIdsOf(definition)).due;
}

/** 중지의 대기 행·보류 해소 — 중지 이벤트 뒤에 붙는다. */
function stopResolution(
  deps: DomainDeps,
  definition: Pick<DefinitionRecord, "id" | "retiredOccurrenceIds">,
  activation: TriggerSpec,
  pending: ScheduleRow | undefined,
  held: readonly HeldOccurrence[],
  now: UtcInstant,
): readonly DecidedEvent[] {
  const out: DecidedEvent[] = [];
  const items: SkipItem[] = [];
  if (pending !== undefined) {
    if (isDue(pending, now)) {
      for (const row of dueRowsOf(deps, definition, activation, pending, now)) {
        items.push(skipItemOfRow(row));
      }
    } else {
      out.push(canceledEvent(definition, pending, "definition_stopped"));
    }
  }
  for (const occurrence of held) items.push(skipItemOfHeld(occurrence));
  const skipped = skipEvent(definition, items, "definition_stopped");
  if (skipped !== undefined) out.push(skipped);
  return out;
}

function stoppedEvent(
  definition: Pick<DefinitionRecord, "id">,
  stopOrigin: DefinitionStopOrigin,
): DecidedEvent {
  return mkEvent("work_definition_stopped", { definitionId: definition.id, stopOrigin });
}

/** 정의 중지 — `work_definition_stopped` → `trigger_canceled`? → 건너뜀(`definition_stopped`)?. */
export function decideStop(
  deps: DomainDeps,
  definition: DefinitionRecord,
  stopOrigin: DefinitionStopOrigin,
  now: UtcInstant,
): readonly DecidedEvent[] {
  return [
    stoppedEvent(definition, stopOrigin),
    ...stopResolution(
      deps,
      definition,
      definition.activation,
      definition.pendingSchedule,
      definition.held,
      now,
    ),
  ];
}

const SERIES_EXHAUSTED: DefinitionStopOrigin = {
  kind: "series_exhausted",
  actorSource: "adde_self",
};

/**
 * 관리 Work 취소가 정의를 멈추는 중지 출처 — 출처는 `work_canceled` envelope 의 것(= 명령·신호 출처),
 * 신호·제어 요청·키 ID 는 취소 origin 의 값.
 */
export function workCascadeStopOrigin(
  origin: CancelOrigin,
  actorSource: ActorSource,
): DefinitionStopOrigin {
  return {
    kind: "work_cascade",
    actorSource,
    ...(origin.kind === "vault_signal" && origin.signalId !== undefined
      ? { signalId: origin.signalId }
      : {}),
    ...(origin.kind === "control_request" && origin.controlRequestId !== undefined
      ? { controlRequestId: origin.controlRequestId }
      : {}),
    ...(origin.kind === "control_request" && origin.keyId !== undefined
      ? { keyId: origin.keyId }
      : {}),
  };
}

/** 계열 소진 중지 출처. */
export function seriesExhaustedOrigin(): DefinitionStopOrigin {
  return SERIES_EXHAUSTED;
}

/** 새 활성화가 이 보류 신호 회차의 출처·신호 이름을 받는가. */
function acceptsHeldSignal(
  deps: DomainDeps,
  activation: TriggerSpec,
  held: HeldOccurrence,
): boolean {
  if (!isSignalActivation(deps.registries, activation)) return false;
  const view = signalActivationView(activation);
  const signal = held.input.signal;
  return (
    view !== undefined &&
    signal !== undefined &&
    view.sourceId === signal.sourceId &&
    view.signal === signal.signalName
  );
}

/**
 * 정의 개정 — `work_definition_revised` → `trigger_canceled`? → 건너뜀(`definition_revised`)? →
 * (계열 소진이면) `work_definition_stopped(series_exhausted)` + 중지 해소. 개정 건너뜀은 이전 활성화의
 * 만기 집합·보류 일정 회차·받지 않는 보류 신호 회차·잃는 주기를 한 이벤트로 묶는다.
 */
export function decideAmendment(
  deps: DomainDeps,
  definition: DefinitionRecord,
  draft: DefinitionDraftContent,
  proposalId: PlanProposalId,
  now: UtcInstant,
): readonly DecidedEvent[] {
  const pending = definition.pendingSchedule;
  const pendingDue = pending !== undefined && isDue(pending, now);
  const dueRows =
    pending !== undefined && pendingDue
      ? dueRowsOf(deps, definition, definition.activation, pending, now)
      : [];

  const keptHeld: HeldOccurrence[] = [];
  const skippedHeld: HeldOccurrence[] = [];
  for (const held of definition.held) {
    const isSignalHeld = held.recurrenceIndex === undefined;
    if (isSignalHeld && acceptsHeldSignal(deps, draft.activation, held)) keptHeld.push(held);
    else skippedHeld.push(held);
  }

  const resolvedItems: SkipItem[] = [
    ...dueRows.map(skipItemOfRow),
    ...skippedHeld.map(skipItemOfHeld),
  ];
  const lastResolvedBefore = latestScheduleRef([
    ...(definition.lastResolvedSchedule !== undefined
      ? [
          {
            instant: definition.lastResolvedSchedule.scheduledForUtc,
            recurrenceIndex: definition.lastResolvedSchedule.recurrenceIndex,
          },
        ]
      : []),
    ...resolvedItems,
  ]);

  const newIsSignal = isSignalActivation(deps.registries, draft.activation);
  let nextRow: ScheduleRow | undefined;
  let kept = false;
  let lostPeriods: readonly ScheduleRow[] = [];
  if (!newIsSignal) {
    const first = firstRowAfterAmendment(
      deps,
      definition,
      draft.activation,
      now,
      lastResolvedBefore,
      pending !== undefined && !pendingDue ? pending : undefined,
    );
    nextRow = first.row;
    kept = first.kept;
    lostPeriods = first.lostPeriods;
  }

  const out: DecidedEvent[] = [
    mkEvent("work_definition_revised", {
      definitionId: definition.id,
      proposalId,
      title: draft.title,
      activation: draft.activation,
      template: draft.template,
      maxOpenOccurrences: draft.maxOpenOccurrences,
      ...(draft.maxOccurrences !== undefined ? { maxOccurrences: draft.maxOccurrences } : {}),
      nextSchedule: nextRow ?? null,
    }),
  ];
  if (pending !== undefined && !pendingDue && !kept) {
    out.push(canceledEvent(definition, pending, "definition_revised"));
  }
  const revisedSkip = skipEvent(
    definition,
    [...resolvedItems, ...lostPeriods.map(skipItemOfRow)],
    "definition_revised",
  );
  if (revisedSkip !== undefined) out.push(revisedSkip);

  const exhausted = newIsSignal
    ? draft.maxOccurrences !== undefined && draft.maxOccurrences <= definition.materialized.length
    : nextRow === undefined;
  if (exhausted) {
    out.push(stoppedEvent(definition, SERIES_EXHAUSTED));
    for (const event of stopResolution(
      deps,
      definition,
      draft.activation,
      undefined,
      keptHeld,
      now,
    )) {
      out.push(event);
    }
  }
  return out;
}
