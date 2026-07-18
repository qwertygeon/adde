import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { waitFor } from "../helpers/wait.js";

// SC-003·014·019·021 — run.ts 의 데몬 부팅 exit code 전환·크래시 가드 설치 범위·SIGTERM graceful.
// confirmed 시그니처: run() 자체는 시그니처 불변 — 반환값(부팅 결과)과 실 process.exit(크래시
// 가드·SIGTERM 경로) 양쪽으로 관찰한다. 크래시 가드는 기본 emitter=process 로 설치되므로
// (ADR-002 — 데몬 전용, 단발 CLI 미설치) 실 process 이벤트로 트리거하고, 테스트 종료 시
// diff 기반으로 "이 테스트가 새로 추가한" 리스너만 제거해 vitest 자체 핸들러를 보존한다.

const { supervisorUp, supervisorDown } = vi.hoisted(() => ({
  supervisorUp: vi.fn(),
  supervisorDown: vi.fn(),
}));

vi.mock("../../src/core/supervisor.js", () => ({ supervisorUp, supervisorDown }));

import { run } from "../../src/cli/run.js";

const WATCHED_EVENTS = ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGINT"] as const;

// process 는 NodeJS.Process(EventEmitter 확장)이나, 타입 선언이 알려진 이벤트별로 세분화된
// 오버로드를 가져 임의 문자열 유니온으로 listeners()/emit() 을 호출하면 오버로드 매칭에 실패한다.
// 테스트가 합성 이벤트를 주입/조회하는 용도이므로 EventEmitter 로 캐스팅해 일반 시그니처를 쓴다.
const proc = process as unknown as NodeJS.EventEmitter;

let baseline: Record<string, unknown[]>;
let prevAddeHome: string | undefined;
let tmpAddeHome: string;

beforeEach(() => {
  baseline = {};
  for (const ev of WATCHED_EVENTS) baseline[ev] = proc.listeners(ev).slice();
  vi.clearAllMocks();
  // runDaemonForeground 는 crash-loop 의 daemon-boots.json 을 defaultBase()(ADDE_HOME)에 실 fs 로
  // 기록한다 — 실 홈 디렉터리 오염을 막기 위해 격리된 tmp 로 override.
  prevAddeHome = process.env["ADDE_HOME"];
  tmpAddeHome = fs.mkdtempSync(path.join(os.tmpdir(), "adde-run-boot-"));
  process.env["ADDE_HOME"] = tmpAddeHome;
});

afterEach(() => {
  for (const ev of WATCHED_EVENTS) {
    const before = new Set(baseline[ev]);
    for (const l of proc.listeners(ev)) {
      if (!before.has(l)) proc.removeListener(ev, l as (...args: unknown[]) => void);
    }
  }
  vi.restoreAllMocks();
  if (prevAddeHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevAddeHome;
  fs.rmSync(tmpAddeHome, { recursive: true, force: true });
});

describe("run — 단발 CLI 명령은 크래시 가드를 설치하지 않는다 (SC-003 Happy)", () => {
  it("completion 명령 실행 전후 전역 예외/거부 핸들러 등록 수가 변하지 않는다", async () => {
    const before = {
      uncaught: process.listenerCount("uncaughtException"),
      rejection: process.listenerCount("unhandledRejection"),
    };
    await run(["completion", "bash"]);
    expect(process.listenerCount("uncaughtException")).toBe(before.uncaught);
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection);
  });
});

describe("run __daemon — 결정적 부팅 실패 exit0 (SC-019 Happy)", () => {
  it("기동된 레인이 0개면 exit0(비정상 코드 없음)", async () => {
    supervisorUp.mockResolvedValue({ message: "no lanes configured", lanes: [] });
    const code = await run(["__daemon", "demo"]);
    expect(code).toBe(0);
  });

  it("전 레인이 error(기동 실패)라도 running=0 이면 exit0(FR-018 — 재시도 무익)", async () => {
    supervisorUp.mockResolvedValue({
      message: "boot",
      lanes: [{ lane: "a", status: "error", error: "engine spawn ENOENT" }],
    });
    const code = await run(["__daemon", "demo"]);
    expect(code).toBe(0);
  });
});

describe("run __daemon — 부팅 중 비결정적 크래시 exit1 (SC-021 Error)", () => {
  it("부팅 대기 중(supervisorUp pending) uncaughtException 발생 시 크래시 가드가 exit(1) 호출", async () => {
    supervisorUp.mockImplementation(() => new Promise(() => {})); // 부팅 진행 중(미확정) 시뮬레이션
    supervisorDown.mockResolvedValue({ message: "down" });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const before = process.listenerCount("uncaughtException");
    void run(["__daemon", "demo"]); // 부팅이 끝나지 않으므로 await 하지 않음(fire-and-forget)
    // 크래시 가드(uncaughtException 리스너) 설치 완료를 폴링 대기(고정 지연 대신 — flaky 방지).
    await waitFor(() => process.listenerCount("uncaughtException") > before);

    proc.emit("uncaughtException", new Error("boot-phase-crash"), "uncaughtException");

    await waitFor(() => exitSpy.mock.calls.length > 0);
    expect(exitSpy).toHaveBeenCalledWith(1);
    errSpy.mockRestore();
  });
});

describe("run __daemon — SIGTERM graceful shutdown exit0 (SC-014 Happy)", () => {
  it("레인 기동 성공 후 SIGTERM 을 받으면 supervisorDown 완주 후 exit(0)", async () => {
    supervisorUp.mockResolvedValue({
      message: "boot ok",
      lanes: [{ lane: "a", status: "running", error: null }],
    });
    supervisorDown.mockResolvedValue({ message: "shutdown ok" });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const before = process.listenerCount("SIGTERM");
    void run(["__daemon", "demo"]); // 레인 기동 성공 후 상주(포그라운드) — await 하지 않음
    // SIGTERM 핸들러(process.once) 등록 완료를 폴링 대기(고정 지연 대신 — flaky 방지).
    await waitFor(() => process.listenerCount("SIGTERM") > before);

    process.emit("SIGTERM");

    await waitFor(() => exitSpy.mock.calls.length > 0);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(supervisorDown).toHaveBeenCalledWith("demo");
    errSpy.mockRestore();
    outSpy.mockRestore();
  });
});

describe("run __daemon — proj 위치인자 누락 (SC-010 Error)", () => {
  it("proj 없이 호출하면 usage.daemon 을 stderr 에 출력하고 exit 2(USAGE)", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await run(["__daemon"]);

    // mockRestore() 는 원복과 함께 mock.calls 도 리셋한다 — 텍스트는 restore 전에 읽는다.
    const err = errSpy.mock.calls.map((c) => String(c[0])).join("");
    errSpy.mockRestore();
    expect(code).toBe(2);
    expect(err).toMatch(/adde __daemon/);
  });
});

describe("run __daemon — 결정적 부팅 예외 (SC-010 Edge)", () => {
  it("runDaemonForeground await 중 잡힌 예외는 cmdError 로 표면화하고 exit 0(OK) 를 반환한다", async () => {
    supervisorUp.mockRejectedValue(new Error("deterministic boot failure"));
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await run(["__daemon", "demo"]);

    const err = errSpy.mock.calls.map((c) => String(c[0])).join("");
    errSpy.mockRestore();
    expect(code).toBe(0);
    // i18n 카탈로그(en/ko) 무관 — cmdError 포맷 접두([adde __daemon])와 원본 오류 메시지 보존만 확인.
    expect(err).toMatch(/\[adde __daemon\]/);
    expect(err).toMatch(/deterministic boot failure/);
  });
});
