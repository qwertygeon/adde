/**
 * 라이브니스 수명 단위(L3, 신규) — 데몬 워커의 기록·주기 갱신·제거 3종을 한 단위로 소유한다
 * (FR-001·FR-002·FR-003·FR-005). 정상 종료 경로(core/daemon.ts)에서만 제거를 호출한다(FR-004
 * — supervisorDown 은 크래시 가드 정리 경로에서도 호출되므로 기록을 건드리지 않는다).
 */
import type { ProjectPaths } from "../shared/paths.js";
import { t } from "../shared/i18n.js";
import { errMsg } from "../shared/errors.js";
import {
  writeRuntime,
  touchRuntime,
  removeRuntime,
  resolveHeartbeatIntervalMs,
} from "./runtime-state.js";
import type { RuntimeInfo } from "./runtime-state.js";

export interface LivenessDeps {
  proj: string;
  paths: ProjectPaths;
  /** 실패 표면화 채널 — 무음 흡수 금지(FR-005). 데몬 배선에서는 stderr 기록자. */
  warn: (line: string) => void;
  pid?: number;
  now?: () => Date;
  intervalMs?: number;
  write?: (paths: ProjectPaths, info: RuntimeInfo) => Promise<void>;
  touch?: (paths: ProjectPaths) => Promise<void>;
  remove?: (paths: ProjectPaths) => Promise<void>;
  /** 기존 관례와 동형(session-manager.ts 의 scheduler 선언과 일치) — `manual-scheduler` 를 그대로
   *  주입할 수 있게 한다. */
  scheduler?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (h: unknown) => void;
  };
}

export interface LivenessHandle {
  /** 타이머 해제 → 기록 제거. 정상 종료 경로에서만 호출한다(FR-004). 멱등. */
  stop(): Promise<void>;
}

const defaultScheduler = {
  setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
  clearInterval: (h: unknown) => clearInterval(h as NodeJS.Timeout),
};

/** 기록 1회 + 주기 갱신 타이머 설치. 기록·설치 실패는 throw 하지 않고 warn 으로 표면화한다. */
export async function startLiveness(deps: LivenessDeps): Promise<LivenessHandle> {
  const { proj, paths, warn } = deps;
  const pid = deps.pid ?? process.pid;
  const now = deps.now ?? ((): Date => new Date());
  const intervalMs = deps.intervalMs ?? resolveHeartbeatIntervalMs();
  const write = deps.write ?? writeRuntime;
  const touch = deps.touch ?? touchRuntime;
  const remove = deps.remove ?? removeRuntime;
  const scheduler = deps.scheduler ?? defaultScheduler;

  try {
    await write(paths, { v: 1, pid, startedAt: now().toISOString() });
  } catch (err) {
    warn(t("log.liveness.writeFail", { proj, error: errMsg(err) }));
  }

  const tick = (): void => {
    void touch(paths).catch((err: unknown) => {
      warn(t("log.liveness.refreshFail", { proj, error: errMsg(err) }));
    });
  };
  const handle = scheduler.setInterval(tick, intervalMs);
  if (typeof (handle as { unref?: unknown })?.unref === "function") {
    (handle as { unref: () => void }).unref();
  }

  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      scheduler.clearInterval(handle);
      try {
        await remove(paths);
      } catch (err) {
        warn(t("log.liveness.removeFail", { proj, error: errMsg(err) }));
      }
    },
  };
}

/** 핸들이 없는 경로(기동 창 종료)에서 잔존 기록을 제거한다. ENOENT 는 성공(removeRuntime 계약). */
export async function removeLivenessRecord(
  paths: ProjectPaths,
  warn: (line: string) => void,
  remove: (paths: ProjectPaths) => Promise<void> = removeRuntime,
): Promise<void> {
  try {
    await remove(paths);
  } catch (err) {
    warn(errMsg(err));
  }
}
