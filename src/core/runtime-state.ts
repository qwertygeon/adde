/**
 * 데몬(프로젝트 스코프) 라이브니스 상태 파일(runtime.json, v2 — 세션 대신 프로젝트 단일 파일).
 * `core/liveness.ts` 가 기동 시 기록·주기 갱신하고 `core/daemon.ts` 의 정상 종료 경로에서
 * 제거한다. `adde status` 는 별도 프로세스라 daemon 의 in-memory 상태를 못 본다 → 이 파일이
 * 유일한 교차 프로세스 신호.
 */
import { unlink, readFile, stat, utimes } from "node:fs/promises";
import type { ProjectPaths } from "../shared/paths.js";
import { atomicWrite } from "../shared/fs-atomic.js";
import { errCode } from "../shared/errors.js";

export const HEARTBEAT_INTERVAL_MS = 60_000;
export const HEARTBEAT_STALE_MS = 180_000;

export interface RuntimeInfo {
  v: 1;
  /** 데몬 프로세스 pid(프로젝트당 1개). */
  pid: number;
  startedAt: string;
}

export type Liveness = "running" | "stale" | "dead" | "stopped" | "unreadable";

export type RuntimeRead =
  | { kind: "absent" }
  | { kind: "ok"; info: RuntimeInfo; mtimeMs: number }
  | { kind: "unreadable"; reason: string };

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

/** 판독 계약 — 부재/정상(+mtime)/판독 불가(+사유)를 판별 유니온으로 분리한다(FR-012). */
export async function readRuntime(paths: ProjectPaths): Promise<RuntimeRead> {
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(paths.runtimeJson)).mtimeMs;
  } catch (err) {
    if (errCode(err) === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: errCode(err) ?? "malformed" };
  }
  let text: string;
  try {
    text = await readFile(paths.runtimeJson, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: errCode(err) ?? "malformed" };
  }
  let parsed: Partial<RuntimeInfo>;
  try {
    parsed = JSON.parse(text) as Partial<RuntimeInfo>;
  } catch {
    return { kind: "unreadable", reason: "malformed" };
  }
  // 정수·양수만 유효 pid 로 인정한다 — `process.kill(0, 0)`(호출 프로세스의 프로세스 그룹 전체)과
  // `process.kill(-1, 0)`(권한 있는 전 프로세스, PID 1 제외)은 POSIX kill(2) 의미상 특수 대상이라
  // 예외 없이 참을 반환하므로(Node.js `process.kill` 문서·POSIX kill(2)), 손상된 기록의 `pid: 0`
  // 또는 음수가 "상주 중"으로 오판정될 수 있다.
  if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0)
    return { kind: "unreadable", reason: "schema" };
  return { kind: "ok", info: parsed as RuntimeInfo, mtimeMs };
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
  now?: number | undefined;
}

/** 판정 순서: 부재 → 판독 불가 → pid 부재 → 임계 초과 → 상주(§핵심 설계 2 결정표). */
export function livenessOf(read: RuntimeRead, opts: LivenessOptions = {}): Liveness {
  if (read.kind === "absent") return "stopped";
  if (read.kind === "unreadable") return "unreadable";
  if (!isPidAlive(read.info.pid)) return "dead";
  const now = opts.now ?? Date.now();
  if (now - read.mtimeMs > HEARTBEAT_STALE_MS) return "stale";
  return "running";
}

/** 검증용 주기 축약 — env `ADDE_HEARTBEAT_INTERVAL_MS`(양의 정수)만 유효, 그 외는 기본값(ADR-004). */
export function resolveHeartbeatIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ADDE_HEARTBEAT_INTERVAL_MS;
  if (raw !== undefined && /^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  return HEARTBEAT_INTERVAL_MS;
}
