/**
 * atomic 저장·상태 전이·dedup.
 * FR-002/003/005/ADR-004: tmp→rename 으로 부분 쓰기 미노출.
 * queue→processing→out 상태 전이는 원자적 rename.
 */
import { mkdir, writeFile, rename, readdir, access } from "node:fs/promises";
import { join, basename } from "node:path";
import type { LanePaths } from "../shared/paths.js";
import { serializeEnvelope } from "../shared/envelope.js";
import type { Envelope } from "../shared/envelope.js";

/** queue 파일명 형식: <ts_ms>-<id>.msg */
function queueFileName(envelope: Envelope): string {
  const ts = Date.now();
  return `${ts}-${envelope.id}.msg`;
}

/** processing 파일명: <id>.msg */
function processingFileName(id: string): string {
  return `${id}.msg`;
}

/** tmp 파일명: .<name>.tmp */
function tmpName(name: string): string {
  return `.${name}.tmp`;
}

/** id 를 queue 파일명에서 추출. */
function idFromQueueFile(filename: string): string {
  const base = filename.replace(/\.msg$/, "");
  const dashIdx = base.indexOf("-");
  return dashIdx === -1 ? base : base.slice(dashIdx + 1);
}

/** id 를 processing 파일명에서 추출. */
function idFromProcessingFile(filename: string): string {
  return filename.replace(/\.msg$/, "");
}

/**
 * envelope 을 queue 디렉토리에 atomic rename 으로 저장.
 * tmp 작성 완료 후 rename → 부분 쓰기가 queue 에 노출되지 않는다.
 */
export async function enqueue(paths: LanePaths, envelope: Envelope): Promise<void> {
  await mkdir(paths.queueDir, { recursive: true });

  const name = queueFileName(envelope);
  const tmpPath = join(paths.queueDir, tmpName(name));
  const finalPath = join(paths.queueDir, name);

  await writeFile(tmpPath, serializeEnvelope(envelope), "utf8");
  await rename(tmpPath, finalPath);
}

/**
 * queue 에서 다음 envelope 을 꺼내 processing 으로 이동.
 * 큐가 비어 있으면 null 반환.
 */
export async function claimNext(
  paths: LanePaths,
): Promise<{ id: string; envelope: Envelope } | null> {
  await mkdir(paths.queueDir, { recursive: true });
  await mkdir(paths.processingDir, { recursive: true });

  let files: string[];
  try {
    files = await readdir(paths.queueDir);
  } catch {
    return null;
  }

  const msgFiles = files.filter((f) => f.endsWith(".msg")).sort();

  const next = msgFiles[0];
  if (!next) return null;

  const id = idFromQueueFile(next);
  const src = join(paths.queueDir, next);
  const dst = join(paths.processingDir, processingFileName(id));

  try {
    await rename(src, dst);
  } catch {
    return null;
  }

  const { readFile } = await import("node:fs/promises");
  const json = await readFile(dst, "utf8");
  const { parseEnvelope } = await import("../shared/envelope.js");
  const envelope = parseEnvelope(json);

  return { id, envelope };
}

/**
 * processing 디렉토리 스캔 — 크래시 재개 대상 id 목록.
 */
export async function scanProcessing(paths: LanePaths): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(paths.processingDir);
  } catch {
    return [];
  }

  return files.filter((f) => f.endsWith(".msg")).map(idFromProcessingFile);
}

/**
 * out/<id>.out 존재 여부 검사 — dedup 판정.
 */
export async function isDone(paths: LanePaths, id: string): Promise<boolean> {
  const outPath = join(paths.outDir, `${id}.out`);
  try {
    await access(outPath);
    return true;
  } catch {
    return false;
  }
}

export interface OutSidecar {
  reply_ref?: { channel_msg_id: string; thread?: string };
  ts?: string;
}

/**
 * 처리 결과를 out 디렉토리에 atomic rename 으로 기록.
 * <id>.out (텍스트) + <id>.out.json (sidecar).
 */
export async function writeOut(
  paths: LanePaths,
  id: string,
  text: string,
  sidecar: OutSidecar,
): Promise<void> {
  await mkdir(paths.outDir, { recursive: true });

  const outName = `${id}.out`;
  const sidecarName = `${id}.out.json`;

  const tmpOut = join(paths.outDir, tmpName(outName));
  const finalOut = join(paths.outDir, outName);
  await writeFile(tmpOut, text, "utf8");
  await rename(tmpOut, finalOut);

  const tmpSidecar = join(paths.outDir, tmpName(sidecarName));
  const finalSidecar = join(paths.outDir, sidecarName);
  await writeFile(tmpSidecar, JSON.stringify(sidecar), "utf8");
  await rename(tmpSidecar, finalSidecar);
}

/** processing/<id>.msg 경로를 직접 반환 (재처리 복원 등에 사용). */
export function processingFilePath(paths: LanePaths, id: string): string {
  return join(paths.processingDir, processingFileName(id));
}

/** out/<id>.out.json sidecar 읽기. */
export async function readSidecar(paths: LanePaths, id: string): Promise<OutSidecar | null> {
  const sidecarPath = join(paths.outDir, `${id}.out.json`);
  try {
    const { readFile } = await import("node:fs/promises");
    const json = await readFile(sidecarPath, "utf8");
    return JSON.parse(json) as OutSidecar;
  } catch {
    return null;
  }
}

export { basename };
