import { describe, expect, it } from "vitest";
import { runCheck, flattenCatalog, checkParity, placeholders } from "../../scripts/check-i18n.js";
import { en } from "../../src/shared/locales/en.js";
import { ko } from "../../src/shared/locales/ko.js";

describe("i18n 패리티 — 실제 카탈로그", () => {
  it("en/ko 키·플레이스홀더·빈 문자열 이슈 0건", () => {
    expect(runCheck()).toEqual([]);
  });

  it("카탈로그에 키가 존재한다", () => {
    expect(flattenCatalog(en).size).toBeGreaterThan(0);
  });
});

// SC-009 (FR-007 관련 — i18n 패리티): 자가 재기동 시도·포기(ON)·비활성(OFF) 메시지 키가
// ko/en 카탈로그에 존재하고 플레이스홀더가 일치한다. 002-lane-engine-recovery.
describe("i18n 패리티 — selfRecovery 키 (SC-009)", () => {
  it("supervisor.selfRecovery.{attempt,abandoned,disabled} 키가 en/ko 양쪽에 존재한다", () => {
    const enFlat = flattenCatalog(en);
    const koFlat = flattenCatalog(ko);
    for (const key of [
      "supervisor.selfRecovery.attempt",
      "supervisor.selfRecovery.abandoned",
      "supervisor.selfRecovery.disabled",
    ]) {
      expect(enFlat.has(key), `en 카탈로그에 ${key} 키가 있어야 한다`).toBe(true);
      expect(koFlat.has(key), `ko 카탈로그에 ${key} 키가 있어야 한다`).toBe(true);
    }
  });

  it("attempt 는 {{lane}}, abandoned 는 {{lane}}·{{attempts}}·{{proj}}, disabled 는 {{lane}}·{{proj}} 플레이스홀더를 갖는다", () => {
    const enFlat = flattenCatalog(en);
    expect([...placeholders(enFlat.get("supervisor.selfRecovery.attempt") ?? "")].sort()).toEqual([
      "lane",
    ]);
    expect([...placeholders(enFlat.get("supervisor.selfRecovery.abandoned") ?? "")].sort()).toEqual(
      ["attempts", "lane", "proj"],
    );
    expect([...placeholders(enFlat.get("supervisor.selfRecovery.disabled") ?? "")].sort()).toEqual([
      "lane",
      "proj",
    ]);
  });

  it("selfRecovery 신규 키도 전체 i18n:check 통과에 포함된다(패리티 회귀 없음)", () => {
    expect(runCheck()).toEqual([]);
  });
});

describe("i18n 패리티 — 검사기 자체 검증", () => {
  it("누락·잉여 키를 검출한다", () => {
    const base = new Map([
      ["a", "x"],
      ["b", "y"],
    ]);
    const other = new Map([
      ["a", "x"],
      ["c", "z"],
    ]);
    const kinds = checkParity(base, other, "ko").map((i) => i.kind);
    expect(kinds).toContain("missing");
    expect(kinds).toContain("extra");
  });

  it("플레이스홀더 불일치를 검출한다", () => {
    const base = new Map([["a", "hi {{name}}"]]);
    const other = new Map([["a", "안녕 {{nome}}"]]);
    expect(checkParity(base, other, "ko").map((i) => i.kind)).toContain("placeholder");
  });

  it("placeholders 는 공백 허용·중복 제거", () => {
    expect([...placeholders("{{ a }} {{a}} {{b}}")].sort()).toEqual(["a", "b"]);
  });
});
