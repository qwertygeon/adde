import { afterEach, describe, expect, it, vi } from "vitest";

// N-1 구조 개선 회귀 방지 — up/restart 결과 표면화(surfaceStartResult) 단일 공유 경로 동등성.
// 판정 신호가 collectStatus 폴링에서 readBootReport(boot id 비교)로 전환됨에 따라 mock patch
// target 도 전환한다(research.md §F PROC-002) — restart 의 리포트 대기 판정이 up 과 동일하게
// 표면화·exit code 를 내는지 검증.

const { loadDaemon, unloadDaemon, daemonRegState, collectStatus, clearHalt } = vi.hoisted(() => ({
  loadDaemon: vi.fn(),
  unloadDaemon: vi.fn(),
  daemonRegState: vi.fn(),
  collectStatus: vi.fn(),
  clearHalt: vi.fn(),
}));
const { readBootReport } = vi.hoisted(() => ({ readBootReport: vi.fn() }));

vi.mock("../../src/core/launchd.js", () => ({ loadDaemon, unloadDaemon, daemonRegState }));
vi.mock("../../src/core/diagnostics.js", () => ({ collectStatus, clearHalt }));
vi.mock("../../src/core/boot-report.js", () => ({ readBootReport }));

import { run } from "../../src/cli/run.js";

function captureStdout(): { out: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  return { out: () => chunks.join(""), restore: () => spy.mockRestore() };
}

describe("restart 결과 표면화 — up 과 동등 (리포트 기반 판정)", () => {
  afterEach(() => vi.clearAllMocks());

  it("restart 판정 리포트에 실패 레인이 포함되면 up 과 동일하게 실패 레인을 표면화하고 exit 1", async () => {
    unloadDaemon.mockResolvedValue(undefined);
    loadDaemon.mockResolvedValue(undefined);
    clearHalt.mockResolvedValue(undefined);
    readBootReport.mockResolvedValueOnce(null).mockResolvedValue({
      v: 1,
      bootId: 1,
      bootedAt: "x",
      lanes: [
        { lane: "ok", status: "running" },
        { lane: "bad", status: "error", error: "engine spawn ENOENT" },
      ],
      running: 1,
    });
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
    clearHalt.mockResolvedValue(undefined);
    readBootReport.mockResolvedValueOnce(null).mockResolvedValue({
      v: 1,
      bootId: 1,
      bootedAt: "x",
      lanes: [{ lane: "a", status: "running" }],
      running: 1,
    });
    const code = await run(["restart", "demo"]);
    expect(code).toBe(0);
  });

  it("restart 판정에서 대응 리포트가 끝내 나타나지 않으면(대기 상한 초과) up 과 동일하게 1 을 반환한다", async () => {
    unloadDaemon.mockResolvedValue(undefined);
    loadDaemon.mockResolvedValue(undefined);
    clearHalt.mockResolvedValue(undefined);
    readBootReport.mockResolvedValue(null);
    const prev = process.env.ADDE_UP_WAIT_MS;
    process.env.ADDE_UP_WAIT_MS = "150"; // 대기 상한 단축(테스트 속도)
    const errs: string[] = [];
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errs.push(String(s));
      return true;
    });
    const code = await run(["restart", "demo"]);
    spyErr.mockRestore();
    if (prev === undefined) delete process.env.ADDE_UP_WAIT_MS;
    else process.env.ADDE_UP_WAIT_MS = prev;
    expect(code).toBe(1);
    expect(errs.join("")).toContain("부팅"); // run.upInconclusive 안내(ko) — up 과 동일 문구
  });
});
