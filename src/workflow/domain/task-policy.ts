/**
 * TaskPolicy 와 하위 정책 형태(FR-009) — the workflow contract "TaskPolicy" 필드명 그대로.
 * 본 차수는 형태만 다룬다(확인 채널 검증 규칙·fan-out 평가는 범위 외).
 */
import { type Result, ok, err } from "./result.js";
import { parseUtcInstant } from "./values.js";
import type { UtcInstant } from "./values.js";
import type { ActorRef } from "./values.js";

export type ConfirmationSurface = "markdown" | "out_of_band";

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
  readonly confirmationSurface: ConfirmationSurface;
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

/** `+`/`-` 로 시작하거나 `:` 를 포함하면 거절(오프셋), 그 밖은 `Intl.DateTimeFormat` 이 받아들이면 통과, 원문 보존. */
export function isIanaTimeZone(raw: string): boolean {
  if (raw.length === 0) return false;
  if (raw.startsWith("+") || raw.startsWith("-") || raw.includes(":")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return true;
  } catch {
    return false;
  }
}

const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function isNonNegInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

function isPosInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

function fail(field: string, reason: string): PolicyFormatError {
  return { kind: "policy_format", field, reason };
}

function parseLocalWindow(raw: unknown, field: string): Result<LocalWindow, PolicyFormatError> {
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
  if (typeof timezone !== "string" || !isIanaTimeZone(timezone)) {
    return err(fail(`${field}.timezone`, "not_iana_timezone"));
  }
  return ok({ fromLocal, toLocal, timezone });
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
    const parsed = parseLocalWindow(raw["window"], `${field}.window`);
    if (!parsed.ok) return err(parsed.error);
    window = parsed.value;
  }
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
    const parsed = parseLocalWindow(raw["quietHours"], `${field}.quietHours`);
    if (!parsed.ok) return err(parsed.error);
    quietHours = parsed.value;
  }
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

  const confirmationSurface = raw["confirmationSurface"];
  if (confirmationSurface !== "markdown" && confirmationSurface !== "out_of_band") {
    return err(fail("confirmationSurface", "unknown_value"));
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
  if (typeof timezone !== "string" || timezone.length === 0)
    return err(fail("timezone", "required"));
  if (!isIanaTimeZone(timezone)) return err(fail("timezone", "not_iana_timezone"));

  const maxSpawnDepth = raw["maxSpawnDepth"];
  if (!isNonNegInt(maxSpawnDepth)) return err(fail("maxSpawnDepth", "not_nonnegative_integer"));
  const maxTasksPerWork = raw["maxTasksPerWork"];
  if (!isNonNegInt(maxTasksPerWork)) return err(fail("maxTasksPerWork", "not_nonnegative_integer"));
  const maxWorksPerChain = raw["maxWorksPerChain"];
  if (!isNonNegInt(maxWorksPerChain))
    return err(fail("maxWorksPerChain", "not_nonnegative_integer"));

  return ok({
    policyVersion,
    terminalRequired,
    onDependencyUnsatisfied,
    approvalRequiredBeforeExecute,
    confirmationSurface,
    fanOutMaxConcurrent,
    unattended: unattendedResult.value,
    retry: retryResult.value,
    ...(reminder !== undefined ? { reminder } : {}),
    ...(targetDueAt !== undefined ? { targetDueAt } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(attemptTimeoutMs !== undefined ? { attemptTimeoutMs } : {}),
    timezone,
    maxSpawnDepth,
    maxTasksPerWork,
    maxWorksPerChain,
  });
}
