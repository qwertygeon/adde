/**
 * ADR-020 시계 주입 더블 — `RetentionPolicy.now: () => Date`(확정 시그니처) 와 동일 형태를
 * SessionManager 의 유휴·상한 판정에도 재사용한다(설계가 "동일 clock/scheduler 주입 패턴" 을
 * 명시 — lane-watcher.ts 의 `scheduler:{setTimeout,clearTimeout}` 주입 관례와 짝을 이룬다).
 * 실시간 대기 없이 30분 유휴 등 시간 경과를 결정론적으로 재현한다(vi.useFakeTimers 만으로는
 * 상주 프로세스 경로를 재현하지 못한다는 tasks.md 제약과 정합).
 */
export interface FakeClock {
  /** `RetentionPolicy.now`(실측 `src/record/retention.ts`)와 동일 계약 — Date 반환. */
  now: () => Date;
  /** `SessionManagerDeps.clock.now()`(실측 `src/core/session-manager.ts`)와 동일 계약 — ms 숫자 반환. */
  nowMs: () => number;
  advanceMinutes(min: number): void;
  advanceMs(ms: number): void;
  set(iso: string): void;
}

export function makeFakeClock(startIso = new Date().toISOString()): FakeClock {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    nowMs: () => current,
    advanceMinutes(min: number) {
      current += min * 60_000;
    },
    advanceMs(ms: number) {
      current += ms;
    },
    set(iso: string) {
      current = new Date(iso).getTime();
    },
  };
}

/** lane-watcher.ts 선례와 동일한 scheduler 주입 형태 — vi.useFakeTimers() 활성 중 전역을 그대로 넘긴다. */
export function realTimerScheduler(): {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
} {
  return { setTimeout, clearTimeout };
}
