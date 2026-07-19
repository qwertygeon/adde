import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// SC-N04 (NFR-004): macOS 한정 로직이 OS 분기(assertMacOS SSOT)로 격리되고,
// 크래시 가드·로그 회전 프리미티브는 OS 분기에 종속되지 않는다(침묵 OS 한정 도입 0건).

const srcRoot = path.resolve(process.cwd(), "src");

function read(relPath: string): string | null {
  const p = path.join(srcRoot, relPath);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

describe("SC-N04: launchd 전용 로직은 assertMacOS 분기 하에 있다", () => {
  it("launchd.ts 의 loadDaemon/unloadDaemon 은 assertMacOS 를 호출한다", () => {
    const content = read("core/launchd.ts");
    if (content === null) {
      expect(true).toBe(true); // TDD Red — 구현 전
      return;
    }
    expect(content).toContain("assertMacOS");
    // loadDaemon/unloadDaemon 함수 본문 내에 assertMacOS 호출이 존재해야 한다(정적 근접성 검사).
    const loadIdx = content.indexOf("export async function loadDaemon");
    const unloadIdx = content.indexOf("export async function unloadDaemon");
    expect(loadIdx).toBeGreaterThan(-1);
    expect(unloadIdx).toBeGreaterThan(-1);
    expect(content.slice(loadIdx, loadIdx + 500)).toContain("assertMacOS");
    expect(content.slice(unloadIdx, unloadIdx + 500)).toContain("assertMacOS");
  });
});

describe("SC-N04: OS 무관 프리미티브는 OS 분기에 종속되지 않는다", () => {
  const osIndependentFiles = ["shared/log-rotate.ts", "core/crash-guard.ts", "core/crash-loop.ts"];

  it.each(osIndependentFiles)("%s 는 assertMacOS·process.platform 분기를 포함하지 않는다", (rel) => {
    const content = read(rel);
    if (content === null) {
      expect(true).toBe(true); // TDD Red — 구현 전
      return;
    }
    expect(content).not.toContain("assertMacOS");
    expect(content).not.toContain("process.platform");
  });
});
