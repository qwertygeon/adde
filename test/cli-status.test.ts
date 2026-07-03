import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runStatus } from "../src/cli/ops.js";
import { writeRuntime } from "../src/core/runtime-state.js";
import { lanePaths } from "../src/shared/paths.js";
import type { RuntimeInfo } from "../src/core/runtime-state.js";

// status parity: 인자 없는 status = 실행 중 전체(정지 제외), --all = 정지 포함 전체.
// runStatus 는 collectAllStatus()→defaultBase()→$ADDE_HOME 를 읽으므로 tmp 로 격리.

let tmpBase: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-cli-status-"));
  prevHome = process.env["ADDE_HOME"];
  process.env["ADDE_HOME"] = tmpBase;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevHome;
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CONF = `source=telegram\nbackend=acp\nengine=claude-code-acp\nchannel=telegram\nperm_tier=acp\nacp_version=v1\n`;

function writeConf(proj: string, lane: string): void {
  const dir = path.join(tmpBase, proj, "lanes.d");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${lane}.conf`), CONF);
}

function rt(pid: number, lane: string): RuntimeInfo {
  return {
    v: 1,
    pid,
    lane,
    sessionId: "s",
    startedAt: new Date().toISOString(),
    source: "telegram",
    backend: "acp",
    engine: "claude-code-acp",
  };
}

function captureStdout(): () => string {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => spy.mock.calls.map((c) => String(c[0])).join("");
}

describe("runStatus 인자 없음 — 다중 프로젝트 집계 (CCTG parity)", () => {
  it("인자 없으면 실행 중 레인만 PROJECT 컬럼과 함께 표시(정지 제외)", async () => {
    writeConf("p1", "alive");
    writeConf("p2", "idle"); // runtime.json 없음 → stopped
    await writeRuntime(lanePaths(tmpBase, "p1", "alive"), rt(process.pid, "alive"));

    const out = captureStdout();
    const code = await runStatus([]);

    expect(out()).toContain("PROJECT");
    expect(out()).toContain("p1");
    expect(out()).toContain("alive");
    // 정지(stopped) 레인은 기본 뷰에서 제외.
    expect(out()).not.toContain("idle");
    expect(code).toBe(0);
  });

  it("--all 은 정지 포함 전체 표시", async () => {
    writeConf("p1", "alive");
    writeConf("p2", "idle");
    await writeRuntime(lanePaths(tmpBase, "p1", "alive"), rt(process.pid, "alive"));

    const out = captureStdout();
    await runStatus(["--all"]);

    expect(out()).toContain("alive");
    expect(out()).toContain("idle"); // 정지 레인 포함
  });

  it("실행 중 레인이 없으면 안내 메시지(정지만 존재)", async () => {
    writeConf("p1", "idle"); // stopped

    const out = captureStdout();
    const code = await runStatus([]);

    expect(out()).toContain("실행 중인 레인 없음");
    expect(code).toBe(0);
  });
});
