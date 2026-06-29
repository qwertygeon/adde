/**
 * 레인 라이브니스 상태 파일(runtime.json) 입출력 + pid 생존 판정.
 * `adde up` 이 레인 기동 시 기록하고 graceful 종료(down·시그널)에서 제거한다.
 * `adde status` 는 별도 프로세스라 up 의 in-memory 상태를 못 본다 → 이 파일이 유일한 교차 프로세스 신호.
 */
import { writeFile, rename, mkdir, unlink, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LanePaths } from "../shared/paths.js";

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

/** 레인 라이브니스 — 파일/pid 조합으로 판정. */
export type Liveness = "running" | "dead" | "stopped";

/** runtime.json 을 원자적으로(tmp→rename) 기록. stateDir 부재 시 생성. */
export async function writeRuntime(paths: LanePaths, info: RuntimeInfo): Promise<void> {
  await mkdir(dirname(paths.runtimeJson), { recursive: true });
  const tmp = `${paths.runtimeJson}.tmp.${process.pid}`;
  await writeFile(tmp, JSON.stringify(info, null, 2) + "\n", "utf8");
  await rename(tmp, paths.runtimeJson);
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

/** runtime.json + pid 생존으로 라이브니스 판정. */
export function livenessOf(info: RuntimeInfo | null): Liveness {
  if (!info) return "stopped";
  return isPidAlive(info.pid) ? "running" : "dead";
}
