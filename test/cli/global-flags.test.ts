import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// 전역 플래그(-v/--version, -h/--help) 위치 무관 인식 — SC-004·SC-005(구 번호 — 이전 cycle).
// up 은 값 플래그가 없어 --version 을 값으로 흡수하지 않는다(ADR-003 version>help>error).
// loadDaemon 미호출로 "up 미진행"을 확정한다(up-already.test.ts 와 동일한 모킹 관례).

const { loadDaemon, unloadDaemon, daemonRegState, collectStatus, clearHalt } = vi.hoisted(() => ({
  loadDaemon: vi.fn(),
  unloadDaemon: vi.fn(),
  daemonRegState: vi.fn(),
  collectStatus: vi.fn(),
  clearHalt: vi.fn(),
}));

vi.mock("../../src/core/launchd.js", () => ({ loadDaemon, unloadDaemon, daemonRegState }));
vi.mock("../../src/core/diagnostics.js", () => ({ collectStatus, clearHalt }));

import { run } from "../../src/cli/run.js";

function captureStdout(): { out: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  return { out: () => chunks.join(""), restore: () => spy.mockRestore() };
}

afterEach(() => vi.clearAllMocks());

describe("adde up --version — 전역 버전 위치 무관 인식 (SC-004 Happy)", () => {
  it("버전 문자열을 stdout 에 출력하고 exit 0, up 은 진행하지 않는다", async () => {
    const cap = captureStdout();
    const code = await run(["up", "--version"]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out()).toMatch(/adde \d+\.\d+\.\d+/);
    expect(loadDaemon).not.toHaveBeenCalled();
    expect(daemonRegState).not.toHaveBeenCalled();
  });
});

describe("adde logs --help — 명령 선행 help (SC-005 Happy)", () => {
  it("logs 명령의 usage 를 출력하고 exit 0", async () => {
    const cap = captureStdout();
    const code = await run(["logs", "--help"]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out()).toContain("adde logs");
  });
});

describe("--help 전역 / 인자 없음 — 명령 미포함 help (SC-005 Edge)", () => {
  it("run(['--help']) 는 전역 usage 를 출력하고 exit 0", async () => {
    const cap = captureStdout();
    const code = await run(["--help"]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out()).toContain("adde");
    expect(cap.out()).toMatch(/status|doctor|logs/);
  });

  it("run([]) 도 동일하게 전역 usage 를 출력하고 exit 0", async () => {
    const cap = captureStdout();
    const code = await run([]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out()).toMatch(/status|doctor|logs/);
  });
});

describe("성공하는 lane ls — 정상 완료 exit 0 유지 (SC-008 Happy)", () => {
  let tmpBase: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-global-flags-lanels-"));
    prevHome = process.env["ADDE_HOME"];
    process.env["ADDE_HOME"] = tmpBase;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env["ADDE_HOME"];
    else process.env["ADDE_HOME"] = prevHome;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it("adde lane ls <proj> (레인 부재) 는 exit 0", async () => {
    const { runLane } = await import("../../src/cli/lane.js");
    const cap = captureStdout();
    const code = await runLane(["ls", "demo"]);
    cap.restore();
    expect(code).toBe(0);
  });
});
