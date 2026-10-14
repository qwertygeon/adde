// property: 시간대 재계산 왕복.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { localToUtc, utcToLocal } from "../../../../src/workflow/domain/index.js";

const ZONES = ["America/New_York", "Australia/Sydney", "Europe/London", "Asia/Seoul"] as const;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

const localDate = fc
  .integer({ min: Date.UTC(1900, 0, 1) / 86_400_000, max: Date.UTC(2100, 11, 31) / 86_400_000 })
  .map((day) => new Date(day * 86_400_000).toISOString().slice(0, 10));
const localTime = fc
  .tuple(
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 999 }),
  )
  .map(([h, m, s, ms]) => `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`);
const instant = fc
  .integer({ min: Date.UTC(1900, 0, 2), max: Date.UTC(2100, 11, 30) })
  .map((ms) => new Date(ms).toISOString());

describe("시간대 재계산 — property: exact 왕복·모호/없는 시각의 UTC 없음", () => {
  it("현지 → UTC 가 exact 면 왕복이 같고 ambiguous·nonexistent 면 UTC 가 없다 (test_SC063_property_local_to_utc_roundtrip)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ZONES), localDate, localTime, (timeZone, date, time) => {
        const result = localToUtc({ localDate: date, localTime: time, timeZone });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        if (result.value.kind === "exact") {
          expect(utcToLocal(result.value.utc, timeZone)).toEqual({
            ok: true,
            value: { localDate: date, localTime: time },
          });
        } else {
          expect(Object.hasOwn(result.value, "utc")).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("UTC → 현지 → UTC 는 원래 시각(밀리초 포함)이거나 ambiguous 다 (test_SC063_property_utc_to_local_roundtrip)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ZONES), instant, (timeZone, utc) => {
        const local = utcToLocal(utc, timeZone);
        expect(local.ok).toBe(true);
        if (!local.ok) return;
        const back = localToUtc({ ...local.value, timeZone });
        expect(back.ok).toBe(true);
        if (!back.ok) return;
        if (back.value.kind === "exact") expect(back.value.utc).toBe(utc);
        else expect(back.value.kind).toBe("ambiguous");
      }),
      { numRuns: 500 },
    );
  });
});
