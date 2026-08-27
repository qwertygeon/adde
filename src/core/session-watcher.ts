/**
 * 세션 엔진 자가 회복(self-recovery) 상태기계(FR-044, ADR-031) — 현행 `core/lane-watcher.ts` 의
 * 상태기계를 세션 스코프로 이식(레인→세션). 상태: disarmed(초기·정지) → armed(정상) →
 * scheduled(백오프 대기) → relaunching → armed(성공) 또는 terminal(포기·OFF 즉시 확정).
 * hibernate·clear 등 **의도적** 종료는 disarm() 으로 신호를 억제한다(SC-063 — 크래시 아님).
 */
import { errMsg } from "../shared/errors.js";

export interface BackoffConfig {
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  maxAttempts: number;
  stabilityResetMs: number;
}

export interface SessionWatcherDeps {
  sid: string;
  /** conf.auto_relaunch — false 면 재기동 시도 없이 즉시 detached 확정(FR-044 옵트아웃). */
  autoRelaunch: boolean;
  /** 재개 핸들로 엔진을 다시 연다(SessionManager.admit 가 engineRef 재사용을 처리). */
  relaunch: () => Promise<void>;
  isAlive: () => boolean;
  /** in-flight 미결 승인 전부 deny 종결(ON/OFF 공통 — 크래시 시 항상 수행, FR-044). */
  denyPending: () => void;
  setHealth: (healthy: boolean) => void;
  /** 재시도 소진·옵트아웃 확정 시 세션을 detached 로 전환 + 사유 1회 통지. */
  markDetached: (reason: string) => Promise<void>;
  notify: (kind: "attempt" | "abandoned" | "disabled") => void;
  backoff?: Partial<BackoffConfig>;
  scheduler?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export interface SessionWatcher {
  arm(): void;
  disarm(): void;
  onCrash(info: { code: number | null; signal: NodeJS.Signals | null }): void;
  isHealthy(): boolean;
}

export const SELF_RECOVERY_INITIAL_DELAY_MS = 1_000;
export const SELF_RECOVERY_BACKOFF_MULTIPLIER = 2;
export const SELF_RECOVERY_MAX_DELAY_MS = 30_000;
export const SELF_RECOVERY_MAX_ATTEMPTS = 5;
export const SELF_RECOVERY_STABILITY_RESET_MS = 60_000;

type State = "disarmed" | "armed" | "scheduled" | "relaunching" | "terminal";

export function createSessionWatcher(deps: SessionWatcherDeps): SessionWatcher {
  const cfg: BackoffConfig = {
    initialDelayMs: deps.backoff?.initialDelayMs ?? SELF_RECOVERY_INITIAL_DELAY_MS,
    multiplier: deps.backoff?.multiplier ?? SELF_RECOVERY_BACKOFF_MULTIPLIER,
    maxDelayMs: deps.backoff?.maxDelayMs ?? SELF_RECOVERY_MAX_DELAY_MS,
    maxAttempts: deps.backoff?.maxAttempts ?? SELF_RECOVERY_MAX_ATTEMPTS,
    stabilityResetMs: deps.backoff?.stabilityResetMs ?? SELF_RECOVERY_STABILITY_RESET_MS,
  };
  const scheduler = deps.scheduler ?? { setTimeout, clearTimeout };

  let state: State = "disarmed";
  let attempt = 0;
  let healthy = true;
  let scheduledTimer: ReturnType<typeof setTimeout> | undefined;
  let stabilityTimer: ReturnType<typeof setTimeout> | undefined;

  function clearTimers(): void {
    if (scheduledTimer !== undefined) {
      scheduler.clearTimeout(scheduledTimer);
      scheduledTimer = undefined;
    }
    if (stabilityTimer !== undefined) {
      scheduler.clearTimeout(stabilityTimer);
      stabilityTimer = undefined;
    }
  }

  function setHealthy(next: boolean): void {
    healthy = next;
    deps.setHealth(next);
  }

  function attemptOrAbandon(): void {
    attempt += 1;
    if (attempt > cfg.maxAttempts) {
      state = "terminal";
      void deps
        .markDetached(`엔진 자가 재기동 시도 소진(${attempt - 1}회)`)
        .catch((err: unknown) =>
          console.warn(`[session-watcher] sid=${deps.sid} markDetached 실패: ${errMsg(err)}`),
        );
      deps.notify("abandoned");
      return;
    }
    const delay = Math.min(cfg.initialDelayMs * cfg.multiplier ** (attempt - 1), cfg.maxDelayMs);
    state = "scheduled";
    if (attempt === 1) deps.notify("attempt");
    scheduledTimer = scheduler.setTimeout(() => void fire(), delay);
    scheduledTimer.unref?.();
  }

  async function fire(): Promise<void> {
    scheduledTimer = undefined;
    if (deps.isAlive() || state === "disarmed" || state === "terminal") return;
    state = "relaunching";
    try {
      await deps.relaunch();
      state = "armed";
      setHealthy(true);
      stabilityTimer = scheduler.setTimeout(() => {
        stabilityTimer = undefined;
        if (state === "armed") attempt = 0;
      }, cfg.stabilityResetMs);
      stabilityTimer.unref?.();
    } catch (err) {
      console.warn(`[session-watcher] sid=${deps.sid} relaunch 실패: ${errMsg(err)}`);
      attemptOrAbandon();
    }
  }

  function onCrash(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    // 분류 기준은 종료코드가 아니라 disarm 여부다 — 유휴 내림·초기화·데몬 종료는 disarm 을 거치고,
    // armed 상태의 종료는 코드가 0 이어도 예기치 않은 것이다. 이 구분 없이 전부 "crash" 로 적으면
    // 정상 운영 로그가 크래시 경고로 채워져 실제 오류가 묻힌다.
    const intended = state === "disarmed";
    console.warn(
      intended
        ? `[session-watcher] sid=${deps.sid} engine exited as intended (code=${info.code} signal=${info.signal})`
        : `[session-watcher] sid=${deps.sid} crash detected (code=${info.code} signal=${info.signal})`,
    );
    deps.denyPending();
    setHealthy(false);

    if (!deps.autoRelaunch) {
      if (state === "terminal") return;
      state = "terminal";
      void deps
        .markDetached("엔진 비정상 종료 — 자가 재기동 꺼짐(auto_relaunch=false)")
        .catch((err: unknown) =>
          console.warn(`[session-watcher] sid=${deps.sid} markDetached 실패: ${errMsg(err)}`),
        );
      deps.notify("disabled");
      return;
    }

    if (state !== "armed") return; // 의도적 종료(disarm 됨) 또는 이미 처리 중 — 중복 트리거 방지.
    attemptOrAbandon();
  }

  return {
    arm(): void {
      state = "armed";
    },
    disarm(): void {
      state = "disarmed";
      clearTimers();
    },
    onCrash,
    isHealthy(): boolean {
      return healthy;
    },
  };
}
