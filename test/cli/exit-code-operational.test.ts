import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runStatus } from "../../src/cli/ops.js";
import { writeRuntime } from "../../src/core/runtime-state.js";
import { lanePaths } from "../../src/shared/paths.js";
import type { RuntimeInfo } from "../../src/core/runtime-state.js";

// 운영 실패·미지원 서브커맨드·비정상 판정 → exit 1 유지(SC-007, FR-005 경계). exit 2(잘못된 호출)
// 로 잘못 승격되지 않음을 회귀 고정 — ADR-002 의 exit 1 유지 경계(GAP-001)를 포함한다.

let tmpBase: string;
let prevHome: string | undefined;

const CONF = `source=telegram\nbackend=acp\nengine=claude-agent-acp\nchannel=telegram\nperm_tier=acp\nacp_version=v1\n`;

function writeConf(proj: string, lane: string): void {
  const dir = path.join(tmpBase, proj, "lanes.d");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${lane}.conf`), CONF);
}

function deadRuntime(lane: string): RuntimeInfo {
  return {
    v: 1,
    pid: 999999, // isPidAlive 가 false 로 판정할 존재하지 않는 pid → dead
    lane,
    sessionId: "s",
    startedAt: new Date().toISOString(),
    source: "telegram",
    backend: "acp",
    engine: "claude-agent-acp",
  };
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-exit-op-"));
  prevHome = process.env["ADDE_HOME"];
  process.env["ADDE_HOME"] = tmpBase;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevHome;
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.restoreAllMocks();
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

describe("adde completion foo — enum 값 검증 실패 (SC-007 Error)", () => {
  it("미지원 shell 이름은 exit 1(2 아님)", async () => {
    const { run } = await import("../../src/cli/run.js");
    const cap = captureStdio();
    const code = await run(["completion", "foo"]);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.err()).toContain("foo");
  });
});

describe("adde lane foo — 미지원 서브커맨드 (SC-007 Edge, ADR-002)", () => {
  it("알 수 없는 lane 서브커맨드는 usage 안내와 함께 exit 1(2 아님)", async () => {
    const { runLane } = await import("../../src/cli/lane.js");
    const cap = captureStdio();
    const code = await runLane(["foo"]);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.err()).toMatch(/foo/);
  });
});

describe("adde status <proj> — 비정상 레인(dead) 판정 (SC-007 Error)", () => {
  it("dead 레인이 있으면 exit 1(2 아님)", async () => {
    writeConf("p", "l");
    await writeRuntime(lanePaths(tmpBase, "p", "l"), deadRuntime("l"));
    const cap = captureStdio();
    const code = await runStatus(["p"]);
    cap.restore();
    expect(code).toBe(1);
  });
});
