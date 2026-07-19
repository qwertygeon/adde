import { describe, expect, it, vi } from "vitest";
import { createLaneWatcher } from "../../src/core/lane-watcher.js";
import type { LaneWatcherDeps, BackoffConfig } from "../../src/core/lane-watcher.js";
import { waitFor } from "../helpers/wait.js";

// SC-003(FR-002·NFR-002): 연속 크래시 시 백오프 단조 증가·상한·시도 cap.
// SC-004(FR-003): disarm 구간 crash 미트리거 + 백오프 대기 중 isAlive=true 면 fire skip(double-spawn 0).
// SC-005(FR-004·NFR-002·NFR-003): cap 초과 → 중단·error 기록·통지 정확히 1회.
// SC-008(FR-006·NFR-003): crash 시 미결 승인 즉시 deny(ON/OFF 공통부).
// SC-014-edge(FR-008): OFF 는 백오프 타이머 미예약.
// SC-015(FR-008·FR-002): ON(또는 키부재=ON) 은 즉시 error 가 아니라 백오프 경로.
//
// 테스트 런타임 제약(Test Authoring Contract): 백오프 실시간 대기 금지 — deps.scheduler 를
// 결정론적 manual fake 로 주입해 setTimeout 발동 시점을 테스트가 직접 통제한다(실 1s~30s 대기 0).

/** deps.scheduler 주입용 manual fake — 프로덕션이 반환값에 호출하는 .unref() 도 안전하게 제공. */
function makeManualScheduler() {
  let seq = 0;
  const timers = new Map<number, { cb: () => void; delay: number }>();
  const handle = (id: number): NodeJS.Timeout =>
    ({ id, unref: () => handle(id) }) as unknown as NodeJS.Timeout;

  const scheduler = {
    setTimeout: ((cb: (...args: unknown[]) => void, delay?: number) => {
      const id = seq++;
      timers.set(id, { cb: () => cb(), delay: delay ?? 0 });
      return handle(id);
    }) as unknown as typeof setTimeout,
    clearTimeout: ((h: unknown) => {
      const id = (h as { id?: number } | undefined)?.id;
      if (id !== undefined) timers.delete(id);
    }) as typeof clearTimeout,
  };

  return {
    scheduler,
    /** 가장 오래 예약된(먼저 스케줄된) 타이머를 발동시킨다. */
    fire(): void {
      const entry = [...timers.entries()][0];
      if (!entry) throw new Error("no pending timer to fire");
      const [id, t] = entry;
      timers.delete(id);
      t.cb();
    },
    delays(): number[] {
      return [...timers.values()].map((t) => t.delay);
    },
    pendingCount(): number {
      return timers.size;
    },
  };
}

/** setImmediate 큐 flush — fire() 내부 async 재진입(resumeSession.catch → onCrash 재진입)의 마이크로태스크 정리. */
const flush = () => new Promise<void>((r) => setImmediate(r));

type Deps = LaneWatcherDeps & {
  resumeSession: ReturnType<typeof vi.fn>;
  isAlive: ReturnType<typeof vi.fn>;
  lastSessionId: ReturnType<typeof vi.fn>;
  denyPending: ReturnType<typeof vi.fn>;
  setHealth: ReturnType<typeof vi.fn>;
  writeError: ReturnType<typeof vi.fn>;
  onSessionUpdated: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
};

function makeDeps(overrides: Partial<LaneWatcherDeps> = {}): Deps {
  return {
    lane: "lane",
    autoRelaunch: true,
    resumeSession: vi.fn().mockResolvedValue({ sessionId: "s2", resumed: true }),
    isAlive: vi.fn().mockReturnValue(false),
    lastSessionId: vi.fn().mockResolvedValue("s1"),
    denyPending: vi.fn(),
    setHealth: vi.fn(),
    writeError: vi.fn().mockResolvedValue(undefined),
    onSessionUpdated: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    ...overrides,
  } as unknown as Deps;
}

describe("createLaneWatcher — 백오프 단조 증가·상한·cap (SC-003)", () => {
  it("연속 크래시 시 백오프가 단조 증가하며 상한을 넘지 않고, 시도 횟수가 cap 을 초과하면 포기한다", async () => {
    const { scheduler, fire, delays, pendingCount } = makeManualScheduler();
    const resumeSession = vi.fn().mockRejectedValue(new Error("re-crash"));
    const backoff: BackoffConfig = {
      initialDelayMs: 10,
      multiplier: 2,
      maxDelayMs: 50,
      maxAttempts: 4,
      stabilityResetMs: 1_000_000,
    };
    const deps = makeDeps({ scheduler, resumeSession, backoff });
    const watcher = createLaneWatcher(deps);
    watcher.arm();

    const observed: number[] = [];
    watcher.onCrash({ code: 1, signal: null }); // attempt=1
    await waitFor(() => pendingCount() === 1);
    observed.push(delays()[0]!);

    for (let i = 0; i < 3; i++) {
      fire();
      await waitFor(() => pendingCount() === 1 || deps.writeError.mock.calls.length > 0);
      if (pendingCount() === 1) observed.push(delays()[0]!);
    }

    expect(observed).toEqual([10, 20, 40, 50]); // 10*2^(n-1), 상한 50 에서 캡
    for (let i = 1; i < observed.length; i++) {
      expect(observed[i]).toBeGreaterThanOrEqual(observed[i - 1]!); // 단조 증가
    }
    expect(Math.max(...observed)).toBeLessThanOrEqual(50); // 상한 이내

    // 4번째 예약(attempt=4)의 타이머까지 발동 → attempt=5 > cap(4) → 포기, 추가 백오프 없음.
    fire();
    await waitFor(() => deps.writeError.mock.calls.length > 0);
    expect(pendingCount()).toBe(0); // 무한 재시도 금지(NFR-002)
    expect(resumeSession).toHaveBeenCalledTimes(4); // attempt 1~4 각각 1회 재기동 시도
  });
});

describe("createLaneWatcher — disarm·double-spawn 방지 (SC-004)", () => {
  it("disarm 상태에서 crash 는 자가 재기동을 트리거하지 않는다 (Happy)", async () => {
    const { scheduler, pendingCount } = makeManualScheduler();
    const deps = makeDeps({ scheduler });
    const watcher = createLaneWatcher(deps);
    watcher.arm();
    watcher.disarm();

    watcher.onCrash({ code: 1, signal: null });
    await flush();

    expect(pendingCount()).toBe(0);
    expect(deps.resumeSession).not.toHaveBeenCalled();
  });

  it("백오프 대기 중 isAlive=true(수동 복구됨)면 fire 시 재기동을 skip 한다 (Edge — double-spawn 0)", async () => {
    const { scheduler, fire, pendingCount } = makeManualScheduler();
    const isAlive = vi.fn().mockReturnValue(false);
    const deps = makeDeps({ scheduler, isAlive });
    const watcher = createLaneWatcher(deps);
    watcher.arm();

    watcher.onCrash({ code: 1, signal: null });
    expect(pendingCount()).toBe(1);

    isAlive.mockReturnValue(true); // 대기 중 수동 relaunch 등으로 이미 복구됨
    fire();
    await flush();

    expect(deps.resumeSession).not.toHaveBeenCalled();
  });
});

describe("createLaneWatcher — cap 초과 포기 (SC-005)", () => {
  it("cap 초과 시 재기동을 중단하고 error 기록 + 통지 정확히 1회, 재진입에도 재통지하지 않는다", async () => {
    const { scheduler, fire, pendingCount } = makeManualScheduler();
    const resumeSession = vi.fn().mockRejectedValue(new Error("re-crash"));
    const backoff: BackoffConfig = {
      initialDelayMs: 5,
      multiplier: 2,
      maxDelayMs: 20,
      maxAttempts: 2,
      stabilityResetMs: 1_000_000,
    };
    const deps = makeDeps({ scheduler, resumeSession, backoff });
    const watcher = createLaneWatcher(deps);
    watcher.arm();

    watcher.onCrash({ code: 1, signal: null }); // attempt=1
    await waitFor(() => pendingCount() === 1);
    fire(); // attempt=1 실패 → attempt=2 스케줄
    await waitFor(() => pendingCount() === 1);
    fire(); // attempt=2 실패 → attempt=3 > cap(2) → 포기

    await waitFor(() => deps.writeError.mock.calls.length > 0);
    expect(deps.writeError).toHaveBeenCalledTimes(1);
    // notify 는 최초 시도(attempt=1) 시 "attempt" 1회 + cap 초과 시 "abandoned" 1회 — 포기(통지) 자체는
    // 정확히 1회(SC-005 의 "통지 정확히 1회"는 포기 통지를 가리킨다. attempt 통지는 별개 종류).
    const abandonedCalls = deps.notify.mock.calls.filter((c) => c[0] === "abandoned");
    expect(abandonedCalls).toHaveLength(1);
    expect(pendingCount()).toBe(0);

    // terminal 전이 후 재진입 crash — 방어적 가드로 재통지하지 않는다.
    watcher.onCrash({ code: 1, signal: null });
    await flush();
    expect(deps.notify.mock.calls.filter((c) => c[0] === "abandoned")).toHaveLength(1);
    expect(deps.writeError).toHaveBeenCalledTimes(1);
  });
});

describe("createLaneWatcher — onCrash 공통부: 미결 승인 즉시 deny (SC-008)", () => {
  it("ON 레인 crash 시 denyPending·setHealth(false) 가 즉시 호출된다", () => {
    const deps = makeDeps({ autoRelaunch: true });
    const watcher = createLaneWatcher(deps);
    watcher.arm();

    watcher.onCrash({ code: 1, signal: null });

    expect(deps.denyPending).toHaveBeenCalledTimes(1);
    expect(deps.setHealth).toHaveBeenCalledWith(false);
  });

  it("OFF 레인 crash 시에도 denyPending 이 즉시 호출된다(재기동 활성 여부 무관)", () => {
    const deps = makeDeps({ autoRelaunch: false });
    const watcher = createLaneWatcher(deps);

    watcher.onCrash({ code: 1, signal: null });

    expect(deps.denyPending).toHaveBeenCalledTimes(1);
    expect(deps.setHealth).toHaveBeenCalledWith(false);
  });
});

describe("createLaneWatcher — auto_relaunch=false 는 백오프 없이 즉시 확정 (SC-014 Edge)", () => {
  it("OFF 레인은 백오프 타이머를 예약하지 않고 즉시 writeError+notify(disabled)", async () => {
    const { scheduler, pendingCount } = makeManualScheduler();
    const deps = makeDeps({ autoRelaunch: false, scheduler });
    const watcher = createLaneWatcher(deps);

    watcher.onCrash({ code: 1, signal: null });
    await flush();

    expect(pendingCount()).toBe(0); // 백오프 예약 0
    expect(deps.resumeSession).not.toHaveBeenCalled(); // 재기동 시도 0회
    expect(deps.writeError).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith("disabled", expect.anything());
  });

  it("OFF 레인은 재진입 crash 에도 통지를 재발생하지 않는다(terminal 가드)", async () => {
    const deps = makeDeps({ autoRelaunch: false });
    const watcher = createLaneWatcher(deps);

    watcher.onCrash({ code: 1, signal: null });
    await flush();
    watcher.onCrash({ code: 1, signal: null });
    await flush();

    expect(deps.notify).toHaveBeenCalledTimes(1);
  });
});

describe("createLaneWatcher — auto_relaunch=true(또는 키부재) 는 백오프 경로 (SC-015)", () => {
  it("ON 레인 crash 는 즉시 error 확정이 아니라 백오프를 예약한다(cap 초과 전까지 error 미기록)", () => {
    const { scheduler, pendingCount, delays } = makeManualScheduler();
    const deps = makeDeps({ autoRelaunch: true, scheduler });
    const watcher = createLaneWatcher(deps);
    watcher.arm();

    watcher.onCrash({ code: 1, signal: null });

    expect(pendingCount()).toBe(1); // 백오프 예약(즉시 error 아님)
    expect(delays()[0]).toBeGreaterThan(0);
    expect(deps.writeError).not.toHaveBeenCalled();
  });
});
