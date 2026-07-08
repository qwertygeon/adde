/**
 * 데몬 크래시루프 감지·자가 정지 — 데몬 프로세스가 launchd 에 의해 반복 재기동되는 루프를
 * 데몬 스스로 감지해 exit 0(확정 종료)으로 끊는다. 판정 패턴은 lane-watcher.ts 의
 * stabilityReset 선례(생존 시간 기반 카운터 리셋)를 데몬 계층에 동형 이식한다.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { daemonBootsPath, daemonHaltPath } from "../shared/paths.js";

/** 연속 짧은-수명 사망 임계 — ThrottleInterval(60s)·lane-watcher maxAttempts(5)와 정합. */
export const CRASH_LOOP_MAX_SHORT_LIVED = 5;
/** 이 미만 생존 후 사망 = 짧은-수명. */
export const CRASH_LOOP_MIN_LIFETIME_MS = 60_000;

export interface HaltRecord {
  reason: string;
  haltedAt: string;
  consecutiveShortLived: number;
}

export interface CrashLoopDeps {
  base: string;
  proj: string;
  /** 시계 주입. 기본 Date.now. */
  now?: () => number;
  readBoots?: () => Promise<{ consecutiveShortLived: number } | null>;
  writeBoots?: (s: { consecutiveShortLived: number }) => Promise<void>;
  writeHalt?: (r: HaltRecord) => Promise<void>;
  scheduler?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  maxShortLived?: number;
  minLifetimeMs?: number;
}

export interface CrashLoopGuard {
  /** 부팅 시 호출 — 짧은-수명 카운터를 +1 하고 daemon-boots.json 에 기록. 임계 도달 시 halt. */
  checkOnBoot(): Promise<{ halt: boolean; count: number }>;
  /** 부팅 성공 후 호출 — minLifetimeMs 생존 시 카운터 0 리셋(안정 판정). */
  armStable(): void;
  disarm(): void;
}

async function defaultReadBoots(path: string): Promise<{ consecutiveShortLived: number } | null> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as { consecutiveShortLived?: number };
    return { consecutiveShortLived: parsed.consecutiveShortLived ?? 0 };
  } catch {
    return null;
  }
}

async function defaultWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data), "utf8");
}

/**
 * 크래시루프 감지기 생성.
 * 카운터 누적 원리: checkOnBoot 이 매 부팅에서 카운터를 먼저 +1 한다. 데몬이 minLifetimeMs
 * 이상 생존하면 armStable 타이머가 카운터를 0으로 리셋한다. 짧은-수명으로 죽으면 리셋 전에
 * 죽으므로 카운터가 잔존 → 다음 부팅에서 다시 +1 → 연속 N회 도달 시 halt.
 */
export function createCrashLoopGuard(deps: CrashLoopDeps): CrashLoopGuard {
  const now = deps.now ?? Date.now;
  const maxShortLived = deps.maxShortLived ?? CRASH_LOOP_MAX_SHORT_LIVED;
  const minLifetimeMs = deps.minLifetimeMs ?? CRASH_LOOP_MIN_LIFETIME_MS;
  const scheduler = deps.scheduler ?? { setTimeout, clearTimeout };
  const bootsPath = daemonBootsPath(deps.base, deps.proj);
  const haltPath = daemonHaltPath(deps.base, deps.proj);

  const readBoots = deps.readBoots ?? (() => defaultReadBoots(bootsPath));
  const writeBoots = deps.writeBoots ?? ((s: { consecutiveShortLived: number }) => defaultWriteJson(bootsPath, s));
  const writeHalt = deps.writeHalt ?? ((r: HaltRecord) => defaultWriteJson(haltPath, r));

  let stabilityTimer: ReturnType<typeof setTimeout> | undefined;

  async function checkOnBoot(): Promise<{ halt: boolean; count: number }> {
    const prior = await readBoots();
    const count = (prior?.consecutiveShortLived ?? 0) + 1;
    await writeBoots({ consecutiveShortLived: count });
    if (count >= maxShortLived) {
      await writeHalt({
        reason: `crash loop — ${count} consecutive short-lived boots (< ${minLifetimeMs}ms)`,
        haltedAt: new Date(now()).toISOString(),
        consecutiveShortLived: count,
      });
      return { halt: true, count };
    }
    return { halt: false, count };
  }

  function armStable(): void {
    if (stabilityTimer !== undefined) scheduler.clearTimeout(stabilityTimer);
    stabilityTimer = scheduler.setTimeout(() => {
      stabilityTimer = undefined;
      // fire-and-forget — 리셋 실패는 다음 부팅에서 카운터가 과대해질 뿐(보조), 데몬을 막지 않는다.
      void writeBoots({ consecutiveShortLived: 0 }).catch((err: unknown) => {
        console.warn(`[crash-loop] stability reset write failed: ${String(err)}`);
      });
    }, minLifetimeMs);
    stabilityTimer.unref?.();
  }

  function disarm(): void {
    if (stabilityTimer !== undefined) {
      scheduler.clearTimeout(stabilityTimer);
      stabilityTimer = undefined;
    }
  }

  return { checkOnBoot, armStable, disarm };
}
