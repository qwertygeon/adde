/**
 * 레인 엔진 자가 회복(self-recovery) 상태기계 — 주입식 팩토리(createLaneWatcher).
 * supervisor per-lane 클로저에서 인스턴스화되며, deps 주입으로 fake timer 단위 검증이 가능하다.
 * 상태: disarmed(초기·정지) → armed(정상) → scheduled(백오프 대기) → relaunching → armed(성공)
 *       또는 terminal(포기·OFF 즉시 확정).
 */
import { errMsg } from "../shared/errors.js";

/** 백오프 스케줄·상한 — conf 미노출(하드코딩, 튜닝값은 운영 데이터 없이 안전 기본값). */
export interface BackoffConfig {
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
  maxAttempts: number;
  stabilityResetMs: number;
}

export interface LaneWatcherDeps {
  lane: string;
  /** conf.auto_relaunch — false 면 재기동 시도 없이 즉시 error 확정한다. */
  autoRelaunch: boolean;
  resumeSession: (sessionId: string) => Promise<{ sessionId: string; resumed: boolean }>;
  /** 백오프 fire 직전 재확인 — true 면 이미 복구됨(수동 relaunch 등) → skip(double-spawn 가드). */
  isAlive: () => boolean;
  lastSessionId: () => Promise<string>;
  /** in-flight 미결 승인 전부 deny 종결(ON/OFF 공통 — 크래시 시 항상 수행). */
  denyPending: () => void;
  setHealth: (healthy: boolean) => void;
  writeError: () => Promise<void>;
  onSessionUpdated: (sessionId: string) => Promise<void>;
  notify: (kind: "attempt" | "abandoned" | "disabled", ctx?: Record<string, unknown>) => void;
  /** 테스트 주입(작은 지연) — 미주입 시 하드코딩 상수. */
  backoff?: Partial<BackoffConfig>;
  /** 테스트 fake timer 주입 — 미주입 시 node:timers + unref. */
  scheduler?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
}

export interface LaneWatcher {
  /** 최초 launch 성공 후 또는 자가 재기동 성공 후 호출 — 크래시 신호를 재기동 트리거로 활성화. */
  arm(): void;
  /** 의도적 relaunch·정지(stop()) 진입 시 호출 — 예약 타이머 clear + 신호 억제. */
  disarm(): void;
  /** 엔진 child 종료(크래시) 신호 — backend.onExit 콜백에서 호출. */
  onCrash(info: { code: number | null; signal: NodeJS.Signals | null }): void;
  isHealthy(): boolean;
}

export const SELF_RECOVERY_INITIAL_DELAY_MS = 1_000;
export const SELF_RECOVERY_BACKOFF_MULTIPLIER = 2;
export const SELF_RECOVERY_MAX_DELAY_MS = 30_000;
/** 시도 스케줄 1s·2s·4s·8s·16s → 6번째 크래시(attempt=6)에서 포기. */
export const SELF_RECOVERY_MAX_ATTEMPTS = 5;
export const SELF_RECOVERY_STABILITY_RESET_MS = 60_000;

type State = "disarmed" | "armed" | "scheduled" | "relaunching" | "terminal";

export function createLaneWatcher(deps: LaneWatcherDeps): LaneWatcher {
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

  /** attempt++ → cap 초과 시 포기(terminal), 아니면 다음 백오프 예약(scheduled). ON 전용. */
  function attemptOrAbandon(): void {
    attempt += 1;
    if (attempt > cfg.maxAttempts) {
      state = "terminal";
      void deps
        .writeError()
        .catch((err: unknown) =>
          console.warn(`[lane-watcher] lane=${deps.lane} writeError failed: ${errMsg(err)}`),
        );
      deps.notify("abandoned", { attempts: attempt - 1 });
      return;
    }
    const delay = Math.min(cfg.initialDelayMs * cfg.multiplier ** (attempt - 1), cfg.maxDelayMs);
    state = "scheduled";
    if (attempt === 1) deps.notify("attempt", { lane: deps.lane });
    scheduledTimer = scheduler.setTimeout(() => void fire(), delay);
    scheduledTimer.unref?.();
  }

  /** 백오프 타이머 fire — isAlive 재확인(race 방지) 후 resumeSession. */
  async function fire(): Promise<void> {
    scheduledTimer = undefined;
    if (deps.isAlive() || state === "disarmed" || state === "terminal") return;
    state = "relaunching";
    try {
      const sid = await deps.lastSessionId();
      const res = await deps.resumeSession(sid);
      state = "armed";
      setHealthy(true);
      stabilityTimer = scheduler.setTimeout(() => {
        stabilityTimer = undefined;
        if (state === "armed") attempt = 0;
      }, cfg.stabilityResetMs);
      stabilityTimer.unref?.();
      await deps
        .onSessionUpdated(res.sessionId)
        .catch((err: unknown) =>
          console.warn(`[lane-watcher] lane=${deps.lane} onSessionUpdated failed: ${errMsg(err)}`),
        );
    } catch (err) {
      console.warn(`[lane-watcher] lane=${deps.lane} resumeSession failed: ${errMsg(err)}`);
      attemptOrAbandon();
    }
  }

  function onCrash(info: { code: number | null; signal: NodeJS.Signals | null }): void {
    console.warn(
      `[lane-watcher] lane=${deps.lane} crash detected (code=${info.code} signal=${info.signal})`,
    );
    // 공통부 — 재기동 활성/비활성 무관, 크래시 시 항상 수행.
    deps.denyPending();
    setHealthy(false);

    if (!deps.autoRelaunch) {
      // OFF — 재기동 시도 0회, 즉시 error 확정. terminal 가드로 통지 중복 방지.
      if (state === "terminal") return;
      state = "terminal";
      void deps
        .writeError()
        .catch((err: unknown) =>
          console.warn(`[lane-watcher] lane=${deps.lane} writeError failed: ${errMsg(err)}`),
        );
      deps.notify("disabled", { lane: deps.lane });
      return;
    }

    // ON — armed 아닐 때(disarmed/scheduled/relaunching/terminal)는 중복·의도적종료 신호 무시.
    if (state !== "armed") return;
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
