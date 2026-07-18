import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runStatus } from "../../src/cli/ops.js";
import { writeRuntime } from "../../src/core/runtime-state.js";
import { lanePaths, daemonHaltPath } from "../../src/shared/paths.js";
import type { RuntimeInfo } from "../../src/core/runtime-state.js";
import type { HaltRecord } from "../../src/core/crash-loop.js";

// status halt exit code + --json 객체 재구성 (FR-010·FR-011) — SC-017·SC-018·SC-019·SC-020.
// runStatus 는 collectStatus/collectAllStatus/readHalt→defaultBase()→$ADDE_HOME 를 읽으므로 tmp 로 격리.

let tmpBase: string;
let prevHome: string | undefined;

const CONF = `source=telegram\nbackend=acp\nengine=claude-agent-acp\nchannel=telegram\nperm_tier=acp\nacp_version=v1\n`;

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
    engine: "claude-agent-acp",
  };
}

function writeHalt(proj: string, record: HaltRecord): void {
  const p = daemonHaltPath(tmpBase, proj);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2) + "\n");
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-status-json-"));
  prevHome = process.env["ADDE_HOME"];
  process.env["ADDE_HOME"] = tmpBase;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevHome;
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureStdout(): () => string {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => spy.mock.calls.map((c) => String(c[0])).join("");
}

describe("status --json 객체 재구성 — halt 없음 (SC-018 Happy)", () => {
  it("stdout 은 최상위 배열이 아니라 {lanes:[...],halt:null} 객체로 파싱된다", async () => {
    writeConf("p", "l");
    await writeRuntime(lanePaths(tmpBase, "p", "l"), rt(process.pid, "l"));
    const out = captureStdout();
    const code = await runStatus(["p", "--json"]);
    const parsed = JSON.parse(out()) as { lanes: unknown[]; halt: unknown };
    expect(Array.isArray(parsed)).toBe(false);
    expect(Array.isArray(parsed.lanes)).toBe(true);
    expect(parsed.halt).toBeNull();
    expect(code).toBe(0);
  });
});

describe("status halt exit code (SC-017)", () => {
  it("halt 기록이 있으면 halt 경고 텍스트를 유지하고 exit 1", async () => {
    writeConf("p", "l");
    await writeRuntime(lanePaths(tmpBase, "p", "l"), rt(process.pid, "l"));
    writeHalt("p", {
      reason: "crash loop — 5 consecutive short-lived boots (< 60000ms)",
      haltedAt: new Date().toISOString(),
      consecutiveShortLived: 5,
    });
    const out = captureStdout();
    const code = await runStatus(["p"]);
    expect(out().length).toBeGreaterThan(0);
    expect(code).toBe(1);
  });

  it("halt 없고 레인이 정상이면 exit 0(기존 동작 불변)", async () => {
    writeConf("p", "l");
    await writeRuntime(lanePaths(tmpBase, "p", "l"), rt(process.pid, "l"));
    captureStdout();
    const code = await runStatus(["p"]);
    expect(code).toBe(0);
  });
});

describe("status --json halt 포함 (SC-019 Edge)", () => {
  it(".halt 에 연속 횟수·사유가 담기고 exit 1", async () => {
    writeConf("p", "l");
    await writeRuntime(lanePaths(tmpBase, "p", "l"), rt(process.pid, "l"));
    writeHalt("p", {
      reason: "crash loop — 5 consecutive short-lived boots (< 60000ms)",
      haltedAt: "2026-01-01T00:00:00.000Z",
      consecutiveShortLived: 5,
    });
    const out = captureStdout();
    const code = await runStatus(["p", "--json"]);
    const parsed = JSON.parse(out()) as { halt: HaltRecord | null };
    expect(parsed.halt).not.toBeNull();
    expect(parsed.halt?.consecutiveShortLived).toBe(5);
    expect(parsed.halt?.reason).toMatch(/crash loop/);
    expect(code).toBe(1);
  });
});

describe("status --json 최상위 스키마 불변 (SC-014 Happy, NFR-001)", () => {
  it("최상위 키가 정확히 lanes/halt 뿐이고 성공 경로는 exit 0(신규 필드 없음)", async () => {
    writeConf("p", "l");
    await writeRuntime(lanePaths(tmpBase, "p", "l"), rt(process.pid, "l"));
    const out = captureStdout();
    const code = await runStatus(["p", "--json"]);
    const parsed = JSON.parse(out()) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["halt", "lanes"]);
    expect(code).toBe(0);
  });
});

describe("집계 status --json 구조 (SC-020 Edge)", () => {
  it("인자 없는 status --json 은 .lanes(각 행 proj 부기)·.halt(프로젝트별 상태)로 파싱된다", async () => {
    writeConf("p1", "a");
    await writeRuntime(lanePaths(tmpBase, "p1", "a"), rt(process.pid, "a"));
    writeConf("p2", "b");
    await writeRuntime(lanePaths(tmpBase, "p2", "b"), rt(process.pid, "b"));
    writeHalt("p2", {
      reason: "crash loop — 5 consecutive short-lived boots (< 60000ms)",
      haltedAt: "2026-01-01T00:00:00.000Z",
      consecutiveShortLived: 5,
    });

    const out = captureStdout();
    const code = await runStatus(["--json"]);
    const parsed = JSON.parse(out()) as {
      lanes: Array<{ proj?: string }>;
      halt: Record<string, HaltRecord | null>;
    };
    expect(Array.isArray(parsed.lanes)).toBe(true);
    expect(parsed.lanes.every((r) => typeof r.proj === "string")).toBe(true);
    expect(parsed.halt.p1).toBeNull();
    expect(parsed.halt.p2?.consecutiveShortLived).toBe(5);
    expect(code).toBe(1); // p2 halt 존재 → 집계도 1
  });
});
