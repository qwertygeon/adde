/**
 * WorkDefinition 값 모델 — 관리 Work 애그리거트 안에 두는 정의 레코드(계약 `WorkDefinition` + 장부),
 * 중지·일시정지 출처, 대기 일정 행·보류 회차, 반복 전개 포트, 활성화 분류.
 *
 * 장부(대기 행·보류·materialize 목록·마지막 해소 회차·취소 ID)는 이벤트 페이로드에 실린 값으로만
 * 갱신된다 — fold 가 판정 로직 없이 재구성한다. 활성화 종류는 등록부 descriptor 선언(`firing`·
 * `occurrenceDerivation.kind`)과 반복 규칙 유무로 가르고, Trigger 종류 식별자로 분기하지 않는다.
 */
import type {
  WorkDefinitionId,
  WorkId,
  ProjectId,
  OccurrenceId,
  ControlRequestId,
} from "../ids.js";
import type { SignalId } from "../ids.js";
import type { UtcInstant, ActorSource } from "../values.js";
import type { MisfirePolicy, RecurrenceRule, TriggerSpec } from "../trigger.js";
import type { OccurrenceInput } from "../aggregate.js";
import type { ProposedTaskDraft } from "../plan/proposal.js";
import type { DomainRegistries } from "../registry/registries.js";
import type { DefinitionStateName } from "../contract/definition-transitions.js";

/** 반복 전개 포트의 회차 하나 — 원래 시각과 계열 안 번호(0 부터). */
export interface RecurrenceStep {
  readonly scheduledForUtc: UtcInstant;
  readonly recurrenceIndex: number;
}

/**
 * 반복 전개 포트 — 규칙 문법 해석은 포트 몫이다. 도메인은 출력 형식·단조성을 검사하고 계열 한계
 * (`until` 포함, `recurrence.maxOccurrences`)를 직접 적용한다.
 */
export interface RecurrenceExpander {
  /** `atOrAfter` 이상의 첫 회차. 규칙상 더 없으면 undefined. */
  firstAtOrAfter(activation: TriggerSpec, atOrAfter: UtcInstant): RecurrenceStep | undefined;
  /** 회차가 속한 반복 주기의 키(예: 일일 규칙의 현지 날짜). 같은 주기의 회차는 같은 키다. */
  periodOf(activation: TriggerSpec, scheduledForUtc: UtcInstant): string;
}

export type DefinitionPauseOriginKind = "vault_signal" | "control_request" | "template_invalid";
export type DefinitionStopOriginKind =
  "vault_signal" | "control_request" | "series_exhausted" | "work_cascade";

export interface DefinitionPauseOrigin {
  readonly kind: DefinitionPauseOriginKind;
  readonly actorSource: ActorSource;
  readonly signalId?: SignalId;
  readonly controlRequestId?: ControlRequestId;
  readonly keyId?: string;
}

export interface DefinitionStopOrigin {
  readonly kind: DefinitionStopOriginKind;
  readonly actorSource: ActorSource;
  readonly signalId?: SignalId;
  readonly controlRequestId?: ControlRequestId;
  readonly keyId?: string;
}

/** 보류 사유 — 처음 실패한 materialize 조건(정의 일시정지 → 오래된 보류 → 열린 회차 상한 → 템플릿 무효). */
export type HoldCause = "definition_paused" | "older_held" | "open_bound" | "template_invalid";

export type SkipReason =
  "misfire_skip" | "superseded_by_later" | "definition_revised" | "definition_stopped";

/** 대기 일정 행 — 정의당 하나. */
export interface ScheduleRow {
  readonly occurrenceId: OccurrenceId;
  readonly triggerId: string;
  readonly scheduledForUtc: UtcInstant;
  readonly recurrenceIndex: number;
}

export interface PendingScheduleRow extends ScheduleRow {
  /** 재개 시점에 이미 도래해 있던 행 — 해소에서 놓친 회차로 판정한다. */
  readonly overdue: boolean;
}

/** 보류 회차 — 파생에 쓴 `triggerId` 를 함께 보관해 해제의 `trigger_fired.triggerId` 로 쓴다. */
export interface HeldOccurrence {
  readonly occurrenceId: OccurrenceId;
  readonly triggerId: string;
  /** 일정 회차는 원래 시각, 신호 회차는 수용 시각. */
  readonly originalInstant: UtcInstant;
  /** 일정 회차만. */
  readonly recurrenceIndex?: number;
  readonly input: Omit<OccurrenceInput, "definitionRevision">;
}

export interface MaterializedOccurrence {
  readonly occurrenceId: OccurrenceId;
  readonly workId: WorkId;
  readonly definitionRevision: number;
}

export interface ResolvedScheduleRef {
  readonly scheduledForUtc: UtcInstant;
  readonly recurrenceIndex: number;
}

export interface DefinitionRecord {
  readonly id: WorkDefinitionId;
  readonly projectId: ProjectId;
  readonly sourceWorkId: WorkId;
  readonly state: DefinitionStateName;
  readonly revision: number;
  readonly title: string;
  readonly activation: TriggerSpec;
  readonly template: readonly ProposedTaskDraft[];
  readonly maxOpenOccurrences: number;
  readonly maxOccurrences?: number;
  readonly pauseOrigin?: DefinitionPauseOrigin;
  readonly stopOrigin?: DefinitionStopOrigin;
  readonly createdAt: UtcInstant;
  readonly updatedAt: UtcInstant;
  readonly correlationId: string;
  readonly pendingSchedule?: PendingScheduleRow;
  /** 원래 순서. */
  readonly held: readonly HeldOccurrence[];
  /** 정의 일생 동안 줄지 않는다 — 길이가 신호 상한 계수다. */
  readonly materialized: readonly MaterializedOccurrence[];
  /** 마지막으로 materialize·건너뛴 일정 회차. */
  readonly lastResolvedSchedule?: ResolvedScheduleRef;
  /** 취소된 occurrence ID — 다시 발급하지 않는다. */
  readonly retiredOccurrenceIds: readonly OccurrenceId[];
}

/** 정의 초안 검증 이슈 사유(`definition_invalid.reason`). */
export type DefinitionDraftInvalidReason =
  | "draft_malformed"
  | "work_source_not_markdown"
  | "amends_not_steward"
  | "amends_definition_stopped"
  | "amends_revision_mismatch"
  | "already_stewards_definition"
  | "activation_descriptor_unknown"
  | "activation_schema_invalid"
  | "activation_kind_not_allowed"
  | "max_open_occurrences_invalid"
  | "max_occurrences_not_allowed"
  | "max_occurrences_invalid";

/** 일정 활성화가 계산에 쓰는 필드 — TriggerSpec 를 종류로 좁히지 않고 구조로 읽는다. */
export interface ScheduleActivationView {
  readonly triggerId: string;
  readonly timezone: string;
  readonly misfire: MisfirePolicy;
  readonly recurrence: RecurrenceRule;
}

/** 신호 활성화가 일치 판정에 쓰는 필드. */
export interface SignalActivationView {
  readonly triggerId: string;
  readonly sourceId: string;
  readonly signal: string;
}

function hasRecurrence(activation: TriggerSpec): boolean {
  const view = activation as unknown as { readonly recurrence?: unknown };
  return view.recurrence !== undefined;
}

function descriptorOf(registries: DomainRegistries, activation: TriggerSpec) {
  const view = activation as unknown as { readonly kind?: unknown; readonly version?: unknown };
  if (typeof view.kind !== "string" || typeof view.version !== "number") return undefined;
  return registries.triggers.get(view.kind, view.version);
}

/** 예약 발화·예약 파생 선언이고 반복 규칙을 실은 활성화. */
export function isScheduleActivation(
  registries: DomainRegistries,
  activation: TriggerSpec,
): boolean {
  const descriptor = descriptorOf(registries, activation);
  return (
    descriptor !== undefined &&
    descriptor.firing === "schedule" &&
    descriptor.occurrenceDerivation.kind === "schedule" &&
    hasRecurrence(activation)
  );
}

/** 외부 신호 발화 선언의 활성화. */
export function isSignalActivation(registries: DomainRegistries, activation: TriggerSpec): boolean {
  const descriptor = descriptorOf(registries, activation);
  return descriptor !== undefined && descriptor.firing === "external_signal";
}

/** 일정 활성화의 계산 필드. 형태가 맞지 않으면 undefined. */
export function scheduleActivationView(
  activation: TriggerSpec,
): ScheduleActivationView | undefined {
  const view = activation as unknown as {
    readonly triggerId?: unknown;
    readonly timezone?: unknown;
    readonly misfire?: unknown;
    readonly recurrence?: unknown;
  };
  if (typeof view.triggerId !== "string" || typeof view.timezone !== "string") return undefined;
  if (typeof view.misfire !== "object" || view.misfire === null) return undefined;
  if (typeof view.recurrence !== "object" || view.recurrence === null) return undefined;
  return {
    triggerId: view.triggerId,
    timezone: view.timezone,
    misfire: view.misfire as MisfirePolicy,
    recurrence: view.recurrence as RecurrenceRule,
  };
}

/** 신호 활성화(또는 신호 발화 Task Trigger)의 출처·신호 이름. 형태가 맞지 않으면 undefined. */
export function signalActivationView(activation: TriggerSpec): SignalActivationView | undefined {
  const view = activation as unknown as {
    readonly triggerId?: unknown;
    readonly sourceId?: unknown;
    readonly signal?: unknown;
  };
  if (
    typeof view.triggerId !== "string" ||
    typeof view.sourceId !== "string" ||
    typeof view.signal !== "string"
  ) {
    return undefined;
  }
  return { triggerId: view.triggerId, sourceId: view.sourceId, signal: view.signal };
}
