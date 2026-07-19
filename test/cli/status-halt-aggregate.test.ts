import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runStatus } from "../../src/cli/ops.js";
import { writeRuntime } from "../../src/core/runtime-state.js";
import { lanePaths, daemonHaltPath } from "../../src/shared/paths.js";
import type { RuntimeInfo } from "../../src/core/runtime-state.js";
import type { HaltRecord } from "../../src/core/crash-loop.js";

// M-1 회귀 방지 — 인자 없는 집계 status 는 halt 판정 대상 프로젝트 집합을 표시 필터(rows,
// 기본 뷰는 stopped 제외)가 아니라 대상 전체(allRows)에서 파생해야 한다(ADR-005). 전 레인이
// stopped 인 halt 프로젝트가 기본 뷰 필터에서 빠지더라도 halt 경고·exit 1 이 표면화되어야
// 한다(SC-107·SC-107b).

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
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-status-halt-agg-"));
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

function captureStderr(): () => string {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return () => spy.mock.calls.map((c) => String(c[0])).join("");
}

describe("집계 status 기본 뷰 — 전 레인 stopped halt 프로젝트 감지 (SC-107 Edge)", () => {
  it("전 레인이 stopped 라 기본 뷰 필터에서 빠져도 halt 경고 + exit 1 을 반환한다", async () => {
    writeConf("haltproj", "l"); // runtime.json 없음 → stopped(기본 뷰 필터 제외 대상)
    writeHalt("haltproj", {
      reason: "crash loop — 5 consecutive short-lived boots (< 60000ms)",
      haltedAt: new Date().toISOString(),
      consecutiveShortLived: 5,
    });
    captureStdout();
    const err = captureStderr();
    const code = await runStatus([]);
    expect(code).toBe(1);
    // halt 경고는 조언·경고성 출력이라 stderr 로 이동한다(FR-006 — 종전 stdout).
    expect(err()).toContain("haltproj");
  });

  it("halt 대상 프로젝트에 running 레인이 섞여도(부분 stopped) halt 가 누락되지 않는다", async () => {
    writeConf("haltproj2", "stoppedlane"); // stopped
    writeConf("haltproj2", "runninglane");
    await writeRuntime(lanePaths(tmpBase, "haltproj2", "runninglane"), rt(process.pid, "runninglane"));
    writeHalt("haltproj2", {
      reason: "crash loop — 5 consecutive short-lived boots (< 60000ms)",
      haltedAt: new Date().toISOString(),
      consecutiveShortLived: 5,
    });
    captureStdout();
    const err = captureStderr();
    const code = await runStatus([]);
    expect(code).toBe(1);
    expect(err()).toContain("haltproj2");
  });
});

describe("집계 status --json — 전 레인 stopped halt 프로젝트 포함 (SC-107b Edge)", () => {
  it(".halt 에 전 레인 stopped 인 halt 프로젝트가 포함되고 exit 1(다중 프로젝트, 일부만 halt)", async () => {
    writeConf("normalproj", "l");
    await writeRuntime(lanePaths(tmpBase, "normalproj", "l"), rt(process.pid, "l"));
    writeConf("haltproj", "l"); // runtime.json 없음 → stopped 뿐
    writeHalt("haltproj", {
      reason: "crash loop — 5 consecutive short-lived boots (< 60000ms)",
      haltedAt: "2026-01-01T00:00:00.000Z",
      consecutiveShortLived: 5,
    });
    const out = captureStdout();
    const code = await runStatus(["--json"]);
    const parsed = JSON.parse(out()) as { halt: Record<string, HaltRecord | null> };
    expect(parsed.halt["haltproj"]?.consecutiveShortLived).toBe(5);
    expect(parsed.halt["normalproj"]).toBeNull();
    expect(code).toBe(1);
  });
});

describe("집계 status — halt 없음(회귀) (SC-107 무회귀)", () => {
  it("halt 기록이 전혀 없으면 exit 0(기존 동작 불변)", async () => {
    writeConf("p1", "alive");
    await writeRuntime(lanePaths(tmpBase, "p1", "alive"), rt(process.pid, "alive"));
    captureStdout();
    const code = await runStatus([]);
    expect(code).toBe(0);
  });
});
