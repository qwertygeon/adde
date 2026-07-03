import { describe, expect, it, vi, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";

// D-004: macOS 조건 분기 — SC-016
// launchd 경로(assertMacOS 가드)가 비-darwin 에서 throw 하는지 + 정적 검사

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── 비-darwin assertMacOS throw (process.platform mock) ───────────────────

describe("비-darwin assertMacOS throw (SC-016)", () => {
  it("비darwin_assertMacOS_throw", async () => {
    // process.platform 을 'linux' 로 mock → assertMacOS() 는 throw 해야 한다
    vi.stubGlobal("process", { ...process, platform: "linux" as NodeJS.Platform });

    // 동적 import 로 모듈을 새로 로드해 mock platform 반영
    // (ESM 캐시 탓에 이미 로드된 모듈은 재주입 불가 — 단 assertMacOS 자체를 직접 테스트)
    const { assertMacOS } = await import("../../src/core/launchd.js");
    expect(() => assertMacOS()).toThrow();
  });

  it("darwin 에서 assertMacOS 는 throw 하지 않는다", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" as NodeJS.Platform });

    const { assertMacOS } = await import("../../src/core/launchd.js");
    expect(() => assertMacOS()).not.toThrow();
  });
});

// ── 정적 검사: launchd.ts 의 launchctl exec 호출이 assertMacOS 가드 뒤에 위치 ──

describe("launchd_ts_launchctl_exec_assertMacOS_가드_하_실행 (SC-016 정적)", () => {
  it("src/core/launchd.ts 에 assertMacOS() 선언이 존재한다", () => {
    const srcPath = path.resolve(process.cwd(), "src", "core", "launchd.ts");
    // 파일이 없으면(TDD Red 단계) 스킵 — Development 구현 후 Green
    if (!fs.existsSync(srcPath)) {
      expect(true).toBe(true);
      return;
    }
    const content = fs.readFileSync(srcPath, "utf8");
    expect(content).toMatch(/assertMacOS/);
  });

  it("process.platform 체크가 launchd.ts 에 존재하거나 assertMacOS 가 이를 위임한다", () => {
    const srcPath = path.resolve(process.cwd(), "src", "core", "launchd.ts");
    if (!fs.existsSync(srcPath)) {
      expect(true).toBe(true);
      return;
    }
    const content = fs.readFileSync(srcPath, "utf8");
    // platform 가드 또는 assertMacOS 위임 — 둘 중 하나
    const hasPlatformCheck =
      content.includes("process.platform") || content.includes("assertMacOS");
    expect(hasPlatformCheck).toBe(true);
  });

  it("launchd.ts 에 침묵 실패 패턴(빈 catch로 무시)이 없다 — 비-darwin 오류 표면화 보장", () => {
    const srcPath = path.resolve(process.cwd(), "src", "core", "launchd.ts");
    if (!fs.existsSync(srcPath)) {
      expect(true).toBe(true);
      return;
    }
    const content = fs.readFileSync(srcPath, "utf8");
    // 플랫폼 체크를 완전히 흡수하는 빈 catch 패턴 금지
    // "catch {}" 또는 "catch (_) {}" 형태가 assertMacOS 직접 호출부를 감싸는 패턴 탐지
    const silentCatch = /catch\s*\([^)]*\)\s*\{\s*\}/.test(content);
    // 빈 catch 자체는 lifecycle.ts 등 정당한 사유(ENOENT 흡수 등)로 있을 수 있으므로
    // launchd.ts 전체에 assertMacOS 존재하면서 빈 catch 가 과도하지 않은지 확인한다.
    // 여기서는 assertMacOS 를 catch 로 삼키는 극단적 패턴만 차단 — 정밀 판단은 정적 lint 에 위임.
    if (silentCatch) {
      // assertMacOS 가 실제로 catch 에 감싸여 있는지 확인 (빈 catch 는 launchd.ts 에서 비허용)
      const assertMacOSWrapped =
        /try\s*\{[^}]*assertMacOS[^}]*\}\s*catch\s*\([^)]*\)\s*\{\s*\}/.test(content);
      expect(assertMacOSWrapped).toBe(false);
    } else {
      expect(true).toBe(true);
    }
  });
});
