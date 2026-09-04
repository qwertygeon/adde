import { describe, expect, it } from "vitest";
import { flattenCatalog, placeholders, runCheck } from "../../scripts/check-i18n.js";
import { en } from "../../src/shared/locales/en.js";
import { ko } from "../../src/shared/locales/ko.js";

// SC-014(FR-014·NFR-006) — 판정 대상 문구(design.md ADR-014 배선 키 전건 + 선존 배선 3종)가
// en·ko 양쪽에 존재하고 플레이스홀더가 일치하며, 그 값 문자열에 구 어휘("레인"/`lane`)가 남아
// 있지 않다. 카탈로그 전역 스윕이 아니다 — `adde lane add|set|ls|show|rm` 는 현행 명령 표면이라
// 다른 키의 `lane`·`{{lane}}` 은 정당한 현행 어휘다(research §문구 literal 스윕, en 카탈로그
// `{{lane}}` 43행). 판정 단위는 아래 TARGET_KEYS 의 **값 문자열** 한정이다.

const TARGET_KEYS = [
  // 재배선(현행 문안 유지) — 그래도 판정 대상 키 집합에는 포함한다(design.md ADR-014).
  "ops.doctor.summary",
  "ops.logs.badCount",
  "ops.status.haltWarn",
  // 통합 재작성.
  "ops.status.daemonDead",
  "ops.status.daemonStale",
  // 개명·어휘 갱신.
  "log.liveness.writeFail",
  "log.liveness.refreshFail",
  "log.liveness.removeFail",
  // 신설.
  "ops.status.daemonLine",
  "ops.status.daemonState.running",
  "ops.status.daemonState.stale",
  "ops.status.daemonState.dead",
  "ops.status.daemonState.stopped",
  "ops.status.daemonState.unreadable",
  "ops.status.daemonUnreadable",
  // 선존 배선 3종(spec v1.1 FR-014 로 범위 내 이동).
  "run.signalShutdown",
  "run.laneStartFailed.situation",
  "run.laneStartFailed.action",
];

describe("SC-014: 판정 대상 키가 en·ko 양쪽에 존재하고 플레이스홀더가 일치한다", () => {
  it("Happy: 판정 대상 키 전건이 두 카탈로그에 존재하고(누락 0) 플레이스홀더가 일치한다", () => {
    const enFlat = flattenCatalog(en);
    const koFlat = flattenCatalog(ko);
    for (const key of TARGET_KEYS) {
      expect(enFlat.has(key), `en 카탈로그에 ${key} 키가 있어야 한다`).toBe(true);
      expect(koFlat.has(key), `ko 카탈로그에 ${key} 키가 있어야 한다`).toBe(true);
      const enPh = [...placeholders(enFlat.get(key) ?? "")].sort();
      const koPh = [...placeholders(koFlat.get(key) ?? "")].sort();
      expect(enPh, `${key} 플레이스홀더 en/ko 불일치`).toEqual(koPh);
    }
  });

  it("Happy: 판정 대상 키 포함 전체 i18n:check 통과(패리티 회귀 없음)", () => {
    expect(runCheck()).toEqual([]);
  });

  it("Happy: 선존 2종의 플레이스홀더가 sid 를 포함하고 lane 을 포함하지 않는다", () => {
    const enFlat = flattenCatalog(en);
    for (const key of ["run.laneStartFailed.situation", "run.laneStartFailed.action"]) {
      const ph = [...placeholders(enFlat.get(key) ?? "")];
      expect(ph, `${key} 에 sid 플레이스홀더가 있어야 한다`).toContain("sid");
      expect(ph, `${key} 에 lane 플레이스홀더가 남아있으면 안 된다`).not.toContain("lane");
    }
  });
});

describe("SC-014: 판정 대상 문구 본문에 구 어휘가 없다 — ko 레인·en lane 양쪽", () => {
  it("Edge: ko 판정 대상 값 문자열에 '레인' 이 0건이다", () => {
    const koFlat = flattenCatalog(ko);
    const violations: string[] = [];
    for (const key of TARGET_KEYS) {
      const value = koFlat.get(key) ?? "";
      if (value.includes("레인")) violations.push(key);
    }
    expect(violations).toEqual([]);
  });

  it("Edge: en 판정 대상 값 문자열에 lane(대소문자 무시, {{lane}} 포함) 이 0건이다", () => {
    const enFlat = flattenCatalog(en);
    const violations: string[] = [];
    for (const key of TARGET_KEYS) {
      const value = (enFlat.get(key) ?? "").toLowerCase();
      if (value.includes("lane")) violations.push(key);
    }
    expect(violations).toEqual([]);
  });

  it("Error: 카탈로그 전역 스윕이 아니다(현행 lane 명령 표면 문구는 판정 대상 밖 — 자기점검)", () => {
    // adde lane add|set|ls|show|rm 는 현행 명령 표면이므로 en 카탈로그 전체에는 `{{lane}}` 이
    // 다수 남아 있어야 정상이다(research §문구 literal 스윕 실측 43행). 판정 대상(TARGET_KEYS)
    // 밖의 키에 lane 이 있어도 위반이 아님을 스캐너 자기점검으로 확인한다 — 전역 카운트가 0이면
    // (스캐너가 잘못 짜여 카탈로그를 못 읽는 등) TARGET_KEYS 한정 판정 자체가 무의미해진다.
    const enFlat = flattenCatalog(en);
    let globalLaneCount = 0;
    for (const [key, value] of enFlat) {
      if (TARGET_KEYS.includes(key)) continue;
      if (value.toLowerCase().includes("lane")) globalLaneCount++;
    }
    expect(globalLaneCount).toBeGreaterThan(0);
  });
});

describe("SC-014: 미기동 표기가 세션 상태 '중지'와 구분된다", () => {
  it("Error: ko 는 '미기동'(≠중지), en 은 'not started'(≠stopped)", () => {
    const enFlat = flattenCatalog(en);
    const koFlat = flattenCatalog(ko);
    const koStopped = koFlat.get("ops.status.daemonState.stopped") ?? "";
    const enStopped = enFlat.get("ops.status.daemonState.stopped") ?? "";
    expect(koStopped).toBe("미기동");
    expect(koStopped).not.toBe("중지");
    expect(enStopped).toBe("not started");
    expect(enStopped).not.toBe("stopped");
  });
});
