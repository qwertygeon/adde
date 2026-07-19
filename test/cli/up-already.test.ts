import { afterEach, describe, expect, it, vi } from "vitest";

// `adde up` 이 이미 등록·상주 중인 데몬을 만나면 launchctl load(=already loaded 실패) 대신
// "이미 기동 중" 을 사용자 터미널에 표면화하는지 검증(SC-007). 등록 잔존 판별·재적재(rekick) 결정은
// 여전히 collectStatus 기반(불변) — 재적재 이후의 신규 부팅 판정(및 신규 기동 분기 전체)은
// readBootReport 기반 리포트 대기로 전환되어(SC-006 restart 순서 포함) mock patch target 도
// 전환한다(research.md §F PROC-002). 잔존 리포트로 오인하지 않는 SC-002·인콘클루시브 SC-004·
// 전부실패 SC-005 등 판정 자체의 세부 로직 검증은 up-boot-report.test.ts 소관(중복 방지).

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

describe("adde up — 이미 기동 중 표면화 (SC-007)", () => {
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

  it("이미 기동 중 + --json 이면 stdout 이 {v,proj,alreadyUp,running} 객체이고 exit 0", async () => {
    daemonRegState.mockResolvedValue({ plistExists: true, launchctlRegistered: true });
    collectStatus.mockResolvedValue([{ lane: "a", status: "running", error: null }]);
    const cap = captureStdout();
    const code = await run(["up", "demo", "--json"]);
    cap.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out()) as {
      v: number;
      proj: string;
      alreadyUp: boolean;
      running: number;
    };
    expect(parsed).toEqual({ v: 1, proj: "demo", alreadyUp: true, running: 1 });
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

  it("데몬 미등록이면 loadDaemon 을 호출하고 전 레인 성공 시 0(리포트 대기 판정 합류)", async () => {
    daemonRegState.mockResolvedValue({ plistExists: false, launchctlRegistered: false });
    loadDaemon.mockResolvedValue(undefined);
    readBootReport.mockResolvedValueOnce(null).mockResolvedValue({
      v: 1,
      bootId: 1,
      bootedAt: "x",
      lanes: [{ lane: "main", status: "running" }],
      running: 1,
    });
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    expect(code).toBe(0);
    expect(loadDaemon).toHaveBeenCalledWith("demo");
  });

  // N-1 구조 개선 회귀 방지(B1) — 판정 메커니즘이 리포트 대기로 재작성되어도 "실패 레인
  // 표면화 + exit 1" 표면 계약 자체는 삭제되지 않았음을 증명한다(구 SC-020 규약의 리포트 기반 승계).
  it("기동 실패 레인이 있으면 up 이 바로 실패 레인을 표기하고 1 을 반환한다 (B1, 리포트 기반)", async () => {
    daemonRegState.mockResolvedValue({ plistExists: false, launchctlRegistered: false });
    loadDaemon.mockResolvedValue(undefined);
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
    const code = await run(["up", "demo"]);
    cap.restore();
    spyErr.mockRestore();
    expect(code).toBe(1);
    expect(errs.join("")).toContain("bad");
    expect(errs.join("")).toContain("engine spawn ENOENT");
  });

  it("이미 기동 중이고 stale(하트비트 끊긴) 레인이 있으면 표면화하고 1 을 반환한다", async () => {
    daemonRegState.mockResolvedValue({ plistExists: true, launchctlRegistered: true });
    collectStatus.mockResolvedValue([
      { lane: "ok", status: "running", error: null },
      { lane: "hung", status: "stale", error: null },
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
    expect(errs.join("")).toContain("hung");
    expect(errs.join("")).toContain("stale");
  });

  // SC-006 (FR-007 통합): 등록 잔존 + running===0(죽은-등록, 부팅-실패-잔존 포함) — 재적재
  // (unload+load) 판단 자체는 collectStatus 기반으로 불변. 재적재 후 판정은 리포트 대기 경로로 합류한다.
  it("등록 잔존 + running===0(죽은-등록, 부팅-실패-잔존 포함) 이면 재적재(unload+load) 한다", async () => {
    daemonRegState.mockResolvedValue({ plistExists: true, launchctlRegistered: true });
    unloadDaemon.mockResolvedValue(undefined);
    loadDaemon.mockResolvedValue(undefined);
    // 재적재 판단(collectStatus 1회, 불변) — running===0(죽은-등록) 관측 시 rekick 트리거.
    collectStatus.mockResolvedValue([{ lane: "a", status: "stopped", error: null }]);
    // rekick 후 판정은 리포트 대기 경로로 합류 — readBootReport 가 새 부팅 성공을 즉시 알린다.
    readBootReport.mockResolvedValueOnce(null).mockResolvedValue({
      v: 1,
      bootId: 1,
      bootedAt: "x",
      lanes: [{ lane: "a", status: "running" }],
      running: 1,
    });
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    expect(code).toBe(0);
    expect(unloadDaemon).toHaveBeenCalledWith("demo");
    expect(loadDaemon).toHaveBeenCalledWith("demo");
  });

  it("등록 잔존 + running>=1 이면 기존 alreadyUp 보고(재적재 없음)", async () => {
    daemonRegState.mockResolvedValue({ plistExists: true, launchctlRegistered: true });
    collectStatus.mockResolvedValue([{ lane: "a", status: "running", error: null }]);
    const cap = captureStdout();
    const code = await run(["up", "demo"]);
    cap.restore();
    expect(code).toBe(0);
    expect(unloadDaemon).not.toHaveBeenCalled();
    expect(loadDaemon).not.toHaveBeenCalled();
  });

  // SC-025(008-cycle)/현 FR-024 상당: up/restart 는 halt 상태를 초기화한다(사용자 명령 = 명시적 재시도).
  describe("halt 초기화", () => {
    it("up 은 등록 잔존 분기에서 clearHalt(base, proj) 를 호출한다", async () => {
      daemonRegState.mockResolvedValue({ plistExists: true, launchctlRegistered: true });
      collectStatus.mockResolvedValue([{ lane: "a", status: "running", error: null }]);
      const cap = captureStdout();
      await run(["up", "demo"]);
      cap.restore();
      // 확정 시그니처(research.md): clearHalt(base, proj) — base 는 defaultBase() 해석값이라
      // 테스트가 정확한 문자열을 알 필요 없이 두 번째 인자(proj)만 고정 검증한다.
      expect(clearHalt).toHaveBeenCalledWith(expect.anything(), "demo");
    });

    it("up 은 신규 기동(미등록) 분기에서도 clearHalt(base, proj) 를 호출한다", async () => {
      daemonRegState.mockResolvedValue({ plistExists: false, launchctlRegistered: false });
      loadDaemon.mockResolvedValue(undefined);
      readBootReport.mockResolvedValueOnce(null).mockResolvedValue({
        v: 1,
        bootId: 1,
        bootedAt: "x",
        lanes: [{ lane: "main", status: "running" }],
        running: 1,
      });
      const cap = captureStdout();
      await run(["up", "demo"]);
      cap.restore();
      expect(clearHalt).toHaveBeenCalledWith(expect.anything(), "demo");
    });

    // SC-006 (FR-007): 신 restart 계약은 리포트 대기 판정으로 기동 결과를 확정한다 — fake
    // readBootReport 를 주입해 판정이 즉시 수렴하게 한다.
    it("restart 는 clearHalt → unloadDaemon → loadDaemon 순서로 halt 를 해제한 뒤 기동한다 (SC-006)", async () => {
      const callOrder: string[] = [];
      clearHalt.mockImplementation(async () => {
        callOrder.push("clearHalt");
      });
      unloadDaemon.mockImplementation(async () => {
        callOrder.push("unloadDaemon");
      });
      loadDaemon.mockImplementation(async () => {
        callOrder.push("loadDaemon");
      });
      readBootReport.mockResolvedValueOnce(null).mockResolvedValue({
        v: 1,
        bootId: 1,
        bootedAt: "x",
        lanes: [{ lane: "a", status: "running" }],
        running: 1,
      });

      const code = await run(["restart", "demo"]);

      expect(code).toBe(0);
      expect(callOrder).toEqual(["clearHalt", "unloadDaemon", "loadDaemon"]);
    });
  });
});
