import { describe, expect, it } from "vitest";
import { runCheck, flattenCatalog, checkParity, placeholders } from "../../scripts/check-i18n.js";
import { en } from "../../src/shared/locales/en.js";

describe("i18n 패리티 — 실제 카탈로그", () => {
  it("en/ko 키·플레이스홀더·빈 문자열 이슈 0건", () => {
    expect(runCheck()).toEqual([]);
  });

  it("카탈로그에 키가 존재한다", () => {
    expect(flattenCatalog(en).size).toBeGreaterThan(0);
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
