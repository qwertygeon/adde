import { describe, expect, it } from "vitest";
import { formatDateFolder, dateFolderFromStamp } from "../../src/shared/date-folder.js";

// helper/regression unit — SC 매핑 없음(SC 매핑 테스트는 Test Agent AUTHORING 책임).

describe("formatDateFolder", () => {
  it("로컬 날짜를 YYYY-MM-DD 로 zero-pad 포맷한다", () => {
    const d = new Date(2026, 0, 5, 23, 59, 59); // 2026-01-05 (월/일 1자리 zero-pad 확인)
    expect(formatDateFolder(d)).toBe("2026-01-05");
  });

  it("두 자리 월/일도 그대로 유지한다", () => {
    const d = new Date(2026, 11, 25);
    expect(formatDateFolder(d)).toBe("2026-12-25");
  });
});

describe("dateFolderFromStamp", () => {
  it("YYYYMMDD-HHmmss 스탬프에서 YYYY-MM-DD 를 파생한다", () => {
    expect(dateFolderFromStamp("20260705-143000")).toBe("2026-07-05");
  });

  it("형식이 어긋나면 throw 한다(방어적 — 파티셔닝 대상 오판정 방지)", () => {
    expect(() => dateFolderFromStamp("not-a-stamp")).toThrow();
    expect(() => dateFolderFromStamp("2026-07-05")).toThrow();
  });
});
