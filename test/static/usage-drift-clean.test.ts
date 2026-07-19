import { describe, expect, it } from "vitest";

// N9 CI 게이트 — 현행 spec.ts 선언 + en/ko usage 카탈로그가 정합하면 위반 0 (SC-013, FR-008).
// `runCheck()` 는 check-i18n.ts 의 동일 명명 관행을 그대로 따른다고 가정한다(연구 §E 명시 모델링 —
// test-cases.md "계약 시그니처 가정" 절 참조). 지연 import 로 4단계 미착지(T-C1) 시점의 RED 를
// 개별 테스트 단위로 격리한다(PROC-R15).

describe("현행 카탈로그(en·ko) 정합 검사 (SC-013 Happy, CI 게이트)", () => {
  it("실 spec.ts 선언과 실 locales 카탈로그로 실행하면 위반 0건", async () => {
    const mod = await import("../../scripts/check-usage-drift.js");
    const issues = mod.runCheck();
    expect(issues, JSON.stringify(issues)).toEqual([]);
  });
});
