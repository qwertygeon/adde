/**
 * 크기 기반 rename 세대 로그 회전 공용 프리미티브.
 * 최고령 세대 삭제 → rename 체인(current→.1→.2→...→.keep). 호출자(transcript·spawn)가
 * fail-open(경고 후 흡수)을 결정한다 — 본 함수는 실패 시 그대로 throw 한다.
 */
import { rename as fsRename, unlink as fsUnlink } from "node:fs/promises";

/** 5MB — 회전 임계 기본값(기능 파라미터). */
export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** 보관 세대 수 기본값. */
export const DEFAULT_LOG_KEEP = 2;

export interface RotateConfig {
  maxBytes: number;
  keep: number;
}

/** 테스트 주입용 파일 연산 — 미주입 시 fs.promises 기본. */
export interface RotateDeps {
  rename?: (a: string, b: string) => Promise<void>;
  unlink?: (p: string) => Promise<void>;
}

/** ENOENT 는 흡수(대상 세대 파일 부재 — 정상 상태), 그 외는 재던짐. */
async function unlinkIgnoreEnoent(
  unlinkFn: (p: string) => Promise<void>,
  path: string,
): Promise<void> {
  try {
    await unlinkFn(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** ENOENT 는 흡수(rename 원본 세대 부재 — 아직 그만큼 회전이 안 된 상태), 그 외는 재던짐. */
async function renameIgnoreEnoent(
  renameFn: (a: string, b: string) => Promise<void>,
  from: string,
  to: string,
): Promise<void> {
  try {
    await renameFn(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * 세대 회전 — `unlink(.{keep})` → `for k=keep-1..1: rename(.{k}, .{k+1})` → `rename(current, .1)`.
 * 회전 연산 자체의 실패는 그대로 throw(호출자가 fail-open 흡수).
 */
export async function rotateGenerations(
  logPath: string,
  cfg: RotateConfig,
  deps?: RotateDeps,
): Promise<void> {
  const rename = deps?.rename ?? fsRename;
  const unlink = deps?.unlink ?? fsUnlink;

  await unlinkIgnoreEnoent(unlink, `${logPath}.${cfg.keep}`);
  for (let k = cfg.keep - 1; k >= 1; k--) {
    await renameIgnoreEnoent(rename, `${logPath}.${k}`, `${logPath}.${k + 1}`);
  }
  await renameIgnoreEnoent(rename, logPath, `${logPath}.1`);
}
