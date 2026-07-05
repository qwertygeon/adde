import { afterEach, describe, expect, it, vi } from "vitest";

// `adde up` 이 이미 등록·상주 중인 데몬을 만나면 launchctl load(=already loaded 실패) 대신
// "이미 기동 중" 을 사용자 터미널에 표면화하는지 검증. 실 launchctl/데몬 부작용을 피하려고
// launchd·diagnostics 를 모킹한다(로케일은 test/setup.ts 가 ko 고정).

const { loadDaemon, daemonRegState, collectStatus } = vi.hoisted(() => ({
  loadDaemon: vi.fn(),
  daemonRegState: vi.fn(),
  collectStatus: vi.fn(),
}));

vi.mock("../../src/core/launchd.js", () => ({ loadDaemon, daemonRegState }));
vi.mock("../../src/core/diagnostics.js", () => ({ collectStatus }));

import { run } from "../../src/cli/run.js";

function captureStdout(): { out: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  return { out: () => chunks.join(""), restore: () => spy.mockRestore() };
}

describe("adde up — 이미 기동 중 표면화", () => {
  afterEach(() => vi.clearAllMocks());

  it("데몬이 등록돼 있으면 loadDaemon 없이 실행 중 안내 후 0", async () => {
    daemonRegState.mockResolvedValue({ plistExists: true, launchctlRegistered: true });
    collectStatus.mockResolvedValue([{ status: "running" }, { status: "dead" }]);
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    expect(code).toBe(0);
    expect(loadDaemon).not.toHaveBeenCalled();
    expect(cap.out()).toContain("이미 기동");
    expect(cap.out()).toContain("1/2"); // running/total
  });

  it("데몬 미등록이면 loadDaemon 을 호출하고 전 레인 성공 시 0", async () => {
    daemonRegState.mockResolvedValue({ plistExists: false, launchctlRegistered: false });
    loadDaemon.mockResolvedValue(undefined);
    collectStatus.mockResolvedValue([{ lane: "main", status: "running", error: null }]);
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    expect(code).toBe(0);
    expect(loadDaemon).toHaveBeenCalledWith("demo");
  });

  it("기동 실패 레인이 있으면 up 이 바로 실패 레인을 표기하고 1 을 반환한다 (B1)", async () => {
    daemonRegState.mockResolvedValue({ plistExists: false, launchctlRegistered: false });
    loadDaemon.mockResolvedValue(undefined);
    // 데몬이 남긴 error runtime.json 을 status 가 error 로 보고하는 상황.
    collectStatus.mockResolvedValue([
      { lane: "ok", status: "running", error: null },
      { lane: "bad", status: "error", error: "engine spawn ENOENT" },
    ]);
    const errs: string[] = [];
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errs.push(String(s));
      return true;
    });
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    spyErr.mockRestore();
    expect(code).toBe(1);
    expect(errs.join("")).toContain("bad");
    expect(errs.join("")).toContain("engine spawn ENOENT");
  });
});
