import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runStatus, runDoctorCli, runLogs, runSessions } from "../../src/cli/ops.js";
import { writeRuntime } from "../../src/core/runtime-state.js";
import { lanePaths } from "../../src/shared/paths.js";
import type { RuntimeInfo } from "../../src/core/runtime-state.js";

// 상태 비침해 (NFR-003) — SC-026. status/doctor/logs/sessions 는 레인 state/queue/out 을 읽기만
// 하고 변경·삭제하지 않는다(A-P002). 실행 전후 파일 트리(경로·크기·mtime)를 스냅샷 비교한다.

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

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-ops-readonly-"));
  prevHome = process.env["ADDE_HOME"];
  process.env["ADDE_HOME"] = tmpBase;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevHome;
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function snapshotTree(dir: string): Record<string, { size: number; mtimeMs: number }> {
  const result: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const st = fs.statSync(full);
        result[full] = { size: st.size, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(dir);
  return result;
}

describe("status/doctor/logs/sessions 는 레인 state/queue/out 을 변경·삭제하지 않는다 (SC-026 Happy)", () => {
  it("4개 관찰 명령 실행 전후 파일 트리(경로·크기·mtime)가 불변이다", async () => {
    writeConf("p", "l");
    const paths = lanePaths(tmpBase, "p", "l");
    await writeRuntime(paths, rt(process.pid, "l"));
    fs.mkdirSync(paths.queueDir, { recursive: true });
    fs.writeFileSync(path.join(paths.queueDir, "1.json"), "{}");
    fs.mkdirSync(paths.outDir, { recursive: true });
    fs.writeFileSync(path.join(paths.outDir, "1.md"), "hello");
    fs.writeFileSync(paths.transcriptLog, "line1\n");
    fs.writeFileSync(paths.sessionsFile, "[]\n");

    const spyOut = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const before = snapshotTree(tmpBase);
    await runStatus(["p"]);
    await runDoctorCli(["p"]);
    await runLogs(["p", "l"]);
    await runSessions(["p", "l"]);
    const after = snapshotTree(tmpBase);

    spyOut.mockRestore();
    spyErr.mockRestore();

    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const key of Object.keys(before)) {
      expect(after[key]).toEqual(before[key]);
    }
  });
});
