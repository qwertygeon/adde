import { afterEach, describe, expect, it, vi } from "vitest";

// N-1 구조 개선 회귀 방지 — up/restart 결과 표면화(surfaceStartResult) 단일 공유 경로 동등성
// (SC-110). restart 폴링에 실패 레인이 포함되면 up 과 동일하게 표면화·exit code 가 나와야 한다.
// launchd·diagnostics 를 모킹해 실 부작용 없이 폴링/요약 로직만 검증(로케일은 test/setup.ts 가 ko 고정).

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

describe("restart 결과 표면화 — up 과 동등 (SC-110 Error)", () => {
  afterEach(() => vi.clearAllMocks());

  it("restart 폴링에 실패 레인이 포함되면 up 과 동일하게 실패 레인을 표면화하고 exit 1", async () => {
    unloadDaemon.mockResolvedValue(undefined);
    loadDaemon.mockResolvedValue(undefined);
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
    const code = await run(["restart", "demo"]);
    cap.restore();
    spyErr.mockRestore();
    expect(code).toBe(1);
    expect(errs.join("")).toContain("bad");
    expect(errs.join("")).toContain("engine spawn ENOENT");
    expect(cap.out()).toContain("실행 중 1"); // upSummary(ko) — running 카운트 반영
  });

  it("restart 전 레인 성공이면 exit 0(up 과 동일 판정 경로)", async () => {
    unloadDaemon.mockResolvedValue(undefined);
    loadDaemon.mockResolvedValue(undefined);
    collectStatus.mockResolvedValue([
      { lane: "a", status: "running", error: null, startedAt: "2099-01-01T00:00:00Z" },
    ]);
    const code = await run(["restart", "demo"]);
    expect(code).toBe(0);
  });

  it("restart 데드라인까지 기동 확정 레인이 없으면(전부 stopped) up 과 동일하게 1 을 반환한다", async () => {
    unloadDaemon.mockResolvedValue(undefined);
    loadDaemon.mockResolvedValue(undefined);
    collectStatus.mockResolvedValue([{ lane: "main", status: "stopped", error: null }]);
    const prev = process.env.ADDE_UP_POLL_MS;
    process.env.ADDE_UP_POLL_MS = "150"; // 폴링 상한 단축(테스트 속도)
    const errs: string[] = [];
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errs.push(String(s));
      return true;
    });
    const code = await run(["restart", "demo"]);
    spyErr.mockRestore();
    if (prev === undefined) delete process.env.ADDE_UP_POLL_MS;
    else process.env.ADDE_UP_POLL_MS = prev;
    expect(code).toBe(1);
    expect(errs.join("")).toContain("부팅"); // upInconclusive 안내(ko) — up 과 동일 문구
  });
});
