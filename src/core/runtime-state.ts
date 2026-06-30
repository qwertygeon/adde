/**
 * 레인 라이브니스 상태 파일(runtime.json) 입출력 + pid 생존 판정.
 * `adde up` 이 레인 기동 시 기록하고 graceful 종료(down·시그널)에서 제거한다.
 * `adde status` 는 별도 프로세스라 up 의 in-memory 상태를 못 본다 → 이 파일이 유일한 교차 프로세스 신호.
 */
import { writeFile, rename, mkdir, unlink, readFile, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import type { LanePaths } from "../shared/paths.js";

/** 하트비트 touch 주기 — up 이 이 간격으로 runtime.json mtime 을 갱신(긴 인터벌, 보조 신호). */
export const HEARTBEAT_INTERVAL_MS = 60_000;
/** stale 판정 임계 — mtime 이 이보다 오래되면 행(hung)으로 본다(인터벌의 3배 여유). */
export const HEARTBEAT_STALE_MS = 180_000;

/** runtime.json 에 기록되는 레인 런타임 정보. */
export interface RuntimeInfo {
  /** 스키마 버전 — 향후 형식 변경 시 forward-compat 판별. */
  v: 1;
  /** 레인을 기동한 up 프로세스의 pid. 생존 판정 대상. */
  pid: number;
  lane: string;
  sessionId: string;
  /** ISO8601 기동 시각. */
  startedAt: string;
  source: string;
  backend: string;
  engine: string;
}

/** 레인 라이브니스 — 파일/pid/하트비트 조합으로 판정. stale=pid 는 살아있으나 하트비트가 끊긴 행 상태. */
export type Liveness = "running" | "stale" | "dead" | "stopped";

/** runtime.json 을 원자적으로(tmp→rename) 기록. stateDir 부재 시 생성. */
export async function writeRuntime(paths: LanePaths, info: RuntimeInfo): Promise<void> {
  await mkdir(dirname(paths.runtimeJson), { recursive: true });
  const tmp = `${paths.runtimeJson}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(info, null, 2) + "\n", "utf8");
  await rename(tmp, paths.runtimeJson);
}

/**
 * 하트비트 — runtime.json 의 mtime 만 현재시각으로 갱신(utimes, 내용 재작성 없음).
 * 파일 부재(종료 레이스 등 ENOENT)는 무시 — 멱등. 그 외 오류는 호출부가 흡수(보조 신호).
 */
export async function touchRuntime(paths: LanePaths): Promise<void> {
  const now = new Date();
  try {
    await utimes(paths.runtimeJson, now, now);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** runtime.json 제거(graceful 종료). 부재(ENOENT)는 무시 — 멱등. */
export async function removeRuntime(paths: LanePaths): Promise<void> {
  try {
    await unlink(paths.runtimeJson);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** runtime.json 읽기. 부재·파싱불가·스키마 불일치 시 null(=stopped 로 취급). */
export async function readRuntime(paths: LanePaths): Promise<RuntimeInfo | null> {
  let text: string;
  try {
    text = await readFile(paths.runtimeJson, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<RuntimeInfo>;
    if (typeof parsed.pid === "number" && typeof parsed.sessionId === "string") {
      return parsed as RuntimeInfo;
    }
  } catch {
    // 손상된 파일 — null 로 취급(stopped). 진단은 status 가 별도 표면화하지 않는다.
  }
  return null;
}

/**
 * pid 생존 판정. `process.kill(pid, 0)` 은 신호를 보내지 않고 존재만 확인한다.
 * - 성공: 프로세스 존재 → running.
 * - EPERM: 존재하나 시그널 권한 없음(다른 소유자) → 존재하므로 running.
 * - ESRCH(그 외): 프로세스 없음 → dead(크래시 잔존).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** livenessOf 판정 입력 — 하트비트(mtime) 신선도까지 보려면 mtimeMs 주입. */
export interface LivenessOptions {
  /** runtime.json 의 mtime(ms). 주입 시 stale 판정에 사용. 미주입이면 pid-only(running/dead). */
  mtimeMs?: number | undefined;
  /** 현재시각(ms). 테스트 주입용. 기본 Date.now(). */
  now?: number | undefined;
}

/**
 * runtime.json + pid 생존 + 하트비트(mtime)로 라이브니스 판정.
 * - 파일 없음 → stopped, pid 없음 → dead.
 * - pid 생존 + mtime 임계 초과 → stale(행). mtime 미주입이면 running(pid-only).
 */
export function livenessOf(info: RuntimeInfo | null, opts: LivenessOptions = {}): Liveness {
  if (!info) return "stopped";
  if (!isPidAlive(info.pid)) return "dead";
  const { mtimeMs, now = Date.now() } = opts;
  if (mtimeMs !== undefined && now - mtimeMs > HEARTBEAT_STALE_MS) return "stale";
  return "running";
}
