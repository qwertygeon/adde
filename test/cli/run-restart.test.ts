import { afterEach, describe, expect, it, vi } from "vitest";

// restart 결과 표면화 + exit code (FR-008·FR-009) — SC-014·SC-015.
// launchctl/diagnostics 부작용을 피하려고 launchd·diagnostics 를 모킹한다(로케일은 test/setup.ts 가 ko 고정).

const { loadDaemon, unloadDaemon, collectStatus, clearHalt } = vi.hoisted(() => ({
  loadDaemon: vi.fn(),
  unloadDaemon: vi.fn(),
  collectStatus: vi.fn(),
  clearHalt: vi.fn(),
}));

vi.mock("../../src/core/launchd.js", () => ({ loadDaemon, unloadDaemon }));
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

function captureStderr(): { err: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  return { err: () => chunks.join(""), restore: () => spy.mockRestore() };
}

describe("adde restart — 실패 레인 표면화 (SC-014)", () => {
  afterEach(() => vi.clearAllMocks());

  it("collectStatus 주입 상태에 실패 레인이 포함되면 요약에 표면화되고 exit 0 으로 조용히 끝나지 않는다", async () => {
    clearHalt.mockResolvedValue(undefined);
    unloadDaemon.mockResolvedValue(undefined);
    loadDaemon.mockResolvedValue(undefined);
    // startedAt 을 미래로 주입해 "이번 재기동의 신선한 실패"로 즉시 확정(폴링 대기 없이 수렴).
    collectStatus.mockResolvedValue([
      { lane: "ok", status: "running", error: null, startedAt: "2099-01-01T00:00:00Z" },
      {
        lane: "bad",
        status: "error",
        error: "engine spawn ENOENT",
        startedAt: "2099-01-01T00:00:00Z",
      },
    ]);
    const errCap = captureStderr();
    const cap = captureStdout();
    const code = await run(["restart", "demo"]);
    cap.restore();
    errCap.restore();
    expect(code).toBe(1);
    expect(errCap.err()).toContain("bad");
    expect(errCap.err()).toContain("engine spawn ENOENT");
  });
});

describe("adde restart — exit code (SC-015)", () => {
  afterEach(() => vi.clearAllMocks());

  it("기동 실패 레인이 1개 이상이면 exit 1", async () => {
    clearHalt.mockResolvedValue(undefined);
    unloadDaemon.mockResolvedValue(undefined);
    loadDaemon.mockResolvedValue(undefined);
    collectStatus.mockResolvedValue([
      { lane: "bad", status: "error", error: "boom", startedAt: "2099-01-01T00:00:00Z" },
    ]);
    const cap = captureStdout();
    const errCap = captureStderr();
    const code = await run(["restart", "demo"]);
    cap.restore();
    errCap.restore();
    expect(code).toBe(1);
  });

  it("전부 성공이면 exit 0", async () => {
    clearHalt.mockResolvedValue(undefined);
    unloadDaemon.mockResolvedValue(undefined);
    loadDaemon.mockResolvedValue(undefined);
    collectStatus.mockResolvedValue([
      { lane: "a", status: "running", error: null, startedAt: "2099-01-01T00:00:00Z" },
    ]);
    const cap = captureStdout();
    const code = await run(["restart", "demo"]);
    cap.restore();
    expect(code).toBe(0);
  });
});
