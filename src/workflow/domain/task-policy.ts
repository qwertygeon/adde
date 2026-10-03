/**
 * TaskPolicy 와 하위 정책 형태 — the workflow contract "TaskPolicy" 필드명 그대로. 수기 파서는 형태만
 * 검사하고, 각 객체 층위에서 전사된 필드 표 밖의 키는 거절한다(옛 이름이 조용히 무시되지 않게).
 * 승인 채널 판정·정책 평가는 `policy/**` 가 맡는다.
 */
import { type Result, ok, err } from "./result.js";
import { parseUtcInstant } from "./values.js";
import type { UtcInstant } from "./values.js";
import type { ActorRef } from "./values.js";
import { APPROVAL_SURFACE_VALUES, TASK_POLICY_FIELD_SHAPES } from "./contract/index.js";
import { normalizeTimeZoneIdentifier } from "./timezone.js";

export type ApprovalSurface = (typeof APPROVAL_SURFACE_VALUES)[number];

export interface ToolScopeRef {
  readonly id: string;
  readonly configRef: string;
  readonly approvedAt: UtcInstant;
  readonly approvedBy: ActorRef;
}

export interface LocalWindow {
  readonly fromLocal: string;
  readonly toLocal: string;
  readonly timezone: string;
}

export interface UnattendedPolicy {
  readonly eligible: boolean;
  readonly toolScope?: ToolScopeRef;
  readonly window?: LocalWindow;
  readonly onGateDenied: "block_awaiting_human";
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoff: "fixed" | "exponential";
  readonly retryableErrors?: readonly string[];
  readonly jitterMs?: number;
}

export interface ReminderPolicy {
  readonly intervalMs: number;
  readonly maxOccurrences: number;
  readonly quietHours?: LocalWindow;
}

export interface TaskPolicy {
  readonly policyVersion: number;
  readonly terminalRequired: boolean;
  readonly onDependencyUnsatisfied: "block" | "skip" | "fail";
  readonly approvalRequiredBeforeExecute: boolean;
  readonly approvalSurface: ApprovalSurface;
  readonly fanOutMaxConcurrent: number;
  readonly unattended: UnattendedPolicy;
  readonly retry: RetryPolicy;
  readonly reminder?: ReminderPolicy;
  readonly targetDueAt?: UtcInstant;
  readonly expiresAt?: UtcInstant;
  readonly attemptTimeoutMs?: number;
  readonly timezone: string;
  readonly maxSpawnDepth: number;
  readonly maxTasksPerWork: number;
  readonly maxWorksPerChain: number;
}

export interface PolicyFormatError {
  readonly kind: "policy_format";
  readonly field: string;
  readonly reason: string;
}

const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function isApprovalSurface(raw: unknown): raw is ApprovalSurface {
  return typeof raw === "string" && (APPROVAL_SURFACE_VALUES as readonly string[]).includes(raw);
}

function isPosInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

function fail(field: string, reason: string): PolicyFormatError {
  return { kind: "policy_format", field, reason };
}

const ALLOWED_KEYS_BY_SHAPE: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  TASK_POLICY_FIELD_SHAPES.map((entry) => [
    entry.shape,
    new Set(entry.fields.map((f) => f.name)) as ReadonlySet<string>,
  ]),
);

/** 필드 형태 검사 뒤에 부른다 — 옛 이름만 있으면 새 필드 누락이 먼저 드러난다. */
function rejectUnknownKeys(
  raw: Record<string, unknown>,
  shape: string,
  field: string | undefined,
): PolicyFormatError | undefined {
  const allowed = ALLOWED_KEYS_BY_SHAPE.get(shape);
  if (allowed === undefined) throw new Error(`전사 필드 표에 없는 정책 형태: ${shape}`);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return fail(field === undefined ? key : `${field}.${key}`, "unknown_field");
    }
  }
  return undefined;
}

function normalizeTimeZoneField(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = normalizeTimeZoneIdentifier(raw);
  return normalized.ok ? normalized.value : undefined;
}

function parseLocalWindow(
  raw: unknown,
  field: string,
  shape: string,
): Result<LocalWindow, PolicyFormatError> {
  if (!isPlainObject(raw)) return err(fail(field, "not_an_object"));
  const fromLocal = raw["fromLocal"];
  const toLocal = raw["toLocal"];
  const timezone = raw["timezone"];
  if (typeof fromLocal !== "string" || !HH_MM_RE.test(fromLocal)) {
    return err(fail(`${field}.fromLocal`, "not_hh_mm"));
  }
  if (typeof toLocal !== "string" || !HH_MM_RE.test(toLocal)) {
    return err(fail(`${field}.toLocal`, "not_hh_mm"));
  }
  const normalizedTimeZone = normalizeTimeZoneField(timezone);
  if (normalizedTimeZone === undefined) {
    return err(fail(`${field}.timezone`, "not_iana_timezone"));
  }
  const unknown = rejectUnknownKeys(raw, shape, field);
  if (unknown !== undefined) return err(unknown);
  return ok({ fromLocal, toLocal, timezone: normalizedTimeZone });
}

function parseToolScopeRef(raw: unknown, field: string): Result<ToolScopeRef, PolicyFormatError> {
  if (!isPlainObject(raw)) return err(fail(field, "not_an_object"));
  const id = raw["id"];
  const configRef = raw["configRef"];
  const approvedAt = raw["approvedAt"];
  const approvedBy = raw["approvedBy"];
  if (typeof id !== "string") return err(fail(`${field}.id`, "not_a_string"));
  if (typeof configRef !== "string") return err(fail(`${field}.configRef`, "not_a_string"));
  if (typeof approvedAt !== "string") return err(fail(`${field}.approvedAt`, "not_a_string"));
  const parsedAt = parseUtcInstant(approvedAt);
  if (!parsedAt.ok) return err(fail(`${field}.approvedAt`, "not_utc_instant"));
  if (!isPlainObject(approvedBy)) return err(fail(`${field}.approvedBy`, "not_an_object"));
  const unknown = rejectUnknownKeys(raw, "ToolScopeRef", field);
  if (unknown !== undefined) return err(unknown);
  return ok({
    id,
    configRef,
    approvedAt: parsedAt.value,
    approvedBy: approvedBy as unknown as ActorRef,
  });
}

function parseUnattendedPolicy(
  raw: unknown,
  field: string,
): Result<UnattendedPolicy, PolicyFormatError> {
  if (!isPlainObject(raw)) return err(fail(field, "not_an_object"));
  const eligible = raw["eligible"];
  if (typeof eligible !== "boolean") return err(fail(`${field}.eligible`, "not_a_boolean"));
  const onGateDenied = raw["onGateDenied"];
  if (onGateDenied !== "block_awaiting_human") {
    return err(fail(`${field}.onGateDenied`, "must_be_block_awaiting_human"));
  }
  let toolScope: ToolScopeRef | undefined;
  if (raw["toolScope"] !== undefined) {
    const parsed = parseToolScopeRef(raw["toolScope"], `${field}.toolScope`);
    if (!parsed.ok) return err(parsed.error);
    toolScope = parsed.value;
  }
  let window: LocalWindow | undefined;
  if (raw["window"] !== undefined) {
    const parsed = parseLocalWindow(raw["window"], `${field}.window`, "UnattendedPolicy.window");
    if (!parsed.ok) return err(parsed.error);
    window = parsed.value;
  }
  const unknown = rejectUnknownKeys(raw, "UnattendedPolicy", field);
  if (unknown !== undefined) return err(unknown);
  return ok({
    eligible,
    onGateDenied,
    ...(toolScope !== undefined ? { toolScope } : {}),
    ...(window !== undefined ? { window } : {}),
  });
}

function parseRetryPolicy(raw: unknown, field: string): Result<RetryPolicy, PolicyFormatError> {
  if (!isPlainObject(raw)) return err(fail(field, "not_an_object"));
  const maxAttempts = raw["maxAttempts"];
  const initialDelayMs = raw["initialDelayMs"];
  const maxDelayMs = raw["maxDelayMs"];
  const backoff = raw["backoff"];
  if (!isPosInt(maxAttempts)) return err(fail(`${field}.maxAttempts`, "not_positive_integer"));
  if (!isNonNegInt(initialDelayMs))
    return err(fail(`${field}.initialDelayMs`, "not_nonnegative_integer"));
  if (!isNonNegInt(maxDelayMs)) return err(fail(`${field}.maxDelayMs`, "not_nonnegative_integer"));
  if (backoff !== "fixed" && backoff !== "exponential")
    return err(fail(`${field}.backoff`, "unknown_backoff"));
  let retryableErrors: readonly string[] | undefined;
  if (raw["retryableErrors"] !== undefined) {
    const rawErrors = raw["retryableErrors"];
    if (!Array.isArray(rawErrors) || !rawErrors.every((e) => typeof e === "string")) {
      return err(fail(`${field}.retryableErrors`, "not_a_string_array"));
    }
    retryableErrors = rawErrors;
  }
  let jitterMs: number | undefined;
  if (raw["jitterMs"] !== undefined) {
    if (!isNonNegInt(raw["jitterMs"]))
      return err(fail(`${field}.jitterMs`, "not_nonnegative_integer"));
    jitterMs = raw["jitterMs"];
  }
  const unknown = rejectUnknownKeys(raw, "RetryPolicy", field);
  if (unknown !== undefined) return err(unknown);
  return ok({
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoff,
    ...(retryableErrors !== undefined ? { retryableErrors } : {}),
    ...(jitterMs !== undefined ? { jitterMs } : {}),
  });
}

function parseReminderPolicy(
  raw: unknown,
  field: string,
): Result<ReminderPolicy, PolicyFormatError> {
  if (!isPlainObject(raw)) return err(fail(field, "not_an_object"));
  const intervalMs = raw["intervalMs"];
  const maxOccurrences = raw["maxOccurrences"];
  if (!isPosInt(intervalMs)) return err(fail(`${field}.intervalMs`, "not_positive_integer"));
  if (!isNonNegInt(maxOccurrences))
    return err(fail(`${field}.maxOccurrences`, "not_nonnegative_integer"));
  let quietHours: LocalWindow | undefined;
  if (raw["quietHours"] !== undefined) {
    const parsed = parseLocalWindow(
      raw["quietHours"],
      `${field}.quietHours`,
      "ReminderPolicy.quietHours",
    );
    if (!parsed.ok) return err(parsed.error);
    quietHours = parsed.value;
  }
  const unknown = rejectUnknownKeys(raw, "ReminderPolicy", field);
  if (unknown !== undefined) return err(unknown);
  return ok({ intervalMs, maxOccurrences, ...(quietHours !== undefined ? { quietHours } : {}) });
}

export function parseTaskPolicy(raw: unknown): Result<TaskPolicy, PolicyFormatError> {
  if (!isPlainObject(raw)) return err(fail("policy", "not_an_object"));

  const policyVersion = raw["policyVersion"];
  if (!isPosInt(policyVersion)) return err(fail("policyVersion", "not_positive_integer"));

  const terminalRequired = raw["terminalRequired"];
  if (typeof terminalRequired !== "boolean") return err(fail("terminalRequired", "not_a_boolean"));

  const onDependencyUnsatisfied = raw["onDependencyUnsatisfied"];
  if (
    onDependencyUnsatisfied !== "block" &&
    onDependencyUnsatisfied !== "skip" &&
    onDependencyUnsatisfied !== "fail"
  ) {
    return err(fail("onDependencyUnsatisfied", "unknown_value"));
  }

  const approvalRequiredBeforeExecute = raw["approvalRequiredBeforeExecute"];
  if (typeof approvalRequiredBeforeExecute !== "boolean") {
    return err(fail("approvalRequiredBeforeExecute", "not_a_boolean"));
  }

  const approvalSurface = raw["approvalSurface"];
  if (!isApprovalSurface(approvalSurface)) {
    return err(fail("approvalSurface", "unknown_value"));
  }

  const fanOutMaxConcurrent = raw["fanOutMaxConcurrent"];
  if (!isPosInt(fanOutMaxConcurrent))
    return err(fail("fanOutMaxConcurrent", "not_positive_integer"));

  const unattendedResult = parseUnattendedPolicy(raw["unattended"], "unattended");
  if (!unattendedResult.ok) return err(unattendedResult.error);

  const retryResult = parseRetryPolicy(raw["retry"], "retry");
  if (!retryResult.ok) return err(retryResult.error);

  let reminder: ReminderPolicy | undefined;
  if (raw["reminder"] !== undefined) {
    const parsed = parseReminderPolicy(raw["reminder"], "reminder");
    if (!parsed.ok) return err(parsed.error);
    reminder = parsed.value;
  }

  let targetDueAt: UtcInstant | undefined;
  if (raw["targetDueAt"] !== undefined) {
    if (typeof raw["targetDueAt"] !== "string") return err(fail("targetDueAt", "not_a_string"));
    const parsed = parseUtcInstant(raw["targetDueAt"]);
    if (!parsed.ok) return err(fail("targetDueAt", "not_utc_instant"));
    targetDueAt = parsed.value;
  }
  let expiresAt: UtcInstant | undefined;
  if (raw["expiresAt"] !== undefined) {
    if (typeof raw["expiresAt"] !== "string") return err(fail("expiresAt", "not_a_string"));
    const parsed = parseUtcInstant(raw["expiresAt"]);
    if (!parsed.ok) return err(fail("expiresAt", "not_utc_instant"));
    expiresAt = parsed.value;
  }
  let attemptTimeoutMs: number | undefined;
  if (raw["attemptTimeoutMs"] !== undefined) {
    if (!isPosInt(raw["attemptTimeoutMs"]))
      return err(fail("attemptTimeoutMs", "not_positive_integer"));
    attemptTimeoutMs = raw["attemptTimeoutMs"];
  }

  const timezone = raw["timezone"];
  if (typeof timezone !== "string") return err(fail("timezone", "required"));
  const normalizedTimeZone = normalizeTimeZoneField(timezone);
  if (normalizedTimeZone === undefined) return err(fail("timezone", "not_iana_timezone"));

  const maxSpawnDepth = raw["maxSpawnDepth"];
  if (!isNonNegInt(maxSpawnDepth)) return err(fail("maxSpawnDepth", "not_nonnegative_integer"));
  const maxTasksPerWork = raw["maxTasksPerWork"];
  if (!isNonNegInt(maxTasksPerWork)) return err(fail("maxTasksPerWork", "not_nonnegative_integer"));
  const maxWorksPerChain = raw["maxWorksPerChain"];
  if (!isNonNegInt(maxWorksPerChain))
    return err(fail("maxWorksPerChain", "not_nonnegative_integer"));

  const unknown = rejectUnknownKeys(raw, "TaskPolicy", undefined);
  if (unknown !== undefined) return err(unknown);

  return ok({
    policyVersion,
    terminalRequired,
    onDependencyUnsatisfied,
    approvalRequiredBeforeExecute,
    approvalSurface,
    fanOutMaxConcurrent,
    unattended: unattendedResult.value,
    retry: retryResult.value,
    ...(reminder !== undefined ? { reminder } : {}),
    ...(targetDueAt !== undefined ? { targetDueAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(attemptTimeoutMs !== undefined ? { attemptTimeoutMs } : {}),
    timezone: normalizedTimeZone,
    maxSpawnDepth,
    maxTasksPerWork,
    maxWorksPerChain,
  });
}
