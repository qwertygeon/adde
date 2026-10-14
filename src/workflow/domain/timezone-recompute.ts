/**
 * 저장된 타임존 재계산 — (현지 날짜, 현지 시각, 타임존) ↔ UTC 시각. 서머타임으로 겹치는 현지 시각은
 * `ambiguous`, 건너뛴 현지 시각은 `nonexistent` 로 돌려주고 어느 쪽 UTC 시각도 고르지 않는다.
 *
 * 오프셋은 `Intl.DateTimeFormat` 이 낸 벽시계 필드에서 구한다. 포맷터의 초 필드는 밀리초를 버리므로
 * 오프셋은 초 단위로 내린 시각에서 계산하고 밀리초는 따로 보존한다. 현지 → UTC 는 현지 시각 전후
 * 하루·당일 세 시점의 오프셋으로 후보를 만들고 왕복이 맞는 후보만 남긴다 — 현지 시각 전후 하루 안에
 * 전환이 둘 이상인 타임존 역사에서는 유효 후보를 놓칠 수 있다. 시스템 타임존과 시계를 읽지 않는다.
 */
import { type Result, ok, err } from "./result.js";
import type { UtcInstant } from "./values.js";
import { parseUtcInstant } from "./values.js";
import type { TimeZoneError } from "./timezone.js";
import { normalizeTimeZoneIdentifier } from "./timezone.js";

export interface LocalDateTime {
  /** `YYYY-MM-DD` */
  readonly localDate: string;
  /** `HH:MM:SS.sss` */
  readonly localTime: string;
}

export type LocalToUtcResult =
  | { readonly kind: "exact"; readonly utc: UtcInstant }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "nonexistent" };

export type RecomputeError =
  | { readonly kind: "timezone"; readonly reason: TimeZoneError["reason"] | "not_normalized" }
  | { readonly kind: "local_date_invalid" }
  | { readonly kind: "local_time_invalid" }
  | { readonly kind: "instant_invalid" };

const DAY_MS = 86_400_000;
const LOCAL_DATE_RE = /^([1-9]\d{3})-(\d{2})-(\d{2})$/;
const LOCAL_TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/** 타임존별 포맷터 — 값은 타임존의 결정적 함수다. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  FORMATTERS.set(timeZone, created);
  return created;
}

interface WallFields {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/** 필드를 UTC 로 본 epoch 밀리초. 0~99 년을 1900 년대로 바꾸는 `Date.UTC` 해석을 피한다. */
function utcEpochOf(fields: WallFields): number {
  const date = new Date(0);
  date.setUTCFullYear(fields.year, fields.month - 1, fields.day);
  date.setUTCHours(fields.hour, fields.minute, fields.second, fields.millisecond);
  return date.getTime();
}

function millisecondPart(epochMs: number): number {
  return ((epochMs % 1000) + 1000) % 1000;
}

function partNumber(parts: readonly Intl.DateTimeFormatPart[], type: string): number {
  const part = parts.find((p) => p.type === type);
  if (part === undefined) {
    throw new Error(`timezone-recompute: 포맷터 출력에 ${type} 필드가 없다`);
  }
  return Number.parseInt(part.value, 10);
}

/** 시각 `epochMs` 에서 타임존의 UTC 오프셋(밀리초, 초 단위 정수배). */
function offsetAt(timeZone: string, epochMs: number): number {
  const wholeSecond = epochMs - millisecondPart(epochMs);
  const parts = formatterOf(timeZone).formatToParts(new Date(wholeSecond));
  const wall = utcEpochOf({
    year: partNumber(parts, "year"),
    month: partNumber(parts, "month"),
    day: partNumber(parts, "day"),
    hour: partNumber(parts, "hour"),
    minute: partNumber(parts, "minute"),
    second: partNumber(parts, "second"),
    millisecond: 0,
  });
  return wall - wholeSecond;
}

/** 정규형 타임존만 받는다 — 표기만 다른 이름도 정규형과 다르면 거절한다. */
function checkTimeZone(timeZone: string): Result<string, RecomputeError> {
  const normalized = normalizeTimeZoneIdentifier(timeZone);
  if (!normalized.ok) return err({ kind: "timezone", reason: normalized.error.reason });
  if (normalized.value !== timeZone) return err({ kind: "timezone", reason: "not_normalized" });
  return ok(timeZone);
}

function parseLocalDate(
  localDate: string,
): { readonly year: number; readonly month: number; readonly day: number } | undefined {
  const match = LOCAL_DATE_RE.exec(localDate);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return undefined;
  const probe = new Date(
    utcEpochOf({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 }),
  );
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() + 1 !== month ||
    probe.getUTCDate() !== day
  ) {
    return undefined;
  }
  return { year, month, day };
}

function parseLocalTime(localTime: string):
  | {
      readonly hour: number;
      readonly minute: number;
      readonly second: number;
      readonly millisecond: number;
    }
  | undefined {
  const match = LOCAL_TIME_RE.exec(localTime);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  const millisecond = match[4] === undefined ? 0 : Number(match[4].padEnd(3, "0"));
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return { hour, minute, second, millisecond };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function localToUtc(input: {
  readonly localDate: string;
  readonly localTime: string;
  readonly timeZone: string;
}): Result<LocalToUtcResult, RecomputeError> {
  const timeZone = checkTimeZone(input.timeZone);
  if (!timeZone.ok) return timeZone;
  const date = parseLocalDate(input.localDate);
  if (date === undefined) return err({ kind: "local_date_invalid" });
  const time = parseLocalTime(input.localTime);
  if (time === undefined) return err({ kind: "local_time_invalid" });

  const localAsUtc = utcEpochOf({ ...date, ...time });
  const candidates = new Set<number>();
  for (const probe of [localAsUtc - DAY_MS, localAsUtc, localAsUtc + DAY_MS]) {
    candidates.add(localAsUtc - offsetAt(timeZone.value, probe));
  }
  const valid = [...candidates].filter(
    (candidate) => candidate + offsetAt(timeZone.value, candidate) === localAsUtc,
  );
  if (valid.length === 0) return ok({ kind: "nonexistent" });
  if (valid.length >= 2) return ok({ kind: "ambiguous" });
  return ok({ kind: "exact", utc: new Date(valid[0] as number).toISOString() as UtcInstant });
}

export function utcToLocal(
  instant: string,
  timeZone: string,
): Result<LocalDateTime, RecomputeError> {
  const zone = checkTimeZone(timeZone);
  if (!zone.ok) return zone;
  const parsed = parseUtcInstant(instant);
  if (!parsed.ok) return err({ kind: "instant_invalid" });
  const epochMs = Date.parse(parsed.value);
  const wall = new Date(epochMs + offsetAt(zone.value, epochMs));
  return ok({
    localDate: `${pad(wall.getUTCFullYear(), 4)}-${pad(wall.getUTCMonth() + 1, 2)}-${pad(wall.getUTCDate(), 2)}`,
    localTime: `${pad(wall.getUTCHours(), 2)}:${pad(wall.getUTCMinutes(), 2)}:${pad(wall.getUTCSeconds(), 2)}.${pad(wall.getUTCMilliseconds(), 3)}`,
  });
}
