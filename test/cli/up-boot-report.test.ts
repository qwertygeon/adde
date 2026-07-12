import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SC-002·003·004·005·008·009·012·015 — up 의 신규 부팅 리포트 대기 판정(waitForBootReport 기반).
// daemonRegState 는 항상 미등록(fresh boot 경로)으로 고정해, 등록 분기(rekick/alreadyUp, 담당:
// up-already.test.ts)와 무관하게 리포트 판정 로직만 독립적으로 검증한다. mock patch target 은
// Test Authoring Contract(PROC-002) 고정 — readBootReport 를 src/core/boot-report.js 에서 patch.

const { loadDaemon, daemonRegState, unloadDaemon, collectStatus, clearHalt } = vi.hoisted(() => ({
  loadDaemon: vi.fn(),
  daemonRegState: vi.fn(),
  unloadDaemon: vi.fn(),
  collectStatus: vi.fn(),
  clearHalt: vi.fn(),
}));
const { readBootReport } = vi.hoisted(() => ({ readBootReport: vi.fn() }));

vi.mock("../../src/core/launchd.js", () => ({ loadDaemon, daemonRegState, unloadDaemon }));
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

function captureStderr(): { err: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  return { err: () => chunks.join(""), restore: () => spy.mockRestore() };
}

beforeEach(() => {
  vi.clearAllMocks();
  daemonRegState.mockResolvedValue({ plistExists: false, launchctlRegistered: false });
  loadDaemon.mockResolvedValue(undefined);
  clearHalt.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("자기 부팅만 소비 (SC-002 Edge)", () => {
  it("잔존 리포트(bootId=k)로 단정하지 않고 새 리포트(bootId=k+1)가 나타날 때까지 대기한다", async () => {
    let call = 0;
    readBootReport.mockImplementation(async () => {
      call++;
      if (call <= 2) {
        // baseline 조회(1회) + waitForBootReport 첫 tick(1회) 모두 잔존 리포트(bootId=5, 이전 실패)를 본다.
        return {
          v: 1,
          bootId: 5,
          bootedAt: "2026-01-01T00:00:00.000Z",
          lanes: [{ lane: "a", status: "error", error: "OLD FAIL" }],
          running: 0,
        };
      }
      // 신규 부팅 리포트(bootId=6) 등장 — strict-greater 충족 시점에만 판정 확정.
      return {
        v: 1,
        bootId: 6,
        bootedAt: "2026-01-01T00:05:00.000Z",
        lanes: [{ lane: "a", status: "running" }],
        running: 1,
      };
    });
    const cap = captureStdout();
    const errs = captureStderr();
    const code = await run(["up", "demo"]);
    cap.restore();
    errs.restore();
    expect(code).toBe(0);
    expect(errs.err()).not.toContain("OLD FAIL"); // 잔존 리포트로 단정하지 않음
    expect(cap.out()).toContain("실행 중 1");
  });
});

describe("실패 레인 stderr 표면화 (SC-003 Error)", () => {
  it("리포트의 실패 레인명+사유가 stderr 에 표면화된다", async () => {
    let call = 0;
    readBootReport.mockImplementation(async () => {
      call++;
      if (call === 1) return null; // baseline: 리포트 부재(baseline=0)
      return {
        v: 1,
        bootId: 1,
        bootedAt: "x",
        lanes: [{ lane: "B", status: "error", error: "markdown root 누락" }],
        running: 0,
      };
    });
    const errs = captureStderr();
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    errs.restore();
    expect(code).toBe(1);
    expect(errs.err()).toContain("B (markdown root 누락)");
  });
});

describe("리포트 없음 크래시 (SC-004 Error, CLI측)", () => {
  it("대응 리포트가 끝내 나타나지 않으면 대기 상한 후 데몬 부팅 크래시로 보고한다", async () => {
    readBootReport.mockResolvedValue(null); // baseline=0, 이후로도 결코 bootId>0 이 되지 않음
    const prev = process.env.ADDE_UP_WAIT_MS;
    process.env.ADDE_UP_WAIT_MS = "150";
    const errs = captureStderr();
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    errs.restore();
    if (prev === undefined) delete process.env.ADDE_UP_WAIT_MS;
    else process.env.ADDE_UP_WAIT_MS = prev;
    expect(code).toBe(1);
    expect(errs.err()).toContain("부팅"); // run.upInconclusive(ko) 안내
  });
});

describe("전부 실패 즉시 확정 (SC-005 Error)", () => {
  it("running=0 + 전부 error 리포트는 대기 상한을 소진하지 않고 즉시 3사유를 표면화한다", async () => {
    let call = 0;
    readBootReport.mockImplementation(async () => {
      call++;
      if (call === 1) return null; // baseline
      return {
        v: 1,
        bootId: 1,
        bootedAt: "x",
        lanes: [
          { lane: "a", status: "error", error: "fail-a" },
          { lane: "b", status: "error", error: "fail-b" },
          { lane: "c", status: "error", error: "fail-c" },
        ],
        running: 0,
      };
    });
    const start = Date.now();
    const errs = captureStderr();
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    errs.restore();
    const elapsed = Date.now() - start;
    expect(code).toBe(1);
    expect(errs.err()).toContain("fail-a");
    expect(errs.err()).toContain("fail-b");
    expect(errs.err()).toContain("fail-c");
    expect(call).toBeLessThanOrEqual(2); // 즉시 확정 — 추가 폴링 없음
    expect(elapsed).toBeLessThan(1000); // 대기 상한(기본 8000ms) 소진 없이 즉시 반환
  });
});

describe("조건부 exit (SC-008 Happy/Error)", () => {
  it("실행 중 레인 + 실패 레인이 1개 이상이면 exit 1", async () => {
    readBootReport.mockResolvedValueOnce(null).mockResolvedValue({
      v: 1,
      bootId: 1,
      bootedAt: "x",
      lanes: [
        { lane: "a", status: "running" },
        { lane: "b", status: "error", error: "boom" },
      ],
      running: 1,
    });
    const code = await run(["up", "demo"]);
    expect(code).toBe(1);
  });

  it("전부 running 이면 exit 0", async () => {
    readBootReport.mockResolvedValueOnce(null).mockResolvedValue({
      v: 1,
      bootId: 1,
      bootedAt: "x",
      lanes: [{ lane: "a", status: "running" }],
      running: 1,
    });
    const code = await run(["up", "demo"]);
    expect(code).toBe(0);
  });
});

describe("ADDE_UP_WAIT_MS 대기 상한 (SC-009 Edge)", () => {
  it("env 로 대기 상한을 단축할 수 있다(기본 8000ms 를 기다리지 않음)", async () => {
    readBootReport.mockResolvedValue(null); // 리포트가 그 시점까지 미기록
    const prev = process.env.ADDE_UP_WAIT_MS;
    process.env.ADDE_UP_WAIT_MS = "150";
    const start = Date.now();
    const errs = captureStderr();
    const code = await run(["up", "demo"]);
    errs.restore();
    const elapsed = Date.now() - start;
    if (prev === undefined) delete process.env.ADDE_UP_WAIT_MS;
    else process.env.ADDE_UP_WAIT_MS = prev;
    expect(code).toBe(1);
    expect(elapsed).toBeLessThan(2000); // 단축된 150ms 상한이 적용됨(기본 8000ms 아님)
  });
});

describe("첫 기동 안전 (SC-012 Edge)", () => {
  it("리포트 파일 부재(첫 기동)도 오탐·행 없이 정상 판정한다", async () => {
    let call = 0;
    readBootReport.mockImplementation(async () => {
      call++;
      if (call <= 2) return null; // baseline=0(부재) + 첫 tick 도 아직 부재
      return {
        v: 1,
        bootId: 1,
        bootedAt: "x",
        lanes: [{ lane: "a", status: "running" }],
        running: 1,
      };
    });
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out()).toContain("실행 중 1");
  });
});

describe("구 변수 무시 (SC-015 Edge)", () => {
  it("ADDE_UP_POLL_MS 는 더 이상 대기 상한에 반영되지 않고, 이관 힌트만 1회 표면화된다", async () => {
    let call = 0;
    readBootReport.mockImplementation(async () => {
      call++;
      if (call <= 2) return null;
      return {
        v: 1,
        bootId: 1,
        bootedAt: "x",
        lanes: [{ lane: "a", status: "running" }],
        running: 1,
      };
    });
    const prevPoll = process.env.ADDE_UP_POLL_MS;
    const prevWait = process.env.ADDE_UP_WAIT_MS;
    delete process.env.ADDE_UP_WAIT_MS;
    // 구 변수 — 대기 상한으로 잘못 쓰이면 이 값(50ms) 만에 타임아웃 확정될 것이다.
    process.env.ADDE_UP_POLL_MS = "50";
    const start = Date.now();
    const errs = captureStderr();
    const code = await run(["up", "demo"]);
    errs.restore();
    const elapsed = Date.now() - start;
    if (prevPoll === undefined) delete process.env.ADDE_UP_POLL_MS;
    else process.env.ADDE_UP_POLL_MS = prevPoll;
    if (prevWait === undefined) delete process.env.ADDE_UP_WAIT_MS;
    else process.env.ADDE_UP_WAIT_MS = prevWait;
    expect(code).toBe(0); // 구 변수(50ms)가 대기 상한이었다면 첫 tick(300ms) 전에 타임아웃(exit 1)했을 것
    expect(elapsed).toBeGreaterThanOrEqual(200); // 최소 1 tick 간격을 실제로 기다렸음을 방증
    expect(errs.err()).toContain("ADDE_UP_POLL_MS"); // run.pollMsDeprecated 이관 힌트
  });
});
