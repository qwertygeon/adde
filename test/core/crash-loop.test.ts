import { describe, expect, it, vi } from "vitest";
import { createCrashLoopGuard } from "../../src/core/crash-loop.js";
import type { CrashLoopDeps, HaltRecord } from "../../src/core/crash-loop.js";

// 확정 시그니처 SSOT: design/research.md "확정 시그니처" 절.
// SC-022(N회 경계 자가정지)·SC-023(halt 기록 파일 생성). 시계·fs(readBoots/writeBoots/writeHalt)·
// scheduler 전부 주입 — 실 대기·실 fs 없이 검증(lane-watcher.test.ts manual scheduler 관례 준용).

/** deps.scheduler 주입용 manual fake — lane-watcher.test.ts 와 동형 관례. */
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
    fire(): void {
      const entry = [...timers.entries()][0];
      if (!entry) throw new Error("no pending timer to fire");
      const [id, t] = entry;
      timers.delete(id);
      t.cb();
    },
    pendingCount(): number {
      return timers.size;
    },
  };
}

/** in-memory boots 저장소 — daemon-boots.json 을 재부팅 간 이어지는 상태로 시뮬레이션. */
function makeBootsStore(initial: { consecutiveShortLived: number } | null = null) {
  let state = initial;
  return {
    readBoots: vi.fn(async () => state),
    writeBoots: vi.fn(async (s: { consecutiveShortLived: number }) => {
      state = s;
    }),
    get(): { consecutiveShortLived: number } | null {
      return state;
    },
  };
}

function makeDeps(overrides: Partial<CrashLoopDeps> = {}): CrashLoopDeps {
  return {
    base: "/tmp/adde-test-base",
    proj: "testproj",
    now: () => 1_700_000_000_000,
    maxShortLived: 3,
    minLifetimeMs: 60_000,
    ...overrides,
  };
}

describe("createCrashLoopGuard.checkOnBoot (SC-022 Edge) — N회 경계", () => {
  it("연속 짧은-수명 사망이 임계(N) 미만이면 halt 트리거 안 함", async () => {
    const store = makeBootsStore();
    const writeHalt = vi.fn(async () => {});
    const guard = createCrashLoopGuard(
      makeDeps({ readBoots: store.readBoots, writeBoots: store.writeBoots, writeHalt }),
    );

    const r1 = await guard.checkOnBoot();
    expect(r1).toEqual({ halt: false, count: 1 });
    const r2 = await guard.checkOnBoot();
    expect(r2).toEqual({ halt: false, count: 2 });
    expect(writeHalt).not.toHaveBeenCalled();
  });

  it("연속 짧은-수명 사망이 임계(N) 도달 시 halt 트리거(exit0 자가 정지)", async () => {
    const store = makeBootsStore();
    const writeHalt = vi.fn(async () => {});
    const guard = createCrashLoopGuard(
      makeDeps({ readBoots: store.readBoots, writeBoots: store.writeBoots, writeHalt }),
    );

    await guard.checkOnBoot(); // count=1
    await guard.checkOnBoot(); // count=2
    const r3 = await guard.checkOnBoot(); // count=3 === maxShortLived(3)

    expect(r3).toEqual({ halt: true, count: 3 });
    expect(writeHalt).toHaveBeenCalledTimes(1);
  });

  it("readBoots 가 null(최초 부팅)이면 카운터 1부터 시작한다", async () => {
    const readBoots = vi.fn(async () => null);
    const writeBoots = vi.fn(async () => {});
    const guard = createCrashLoopGuard(makeDeps({ readBoots, writeBoots }));

    const r = await guard.checkOnBoot();
    expect(r).toEqual({ halt: false, count: 1 });
    expect(writeBoots).toHaveBeenCalledWith({ consecutiveShortLived: 1 });
  });
});

describe("createCrashLoopGuard.checkOnBoot → writeHalt (SC-023 Happy) — halt 기록 파일 생성", () => {
  it("자가 정지 시 halt 기록에 원인·시점·카운트가 포함된다", async () => {
    const store = makeBootsStore({ consecutiveShortLived: 2 }); // 직전 2회 짧은-수명 잔존
    let captured: HaltRecord | undefined;
    const writeHalt = vi.fn(async (r: HaltRecord) => {
      captured = r;
    });
    const now = () => 1_700_000_000_000;
    const guard = createCrashLoopGuard(
      makeDeps({ readBoots: store.readBoots, writeBoots: store.writeBoots, writeHalt, now }),
    );

    const result = await guard.checkOnBoot(); // count=3 → halt

    expect(result.halt).toBe(true);
    expect(captured).toBeDefined();
    expect(captured?.consecutiveShortLived).toBe(3);
    expect(captured?.reason).toBeTruthy();
    expect(captured?.haltedAt).toBeTruthy();
    // haltedAt 은 시각 문자열(ISO 등)이어야 하며 now() 시각과 정합해야 한다.
    expect(new Date(captured!.haltedAt).getTime()).toBe(now());
  });
});

describe("createCrashLoopGuard.armStable — 안정 리셋(ASM-006)", () => {
  it("minLifetimeMs 생존 후 카운터가 0으로 리셋된다", async () => {
    const { scheduler, fire, pendingCount } = makeManualScheduler();
    const store = makeBootsStore();
    const guard = createCrashLoopGuard(
      makeDeps({
        readBoots: store.readBoots,
        writeBoots: store.writeBoots,
        scheduler,
        minLifetimeMs: 60_000,
      }),
    );

    await guard.checkOnBoot(); // count=1
    guard.armStable();
    expect(pendingCount()).toBe(1);

    fire(); // minLifetimeMs 경과 시뮬레이션
    await Promise.resolve();

    expect(store.get()).toEqual({ consecutiveShortLived: 0 });
  });

  it("리셋 후 다음 부팅은 카운터 1부터 다시 시작한다(정상 상주 후 단발 크래시 오판 방지)", async () => {
    const { scheduler, fire } = makeManualScheduler();
    const store = makeBootsStore();
    const guard = createCrashLoopGuard(
      makeDeps({ readBoots: store.readBoots, writeBoots: store.writeBoots, scheduler }),
    );

    await guard.checkOnBoot(); // count=1
    await guard.checkOnBoot(); // count=2
    guard.armStable();
    fire();
    await Promise.resolve();
    expect(store.get()).toEqual({ consecutiveShortLived: 0 });

    const r = await guard.checkOnBoot(); // 리셋 후 재부팅 → count=1
    expect(r).toEqual({ halt: false, count: 1 });
  });
});

describe("createCrashLoopGuard.disarm", () => {
  it("armStable 예약 후 disarm 하면 안정 타이머가 취소되어 리셋되지 않는다", async () => {
    const { scheduler, pendingCount } = makeManualScheduler();
    const store = makeBootsStore();
    const guard = createCrashLoopGuard(
      makeDeps({ readBoots: store.readBoots, writeBoots: store.writeBoots, scheduler }),
    );

    await guard.checkOnBoot(); // count=1
    guard.armStable();
    expect(pendingCount()).toBe(1);

    guard.disarm();
    expect(pendingCount()).toBe(0);
    // 리셋이 발동하지 않았으므로 카운터는 여전히 1.
    expect(store.get()).toEqual({ consecutiveShortLived: 1 });
  });
});
