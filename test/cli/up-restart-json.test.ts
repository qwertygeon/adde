import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// up/restart --json (FR-001·FR-002·FR-003) — 기존 BootReport 산출을 그대로 JSON 으로 stdout 에
// 낸다(SC-002). 키 집합이 기존 산출(v/bootId/bootedAt/lanes/running)만 포함하는지도 검증한다(SC-003).
// launchd/diagnostics/boot-report 를 모킹해 결정적으로 판정 경로만 검증한다(up-restart-surface.test.ts 관행).

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

const ALLOWED_KEYS = new Set(["v", "bootId", "bootedAt", "lanes", "running"]);

beforeEach(() => {
  // 공유 기본 모킹 — daemonRegState 는 미등록(신규 기동 경로)으로 고정.
  daemonRegState.mockResolvedValue({ launchctlRegistered: false });
  clearHalt.mockResolvedValue(undefined);
  loadDaemon.mockResolvedValue(undefined);
});

afterEach(() => vi.clearAllMocks());

describe("adde up --json — 전 레인 성공 (SC-002 Happy)", () => {
  it("stdout 이 BootReport JSON(running=2) 이고 exit 0", async () => {
    readBootReport.mockResolvedValueOnce(null).mockResolvedValue({
      v: 1,
      bootId: 1,
      bootedAt: "2026-01-01T00:00:00.000Z",
      lanes: [
        { lane: "a", status: "running" },
        { lane: "b", status: "running" },
      ],
      running: 2,
    });
    const cap = captureStdout();
    const code = await run(["up", "demo", "--json"]);
    cap.restore();
    const parsed = JSON.parse(cap.out()) as { running: number; lanes: unknown[] };
    expect(parsed.running).toBe(2);
    expect(parsed.lanes).toHaveLength(2);
    expect(code).toBe(0);
  });
});

describe("adde up --json — 실패 레인 존재 (SC-002 Error)", () => {
  it("JSON 에 error 레인이 포함되고 exit 1", async () => {
    readBootReport.mockResolvedValueOnce(null).mockResolvedValue({
      v: 1,
      bootId: 1,
      bootedAt: "2026-01-01T00:00:00.000Z",
      lanes: [
        { lane: "ok", status: "running" },
        { lane: "bad", status: "error", error: "engine spawn ENOENT" },
      ],
      running: 1,
    });
    const cap = captureStdout();
    const code = await run(["up", "demo", "--json"]);
    cap.restore();
    const parsed = JSON.parse(cap.out()) as { lanes: Array<{ lane: string; status: string }> };
    expect(parsed.lanes.some((l) => l.lane === "bad" && l.status === "error")).toBe(true);
    expect(code).toBe(1);
  });
});

describe("adde up --json — inconclusive(리포트 부재, ADR-004) (SC-002 Edge)", () => {
  it("대응 리포트가 끝내 나타나지 않으면 stdout 은 literal null 이고 exit 1", async () => {
    readBootReport.mockResolvedValue(null);
    const prev = process.env.ADDE_UP_WAIT_MS;
    process.env.ADDE_UP_WAIT_MS = "150"; // 대기 상한 단축(테스트 속도)
    const cap = captureStdout();
    const code = await run(["up", "demo", "--json"]);
    cap.restore();
    if (prev === undefined) delete process.env.ADDE_UP_WAIT_MS;
    else process.env.ADDE_UP_WAIT_MS = prev;
    expect(cap.out().trim()).toBe("null");
    expect(code).toBe(1);
  });
});

describe("adde up --json — 키 집합 = 기존 산출만 (SC-003 Happy)", () => {
  it("JSON 최상위 키가 v/bootId/bootedAt/lanes/running 부분집합이고 신규 파생 필드가 없다", async () => {
    readBootReport.mockResolvedValueOnce(null).mockResolvedValue({
      v: 1,
      bootId: 1,
      bootedAt: "2026-01-01T00:00:00.000Z",
      lanes: [{ lane: "a", status: "running" }],
      running: 1,
    });
    const cap = captureStdout();
    await run(["up", "demo", "--json"]);
    cap.restore();
    const parsed = JSON.parse(cap.out()) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      expect(ALLOWED_KEYS.has(key), `신규 파생 필드 발견: ${key}`).toBe(true);
    }
  });
});
