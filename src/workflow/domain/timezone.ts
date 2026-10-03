/**
 * 타임존 식별자 정규화 — the workflow contract "Timezone identifiers": IANA 이름은 대소문자만 표기로
 * 맞추고 링크 이름은 링크 그대로 둔다. 런타임(`Intl`)이 받지 않는 이름은 거절한다.
 */
import { type Result, ok, err } from "./result.js";
import { IANA_TIME_ZONE_NAMES } from "./timezone-names.js";

export interface TimeZoneError {
  readonly kind: "timezone";
  readonly reason: "empty" | "offset_not_allowed" | "not_accepted_by_runtime";
}

/** `Intl` 해석 결과는 링크를 대상 이름으로 바꾸므로 철자의 출처로 쓰지 않는다 — 소문자 사전이 철자를 정한다. */
const CANONICAL_BY_LOWERCASE: ReadonlyMap<string, string> = new Map(
  IANA_TIME_ZONE_NAMES.map((name) => [name.toLowerCase(), name]),
);

function isAcceptedByRuntime(raw: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return true;
  } catch {
    return false;
  }
}

/** 사전에 없지만 런타임이 받는 이름(데이터 판 이후 추가)은 작성값 그대로 돌려준다. */
export function normalizeTimeZoneIdentifier(raw: string): Result<string, TimeZoneError> {
  if (raw.length === 0) return err({ kind: "timezone", reason: "empty" });
  if (raw.startsWith("+") || raw.startsWith("-") || raw.includes(":")) {
    return err({ kind: "timezone", reason: "offset_not_allowed" });
  }
  if (!isAcceptedByRuntime(raw))
    return err({ kind: "timezone", reason: "not_accepted_by_runtime" });
  return ok(CANONICAL_BY_LOWERCASE.get(raw.toLowerCase()) ?? raw);
}
