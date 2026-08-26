/**
 * 데몬(프로젝트 스코프) 라이브니스 상태 파일(runtime.json, v2 — 세션 대신 프로젝트 단일 파일).
 * `adde up` 이 기동 시 기록하고 graceful 종료(down·시그널)에서 제거한다. `adde status` 는 별도
 * 프로세스라 daemon 의 in-memory 상태를 못 본다 → 이 파일이 유일한 교차 프로세스 신호.
 */
import { unlink, readFile, utimes } from "node:fs/promises";
import type { ProjectPaths } from "../shared/paths.js";
import { atomicWrite } from "../shared/fs-atomic.js";

export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_STALE_MS = 180_000;

export interface RuntimeInfo {
  v: 1;
  /** 데몬 프로세스 pid(프로젝트당 1개). */
  pid: number;
  startedAt: string;
}

export type Liveness = "running" | "stale" | "dead" | "stopped";

export async function writeRuntime(paths: ProjectPaths, info: RuntimeInfo): Promise<void> {
  await atomicWrite(paths.runtimeJson, JSON.stringify(info, null, 2) + "\n");
}

export async function touchRuntime(paths: ProjectPaths): Promise<void> {
  const now = new Date();
  try {
    await utimes(paths.runtimeJson, now, now);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function removeRuntime(paths: ProjectPaths): Promise<void> {
  try {
    await unlink(paths.runtimeJson);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function readRuntime(paths: ProjectPaths): Promise<RuntimeInfo | null> {
  let text: string;
  try {
    text = await readFile(paths.runtimeJson, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<RuntimeInfo>;
    if (typeof parsed.pid === "number") return parsed as RuntimeInfo;
  } catch {
    // 손상된 파일 — null(stopped) 취급.
  }
  return null;
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LivenessOptions {
  mtimeMs?: number | undefined;
  now?: number | undefined;
}

export function livenessOf(info: RuntimeInfo | null, opts: LivenessOptions = {}): Liveness {
  if (!info) return "stopped";
  if (!isPidAlive(info.pid)) return "dead";
  const { mtimeMs, now = Date.now() } = opts;
  if (mtimeMs !== undefined && now - mtimeMs > HEARTBEAT_STALE_MS) return "stale";
  return "running";
}
