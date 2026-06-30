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
import { formatException } from "../shared/notify.js";

/** Node fs 오류 코드 추출(없으면 undefined). */
function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

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
  } catch (err) {
    // ENOENT(디렉터리 부재)는 빈 큐와 동치 — 정상. 그 외 FS 오류는 무음 흡수 금지(전파).
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }

  const msgFiles = files.filter((f) => f.endsWith(".msg")).sort();

  const next = msgFiles[0];
  if (!next) return null;

  const id = idFromQueueFile(next);
  const src = join(paths.queueDir, next);
  const dst = join(paths.processingDir, processingFileName(id));

  try {
    await rename(src, dst);
  } catch (err) {
    // ENOENT = 경합(다른 워커가 먼저 claim) 또는 파일 소멸 → 정상, null.
    // 그 외(EBUSY/EACCES/EXDEV/ENOSPC/NFS 등)는 일시·구조적 FS 오류 → 액션형 로그 후 전파.
    // 흡수해 null 을 돌리면 큐가 안 비었는데 idle 로 빠져 메시지가 무음 방치된다.
    if (errCode(err) === "ENOENT") return null;
    console.error(
      formatException({
        situation: `큐 메시지 claim 실패(${errCode(err) ?? "unknown"}): ${src}`,
        action:
          "디스크 용량·파일 권한·마운트(NFS/EBUSY)를 확인하세요. 메시지는 큐에 남아 다음 신호에 재시도됩니다.",
      }),
    );
    throw err;
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

/**
 * 해당 id 가 큐/처리/출력 어디든 이미 존재하는지 검사 — 크래시 재개 시 중복 enqueue 방지.
 * queue/<ts>-<id>.msg · processing/<id>.msg · out/<id>.out 중 하나라도 있으면 true.
 */
export async function hasId(paths: LanePaths, id: string): Promise<boolean> {
  if (await isDone(paths, id)) return true;
  try {
    await access(join(paths.processingDir, processingFileName(id)));
    return true;
  } catch {
    // processing 에 없음 — 큐 검사로 진행
  }
  try {
    const files = await readdir(paths.queueDir);
    return files.some((f) => f.endsWith(`-${id}.msg`));
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

  // sidecar 를 먼저 확정한다 — `.out` 이 dedup/done 마커(isDone)이므로 본문을 마지막에 rename 하면
  // "`.out` 존재 ⇒ sidecar 존재" 가 성립한다. 두 rename 사이 크래시에도 done 메시지가 reply_ref 를
  // 잃지 않고, reader 가 `.out` 만 보고 sidecar 부재 창을 만나지 않는다(DEC-001).
  const tmpSidecar = join(paths.outDir, tmpName(sidecarName));
  const finalSidecar = join(paths.outDir, sidecarName);
  await writeFile(tmpSidecar, JSON.stringify(sidecar), "utf8");
  await rename(tmpSidecar, finalSidecar);

  const tmpOut = join(paths.outDir, tmpName(outName));
  const finalOut = join(paths.outDir, outName);
  await writeFile(tmpOut, text, "utf8");
  await rename(tmpOut, finalOut);
}

/**
 * inject 실패 등 처리 실패를 out/<id>.failed 로 기록(E1, 가시성).
 * dedup 마커(.out)가 아니므로 processing/<id>.msg 는 남아 재기동 시 재처리된다(at-least-once 유지).
 */
export async function writeFailed(paths: LanePaths, id: string, reason: string): Promise<void> {
  await mkdir(paths.outDir, { recursive: true });
  const name = `${id}.failed`;
  const tmp = join(paths.outDir, tmpName(name));
  const final = join(paths.outDir, name);
  await writeFile(tmp, reason, "utf8");
  await rename(tmp, final);
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
