/**
 * 데몬 워커 전용 크래시 안전망 — uncaughtException/unhandledRejection 전역 가드.
 * 단발 CLI 명령에는 설치하지 않는다(run.ts runDaemonForeground 에서만 호출).
 */
import { maskSecrets } from "../shared/mask.js";

/** 종료 진행 공유 플래그 — run.ts 의 signal shutdown()과 크래시 가드가 공유해 이중 종결을 막는다. */
export interface ShutdownState {
  active: boolean;
}

export interface CrashGuardDeps {
  /** 레인 정지 등 정리 동작 — 실패해도 종료를 막지 않는다. */
  onCleanup: () => Promise<void>;
  /** 기본 process.exit. */
  exit: (code: number) => void;
  /** 기본 console.error(→ launchd .err.log). */
  log: (line: string) => void;
  state: ShutdownState;
  /** 기본 process. 테스트에 fake EventEmitter 주입 가능. */
  emitter?: NodeJS.EventEmitter;
  /** 유계 정리 타임아웃(ms). 기본 5000. */
  cleanupTimeoutMs?: number;
  /** rate-limit 시계 주입. 기본 Date.now. */
  now?: () => number;
  /** rate-limit 윈도(ms). 기본 60000. */
  rateWindowMs?: number;
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 5000;
const DEFAULT_RATE_WINDOW_MS = 60000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

/**
 * 데몬 워커 전용 전역 크래시 가드 설치.
 * - uncaughtException: 재진입 방지 → 마스킹 로그 1회 → 유계 정리 시도(성공/실패/타임아웃 무관) → exit(1).
 * - unhandledRejection: reason 서명별 rate-limit 마스킹 로그 → 흡수(종료하지 않음, 상주 유지).
 */
export function installCrashGuard(deps: CrashGuardDeps): void {
  const emitter = deps.emitter ?? process;
  const cleanupTimeoutMs = deps.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const rateWindowMs = deps.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  // reason 서명별 마지막 로깅 시각 — 동일 원인 반복 시 로그 폭주 방지.
  const lastLoggedAt = new Map<string, number>();

  emitter.on("uncaughtException", (err: unknown) => {
    // 재진입/이중 종결 방지 — 종료 진행 중이면 아무것도 하지 않는다.
    if (deps.state.active) return;
    deps.state.active = true;

    deps.log(`[crash-guard] uncaught exception: ${maskSecrets(formatErr(err))}`);

    // 정리 성공/실패/타임아웃 무관하게 exit(1) 에 반드시 도달.
    void (async () => {
      try {
        await Promise.race([deps.onCleanup(), delay(cleanupTimeoutMs)]);
      } catch {
        // 정리 실패 흡수 — 종료 도달을 막지 않는다.
      } finally {
        deps.exit(1);
      }
    })();
  });

  emitter.on("unhandledRejection", (reason: unknown) => {
    const signature = formatErr(reason);
    const last = lastLoggedAt.get(signature);
    const nowMs = now();
    if (last === undefined || nowMs - last >= rateWindowMs) {
      lastLoggedAt.set(signature, nowMs);
      deps.log(`[crash-guard] unhandled rejection: ${maskSecrets(signature)}`);
    }
    // 종료하지 않음 — 흡수·상주 유지.
  });
}
