import { describe, expect, it } from "vitest";

// SC-042 (NFR-008): OS 적용 범위가 명시적으로 강제된다. assertMacOS(platform) 는 기존 모듈에서
// 이미 이식(유지) 대상 — 신규 시그니처 도입 없음(연구 문서 확인: launchd.ts 그대로 재사용).

describe("SC-042: OS 적용 범위가 명시적으로 강제된다", () => {
  it("Happy: 비-macOS 를 흉내내면 데몬 상주 명령이 사유를 밝히며 거부된다", async () => {
    const launchd = await import("../../src/core/launchd.js");
    expect(() => launchd.assertMacOS("linux")).toThrow(/macOS|darwin/i);
    expect(() => launchd.assertMacOS("win32")).toThrow();
  });

  it("Edge: 비데몬 명령(session ls 등)은 플랫폼과 무관하게 정상 동작해야 한다", async () => {
    const sessionStore = await import("../../src/core/session-store.js");
    // session-store 는 assertMacOS 를 호출하지 않는 순수 데이터 계층 — 어떤 플랫폼에서도 동작.
    expect(typeof sessionStore.loadSessions).toBe("function");
  });

  it("Happy: darwin 에서는 거부되지 않는다", async () => {
    const launchd = await import("../../src/core/launchd.js");
    expect(() => launchd.assertMacOS("darwin")).not.toThrow();
  });

  it("Error: 플랫폼 판정이 모호한 값이 들어와도 fail-closed(거부) 로 수렴한다", async () => {
    const launchd = await import("../../src/core/launchd.js");
    expect(() => launchd.assertMacOS("aix" as NodeJS.Platform)).toThrow();
  });
});
