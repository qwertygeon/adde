/**
 * 무손실 파일/디렉터리 이동 — 리포에 크로스디바이스 이동기 선례가 없어 신규 도입.
 * rename(fast path, 동일 볼륨) 우선 시도 → EXDEV(타 볼륨)|ENOTEMPTY|EEXIST(대상 기존 존재) 시
 * 항목별 copy→fsync→크기 검증→원본 unlink 로 폴백한다. 검증 전 원본 삭제는 절대 하지 않는다 —
 * 어떤 중단점에서도 원본 또는 사본 중 최소 하나가 보존된다.
 * 파일 단위로 항상 materialize 훅을 먼저 호출한다(디렉터리 통째 rename 최적화를 하지 않는 이유 —
 * iCloud dataless placeholder 를 vault 밖으로 이동하기 전에는 반드시 다운로드 확정이 선행돼야
 * 하며, 이는 개별 파일 단위 결정이라 상위 디렉터리 rename 한 번으로 우회할 수 없다).
 */
import { rename, mkdir, copyFile, unlink, rmdir, readdir, stat, open } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { errCode } from "./errors.js";

export type SafeMoveMaterialize = "ready" | "skip";

export interface SafeMoveOptions {
  /** 파일 이동 전 물질화 보장 훅(iCloud dataless 등) — "skip" 이면 해당 파일을 건너뛴다(다음 실행 재시도). */
  materialize?: (filePath: string) => Promise<SafeMoveMaterialize>;
}

export interface SafeMoveResult {
  /** 이동 완료된 항목의 상대경로(디렉터리 이동 시 src 기준, 단일 파일 이동 시 basename). */
  moved: string[];
  /** materialize 가 "skip" 을 반환해 건너뛴 항목(원본은 src 에 보존, 다음 실행 재시도 대상). */
  skipped: string[];
}

/** rename 실패 시 copy 폴백으로 전환하는 오류 코드 — EXDEV(타 볼륨)·ENOTEMPTY/EEXIST(대상 기존 존재). */
const FALLBACK_CODES = new Set(["EXDEV", "ENOTEMPTY", "EEXIST"]);

/**
 * src 를 dst 로 무손실 이동한다. src 가 디렉터리면 재귀적으로 병합(merge) 이동하고(기존 dst 항목과
 * 공존하는 병합 시맨틱), 파일이면 단일 이동한다. 반환값의 moved/skipped 는 상대경로 목록.
 */
export async function safeMove(
  src: string,
  dst: string,
  opts?: SafeMoveOptions,
): Promise<SafeMoveResult> {
  const materialize = opts?.materialize;
  const srcStat = await stat(src);
  const moved: string[] = [];
  const skipped: string[] = [];

  if (!srcStat.isDirectory()) {
    await moveFile(src, dst, materialize, basename(src), moved, skipped);
    return { moved, skipped };
  }

  await mkdir(dst, { recursive: true });
  await mergeDir(src, dst, materialize, moved, skipped, "");
  // 빈 원본 폴더 best-effort 제거 — skip 으로 남은 파일이 있으면 실패(무해, 다음 실행에 재시도).
  await rmdir(src).catch(() => {});
  return { moved, skipped };
}

/** 디렉터리 재귀 병합 — 항목별로 이동, 하위 폴더는 완료 후 best-effort rmdir. */
async function mergeDir(
  srcDir: string,
  dstDir: string,
  materialize: SafeMoveOptions["materialize"],
  moved: string[],
  skipped: string[],
  relBase: string,
): Promise<void> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = relBase ? join(relBase, entry.name) : entry.name;
    const s = join(srcDir, entry.name);
    const d = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(d, { recursive: true });
      await mergeDir(s, d, materialize, moved, skipped, rel);
      await rmdir(s).catch(() => {}); // 새로 착지한 파일이 남으면 실패 — 다음 실행에 재시도(루프 금지).
    } else {
      await moveFile(s, d, materialize, rel, moved, skipped);
    }
  }
}

/** 파일 1건 이동 — materialize 훅 → rename 시도 → 폴백(copy→fsync→검증→unlink). */
async function moveFile(
  src: string,
  dst: string,
  materialize: SafeMoveOptions["materialize"],
  rel: string,
  moved: string[],
  skipped: string[],
): Promise<void> {
  if (materialize) {
    const result = await materialize(src);
    if (result === "skip") {
      skipped.push(rel);
      return;
    }
  }
  await mkdir(dirname(dst), { recursive: true });
  try {
    await rename(src, dst);
    moved.push(rel);
    return;
  } catch (err) {
    const code = errCode(err);
    if (!code || !FALLBACK_CODES.has(code)) throw err;
  }
  await copyVerifyUnlink(src, dst);
  moved.push(rel);
}

/**
 * copy→fsync→크기 검증→원본 unlink. 검증 전 원본 삭제는 절대 하지 않는다 — 크래시가 나면
 * 원본이 그대로 남아 다음 실행이 재시도한다(유실 없음). 검증 실패 시 원본을 보존하고 throw.
 */
async function copyVerifyUnlink(src: string, dst: string): Promise<void> {
  await copyFile(src, dst);
  const fh = await open(dst, "r+");
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  const [srcStat, dstStat] = await Promise.all([stat(src), stat(dst)]);
  if (dstStat.size !== srcStat.size) {
    throw new Error(`fs-move: verify failed (size mismatch) ${src} -> ${dst}`);
  }
  await unlink(src);
}
