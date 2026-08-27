import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionWatcher } from "../../src/core/session-watcher.js";
import type { SessionWatcherDeps } from "../../src/core/session-watcher.js";

// 유휴 내림·초기화·데몬 종료는 disarm() 으로 억제되는 **의도적** 종료다. 자가 재기동 억제는
// 이미 동작하지만 진단 로그가 이를 "crash" 로 기록하면, 정상 운영 로그가 크래시 경고로 가득 차
// 실제 오류가 묻힌다(실기기 데몬 로그 62줄 중 20줄이 code=0 의 "crash detected" 였다).

function makeWatcher(overrides: Partial<SessionWatcherDeps> = {}) {
  const calls = { denyPending: 0, relaunch: 0, health: [] as boolean[] };
  const deps: SessionWatcherDeps = {
    sid: "sid-1",
    autoRelaunch: true,
    relaunch: async () => {
      calls.relaunch++;
    },
    isAlive: () => false,
    denyPending: () => {
      calls.denyPending++;
    },
    setHealth: (h) => calls.health.push(h),
    markDetached: async () => {},
    notify: () => {},
    // 백오프 타이머가 테스트 뒤 살아남지 않도록 즉시 발화하지 않는 스케줄러를 준다.
    scheduler: {
      setTimeout: (() => ({ unref: () => {} })) as unknown as typeof setTimeout,
      clearTimeout: (() => {}) as unknown as typeof clearTimeout,
    },
    ...overrides,
  };
  return { watcher: createSessionWatcher(deps), calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** console.warn 출력을 모아 반환한다. */
function captureWarn(): string[] {
  const out: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  });
  return out;
}

describe("엔진 종료 신호의 의도/크래시 분류", () => {
  it("Happy: 의도적 종료(disarm 상태)는 crash 로 기록하지 않는다", () => {
    const { watcher, calls } = makeWatcher();
    watcher.arm();
    watcher.disarm(); // 유휴 내림·초기화 경로가 하는 일
    const warns = captureWarn();

    watcher.onCrash({ code: 0, signal: null });

    expect(warns.join("\n")).not.toContain("crash");
    expect(calls.relaunch).toBe(0); // 재기동도 트리거하지 않는다(기존 계약)
  });

  it("Happy: 의도적 종료에도 미결 승인 deny·상태 반영은 계속 수행한다", () => {
    const { watcher, calls } = makeWatcher();
    watcher.arm();
    watcher.disarm();
    captureWarn();

    watcher.onCrash({ code: 0, signal: null });

    expect(calls.denyPending).toBe(1); // fail-closed 유지
    expect(calls.health).toContain(false); // 엔진 비상주 반영
  });

  it("Happy: 정상 상태(armed)에서의 예기치 않은 종료는 crash 로 기록한다", () => {
    const { watcher } = makeWatcher();
    watcher.arm();
    const warns = captureWarn();

    watcher.onCrash({ code: 0, signal: null });

    // 종료코드 0 이어도 armed 상태의 종료는 예기치 않은 것이다(코드값으로 분류하지 않는다).
    expect(warns.join("\n")).toContain("crash");
  });
});
