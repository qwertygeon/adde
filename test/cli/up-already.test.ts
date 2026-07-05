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

  it("데몬이 등록돼 있고 실패 레인이 없으면 loadDaemon 없이 실행 중 안내 후 0", async () => {
    daemonRegState.mockResolvedValue({ plistExists: true, launchctlRegistered: true });
    collectStatus.mockResolvedValue([
      { lane: "a", status: "running", error: null },
      { lane: "b", status: "stopped", error: null },
    ]);
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    expect(code).toBe(0);
    expect(loadDaemon).not.toHaveBeenCalled();
    expect(cap.out()).toContain("이미 기동");
    expect(cap.out()).toContain("1/2"); // running/total
  });

  it("이미 기동 중이어도 실패(error/dead) 레인이 있으면 표면화하고 1 을 반환한다", async () => {
    daemonRegState.mockResolvedValue({ plistExists: true, launchctlRegistered: true });
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
    expect(loadDaemon).not.toHaveBeenCalled();
    expect(cap.out()).toContain("이미 기동");
    expect(errs.join("")).toContain("bad");
    expect(errs.join("")).toContain("engine spawn ENOENT");
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
    // 데몬이 남긴 error runtime.json 을 status 가 error 로 보고하는 상황(이번 기동 = startedAt 미래).
    collectStatus.mockResolvedValue([
      { lane: "ok", status: "running", error: null, startedAt: "2099-01-01T00:00:00Z" },
      {
        lane: "bad",
        status: "error",
        error: "engine spawn ENOENT",
        startedAt: "2099-01-01T00:00:00Z",
      },
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

  it("데드라인까지 아무 레인도 기동 못 하면(전부 stopped) 데몬 부팅 실패로 보고하고 1 을 반환한다", async () => {
    daemonRegState.mockResolvedValue({ plistExists: false, launchctlRegistered: false });
    loadDaemon.mockResolvedValue(undefined);
    // 데몬이 부팅 중 크래시 → runtime.json 을 아무도 못 남김 → 전 레인 stopped 로 미확정 유지.
    collectStatus.mockResolvedValue([{ lane: "main", status: "stopped", error: null }]);
    const prev = process.env.ADDE_UP_POLL_MS;
    process.env.ADDE_UP_POLL_MS = "150"; // 폴링 상한 단축(테스트 속도)
    const errs: string[] = [];
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errs.push(String(s));
      return true;
    });
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    spyErr.mockRestore();
    if (prev === undefined) delete process.env.ADDE_UP_POLL_MS;
    else process.env.ADDE_UP_POLL_MS = prev;
    expect(code).toBe(1);
    expect(errs.join("")).toContain("부팅"); // upInconclusive 안내(ko)
  });

  it("이전 기동의 stale error 레코드는 실패로 오인하지 않고 running 으로 수렴한다 (리뷰 회귀)", async () => {
    daemonRegState.mockResolvedValue({ plistExists: false, launchctlRegistered: false });
    loadDaemon.mockResolvedValue(undefined);
    let call = 0;
    // 1회차: 이전 기동에서 남은 stale error(과거 startedAt — down 이 실패 레인 runtime 을 안 지움).
    // 2회차: 새 데몬이 dead-pid 레코드를 정리·재기동해 running 으로 수렴.
    collectStatus.mockImplementation(async () => {
      call++;
      return call === 1
        ? [
            {
              lane: "main",
              status: "error",
              error: "old failure",
              startedAt: "2000-01-01T00:00:00Z",
            },
          ]
        : [{ lane: "main", status: "running", error: null, startedAt: "2099-01-01T00:00:00Z" }];
    });
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    expect(code).toBe(0); // stale error 를 이번 기동 실패로 세지 않음
    expect(call).toBeGreaterThanOrEqual(2); // 미확정(stale)이라 최소 1회 재폴링
  });
});
