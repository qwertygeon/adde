// 저장된 타임존의 현지 시각 재계산: 서머타임 전환 전후 유지·모호/없는 시각·결정성·프로세스 TZ 무관.
// 기대값은 tz 데이터베이스 규칙에서 손으로 계산한 리터럴이다(구현 계산을 쓰지 않는다).
import { isMainThread } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { localToUtc, utcToLocal } from "../../../src/workflow/domain/index.js";
import type { WorkDefinitionId } from "../../../src/workflow/domain/index.js";
import {
  dailyActivation,
  definitionDeps,
  definitionDraft,
  registerDefinition,
} from "./helpers/definition-fixtures.js";
import { at } from "./helpers/fixtures.js";

function exact(localDate: string, localTime: string, timeZone: string): string {
  const result = localToUtc({ localDate, localTime, timeZone });
  if (!result.ok || result.value.kind !== "exact") {
    throw new Error(
      `expected exact for ${localDate} ${localTime} ${timeZone}: ${JSON.stringify(result)}`,
    );
  }
  return result.value.utc;
}

function kindOf(localDate: string, localTime: string, timeZone: string): string {
  const result = localToUtc({ localDate, localTime, timeZone });
  return result.ok ? result.value.kind : `error:${JSON.stringify(result.error)}`;
}

const HOUR = 3_600_000;

/** [현지 날짜, 현지 시각, 타임존, 기대 UTC] — 전환 전날·당일. */
const TRANSITION_ROWS: Readonly<Record<string, readonly [string, string, string, string][]>> = {
  "New York spring": [
    ["2026-03-07", "07:00", "America/New_York", "2026-03-07T12:00:00.000Z"],
    ["2026-03-08", "07:00", "America/New_York", "2026-03-08T11:00:00.000Z"],
    ["2026-03-07", "09:00", "America/New_York", "2026-03-07T14:00:00.000Z"],
    ["2026-03-08", "09:00", "America/New_York", "2026-03-08T13:00:00.000Z"],
  ],
  "New York fall": [
    ["2026-10-31", "07:00", "America/New_York", "2026-10-31T11:00:00.000Z"],
    ["2026-11-01", "07:00", "America/New_York", "2026-11-01T12:00:00.000Z"],
    ["2026-10-31", "09:00", "America/New_York", "2026-10-31T13:00:00.000Z"],
    ["2026-11-01", "09:00", "America/New_York", "2026-11-01T14:00:00.000Z"],
  ],
  "Sydney autumn": [
    ["2026-04-04", "07:00", "Australia/Sydney", "2026-04-03T20:00:00.000Z"],
    ["2026-04-05", "07:00", "Australia/Sydney", "2026-04-04T21:00:00.000Z"],
    ["2026-04-04", "09:00", "Australia/Sydney", "2026-04-03T22:00:00.000Z"],
    ["2026-04-05", "09:00", "Australia/Sydney", "2026-04-04T23:00:00.000Z"],
  ],
  "Sydney spring": [
    ["2026-10-03", "07:00", "Australia/Sydney", "2026-10-02T21:00:00.000Z"],
    ["2026-10-04", "07:00", "Australia/Sydney", "2026-10-03T20:00:00.000Z"],
    ["2026-10-03", "09:00", "Australia/Sydney", "2026-10-02T23:00:00.000Z"],
    ["2026-10-04", "09:00", "Australia/Sydney", "2026-10-03T22:00:00.000Z"],
  ],
  "London spring": [
    ["2026-03-28", "07:00", "Europe/London", "2026-03-28T07:00:00.000Z"],
    ["2026-03-29", "07:00", "Europe/London", "2026-03-29T06:00:00.000Z"],
  ],
  "London autumn": [
    ["2026-10-24", "07:00", "Europe/London", "2026-10-24T06:00:00.000Z"],
    ["2026-10-25", "07:00", "Europe/London", "2026-10-25T07:00:00.000Z"],
  ],
};

function checkTransitions(groups: readonly string[]): void {
  for (const group of groups) {
    const rows = TRANSITION_ROWS[group] ?? [];
    for (const [localDate, localTime, timeZone, utc] of rows) {
      expect(exact(localDate, localTime, timeZone), `${group} ${localDate} ${localTime}`).toBe(utc);
      expect(utcToLocal(utc, timeZone), `${group} roundtrip`).toEqual({
        ok: true,
        value: { localDate, localTime: `${localTime}:00.000` },
      });
    }
    // 같은 현지 시각의 전날·당일 차는 24h ± 1h 다.
    const [before, after] = [rows[0], rows[1]];
    if (before !== undefined && after !== undefined) {
      const diff = Date.parse(after[3]) - Date.parse(before[3]);
      expect([23 * HOUR, 25 * HOUR], group).toContain(diff);
    }
  }
}

describe("SC-052: 서머타임 전환을 건너도 현지 시각이 유지된다", () => {
  it("Happy: New York·Sydney 의 두 전환 전후 07:00·09:00 이 현지 시각을 유지하고 왕복이 같다 (test_SC052_north_south_dst_local_time_kept)", () => {
    checkTransitions(["New York spring", "New York fall", "Sydney autumn", "Sydney spring"]);
  });

  it("Edge: London 도 같다 (test_SC052_london_dst_local_time_kept)", () => {
    checkTransitions(["London spring", "London autumn"]);
  });

  it("Error: 달력 무효·형식 무효 입력은 거절된다 (test_SC052_invalid_local_date_time_refused)", () => {
    expect(
      localToUtc({ localDate: "2026-02-30", localTime: "07:00", timeZone: "Asia/Seoul" }),
    ).toEqual({
      ok: false,
      error: { kind: "local_date_invalid" },
    });
    expect(
      localToUtc({ localDate: "2026-2-3", localTime: "07:00", timeZone: "Asia/Seoul" }),
    ).toEqual({
      ok: false,
      error: { kind: "local_date_invalid" },
    });
    expect(
      localToUtc({ localDate: "2026-03-01", localTime: "24:00", timeZone: "Asia/Seoul" }),
    ).toEqual({
      ok: false,
      error: { kind: "local_time_invalid" },
    });
    expect(utcToLocal("2026-03-01 07:00", "Asia/Seoul")).toEqual({
      ok: false,
      error: { kind: "instant_invalid" },
    });
    // 대조: 같은 날짜의 유효 입력은 정확한 시각이다.
    expect(exact("2026-02-28", "07:00", "Asia/Seoul")).toBe("2026-02-27T22:00:00.000Z");
  });
});

describe("SC-053: 모호·없는 현지 시각은 UTC 를 내지 않는다", () => {
  it("Happy: New York 가을 01:30 은 ambiguous, 봄 02:30 은 nonexistent 다 (test_SC053_new_york_ambiguous_and_nonexistent)", () => {
    expect(
      localToUtc({ localDate: "2026-11-01", localTime: "01:30", timeZone: "America/New_York" }),
    ).toEqual({
      ok: true,
      value: { kind: "ambiguous" },
    });
    expect(
      localToUtc({ localDate: "2026-03-08", localTime: "02:30", timeZone: "America/New_York" }),
    ).toEqual({
      ok: true,
      value: { kind: "nonexistent" },
    });
  });

  it("Edge: Sydney 도 같다 (test_SC053_sydney_ambiguous_and_nonexistent)", () => {
    expect(kindOf("2026-04-05", "02:30", "Australia/Sydney")).toBe("ambiguous");
    expect(kindOf("2026-10-04", "02:30", "Australia/Sydney")).toBe("nonexistent");
  });

  it("Error: 간격 경계 바로 밖은 exact 이고 밀리초를 보존한다 (test_SC053_gap_boundaries_exact)", () => {
    expect(exact("2026-03-08", "01:59:59.999", "America/New_York")).toBe(
      "2026-03-08T06:59:59.999Z",
    );
    expect(exact("2026-03-08", "03:00", "America/New_York")).toBe("2026-03-08T07:00:00.000Z");
  });

  it("Edge: 밀리초가 있는 시각도 모호·없는 시각을 가리고 연도 1000 대 왕복에서 밀리초가 보존된다 (test_SC053_milliseconds_kept_in_ambiguous_gap_and_roundtrip)", () => {
    expect(kindOf("2026-11-01", "01:30:00.500", "America/New_York")).toBe("ambiguous");
    expect(kindOf("2026-03-08", "02:00:00.001", "America/New_York")).toBe("nonexistent");
    for (const timeZone of ["Europe/London", "America/New_York"]) {
      const instant = "1000-06-15T12:34:56.789Z";
      const local = utcToLocal(instant, timeZone);
      expect(local.ok, timeZone).toBe(true);
      if (!local.ok) continue;
      expect(local.value.localTime.endsWith(".789"), timeZone).toBe(true);
      const back = localToUtc({
        localDate: local.value.localDate,
        localTime: local.value.localTime,
        timeZone,
      });
      expect(back, timeZone).toEqual({ ok: true, value: { kind: "exact", utc: instant } });
    }
  });
});

describe("SC-054: 재계산·파생은 결정적이다", () => {
  /** 서머타임 시작을 건너는 New York 07:00 일일 정의의 세 회차를 해소한다. */
  function nyRun(seed: string, extraIds = 0) {
    const anchor = at("2026-03-07T12:00:00Z");
    const registered = registerDefinition(definitionDeps(seed), {
      draft: definitionDraft({
        maxOpenOccurrences: 3,
        activation: dailyActivation({ timezone: "America/New_York", anchorUtc: anchor }),
      }),
    });
    const { journal, definitionId } = registered;
    for (let i = 0; i < extraIds; i += 1) journal.deps.ids.next("work");
    const instants: string[] = [];
    for (const due of ["2026-03-07T12:00:00Z", "2026-03-08T11:00:00Z", "2026-03-09T11:00:00Z"]) {
      const pending = journal.definition(definitionId).pendingSchedule;
      instants.push(pending?.scheduledForUtc ?? "none");
      const outcome = journal.resolveDue(definitionId, at(due));
      if (outcome.kind !== "committed")
        throw new Error(`resolve ${due}: ${JSON.stringify(outcome)}`);
    }
    const materialized = journal.definition(definitionId).materialized;
    return {
      definitionId: definitionId as WorkDefinitionId,
      instants,
      occurrenceIds: materialized.map((m) => m.occurrenceId),
      workIds: materialized.map((m) => m.workId),
    };
  }

  it("Happy: 전환을 건너는 일일 회차를 두 번 처음부터 계산하면 UTC·occurrence ID 가 같다 (test_SC054_two_runs_same_instants_and_ids)", () => {
    const first = nyRun("tz054");
    expect(first.instants).toEqual([
      "2026-03-07T12:00:00.000Z",
      "2026-03-08T11:00:00.000Z",
      "2026-03-09T11:00:00.000Z",
    ]);
    expect(nyRun("tz054")).toEqual(first);
  });

  it("Edge: 생성 ID 가 달라도 occurrence ID 는 같다 (test_SC054_id_seed_independent)", () => {
    const plain = nyRun("tz054e");
    const shifted = nyRun("tz054e", 3);
    expect(shifted.definitionId).toBe(plain.definitionId);
    expect(shifted.workIds).not.toEqual(plain.workIds);
    expect(shifted.occurrenceIds).toEqual(plain.occurrenceIds);
  });

  it("Error: 정의 ID 가 다르면 occurrence ID 가 다르다 (test_SC054_other_definition_other_ids)", () => {
    const a = nyRun("tz054a");
    const b = nyRun("tz054b");
    expect(a.definitionId).not.toBe(b.definitionId);
    expect(a.instants).toEqual(b.instants);
    for (let i = 0; i < a.occurrenceIds.length; i += 1)
      expect(a.occurrenceIds[i]).not.toBe(b.occurrenceIds[i]);
  });
});

describe("SC-055: 결과는 프로세스 타임존과 무관하다", () => {
  const SAMPLES = [
    () => localToUtc({ localDate: "2026-03-08", localTime: "07:00", timeZone: "America/New_York" }),
    () => localToUtc({ localDate: "2026-11-01", localTime: "01:30", timeZone: "America/New_York" }),
    () => localToUtc({ localDate: "2026-04-05", localTime: "07:00", timeZone: "Australia/Sydney" }),
    () => utcToLocal("2026-03-29T06:00:00.000Z", "Europe/London"),
  ];

  /** 프로세스 TZ 를 둘로 바꿔 계산하고 원래 값으로 되돌린다. 전환이 실제 적용됐는지도 돌려준다. */
  function underTwoZones(): { applied: boolean; results: unknown[][] } {
    const original = process.env["TZ"];
    const probe = Date.UTC(2026, 0, 15, 12);
    const results: unknown[][] = [];
    const offsets: number[] = [];
    try {
      for (const zone of ["America/New_York", "Asia/Seoul"]) {
        process.env["TZ"] = zone;
        offsets.push(new Date(probe).getTimezoneOffset());
        results.push(SAMPLES.map((sample) => sample()));
      }
    } finally {
      if (original === undefined) delete process.env["TZ"];
      else process.env["TZ"] = original;
    }
    return { applied: offsets[0] === 300 && offsets[1] === -540, results };
  }

  it("Happy: 메인 스레드면 TZ 전환이 적용된 것을 확인하고 두 결과가 같다 (test_SC055_tz_switch_applied_results_equal)", () => {
    const { applied, results } = underTwoZones();
    // 실행 중 TZ 변경은 메인 스레드에만 적용된다 — worker 스레드 실행에서는 적용되지 않는 것이 사실이다.
    expect(applied).toBe(isMainThread);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]?.[0]).toEqual({
      ok: true,
      value: { kind: "exact", utc: "2026-03-08T11:00:00.000Z" },
    });
  });

  it("Edge: worker 스레드면 그 사실을 단언하고 결과를 비교한다 (test_SC055_worker_thread_asserts_and_compares)", () => {
    const { applied, results } = underTwoZones();
    if (!isMainThread) expect(applied).toBe(false);
    else expect(applied).toBe(true);
    expect(results[1]).toEqual(results[0]);
    expect(results[0]?.[3]).toEqual({
      ok: true,
      value: { localDate: "2026-03-29", localTime: "07:00:00.000" },
    });
  });

  it("Error: 오프셋·빈 문자열·런타임 미수용·비정규형 타임존은 거절된다 (test_SC055_offset_empty_unknown_unnormalized_refused)", () => {
    const reasons: readonly [string, string][] = [
      ["+09:00", "offset_not_allowed"],
      ["", "empty"],
      ["Mars/Olympus_Mons", "not_accepted_by_runtime"],
      ["asia/seoul", "not_normalized"],
    ];
    for (const [timeZone, reason] of reasons) {
      expect(
        localToUtc({ localDate: "2026-03-01", localTime: "07:00", timeZone }),
        timeZone,
      ).toEqual({
        ok: false,
        error: { kind: "timezone", reason },
      });
      expect(utcToLocal("2026-03-01T07:00:00.000Z", timeZone), timeZone).toEqual({
        ok: false,
        error: { kind: "timezone", reason },
      });
    }
  });
});
