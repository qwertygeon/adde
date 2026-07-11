import { afterEach, describe, expect, it, vi } from "vitest";

// `adde up` 이 이미 등록·상주 중인 데몬을 만나면 launchctl load(=already loaded 실패) 대신
// "이미 기동 중" 을 사용자 터미널에 표면화하는지 검증. 실 launchctl/데몬 부작용을 피하려고
// launchd·diagnostics 를 모킹한다(로케일은 test/setup.ts 가 ko 고정).

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

  // SC-020 (FR-019 통합): 부팅 결정적 실패의 exit0 전환(daemon 프로세스 자체의 종료 코드)은
  // `up` 커맨드의 실패 레인 표면화·종료코드(1)를 삭제하지 않는다 — 기존 배선(runtime.json
  // status:error → up 폴링 표면화)이 그대로 유지됨을 이 회귀 테스트가 증명한다.
  it("기동 실패 레인이 있으면 up 이 바로 실패 레인을 표기하고 1 을 반환한다 (B1 / SC-020)", async () => {
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

  // SC-015 (FR-015 통합 — 죽은-등록 up 감지 → 재적재): job 등록 잔존하나 프로세스는 죽어있는
  // 상태(부팅-실패-잔존 포함) — running===0 이면 기존 alreadyUp 조기반환 대신 재적재(rekick) 한다.
  it("등록 잔존 + running===0(죽은-등록, 부팅-실패-잔존 포함) 이면 재적재(unload+load) 한다 (SC-015)", async () => {
    daemonRegState.mockResolvedValue({ plistExists: true, launchctlRegistered: true });
    unloadDaemon.mockResolvedValue(undefined);
    loadDaemon.mockResolvedValue(undefined);
    // 1회차(재적재 판단 시점): running===0(죽은-등록) — rekick 트리거.
    // 2회차 이후(재적재 후 폴링): 성공적으로 기동됐다고 가정 — running=1.
    let call = 0;
    collectStatus.mockImplementation(async () => {
      call++;
      return call === 1
        ? [{ lane: "a", status: "stopped", error: null }]
        : [{ lane: "a", status: "running", error: null }];
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

  // SC-025 (FR-024): up/restart 는 halt 상태를 초기화한다(사용자 명령 = 명시적 재시도).
  describe("halt 초기화 (SC-025 Happy)", () => {
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
      collectStatus.mockResolvedValue([{ lane: "main", status: "running", error: null }]);
      const cap = captureStdout();
      await run(["up", "demo"]);
      cap.restore();
      expect(clearHalt).toHaveBeenCalledWith(expect.anything(), "demo");
    });

    // T011 마이그레이션(§PROC-001): 신 restart 계약(FR-008/FR-009)은 up 과 동형으로
    // pollUpResult(collectStatus) 로 기동 결과를 확정한다 — running-lane 을 주입해 폴링이 즉시
    // 수렴하게 한다(미주입 시 collectStatus 가 undefined 를 반환해 rows.some 이 throw 한다).
    it("restart 는 unloadDaemon 전에 clearHalt 를 호출한다", async () => {
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
      collectStatus.mockResolvedValue([
        { lane: "a", status: "running", error: null, startedAt: "2099-01-01T00:00:00Z" },
      ]);

      const code = await run(["restart", "demo"]);

      expect(code).toBe(0);
      expect(callOrder).toEqual(["clearHalt", "unloadDaemon", "loadDaemon"]);
    });
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
