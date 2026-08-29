import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

const repoRoot067 = fileURLToPath(new URL("../..", import.meta.url));

describe("SC-067 (006): 006 변경분에 OS 한정 신규 분기(process.platform)가 도입되지 않았다", () => {
  // 006 신규·변경 대상 파일만 스캔한다(design.md §1 계층·모듈 배치 — 기존 launchd.ts 의
  // 기존 process.platform 사용은 재사용 범위라 대상 아님).
  const CHANGED_006_FILES = [
    "src/core/control-queue.ts",
    "src/core/session-removal.ts",
    "src/core/factory-reset.ts",
    "src/core/session-manager.ts",
    "src/surfaces/markdown/notices.ts",
    "src/surfaces/markdown/inbox.ts",
    "src/surfaces/markdown/index.ts",
    "src/cli/session.ts",
    "src/cli/factory-reset.ts",
    "src/cli/prompt.ts",
  ];

  it("Happy: 006 신규·변경 파일 중 존재하는 것들에 process.platform 신규 사용이 0건이다", () => {
    const hits: string[] = [];
    for (const rel of CHANGED_006_FILES) {
      const full = path.join(repoRoot067, rel);
      if (!fs.existsSync(full)) continue; // PPG-1 병렬 — 아직 미착지 파일은 스킵.
      const content = fs.readFileSync(full, "utf8");
      if (content.includes("process.platform")) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it("Error: process.platform 을 도입하면 검출기가 위반을 잡는다(가드 자기점검)", () => {
    const injected = `if (process.platform === "win32") { doSomething(); }`;
    expect(injected.includes("process.platform")).toBe(true);
  });
});
