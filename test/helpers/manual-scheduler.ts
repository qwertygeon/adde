/**
 * 006(D003/D005/D012 등) — SessionManagerDeps.scheduler 주입용 결정론적 더블. 실 `setInterval`
 * 대신 콜백을 캡처해두고 `fireAll()`/`fireByInterval()` 로 즉시(동기) 1틱 실행한다 — 유휴·중지
 * 스윕(60s)·control 드레인(2s) 등 내부 타이머 로직을 실시간 대기 없이, `makeFakeClock` 이 주입한
 * 논리 시각과 함께 결정론적으로 관통 검증할 수 있게 한다(lane-watcher.ts 의 `scheduler:{setTimeout,
 * clearTimeout}` 주입 관례와 동형 — fake-clock.ts 참조).
 */
export interface ManualScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
  /** 등록된 모든 인터벌 콜백을 등록 순서대로 1회씩 동기 호출한다. */
  fireAll(): void;
  /** 특정 ms 로 등록된 인터벌 콜백만 호출한다(예: 60_000=유휴/중지 스윕, 2_000=control 드레인 구분). */
  fireByInterval(ms: number): void;
  registeredIntervals(): readonly number[];
}

export function makeManualScheduler(): ManualScheduler {
  const registry: Array<{ handle: number; fn: () => void; ms: number; cleared: boolean }> = [];
  let seq = 0;

  return {
    setInterval(fn: () => void, ms: number): unknown {
      const handle = ++seq;
      registry.push({ handle, fn, ms, cleared: false });
      return handle;
    },
    clearInterval(h: unknown): void {
      const entry = registry.find((e) => e.handle === h);
      if (entry) entry.cleared = true;
    },
    fireAll(): void {
      for (const entry of registry) {
        if (!entry.cleared) entry.fn();
      }
    },
    fireByInterval(ms: number): void {
      for (const entry of registry) {
        if (!entry.cleared && entry.ms === ms) entry.fn();
      }
    },
    registeredIntervals(): readonly number[] {
      return registry.filter((e) => !e.cleared).map((e) => e.ms);
    },
  };
}
