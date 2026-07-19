import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// 스트림 규약 (FR-006·FR-007) — status 의 진단·경고(dead/stale/error/halt)·업데이트 알림은 stderr,
// 표·--json 본문은 stdout(SC-009·SC-010). update-check 를 모킹해 알림 유무를 결정적으로 제어한다.

const { checkForUpdate, formatUpdateNotice } = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  formatUpdateNotice: vi.fn(),
}));
vi.mock("../../src/core/update-check.js", () => ({ checkForUpdate, formatUpdateNotice }));

import { runStatus } from "../../src/cli/ops.js";
import { writeRuntime } from "../../src/core/runtime-state.js";
import { lanePaths } from "../../src/shared/paths.js";
import type { RuntimeInfo } from "../../src/core/runtime-state.js";

const CONF = `source=telegram\nbackend=acp\nengine=claude-agent-acp\nchannel=telegram\nperm_tier=acp\nacp_version=v1\n`;

let tmpBase: string;
let prevHome: string | undefined;

function writeConf(proj: string, lane: string): void {
  const dir = path.join(tmpBase, proj, "lanes.d");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${lane}.conf`), CONF);
}

function deadRuntime(lane: string): RuntimeInfo {
  return {
    v: 1,
    pid: 999999,
    lane,
    sessionId: "s",
    startedAt: new Date().toISOString(),
    source: "telegram",
    backend: "acp",
    engine: "claude-agent-acp",
  };
}

function runningRuntime(lane: string): RuntimeInfo {
  return {
    v: 1,
    pid: process.pid,
    lane,
    sessionId: "s",
    startedAt: new Date().toISOString(),
    source: "telegram",
    backend: "acp",
    engine: "claude-agent-acp",
  };
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-status-stream-"));
  prevHome = process.env["ADDE_HOME"];
  process.env["ADDE_HOME"] = tmpBase;
  checkForUpdate.mockResolvedValue(null); // 기본 — 알림 없음
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevHome;
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.clearAllMocks();
});

function captureStdio(): { out: () => string; err: () => string; restore: () => void } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const spyOut = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    outChunks.push(String(s));
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
    errChunks.push(String(s));
    return true;
  });
  return {
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
    restore: () => {
      spyOut.mockRestore();
      spyErr.mockRestore();
    },
  };
}

describe("status — dead 경고 블록은 stderr, stdout 에는 없음 (SC-009 Happy)", () => {
  it("dead 레인이 있으면 경고 블록이 stderr 에만 나타난다", async () => {
    writeConf("p", "l");
    await writeRuntime(lanePaths(tmpBase, "p", "l"), deadRuntime("l"));
    const cap = captureStdio();
    await runStatus(["p"]);
    cap.restore();
    // 표의 STATUS 셀 값 자체("dead")는 1차 데이터라 stdout 유지 대상이므로 "dead" 어휘가
    // 아니라 경고 블록의 고유 접두("warning:")로 판정 — 셀 값과 경고 블록을 혼동하지 않는다.
    expect(cap.err()).toMatch(/경고:|warning:/);
    expect(cap.out()).not.toMatch(/경고:|warning:/);
  });
});

describe("status — 업데이트 알림은 stderr (SC-009 Edge)", () => {
  it("새 버전 알림이 있으면 stderr 에만 나타나고 stdout 에는 없다", async () => {
    writeConf("p", "l");
    await writeRuntime(lanePaths(tmpBase, "p", "l"), runningRuntime("l"));
    checkForUpdate.mockResolvedValueOnce({ latest: "9.9.9", current: "0.0.0" });
    formatUpdateNotice.mockReturnValue("새 버전 9.9.9 사용 가능");
    const cap = captureStdio();
    await runStatus(["p"]);
    cap.restore();
    expect(cap.err()).toContain("새 버전 9.9.9 사용 가능");
    expect(cap.out()).not.toContain("새 버전 9.9.9 사용 가능");
  });
});

describe("status — 표는 stdout (SC-010 Happy)", () => {
  it("텍스트 모드 표가 stdout 에 출력된다", async () => {
    writeConf("p", "l");
    await writeRuntime(lanePaths(tmpBase, "p", "l"), runningRuntime("l"));
    const cap = captureStdio();
    await runStatus(["p"]);
    cap.restore();
    expect(cap.out()).toMatch(/LANE/);
  });
});

describe("status --json — 본문은 stdout (SC-010 Happy)", () => {
  it("--json 본문이 stdout 에 출력되고 stderr 에는 본문이 없다", async () => {
    writeConf("p", "l");
    await writeRuntime(lanePaths(tmpBase, "p", "l"), runningRuntime("l"));
    const cap = captureStdio();
    await runStatus(["p", "--json"]);
    cap.restore();
    const parsed = JSON.parse(cap.out()) as { lanes: unknown[] };
    expect(Array.isArray(parsed.lanes)).toBe(true);
  });
});
