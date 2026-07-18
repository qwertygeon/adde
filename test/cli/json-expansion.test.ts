import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --json 확대 (FR-001) — down/lane ls/lane show/logs 스냅샷. 각 명령이 이미 산출하는 결과를
// 신규 계산 없이 그대로 JSON 으로 stdout 에 낸다 (SC-001).

const { loadDaemon, unloadDaemon, daemonRegState } = vi.hoisted(() => ({
  loadDaemon: vi.fn(),
  unloadDaemon: vi.fn(),
  daemonRegState: vi.fn(),
}));
vi.mock("../../src/core/launchd.js", () => ({ loadDaemon, unloadDaemon, daemonRegState }));

import { run } from "../../src/cli/run.js";
import { runLane } from "../../src/cli/lane.js";
import { runLogs } from "../../src/cli/ops.js";
import { appendTranscript } from "../../src/core/transcript.js";
import { lanePaths } from "../../src/shared/paths.js";

const CONF = `source=telegram\nbackend=acp\nengine=claude-agent-acp\nchannel=telegram\nperm_tier=acp\nacp_version=v1\n`;

let tmpBase: string;
let prevHome: string | undefined;

function writeConf(proj: string, lane: string): void {
  const dir = path.join(tmpBase, proj, "lanes.d");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${lane}.conf`), CONF);
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-json-expansion-"));
  prevHome = process.env["ADDE_HOME"];
  process.env["ADDE_HOME"] = tmpBase;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevHome;
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.clearAllMocks();
});

function captureStdout(): { out: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  return { out: () => chunks.join(""), restore: () => spy.mockRestore() };
}

describe("adde lane ls --json — 레인 이름 배열 (SC-001 Happy)", () => {
  it("레인 conf 가 있으면 stdout 이 JSON.parse 가능한 배열이고 exit 0", async () => {
    writeConf("p", "a");
    writeConf("p", "b");
    const cap = captureStdout();
    const code = await runLane(["ls", "p", "--json"]);
    cap.restore();
    const parsed = JSON.parse(cap.out()) as string[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.sort()).toEqual(["a", "b"]);
    expect(code).toBe(0);
  });
});

describe("adde lane ls --json — 레인 0개 (SC-001 Edge)", () => {
  it("레인 conf 가 없으면 stdout 은 빈 배열이고 exit 0", async () => {
    const cap = captureStdout();
    const code = await runLane(["ls", "p", "--json"]);
    cap.restore();
    expect(JSON.parse(cap.out())).toEqual([]);
    expect(code).toBe(0);
  });
});

describe("adde lane show --json — {lane,confPath,conf} (SC-001 Happy)", () => {
  it("stdout 이 lane/confPath/conf 를 담은 JSON 객체이고 exit 0", async () => {
    writeConf("p", "a");
    const cap = captureStdout();
    const code = await runLane(["show", "p", "a", "--json"]);
    cap.restore();
    const parsed = JSON.parse(cap.out()) as {
      lane: string;
      confPath: string;
      conf: { source: string };
    };
    expect(parsed.lane).toBe("a");
    expect(parsed.confPath).toContain("a.conf");
    expect(parsed.conf.source).toBe("telegram");
    expect(code).toBe(0);
  });
});

describe("adde logs --json — 스냅샷 {proj,lane,path,exists,lines} (SC-001 Happy)", () => {
  it("transcript 존재 시 exists:true 와 lines 배열을 담은 JSON, exit 0", async () => {
    const paths = lanePaths(tmpBase, "p", "a");
    await appendTranscript(paths, { type: "agent_message_chunk", content: "hello" });
    const cap = captureStdout();
    const code = await runLogs(["p", "a", "--json"]);
    cap.restore();
    const parsed = JSON.parse(cap.out()) as {
      proj: string;
      lane: string;
      exists: boolean;
      lines: string[];
    };
    expect(parsed.proj).toBe("p");
    expect(parsed.lane).toBe("a");
    expect(parsed.exists).toBe(true);
    expect(Array.isArray(parsed.lines)).toBe(true);
    expect(code).toBe(0);
  });
});

describe("adde logs --json — 파일 부재 (SC-001 Error)", () => {
  it("transcript 부재는 오류가 아니라 {exists:false,lines:[]} JSON, exit 0", async () => {
    const cap = captureStdout();
    const code = await runLogs(["p", "nolane", "--json"]);
    cap.restore();
    const parsed = JSON.parse(cap.out()) as { exists: boolean; lines: string[] };
    expect(parsed.exists).toBe(false);
    expect(parsed.lines).toEqual([]);
    expect(code).toBe(0);
  });
});

describe("adde down --json — {proj,stopped:true} (SC-001 Happy)", () => {
  it("unloadDaemon 성공 시 stdout 이 {proj,stopped:true} JSON, exit 0", async () => {
    unloadDaemon.mockResolvedValue(undefined);
    const cap = captureStdout();
    const code = await run(["down", "p", "--json"]);
    cap.restore();
    const parsed = JSON.parse(cap.out()) as { proj: string; stopped: boolean };
    expect(parsed).toEqual({ proj: "p", stopped: true });
    expect(code).toBe(0);
  });
});
