// 반복 정의·회차 시험 공용 픽스처. 공개 배럴만 import 한다 — 개별 모듈 경로는 참조하지 않는다.
// 시험용 반복 전개 포트(일일·주 단위 주기)는 시험 코드에만 둔다 — 프로덕션은 규칙 문법을 해석하지 않는다.
import {
  createWork,
  executeCommand,
  judgeSignal,
  nextEntityId,
  deriveOccurrenceId,
  localToUtc,
  utcToLocal,
  executeDefinitionCommand,
  judgeDefinitionSignal,
  judgeTaskExternalSignal,
  foldWorkflowEvents,
  workflowStateOf,
  withWork,
  findSteward,
  parseCancelOrigin,
  parseProjectId,
} from "../../../../src/workflow/domain/index.js";
import type {
  ActorSource,
  CancelOrigin,
  CommandOutcome,
  DecisionApplication,
  DecisionSignal,
  DefinitionControlSignal,
  DefinitionRecord,
  DomainCommit,
  DomainDeps,
  DomainRegistries,
  ExternalSignal,
  OccurrenceId,
  PlanProposalInput,
  PlanTaskDraft,
  RecurrenceExpander,
  RecurrenceStep,
  SignalJudgement,
  TaskCommand,
  TaskId,
  TaskRecord,
  TriggerSpec,
  UtcInstant,
  WorkAggregate,
  WorkCommand,
  WorkDefinitionId,
  WorkId,
  WorkflowState,
  EventId,
  TaskTypeDescriptor,
} from "../../../../src/workflow/domain/index.js";
import * as z from "zod";
import {
  STRUCTURALLY_INVALID_INPUT,
  at,
  committedChain,
  draft,
  entityId,
  meta,
  mustOk,
  patchTask,
  testDeps,
} from "./fixtures.js";
import { testRegistries } from "./registry-fixtures.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type DefinitionOutcome = ReturnType<typeof executeDefinitionCommand>;
export type DefinitionJudgement = ReturnType<typeof judgeDefinitionSignal>;

// ---- 시각 ------------------------------------------------------------------

/** 등록 커밋 시각 — 기본 일일 활성화의 첫 회차(03-01 07:00Z)보다 앞. */
export const DEF_NOW = at("2026-02-28T12:00:00Z");
/** 기본 일일 활성화의 기준 시각 — UTC 07:00, 회차 번호 0. */
export const DEF_ANCHOR = at("2026-03-01T07:00:00Z");

/** 2026-03-01 에서 k 일 뒤의 UTC 시각(`HH:MM[:SS[.sss]]`). */
export function dayAt(k: number, time = "07:00"): UtcInstant {
  const [h = "0", m = "0", rest = "0"] = time.split(":");
  const [s = "0", ms = "0"] = rest.split(".");
  const value = Date.UTC(
    2026,
    2,
    1 + k,
    Number(h),
    Number(m),
    Number(s),
    Number(ms.padEnd(3, "0")),
  );
  return at(new Date(value).toISOString());
}

// ---- 시험용 반복 전개 포트 ----------------------------------------------------

const DAILY_RULE = /^test-daily (\d{2}:\d{2})$/;

interface DailyParams {
  readonly localTime: string;
  readonly timeZone: string;
  readonly anchorUtc: UtcInstant;
}

function dailyParams(activation: TriggerSpec): DailyParams {
  const raw = activation as unknown as {
    readonly timezone?: unknown;
    readonly recurrence?: { readonly rule?: unknown; readonly anchorUtc?: unknown };
  };
  const rule = raw.recurrence?.rule;
  const match = typeof rule === "string" ? DAILY_RULE.exec(rule) : null;
  if (
    match === null ||
    typeof raw.timezone !== "string" ||
    typeof raw.recurrence?.anchorUtc !== "string"
  ) {
    throw new Error(`test recurrence: not a test-daily activation ${JSON.stringify(activation)}`);
  }
  return {
    localTime: match[1] as string,
    timeZone: raw.timezone,
    anchorUtc: raw.recurrence.anchorUtc as UtcInstant,
  };
}

function localDateOf(instant: UtcInstant, timeZone: string): string {
  const local = utcToLocal(instant, timeZone);
  if (!local.ok)
    throw new Error(`test recurrence: utcToLocal failed ${JSON.stringify(local.error)}`);
  return local.value.localDate;
}

function dayNumber(localDate: string): number {
  const [y, m, d] = localDate.split("-").map(Number);
  return Math.round(Date.UTC(y as number, (m as number) - 1, d as number) / 86_400_000);
}

function addDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(Date.UTC(y as number, (m as number) - 1, (d as number) + days))
    .toISOString()
    .slice(0, 10);
}

/** 현지 날짜·시각의 정확한 UTC — 모호·없는 시각은 시험이 피한다(만나면 던진다). */
function exactUtc(localDate: string, localTime: string, timeZone: string): UtcInstant {
  const result = localToUtc({ localDate, localTime, timeZone });
  if (!result.ok || result.value.kind !== "exact") {
    throw new Error(
      `test recurrence: ${localDate} ${localTime} ${timeZone} is not an exact local time`,
    );
  }
  return result.value.utc;
}

/**
 * 시험용 일일 규칙 — `recurrence.rule` 이 `"test-daily HH:MM"` 이면 활성화 `timezone` 의 현지 날짜마다 그
 * 현지 시각을 회차로 낸다. 회차 번호는 기준 시각의 현지 날짜부터 센 날짜 수, 반복 주기는 현지 날짜다.
 * 계열 한계(`until`·`maxOccurrences`)는 도메인이 적용하므로 이 포트는 적용하지 않는다.
 */
export const testDailyRecurrence: RecurrenceExpander = {
  firstAtOrAfter(activation: TriggerSpec, atOrAfter: UtcInstant): RecurrenceStep | undefined {
    const p = dailyParams(activation);
    const start = Date.parse(atOrAfter) < Date.parse(p.anchorUtc) ? p.anchorUtc : atOrAfter;
    const anchorDay = localDateOf(p.anchorUtc, p.timeZone);
    let day = localDateOf(start, p.timeZone);
    for (let i = 0; i < 3; i += 1) {
      const candidate = exactUtc(day, p.localTime, p.timeZone);
      if (Date.parse(candidate) >= Date.parse(start)) {
        return {
          scheduledForUtc: candidate,
          recurrenceIndex: dayNumber(day) - dayNumber(anchorDay),
        };
      }
      day = addDays(day, 1);
    }
    throw new Error("test recurrence: no candidate within three local days");
  },
  periodOf(activation: TriggerSpec, scheduledForUtc: UtcInstant): string {
    return localDateOf(scheduledForUtc, dailyParams(activation).timeZone);
  },
};

/** ISO 주(월요일 시작) — 현지 날짜 기준. */
function isoWeekOf(localDate: string): string {
  const [y, m, d] = localDate.split("-").map(Number);
  const date = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday + 3);
  const weekYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

/** 회차는 시험용 일일 규칙과 같고 반복 주기만 ISO 주로 묶는 시험 포트 — 주기 묶음 판별용. */
export const testWeeklyPeriodRecurrence: RecurrenceExpander = {
  firstAtOrAfter: (activation: TriggerSpec, atOrAfter: UtcInstant) =>
    testDailyRecurrence.firstAtOrAfter(activation, atOrAfter),
  periodOf: (activation: TriggerSpec, scheduledForUtc: UtcInstant) =>
    isoWeekOf(testDailyRecurrence.periodOf(activation, scheduledForUtc)),
};

export type StepPeriod = "local_date" | "utc_hour" | "iso_week";

function activationTimeZone(activation: TriggerSpec): string {
  const zone = (activation as unknown as { readonly timezone?: unknown }).timezone;
  return typeof zone === "string" ? zone : "UTC";
}

/**
 * 하루 여러 번 회차를 내는 반복 포트의 시험 대용 — `recurrence.rule` 이 `rule` 이면 고정 목록 `steps`(시각
 * 오름차순)에서 질의 시각 이상 첫 항목을 내고 목록이 끝나면 계열 끝(`undefined`)이다. 다른 규칙은
 * `testDailyRecurrence` 에 넘긴다. 반복 주기는 `period` 로 고르며 모든 활성화에 같이 적용한다.
 */
export function testStepRecurrence(options: {
  readonly rule: string;
  readonly steps: readonly RecurrenceStep[];
  readonly period: StepPeriod;
}): RecurrenceExpander {
  return {
    firstAtOrAfter(activation: TriggerSpec, atOrAfter: UtcInstant): RecurrenceStep | undefined {
      const rule = (activation as unknown as { readonly recurrence?: { readonly rule?: unknown } })
        .recurrence?.rule;
      if (rule !== options.rule) return testDailyRecurrence.firstAtOrAfter(activation, atOrAfter);
      return options.steps.find(
        (step) => Date.parse(step.scheduledForUtc) >= Date.parse(atOrAfter),
      );
    },
    periodOf(activation: TriggerSpec, scheduledForUtc: UtcInstant): string {
      if (options.period === "utc_hour") return scheduledForUtc.slice(0, 13);
      const localDate = localDateOf(scheduledForUtc, activationTimeZone(activation));
      return options.period === "iso_week" ? isoWeekOf(localDate) : localDate;
    },
  };
}

/** 기본 일일 활성화에서 반복 규칙 이름만 바꾼 활성화 — 같은 triggerId 로 `testStepRecurrence` 규칙을 쓴다. */
export function stepActivation(
  rule: string,
  options: { misfire?: MisfireSpec; anchorUtc?: UtcInstant } = {},
): TriggerSpec {
  const base = dailyActivation({
    ...(options.misfire !== undefined ? { misfire: options.misfire } : {}),
    ...(options.anchorUtc !== undefined ? { anchorUtc: options.anchorUtc } : {}),
  }) as unknown as Record<string, unknown>;
  const recurrence = base["recurrence"] as Record<string, unknown>;
  return {
    ...base,
    expressionText: rule,
    recurrence: { ...recurrence, rule },
  } as unknown as TriggerSpec;
}

/** `testDeps` + 반복 전개 포트. `recurrence: null` 이면 포트 없이 만든다. */
export function definitionDeps(
  seed = "def",
  registries?: DomainRegistries,
  recurrence: RecurrenceExpander | null = testDailyRecurrence,
): DomainDeps {
  const base = testDeps(seed, registries);
  return recurrence === null ? base : { ...base, recurrence };
}

// ---- 회차 결합 소비자 유형 -------------------------------------------------------

const SIGNAL_OBJECT = z.strictObject({
  sourceId: z.string(),
  signalName: z.string(),
  sourceOccurrenceId: z.string(),
  payload: z.unknown(),
});

/**
 * 회차 결합 소비자 — 시험 유형 id 목록을 늘리지 않도록 `probe_consumer` 의 다른 판(2)으로 둔다. 문자열
 * 필드 `when`·`day`·`zone`, 신호 객체 `event`, 숫자 `count`(증명 불가 대조), 안전 관련 필드 `target`
 * (문자열)·`secretEvent`(신호 객체).
 */
export const OCCURRENCE_CONSUMER_TASK_TYPE: TaskTypeDescriptor = {
  id: "probe_consumer",
  version: 2,
  title: "Occurrence consumer",
  description: "Test-only records-only task type whose inputs are bound from occurrence input.",
  schema: z.strictObject({
    when: z.string().optional(),
    day: z.string().optional(),
    zone: z.string().optional(),
    event: SIGNAL_OBJECT.optional(),
    count: z.number().optional(),
    target: z.string().optional(),
    secretEvent: SIGNAL_OBJECT.optional(),
  }),
  inputFields: {
    target: { question: "Who should be notified?", safetyRelevant: true },
    secretEvent: { question: "Which event should be forwarded?", safetyRelevant: true },
  },
  outputs: {},
  executionEffect: "records_only",
  capabilities: { canAutoPlan: true, requiresHumanBeforeExecute: false },
  approvalGatesQuestionOnly: false,
  executionIsWaitRequest: false,
};

/** 같은 소비자에서 `day` 만 안전 관련으로 선언한 판 — 결합 커밋 뒤 선언이 바뀐 등록부 drift 대용. */
export const OCCURRENCE_CONSUMER_DAY_SAFETY_TASK_TYPE: TaskTypeDescriptor = {
  ...OCCURRENCE_CONSUMER_TASK_TYPE,
  inputFields: {
    ...OCCURRENCE_CONSUMER_TASK_TYPE.inputFields,
    day: { question: "Which day?", safetyRelevant: true },
  },
};

export const OCCURRENCE_CONSUMER = {
  id: OCCURRENCE_CONSUMER_TASK_TYPE.id,
  version: OCCURRENCE_CONSUMER_TASK_TYPE.version,
} as const;

/** 회차 결합 소비자를 등록한 정의 deps. */
export function occurrenceConsumerDeps(
  seed: string,
  consumer: TaskTypeDescriptor = OCCURRENCE_CONSUMER_TASK_TYPE,
): DomainDeps {
  return definitionDeps(seed, testRegistries({ taskTypes: [consumer] }));
}

/** 회차 결합 하나를 담은 소비자 템플릿 초안. */
export function bindingTemplate(
  field: string,
  occurrenceField: string,
  ref = "consumer",
): PlanTaskDraft {
  return templateDraft(ref, {
    type: OCCURRENCE_CONSUMER,
    input: {},
    inputBindings: { [field]: { from: "occurrence", field: occurrenceField } },
  } as Partial<PlanTaskDraft>);
}

// ---- 활성화·초안 -------------------------------------------------------------

export type MisfireSpec =
  | { readonly kind: "fire_once_now" }
  | { readonly kind: "skip" }
  | { readonly kind: "catch_up_bounded"; readonly maxCatchUp: number };

export function dailyActivation(
  options: {
    triggerId?: string;
    localTime?: string;
    timezone?: string;
    anchorUtc?: UtcInstant;
    misfire?: MisfireSpec;
    until?: UtcInstant;
    maxOccurrences?: number;
  } = {},
): TriggerSpec {
  const localTime = options.localTime ?? "07:00";
  const anchorUtc = options.anchorUtc ?? DEF_ANCHOR;
  return {
    kind: "at",
    version: 1,
    triggerId: options.triggerId ?? "daily",
    scheduledForUtc: anchorUtc,
    timezone: options.timezone ?? "UTC",
    expressionText: `test-daily ${localTime}`,
    recurrence: {
      rule: `test-daily ${localTime}`,
      anchorUtc,
      ...(options.until !== undefined ? { until: options.until } : {}),
      ...(options.maxOccurrences !== undefined ? { maxOccurrences: options.maxOccurrences } : {}),
    },
    misfire: options.misfire ?? { kind: "fire_once_now" },
  };
}

export const FIXTURE_SIGNAL_SOURCE = "fixture_source";
export const FIXTURE_SIGNAL_NAME = "fixture_ready";

export function signalActivation(
  options: { triggerId?: string; sourceId?: string; signal?: string } = {},
): TriggerSpec {
  return {
    kind: "signal",
    version: 1,
    triggerId: options.triggerId ?? "on_signal",
    sourceId: options.sourceId ?? FIXTURE_SIGNAL_SOURCE,
    signal: options.signal ?? FIXTURE_SIGNAL_NAME,
  };
}

/** 템플릿 초안 — 일반 계획 초안과 같은 형태. */
export function templateDraft(ref: string, overrides?: Partial<PlanTaskDraft>): PlanTaskDraft {
  return draft(ref, overrides);
}

export interface DefinitionDraftInput {
  readonly amends?: { readonly definitionId: WorkDefinitionId; readonly expectedRevision: number };
  readonly title?: string;
  readonly activation?: TriggerSpec;
  readonly template?: readonly PlanTaskDraft[];
  readonly maxOpenOccurrences?: number;
  readonly maxOccurrences?: number;
}

/** 정의 초안 — 기본은 일일 07:00(UTC)·fire_once_now·열린 회차 상한 1·템플릿 Task 하나. */
export function definitionDraft(overrides: DefinitionDraftInput = {}): Record<string, unknown> {
  return {
    ...(overrides.amends !== undefined ? { amends: overrides.amends } : {}),
    title: overrides.title ?? "daily digest",
    activation: overrides.activation ?? dailyActivation(),
    template: overrides.template ?? [templateDraft("digest")],
    maxOpenOccurrences: overrides.maxOpenOccurrences ?? 1,
    ...(overrides.maxOccurrences !== undefined ? { maxOccurrences: overrides.maxOccurrences } : {}),
  };
}

/** 신호 활성화 정의 초안. */
export function signalDefinitionDraft(
  overrides: DefinitionDraftInput = {},
): Record<string, unknown> {
  return definitionDraft({ activation: signalActivation(), title: "on signal", ...overrides });
}

// ---- 신호·출처 빌더 ----------------------------------------------------------

export type ControlChannelSpec = "vault" | "control_request" | DefinitionControlSignal["channel"];

/**
 * 정의 제어 신호. 기본은 노트(vault) 채널·`human_local`. `"control_request"` 는 ctl_ ID·`keyId` 를 채우고
 * 출처 `unknown` 을 기본으로 둔다 — `keyId` 없는 요청은 시험이 채널 객체로 명시해 만든다.
 */
export function controlSignal(
  deps: DomainDeps,
  options: {
    definitionId: WorkDefinitionId;
    expectedRevision: number;
    action: "pause" | "resume" | "stop";
    channel?: ControlChannelSpec;
    actorSource?: ActorSource;
    receivedAt?: UtcInstant;
  },
): DefinitionControlSignal {
  const spec = options.channel ?? "vault";
  const channel: DefinitionControlSignal["channel"] =
    spec === "vault"
      ? { kind: "vault_signal" }
      : spec === "control_request"
        ? {
            kind: "control_request",
            controlRequestId: nextEntityId(deps.ids, "controlRequest"),
            keyId: "fixture-key",
          }
        : spec;
  const actorSource =
    options.actorSource ?? (channel.kind === "control_request" ? "unknown" : "human_local");
  return {
    type: "definition_control",
    signalId: nextEntityId(deps.ids, "signal"),
    definitionId: options.definitionId,
    expectedRevision: options.expectedRevision,
    action: options.action,
    channel,
    actorSource,
    receivedAt: options.receivedAt ?? DEF_NOW,
  };
}

export function externalSignal(
  deps: DomainDeps,
  options: {
    subject: { readonly taskId: TaskId } | { readonly definitionId: WorkDefinitionId };
    sourceOccurrenceId: string;
    sourceId?: string;
    signalName?: string;
    payload?: unknown;
    actorSource?: ActorSource;
    receivedAt?: UtcInstant;
  },
): ExternalSignal {
  return {
    type: "external_signal",
    signalId: nextEntityId(deps.ids, "signal"),
    subject: options.subject,
    sourceId: options.sourceId ?? FIXTURE_SIGNAL_SOURCE,
    signalName: options.signalName ?? FIXTURE_SIGNAL_NAME,
    sourceOccurrenceId: options.sourceOccurrenceId,
    payload: options.payload ?? { note: options.sourceOccurrenceId },
    actorSource: options.actorSource ?? "unknown",
    receivedAt: options.receivedAt ?? DEF_NOW,
  };
}

/** 제어 요청 취소 출처(출처 `unknown`). */
export function controlRequestOrigin(deps: DomainDeps): CancelOrigin {
  return mustOk(
    parseCancelOrigin({
      kind: "control_request",
      actorSource: "unknown",
      controlRequestId: nextEntityId(deps.ids, "controlRequest"),
      keyId: "fixture-key",
    }),
  );
}

/** 노트 취소 출처(`human_local`). */
export function vaultOrigin(deps: DomainDeps): CancelOrigin {
  return mustOk(
    parseCancelOrigin({
      kind: "vault_signal",
      actorSource: "human_local",
      signalId: nextEntityId(deps.ids, "signal"),
    }),
  );
}

// ---- 외부 신호 원인 수용 참조(레코드 패치) ------------------------------------

export interface PendingAcceptanceRef {
  readonly eventId: EventId;
  readonly occurredAt: UtcInstant;
  readonly sourceId: string;
  readonly signalName: string;
}

export const ACCEPTANCE_FIXTURE_AT = at("2026-01-01T00:00:00Z");

/**
 * Task 기록에 미소비 외부 신호 수용 참조를 둔다 — 명령 경로로 남길 수 없는 상태(이 차수 흐름에서 수용은
 * 같은 커밋의 예약이 소비한다)를 만드는 다른 생성 경로 대용이다. 기본 참조의 출처·신호 이름은 그 Task
 * Trigger 값이다. 돌려준 참조에서 파생한 occurrence 를 함께 돌려준다.
 */
export function withPendingSignalAcceptance(
  aggregate: WorkAggregate,
  taskId: TaskId,
  ref?: Partial<PendingAcceptanceRef>,
): { aggregate: WorkAggregate; ref: PendingAcceptanceRef; occurrenceId: OccurrenceId } {
  const record = aggregate.tasks[taskId];
  if (record === undefined) throw new Error(`fixture: task ${taskId} not found`);
  const trigger = record.trigger as unknown as { sourceId?: unknown; signal?: unknown };
  const full: PendingAcceptanceRef = {
    eventId: ref?.eventId ?? entityId("event", `evt_acc${taskId.slice("tsk_".length)}`),
    occurredAt: ref?.occurredAt ?? ACCEPTANCE_FIXTURE_AT,
    sourceId:
      ref?.sourceId ??
      (typeof trigger.sourceId === "string" ? trigger.sourceId : FIXTURE_SIGNAL_SOURCE),
    signalName:
      ref?.signalName ??
      (typeof trigger.signal === "string" ? trigger.signal : FIXTURE_SIGNAL_NAME),
  };
  const patched: TaskRecord = { ...record, pendingSignalAcceptance: full };
  const occurrenceId = mustOk(
    deriveOccurrenceId({
      kind: "event_caused",
      ownerId: taskId,
      triggerId: record.trigger.triggerId,
      causingEvent: { id: full.eventId, occurredAt: full.occurredAt },
    }),
  );
  return {
    aggregate: { ...aggregate, tasks: { ...aggregate.tasks, [taskId]: patched } },
    ref: full,
    occurrenceId,
  };
}

// ---- occurrence ID ---------------------------------------------------------

export function scheduleOccurrenceId(
  definitionId: WorkDefinitionId,
  triggerId: string,
  scheduledForUtc: UtcInstant,
  recurrenceIndex: number,
): OccurrenceId {
  return mustOk(
    deriveOccurrenceId({
      kind: "schedule",
      ownerId: definitionId,
      triggerId,
      scheduledForUtc,
      recurrenceIndex,
    }),
  );
}

/** 커밋의 `signal_accepted` 에서 정의 소유 신호 회차 ID 를 파생한다. */
export function signalOccurrenceIdFrom(
  commit: DomainCommit,
  definitionId: WorkDefinitionId,
  triggerId: string,
): OccurrenceId {
  const accepted = commit.events.find((e) => e.type === "signal_accepted");
  if (accepted === undefined) throw new Error("fixture: commit has no signal_accepted");
  return mustOk(
    deriveOccurrenceId({
      kind: "event_caused",
      ownerId: definitionId,
      triggerId,
      causingEvent: { id: accepted.id as EventId, occurredAt: accepted.occurredAt },
    }),
  );
}

// ---- 결과 읽기 ---------------------------------------------------------------

export function commitOf(outcome: DefinitionOutcome | DefinitionJudgement): DomainCommit {
  if ("commit" in outcome) return outcome.commit;
  throw new Error(`fixture: expected a commit, got ${outcome.kind} ${JSON.stringify(outcome)}`);
}

/** 정의 명령 거절의 사유·detail. 거절이 아니면 던진다. */
export function rejectionOf(outcome: DefinitionOutcome): { reason: string; detail?: string } {
  if (outcome.kind !== "rejected")
    throw new Error(`fixture: expected rejected, got ${outcome.kind}`);
  return {
    reason: outcome.rejection.reason,
    ...(outcome.rejection.detail !== undefined ? { detail: outcome.rejection.detail } : {}),
  };
}

/** 커밋의 `work_plan_invalid` 이슈. */
export function planInvalidIssues(commit: DomainCommit): readonly Record<string, unknown>[] {
  const event = commit.events.find((e) => e.type === "work_plan_invalid");
  if (event === undefined) {
    throw new Error(
      `fixture: no work_plan_invalid in [${commit.events.map((e) => e.type).join(", ")}]`,
    );
  }
  return (event.payload as unknown as { issues: readonly Record<string, unknown>[] }).issues;
}

/** 이슈 목록 중 `definition_invalid` 사유만. */
export function definitionInvalidReasons(issues: readonly Record<string, unknown>[]): string[] {
  return issues.filter((i) => i["kind"] === "definition_invalid").map((i) => String(i["reason"]));
}

/** 이슈 목록 중 `definition_template_issue` 의 내부 이슈만. */
export function templateIssues(
  issues: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  return issues
    .filter((i) => i["kind"] === "definition_template_issue")
    .map((i) => i["issue"] as Record<string, unknown>);
}

export function typesOf(commit: DomainCommit): string[] {
  return commit.events.map((e) => e.type);
}

/** 커밋에서 해당 타입 이벤트 payload 전부. */
export function payloadsOf(commit: DomainCommit, type: string): Record<string, unknown>[] {
  return commit.events
    .filter((e) => e.type === type)
    .map((e) => e.payload as unknown as Record<string, unknown>);
}

/** 정의 이벤트·회차 이벤트 아홉 타입. */
export const DEFINITION_EVENT_TYPES = [
  "work_definition_created",
  "work_definition_revised",
  "work_definition_paused",
  "work_definition_resumed",
  "work_definition_stopped",
  "work_definition_occurrence_held",
  "work_definition_occurrences_skipped",
  "trigger_fired",
  "trigger_canceled",
] as const;

// ---- 진행기 ------------------------------------------------------------------

/**
 * 여러 Work 의 상태와 커밋 이력을 함께 들고 다니는 진행기. 직접 적용 상태는 각 판정이 돌려준 상태를 쓰고
 * (커밋을 다시 접어 만들지 않는다), 커밋 이력은 `foldWorkflowEvents` 대조에 쓴다.
 */
export class WorkflowJournal {
  readonly deps: DomainDeps;
  state: WorkflowState;
  readonly commits: DomainCommit[];

  constructor(deps: DomainDeps, state: WorkflowState, commits: readonly DomainCommit[]) {
    this.deps = deps;
    this.state = state;
    this.commits = [...commits];
  }

  work(workId: WorkId): WorkAggregate {
    const aggregate = this.state.works[workId];
    if (aggregate === undefined) throw new Error(`journal: work ${workId} not in state`);
    return aggregate;
  }

  steward(definitionId: WorkDefinitionId): WorkAggregate {
    const steward = findSteward(this.state, definitionId);
    if (steward === undefined) throw new Error(`journal: no steward for ${definitionId}`);
    return steward;
  }

  definition(definitionId: WorkDefinitionId): DefinitionRecord {
    const record = this.steward(definitionId).definition;
    if (record === undefined) throw new Error(`journal: steward has no definition ${definitionId}`);
    return record;
  }

  task(workId: WorkId, taskId: TaskId): TaskRecord {
    const record = this.work(workId).tasks[taskId];
    if (record === undefined) throw new Error(`journal: task ${taskId} not in ${workId}`);
    return record;
  }

  /** 정의가 materialize 한 회차 Work ID(materialize 순). */
  occurrenceWorkIds(definitionId: WorkDefinitionId): WorkId[] {
    return this.definition(definitionId).materialized.map((m) => m.workId);
  }

  lastCommit(): DomainCommit {
    const last = this.commits[this.commits.length - 1];
    if (last === undefined) throw new Error("journal: no commits");
    return last;
  }

  private takeDefinition(outcome: DefinitionOutcome | DefinitionJudgement): void {
    if ("commit" in outcome && "state" in outcome) {
      this.commits.push(outcome.commit);
      this.state = outcome.state;
    }
  }

  private takeWork(outcome: CommandOutcome | SignalJudgement): void {
    switch (outcome.kind) {
      case "committed":
      case "accepted":
        this.commits.push(outcome.commit);
        this.state = withWork(this.state, outcome.aggregate);
        return;
      case "rejected_stale":
        this.commits.push(outcome.commit);
        return;
      case "stale_after_withdrawal":
        this.commits.push(...outcome.commits);
        this.state = withWork(this.state, outcome.aggregate);
        return;
      default:
        // 기록 전용 커밋은 상태를 바꾸지 않는다 — 이력에만 남긴다.
        this.commits.push(...committedChain(outcome));
    }
  }

  /** 일정 회차 해소 명령. 기본 occurrence 는 현재 대기 행. */
  resolveDue(
    definitionId: WorkDefinitionId,
    now: UtcInstant,
    options: { occurrenceId?: OccurrenceId; late?: boolean; actorSource?: ActorSource } = {},
  ): DefinitionOutcome {
    const occurrenceId =
      options.occurrenceId ?? this.definition(definitionId).pendingSchedule?.occurrenceId;
    if (occurrenceId === undefined) throw new Error("journal: no pending schedule to resolve");
    const outcome = executeDefinitionCommand(this.deps, this.state, {
      kind: "resolve_due_schedule",
      definitionId,
      occurrenceId,
      ...(options.late !== undefined ? { late: options.late } : {}),
      meta: meta(now, options.actorSource ?? "adde_self"),
    });
    this.takeDefinition(outcome);
    return outcome;
  }

  /** 보류 해제 명령. 기본 occurrence 는 가장 오래된 보류. */
  release(
    definitionId: WorkDefinitionId,
    now: UtcInstant,
    options: { occurrenceId?: OccurrenceId } = {},
  ): DefinitionOutcome {
    const occurrenceId =
      options.occurrenceId ?? this.definition(definitionId).held[0]?.occurrenceId;
    if (occurrenceId === undefined) throw new Error("journal: no held occurrence to release");
    const outcome = executeDefinitionCommand(this.deps, this.state, {
      kind: "release_held_occurrence",
      definitionId,
      occurrenceId,
      meta: meta(now),
    });
    this.takeDefinition(outcome);
    return outcome;
  }

  /** 정의 대상 신호(제어·외부). */
  signal(signal: DefinitionControlSignal | ExternalSignal, now: UtcInstant): DefinitionJudgement {
    const judged = judgeDefinitionSignal(this.deps, this.state, signal, now);
    this.takeDefinition(judged);
    return judged;
  }

  /** 정의 제어 — 기대 revision 기본값은 현재 revision. */
  control(
    definitionId: WorkDefinitionId,
    action: "pause" | "resume" | "stop",
    now: UtcInstant,
    options: {
      channel?: ControlChannelSpec;
      actorSource?: ActorSource;
      expectedRevision?: number;
    } = {},
  ): DefinitionJudgement {
    return this.signal(
      controlSignal(this.deps, {
        definitionId,
        expectedRevision: options.expectedRevision ?? this.definition(definitionId).revision,
        action,
        receivedAt: now,
        ...(options.channel !== undefined ? { channel: options.channel } : {}),
        ...(options.actorSource !== undefined ? { actorSource: options.actorSource } : {}),
      }),
      now,
    );
  }

  /** 정의 대상 외부 신호. */
  external(
    definitionId: WorkDefinitionId,
    sourceOccurrenceId: string,
    now: UtcInstant,
    options: { sourceId?: string; signalName?: string; payload?: unknown } = {},
  ): DefinitionJudgement {
    return this.signal(
      externalSignal(this.deps, {
        subject: { definitionId },
        sourceOccurrenceId,
        receivedAt: now,
        ...options,
      }),
      now,
    );
  }

  /** Task 대상 외부 신호. */
  taskExternal(workId: WorkId, signal: ExternalSignal, now: UtcInstant): SignalJudgement {
    const judged = judgeTaskExternalSignal(this.deps, this.work(workId), signal, now);
    this.takeWork(judged);
    return judged;
  }

  /** Work 명령 — 기대 revision·meta 를 현재 Work 에서 채운다. */
  onWork(
    workId: WorkId,
    body: DistributiveOmit<WorkCommand, "expectedRevision" | "meta">,
    now: UtcInstant,
    options: { actorSource?: ActorSource; expectedRevision?: number } = {},
  ): CommandOutcome {
    const before = this.work(workId);
    const outcome = executeCommand(this.deps, before, {
      ...body,
      expectedRevision: options.expectedRevision ?? before.work.revision,
      meta: meta(now, options.actorSource ?? "adde_self"),
    } as WorkCommand);
    this.takeWork(outcome);
    return outcome;
  }

  /** Task 명령 — 기대 revision·meta 를 현재 Task 에서 채운다. */
  onTask(
    workId: WorkId,
    taskId: TaskId,
    body: DistributiveOmit<TaskCommand, "taskId" | "expectedRevision" | "meta">,
    now: UtcInstant,
    options: { actorSource?: ActorSource } = {},
  ): CommandOutcome {
    const before = this.work(workId);
    const outcome = executeCommand(this.deps, before, {
      ...body,
      taskId,
      expectedRevision: this.task(workId, taskId).revision,
      meta: meta(now, options.actorSource ?? "adde_self"),
    } as TaskCommand);
    this.takeWork(outcome);
    return outcome;
  }

  /** Work 대상 결정 신호(재계획 요청·계획 결정 등). */
  onWorkSignal(
    workId: WorkId,
    signal: DecisionSignal,
    application: DecisionApplication,
    now: UtcInstant,
  ): SignalJudgement {
    const judged = judgeSignal(this.deps, this.work(workId), signal, application, now);
    this.takeWork(judged);
    return judged;
  }

  /** 사람 재계획 요청(현재 revision). */
  openReplan(workId: WorkId, now: UtcInstant): SignalJudgement {
    return this.onWorkSignal(
      workId,
      {
        type: "replan_requested",
        workId,
        signalId: nextEntityId(this.deps.ids, "signal"),
        expectedRevision: this.work(workId).work.revision,
        actorSource: "human_local",
        receivedAt: now,
      },
      { kind: "none" },
      now,
    );
  }

  /** 대기 계획 결정에 grant/deny(기본 human_local·현재 revision). */
  decidePlan(
    workId: WorkId,
    choice: "grant" | "deny",
    now: UtcInstant,
    options: { actorSource?: ActorSource; decisionId?: string; expectedRevision?: number } = {},
  ): SignalJudgement {
    const decisionId = options.decisionId ?? this.work(workId).work.pendingDecision?.id;
    if (decisionId === undefined) throw new Error("journal: no pending plan decision");
    return this.onWorkSignal(
      workId,
      {
        type: "human_decision",
        decisionId: decisionId as NonNullable<WorkAggregate["work"]["pendingDecision"]>["id"],
        choice,
        signalId: nextEntityId(this.deps.ids, "signal"),
        expectedRevision: options.expectedRevision ?? this.work(workId).work.revision,
        actorSource: options.actorSource ?? "human_local",
        receivedAt: now,
      },
      choice === "grant" ? { kind: "plan_grant" } : { kind: "plan_deny" },
      now,
    );
  }

  /** 관리 Work 의 현재 member 를 보존하는 재계획 계획 입력. */
  replanBase(
    workId: WorkId,
    options: {
      tasks?: readonly PlanTaskDraft[];
      retain?: readonly TaskId[];
      definition?: unknown;
    } = {},
  ): PlanProposalInput {
    const work = this.work(workId).work;
    return {
      basePlanRevision: work.planRevision,
      source: "planner",
      tasks: options.tasks ?? [],
      retain: options.retain ?? work.memberTaskIds,
      ...(options.definition !== undefined ? { definition: options.definition } : {}),
    };
  }

  /** Work 가 ACTIVE·BLOCKED 면 재계획을 연다(PLANNING 이면 그대로). */
  ensurePlanning(workId: WorkId, now: UtcInstant): void {
    const state = this.work(workId).work.state;
    if (state === "PLANNING") return;
    if (state !== "ACTIVE" && state !== "BLOCKED") {
      throw new Error(`journal: cannot open replan from ${state}`);
    }
    const opened = this.openReplan(workId, now);
    if (opened.kind !== "accepted")
      throw new Error(`journal: replan not accepted (${opened.kind})`);
  }

  propose(workId: WorkId, plan: PlanProposalInput, now: UtcInstant): CommandOutcome {
    return this.onWork(workId, { kind: "propose_plan", plan, summary: "fixture plan" }, now);
  }

  commitPlan(workId: WorkId, plan: PlanProposalInput, now: UtcInstant): CommandOutcome {
    return this.onWork(workId, { kind: "commit_plan", plan }, now);
  }

  /**
   * 개정 제안 — 관리 Work 재계획을 열고(필요하면) 현재 정의 내용에 덮어쓴 초안을 `amends` 와 함께 제안한다.
   * 기대 revision 기본값은 현재 정의 revision.
   */
  proposeAmendment(
    definitionId: WorkDefinitionId,
    overrides: DefinitionDraftInput,
    now: UtcInstant,
    options: { expectedRevision?: number } = {},
  ): CommandOutcome {
    const stewardId = this.steward(definitionId).work.id;
    const current = this.definition(definitionId);
    this.ensurePlanning(stewardId, now);
    const draftContent = definitionDraft({
      title: current.title,
      activation: current.activation,
      template: current.template as readonly PlanTaskDraft[],
      maxOpenOccurrences: current.maxOpenOccurrences,
      ...(current.maxOccurrences !== undefined ? { maxOccurrences: current.maxOccurrences } : {}),
      ...overrides,
      amends: {
        definitionId,
        expectedRevision: options.expectedRevision ?? current.revision,
      },
    });
    return this.propose(stewardId, this.replanBase(stewardId, { definition: draftContent }), now);
  }

  /** 개정 제안 + 사람 grant. grant 판정을 돌려준다. */
  amend(
    definitionId: WorkDefinitionId,
    overrides: DefinitionDraftInput,
    now: UtcInstant,
  ): SignalJudgement {
    const stewardId = this.steward(definitionId).work.id;
    const proposed = this.proposeAmendment(definitionId, overrides, now);
    if (proposed.kind !== "committed" || this.work(stewardId).work.state !== "WAITING_APPROVAL") {
      throw new Error(`journal: amendment proposal did not wait for approval (${proposed.kind})`);
    }
    return this.decidePlan(stewardId, "grant", now);
  }

  /** 회차 Work 를 제어 요청으로 취소한다(출처·meta 출처 `unknown`). */
  cancelWork(workId: WorkId, now: UtcInstant): CommandOutcome {
    return this.onWork(
      workId,
      { kind: "cancel_work", origin: controlRequestOrigin(this.deps) },
      now,
      { actorSource: "unknown" },
    );
  }

  /** 회차 Work 의 Task 를 완료까지 진행한다(즉시 Trigger). */
  completeTask(workId: WorkId, taskId: TaskId, now: UtcInstant): void {
    const step = (body: DistributiveOmit<TaskCommand, "taskId" | "expectedRevision" | "meta">) => {
      const outcome = this.onTask(workId, taskId, body, now);
      if (outcome.kind !== "committed") {
        throw new Error(`journal: ${body.kind} not committed (${JSON.stringify(outcome)})`);
      }
    };
    if (this.task(workId, taskId).state === "DRAFT") step({ kind: "begin_validation" });
    if (this.task(workId, taskId).state === "VALIDATING") step({ kind: "complete_validation" });
    if (this.task(workId, taskId).state === "READY") step({ kind: "start_attempt" });
    const attemptId = this.task(workId, taskId).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("journal: no open attempt");
    step({
      kind: "record_attempt_outcome",
      attemptId,
      outcome: { kind: "completed", evidence: {} },
    });
  }

  /** Work 의 모든 Task 를 완료까지 진행한다. */
  completeWork(workId: WorkId, now: UtcInstant): void {
    for (const taskId of this.work(workId).work.memberTaskIds)
      this.completeTask(workId, taskId, now);
  }

  /** 이 진행기 상태에 markdown 출처 Work 를 만들어 계획 단계로 둔다. */
  createMarkdownWork(now: UtcInstant, documentId = "doc-other"): WorkId {
    const created = createWork(this.deps, {
      kind: "create_work",
      meta: meta(now),
      projectId: mustOk(
        parseProjectId(`prj_${nextEntityId(this.deps.ids, "work").slice("wrk_".length)}`),
      ),
      title: "markdown work",
      objective: "markdown work",
      source: { kind: "markdown", documentId },
    });
    if (created.kind !== "committed") throw new Error("journal: create_work not committed");
    this.commits.push(created.commit);
    this.state = withWork(this.state, created.aggregate);
    const workId = created.aggregate.work.id;
    const planning = this.onWork(workId, { kind: "start_planning" }, now);
    if (planning.kind !== "committed") throw new Error("journal: start_planning not committed");
    return workId;
  }

  /**
   * 레코드 패치 — 명령 경로로 만들 수 없는 기록(구조 무효 입력·미소비 수용 참조 등)을 다른 생성 경로 대용으로
   * 둔다. 커밋 이력에는 남지 않으므로 fold 대조를 하는 시험은 쓰지 않는다.
   */
  patchWork(workId: WorkId, patch: (aggregate: WorkAggregate) => WorkAggregate): void {
    this.state = withWork(this.state, patch(this.work(workId)));
  }

  /** 필수 member 를 검증 실패로 FAILED 에 둔다(구조 무효 입력 레코드 패치 — 검증 실패 경로 대용). */
  failMember(workId: WorkId, taskId: TaskId, now: UtcInstant): void {
    if (this.task(workId, taskId).state === "DRAFT") {
      const begun = this.onTask(workId, taskId, { kind: "begin_validation" }, now);
      if (begun.kind !== "committed") throw new Error(`journal: begin_validation ${begun.kind}`);
    }
    this.patchWork(workId, (aggregate) =>
      patchTask(aggregate, taskId, { input: STRUCTURALLY_INVALID_INPUT }),
    );
    const failed = this.onTask(workId, taskId, { kind: "complete_validation" }, now);
    if (failed.kind !== "committed" || this.task(workId, taskId).state !== "FAILED") {
      throw new Error(`journal: member not failed (${failed.kind})`);
    }
  }

  /** 커밋 이력 전체를 접은 상태(실패면 던진다). */
  folded(): WorkflowState {
    const folded = foldWorkflowEvents(this.commits.flatMap((c) => c.events));
    if (!folded.ok) throw new Error(`journal: fold failed ${JSON.stringify(folded.error)}`);
    return folded.value;
  }
}

// ---- 등록 --------------------------------------------------------------------

export interface Registered {
  readonly journal: WorkflowJournal;
  readonly state: WorkflowState;
  readonly stewardId: WorkId;
  readonly definitionId: WorkDefinitionId;
  readonly commits: readonly DomainCommit[];
  /** 정의 생성 커밋(grant). */
  readonly grant: DomainCommit;
}

/** markdown 출처 Work 를 계획 단계까지 만든다. */
export function markdownWorkInPlanning(
  deps: DomainDeps,
  now: UtcInstant = DEF_NOW,
): { journal: WorkflowJournal; workId: WorkId } {
  const created = createWork(deps, {
    kind: "create_work",
    meta: meta(now),
    projectId: mustOk(parseProjectId(`prj_${nextEntityId(deps.ids, "work").slice("wrk_".length)}`)),
    title: "recurring request",
    objective: "recurring request",
    source: { kind: "markdown", documentId: "doc-recurring" },
  });
  if (created.kind !== "committed") throw new Error("fixture: create_work not committed");
  const journal = new WorkflowJournal(deps, workflowStateOf([created.aggregate]), [created.commit]);
  const workId = created.aggregate.work.id;
  const planning = journal.onWork(workId, { kind: "start_planning" }, now);
  if (planning.kind !== "committed") throw new Error("fixture: start_planning not committed");
  return { journal, workId };
}

/**
 * markdown Work 생성 → 계획 시작 → 정의 초안 제안 → `human_local` grant. 관리 Work 의 자기 계획은
 * `tasks`(기본 빈 계획).
 */
export function registerDefinition(
  deps: DomainDeps,
  options: {
    draft?: Record<string, unknown>;
    now?: UtcInstant;
    tasks?: readonly PlanTaskDraft[];
  } = {},
): Registered {
  const now = options.now ?? DEF_NOW;
  const { journal, workId } = markdownWorkInPlanning(deps, now);
  const proposed = journal.propose(
    workId,
    {
      basePlanRevision: 0,
      source: "planner",
      tasks: options.tasks ?? [],
      retain: [],
      definition: options.draft ?? definitionDraft(),
    },
    now,
  );
  if (proposed.kind !== "committed" || journal.work(workId).work.state !== "WAITING_APPROVAL") {
    throw new Error(
      `fixture: definition proposal did not wait for approval (${JSON.stringify(proposed)})`,
    );
  }
  const granted = journal.decidePlan(workId, "grant", now);
  if (granted.kind !== "accepted") throw new Error(`fixture: definition grant ${granted.kind}`);
  const definitionId = journal.work(workId).definition?.id;
  if (definitionId === undefined) throw new Error("fixture: grant created no definition");
  return {
    journal,
    state: journal.state,
    stewardId: workId,
    definitionId,
    commits: [...journal.commits],
    grant: granted.commit,
  };
}

/** 일일 정의를 등록하고 첫 회차(03-01 07:00Z)를 materialize 한다. */
export function registerAndMaterializeFirst(
  deps: DomainDeps,
  draftContent: Record<string, unknown> = definitionDraft(),
): Registered & { firstWorkId: WorkId } {
  const registered = registerDefinition(deps, { draft: draftContent });
  const outcome = registered.journal.resolveDue(registered.definitionId, dayAt(0));
  if (outcome.kind !== "committed")
    throw new Error(`fixture: first occurrence ${JSON.stringify(outcome)}`);
  const firstWorkId = registered.journal.occurrenceWorkIds(registered.definitionId)[0];
  if (firstWorkId === undefined) throw new Error("fixture: no materialized occurrence work");
  return { ...registered, firstWorkId };
}

/** 회차 Work 의 첫 템플릿 Task. */
export function firstTaskOf(journal: WorkflowJournal, workId: WorkId): TaskId {
  const taskId = journal.work(workId).work.memberTaskIds[0];
  if (taskId === undefined) throw new Error(`fixture: work ${workId} has no member task`);
  return taskId;
}

/** 정의 관련 이벤트만(관리 Work 대상 정의 이벤트 아홉 타입). */
export function definitionEventsIn(commit: DomainCommit): string[] {
  return commit.events
    .map((e) => e.type)
    .filter((t) => (DEFINITION_EVENT_TYPES as readonly string[]).includes(t));
}

/** `sub` 가 `list` 의 부분 순서열인가. */
export function isSubsequence(sub: readonly string[], list: readonly string[]): boolean {
  let i = 0;
  for (const item of list) if (item === sub[i]) i += 1;
  return i === sub.length;
}

// ---- 정의 순회(이벤트·상태 집계용) ----------------------------------------------

export interface DefinitionTour {
  /** 일정 정의 순회와 신호 정의 순회의 진행기. */
  readonly journals: readonly WorkflowJournal[];
  /** 실패한 단계 이름 — 이후 단계는 계속 진행한다. */
  readonly failures: readonly string[];
}

/**
 * 일정 정의: 첫 회차 materialize → 다음 회차 보류(열린 회차 상한) → 첫 회차 완료 → 보류 해제 → 다음 회차 보류
 * → 일시정지 → 재개 → 제목 개정(보류 회차 건너뜀) → 중지. 신호 정의: 외부 신호 수용 → 같은 신호 중복.
 */
export function definitionTour(
  deps: DomainDeps,
  signalDeps: DomainDeps = definitionDeps("toursignal"),
): DefinitionTour {
  const failures: string[] = [];
  const step = (name: string, body: () => unknown): void => {
    try {
      body();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const scheduled = registerAndMaterializeFirst(deps);
  const journal = scheduled.journal;
  const definitionId = scheduled.definitionId;
  step("resolve_day1_held", () => journal.resolveDue(definitionId, dayAt(1)));
  step("complete_first", () => journal.completeWork(scheduled.firstWorkId, dayAt(1, "07:30")));
  step("release_held", () => journal.release(definitionId, dayAt(1, "07:31")));
  step("resolve_day2_held", () => journal.resolveDue(definitionId, dayAt(2)));
  step("pause", () => journal.control(definitionId, "pause", dayAt(2, "08:00")));
  step("resume", () => journal.control(definitionId, "resume", dayAt(2, "09:00")));
  step("amend_title", () =>
    journal.amend(definitionId, { title: "renamed digest" }, dayAt(2, "10:00")),
  );
  step("stop", () => journal.control(definitionId, "stop", dayAt(2, "11:00")));

  const onSignal = registerDefinition(signalDeps, { draft: signalDefinitionDraft() });
  step("external_accept", () =>
    onSignal.journal.external(onSignal.definitionId, "src-occ-1", dayAt(0)),
  );
  step("external_duplicate", () =>
    onSignal.journal.external(onSignal.definitionId, "src-occ-1", dayAt(0, "07:01")),
  );
  return { journals: [journal, onSignal.journal], failures };
}

// ---- 초안 제안 -----------------------------------------------------------------

/** 새 markdown Work 계획 단계에서 정의 초안을 제안한다. */
export function proposeDraft(
  deps: DomainDeps,
  draftContent: unknown,
  options: { tasks?: readonly PlanTaskDraft[]; now?: UtcInstant } = {},
): { journal: WorkflowJournal; workId: WorkId; outcome: CommandOutcome } {
  const now = options.now ?? DEF_NOW;
  const { journal, workId } = markdownWorkInPlanning(deps, now);
  const outcome = journal.propose(
    workId,
    {
      basePlanRevision: 0,
      source: "planner",
      tasks: options.tasks ?? [],
      retain: [],
      definition: draftContent,
    },
    now,
  );
  return { journal, workId, outcome };
}

/** 계획 결과의 `work_plan_invalid` 이슈 — 무효가 아니면 빈 목록. */
export function issuesOf(outcome: CommandOutcome): readonly Record<string, unknown>[] {
  if (outcome.kind !== "committed") throw new Error(`fixture: plan outcome ${outcome.kind}`);
  return outcome.commit.events.some((e) => e.type === "work_plan_invalid")
    ? planInvalidIssues(outcome.commit)
    : [];
}
