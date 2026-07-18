import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-007 — 포그라운드 데몬 워커(runDaemonForeground)가 core/daemon.ts 로 이관되고, run.ts 의
// __daemon 분기는 코어 위임만 남는다. A(core 이관)는 PPG-1 병렬 중 이미 착지했으나 B(run.ts 위임화)
// 착지 전에는 (b) 가 예상 RED.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const coreDaemonPath = path.join(repoRoot, "src", "core", "daemon.ts");
const runSrcPath = path.join(repoRoot, "src", "cli", "run.ts");

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

describe("SC-007 (a): core/daemon.ts 에 데몬 워커가 존재한다", () => {
  it("src/core/daemon.ts 가 runDaemonForeground 를 export 하고 크래시가드·crash-loop·boot-report 의존을 참조한다", () => {
    expect(fs.existsSync(coreDaemonPath), "src/core/daemon.ts 부재").toBe(true);
    const src = read(coreDaemonPath);
    expect(src).toMatch(/export\s+async\s+function\s+runDaemonForeground\s*\(/);
    expect(src).toMatch(/\binstallCrashGuard\b/);
    expect(src).toMatch(/\bsupervisorUp\s*\(/);
    expect(src).toMatch(/\bcreateCrashLoopGuard\b/);
    expect(src).toMatch(/\bwriteBootReport\b/);
  });
});

describe("SC-007 (b): run.ts 에는 데몬 워커 직접 로직이 없고 core 위임만 남는다", () => {
  it("run.ts 에 crash-guard 설치·supervisorUp·crash-loop·boot-report 직접 로직이 없다", () => {
    const src = read(runSrcPath);
    expect(src).not.toMatch(/\binstallCrashGuard\b/);
    expect(src).not.toMatch(/\bcreateCrashLoopGuard\b/);
    expect(src).not.toMatch(/\bwriteBootReport\b/);
    expect(src).not.toMatch(/\bsupervisorUp\s*\(/);
  });

  it("run.ts 의 __daemon 분기가 core/daemon.js 로 동적 위임(import)한다", () => {
    const src = read(runSrcPath);
    expect(src).toMatch(/import\(\s*["']\.\.\/core\/daemon\.js["']\s*\)/);
    expect(src).toMatch(/runDaemonForeground/);
  });
});
