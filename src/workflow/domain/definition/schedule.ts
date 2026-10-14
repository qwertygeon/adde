/**
 * 반복 전개 포트 호출·계열 한계·만기 집합·첫 회차. 포트 출력은 정규 UTC 표기·질의 시각 이상·0 이상
 * 안전 정수 번호·비어 있지 않은 주기 키여야 하고, 어기면 프로그램 오류다. 계열 한계(`until` 포함 —
 * 그 시각의 회차는 존재, `recurrence.maxOccurrences` — 번호 < 상한)는 도메인이 적용한다.
 */
import { DomainInvariantError } from "../result.js";
import type { WorkDefinitionId, OccurrenceId } from "../ids.js";
import type { UtcInstant } from "../values.js";
import { addMs, instantMs, parseUtcInstant } from "../values.js";
import type { TriggerSpec } from "../trigger.js";
import { deriveOccurrenceId } from "../derivation/occurrence-id.js";
import type { DomainDeps } from "../engine.js";
import type {
  DefinitionRecord,
  RecurrenceExpander,
  RecurrenceStep,
  ResolvedScheduleRef,
  ScheduleRow,
} from "./model.js";
import { scheduleActivationView } from "./model.js";

/** 개정 첫 회차 탐색의 반복 상한 — 넘으면 포트 결함으로 본다. */
const AMENDMENT_SEARCH_LIMIT = 10_000;

function requirePort(deps: DomainDeps): RecurrenceExpander {
  const port = deps.recurrence;
  if (port === undefined) {
    throw new DomainInvariantError(
      "일정 활성화를 다루는데 반복 전개 포트(recurrence)가 주입되지 않았다",
    );
  }
  return port;
}

function requireScheduleView(activation: TriggerSpec) {
  const view = scheduleActivationView(activation);
  if (view === undefined) {
    throw new DomainInvariantError(
      "일정 활성화에 triggerId·timezone·misfire·recurrence 형태가 없다",
    );
  }
  return view;
}

function isCanonicalInstant(raw: unknown): raw is UtcInstant {
  if (typeof raw !== "string") return false;
  const parsed = parseUtcInstant(raw);
  return parsed.ok && parsed.value === raw;
}

/** `atOrAfter` 이상의 첫 회차(계열 한계 적용). 계열이 끝났으면 undefined. */
export function nextStep(
  deps: DomainDeps,
  activation: TriggerSpec,
  atOrAfter: UtcInstant,
): RecurrenceStep | undefined {
  const port = requirePort(deps);
  const view = requireScheduleView(activation);
  const step = port.firstAtOrAfter(activation, atOrAfter);
  if (step === undefined) return undefined;
  const scheduledForUtc: unknown = step.scheduledForUtc;
  const recurrenceIndex: unknown = step.recurrenceIndex;
  if (!isCanonicalInstant(scheduledForUtc)) {
    throw new DomainInvariantError(
      `반복 전개 포트가 정규 UTC 표기가 아닌 회차를 냈다: ${String(scheduledForUtc)}`,
    );
  }
  if (instantMs(scheduledForUtc) < instantMs(atOrAfter)) {
    throw new DomainInvariantError(
      `반복 전개 포트가 질의 시각 ${atOrAfter} 보다 이른 회차 ${scheduledForUtc} 를 냈다`,
    );
  }
  if (
    typeof recurrenceIndex !== "number" ||
    !Number.isSafeInteger(recurrenceIndex) ||
    recurrenceIndex < 0
  ) {
    throw new DomainInvariantError(
      `반복 전개 포트가 0 이상 안전 정수가 아닌 회차 번호를 냈다: ${String(recurrenceIndex)}`,
    );
  }
  const until = view.recurrence.until;
  if (until !== undefined && instantMs(scheduledForUtc) > instantMs(until)) return undefined;
  const maxOccurrences = view.recurrence.maxOccurrences;
  if (maxOccurrences !== undefined && recurrenceIndex >= maxOccurrences) return undefined;
  return { scheduledForUtc, recurrenceIndex };
}

/** 회차가 속한 반복 주기 키. */
export function periodOf(
  deps: DomainDeps,
  activation: TriggerSpec,
  scheduledForUtc: UtcInstant,
): string {
  const key: unknown = requirePort(deps).periodOf(activation, scheduledForUtc);
  if (typeof key !== "string" || key.length === 0) {
    throw new DomainInvariantError("반복 전개 포트가 비어 있지 않은 주기 키를 내지 않았다");
  }
  return key;
}

/** 정의 소유 일정 회차의 occurrence ID. */
export function scheduleOccurrenceId(
  definitionId: WorkDefinitionId,
  triggerId: string,
  step: RecurrenceStep,
): OccurrenceId {
  const derived = deriveOccurrenceId({
    kind: "schedule",
    ownerId: definitionId,
    triggerId,
    scheduledForUtc: step.scheduledForUtc,
    recurrenceIndex: step.recurrenceIndex,
  });
  if (!derived.ok) {
    throw new DomainInvariantError(
      `정의 일정 회차 occurrence 파생 실패: ${derived.error.field} ${derived.error.reason}`,
    );
  }
  return derived.value;
}

export function scheduleRowOf(
  definitionId: WorkDefinitionId,
  activation: TriggerSpec,
  step: RecurrenceStep,
): ScheduleRow {
  const triggerId = requireScheduleView(activation).triggerId;
  return {
    occurrenceId: scheduleOccurrenceId(definitionId, triggerId, step),
    triggerId,
    scheduledForUtc: step.scheduledForUtc,
    recurrenceIndex: step.recurrenceIndex,
  };
}

/** `row` 바로 뒤의 회차 행. 계열이 끝났으면 undefined. */
export function rowAfter(
  deps: DomainDeps,
  definitionId: WorkDefinitionId,
  activation: TriggerSpec,
  row: ScheduleRow | ResolvedScheduleRef,
): ScheduleRow | undefined {
  const step = nextStep(deps, activation, addMs(row.scheduledForUtc, 1));
  return step === undefined ? undefined : scheduleRowOf(definitionId, activation, step);
}

/** 개정·중지가 취소한 occurrence ID — 다음 대기 행을 정하는 어떤 계산도 다시 고르지 않는다. */
export function retiredIdsOf(
  definition: Pick<DefinitionRecord, "retiredOccurrenceIds">,
): ReadonlySet<OccurrenceId> {
  return new Set(definition.retiredOccurrenceIds);
}

export interface IssuableRow {
  /** `row` 부터 취소 ID 가 아닌 첫 행. 계열이 끝났으면 undefined. */
  readonly row: ScheduleRow | undefined;
  /** 취소 ID 라 넘긴 행(원래 순서) — 잃는 회차로 기록한다. */
  readonly lost: readonly ScheduleRow[];
}

/**
 * `row` 부터 발급할 수 있는 첫 행. 반복 상한을 두지 않는다 — 계열 시각이 엄격히 늘고 ID 에 원래 시각이
 * 들어가므로 한 취소 ID 는 계열에서 한 번만 만나고, 연속으로 넘기는 행은 취소 목록 길이 이하다.
 */
export function issuableFrom(
  deps: DomainDeps,
  definitionId: WorkDefinitionId,
  activation: TriggerSpec,
  row: ScheduleRow | undefined,
  retired: ReadonlySet<OccurrenceId>,
): IssuableRow {
  const lost: ScheduleRow[] = [];
  let current = row;
  while (current !== undefined && retired.has(current.occurrenceId)) {
    lost.push(current);
    current = rowAfter(deps, definitionId, activation, current);
  }
  return { row: current, lost };
}

export interface DueSet {
  /** 대기 행부터 시각 ≤ now 인 회차(원래 순서, 취소 ID 회차 포함). */
  readonly due: readonly ScheduleRow[];
  /** 만기 집합의 마지막 뒤 발급할 수 있는 첫 회차. 계열이 끝났으면 undefined. */
  readonly next: ScheduleRow | undefined;
  /** 만기 집합의 마지막과 다음 회차 사이의 취소 ID 회차. */
  readonly lostAhead: readonly ScheduleRow[];
}

/** 대기 행부터 포트로 이어 전개한 만기 집합과 다음 대기 행. 대기 행 자체가 미도래면 빈 집합. */
export function dueSet(
  deps: DomainDeps,
  definitionId: WorkDefinitionId,
  activation: TriggerSpec,
  row: ScheduleRow,
  now: UtcInstant,
  retired: ReadonlySet<OccurrenceId>,
): DueSet {
  const nowMs = instantMs(now);
  if (instantMs(row.scheduledForUtc) > nowMs) return { due: [], next: row, lostAhead: [] };
  const due: ScheduleRow[] = [row];
  let current: ScheduleRow = row;
  for (;;) {
    const next = rowAfter(deps, definitionId, activation, current);
    if (next === undefined || instantMs(next.scheduledForUtc) > nowMs) {
      const issuable = issuableFrom(deps, definitionId, activation, next, retired);
      return { due, next: issuable.row, lostAhead: issuable.lost };
    }
    due.push(next);
    current = next;
  }
}

/** 생성 커밋의 첫 회차 — 커밋 시각 이상 첫 회차(계열 한계 적용). 계열이 이미 끝났으면 undefined. */
export function firstRowAtCreation(
  deps: DomainDeps,
  definitionId: WorkDefinitionId,
  activation: TriggerSpec,
  now: UtcInstant,
): ScheduleRow | undefined {
  const step = nextStep(deps, activation, now);
  return step === undefined ? undefined : scheduleRowOf(definitionId, activation, step);
}

/** 고른 행이 아직 도래하지 않은 이전 대기 행과 같은 회차인가. */
function isUndueRow(
  chosen: ScheduleRow,
  pendingRow: ScheduleRow | undefined,
  nowMs: number,
): boolean {
  return (
    pendingRow !== undefined &&
    instantMs(pendingRow.scheduledForUtc) > nowMs &&
    chosen.occurrenceId === pendingRow.occurrenceId
  );
}

export interface AmendmentFirstRow {
  /** 새 활성화의 첫 대기 행. 계열이 끝났으면 undefined. */
  readonly row: ScheduleRow | undefined;
  /** 이전 미도래 대기 행을 그대로 쓴다(취소하지 않는다). */
  readonly kept: boolean;
  /** 취소된 ID 라 다시 발급하지 않고 넘긴 회차 — 개정 커밋의 건너뜀에 넣는다. */
  readonly lostPeriods: readonly ScheduleRow[];
}

/**
 * 개정 뒤 첫 대기 행. 시작 = max(마지막 해소 + 1ms, now). 마지막 해소 회차와 같은 주기의 후보를 넘기고,
 * 취소된 ID 는 다시 발급하지 않고 잃는 주기로 기록하며 마지막 해소를 그 회차로 올린다.
 *
 * 새 활성화가 고른 첫 행이 미도래 이전 대기 행과 같은 회차(occurrence ID)면 그 행을 유지한다 — 한 규칙의
 * 두 자리다. 첫 후보는 필터보다 먼저 본다(주기가 여러 회차를 묶는 포트에서 제목만 바꾼 개정이 대기 행을
 * 잃지 않게). 필터를 거쳐 고른 행도 본다(하루 여러 번 회차를 내는 포트에서 같은 커밋이 그 행을 취소하면서
 * 같은 ID 를 새 대기 행으로 실으면, 대기 행이 지워지고 그 ID 가 재발급 금지에 들어 정의가 멈춘다). 같은
 * 주기라 넘긴 후보는 대기 행과 ID 가 같아도 유지하지 않는다 — 그 주기는 이미 회차가 있었다.
 */
export function firstRowAfterAmendment(
  deps: DomainDeps,
  definition: DefinitionRecord,
  newActivation: TriggerSpec,
  now: UtcInstant,
  lastResolved: ResolvedScheduleRef | undefined,
  pendingRow: ScheduleRow | undefined,
): AmendmentFirstRow {
  const definitionId = definition.id;
  const nowMs = instantMs(now);
  const afterResolved =
    lastResolved === undefined ? undefined : addMs(lastResolved.scheduledForUtc, 1);
  const start =
    afterResolved !== undefined && instantMs(afterResolved) > nowMs ? afterResolved : now;
  const firstStep = nextStep(deps, newActivation, start);
  if (firstStep === undefined) return { row: undefined, kept: false, lostPeriods: [] };
  let candidate: ScheduleRow = scheduleRowOf(definitionId, newActivation, firstStep);

  if (isUndueRow(candidate, pendingRow, nowMs)) {
    return { row: candidate, kept: true, lostPeriods: [] };
  }

  const retired = retiredIdsOf(definition);
  const lostPeriods: ScheduleRow[] = [];
  let resolved: ResolvedScheduleRef | undefined = lastResolved;
  for (let searched = 0; searched < AMENDMENT_SEARCH_LIMIT; searched += 1) {
    const samePeriod =
      resolved !== undefined &&
      periodOf(deps, newActivation, candidate.scheduledForUtc) ===
        periodOf(deps, newActivation, resolved.scheduledForUtc);
    if (!samePeriod) {
      if (!retired.has(candidate.occurrenceId)) {
        return { row: candidate, kept: isUndueRow(candidate, pendingRow, nowMs), lostPeriods };
      }
      lostPeriods.push(candidate);
      resolved = {
        scheduledForUtc: candidate.scheduledForUtc,
        recurrenceIndex: candidate.recurrenceIndex,
      };
    }
    const next = rowAfter(deps, definitionId, newActivation, candidate);
    if (next === undefined) return { row: undefined, kept: false, lostPeriods };
    candidate = next;
  }
  throw new DomainInvariantError(
    `개정 첫 회차 탐색이 ${AMENDMENT_SEARCH_LIMIT} 회를 넘었다 — 반복 전개 포트 결함`,
  );
}
