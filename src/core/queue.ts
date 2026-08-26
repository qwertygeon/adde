/**
 * queue→processing 도메인(세션 스코프, v2) — atomic rename 기반 원자 전이(현행 `core/queue.ts` 이식,
 * `LanePaths` 의존을 `SessionPaths` 로 교체). Surface(enqueue) + TurnRunner(claim) 의 2 writer 라
 * rename 기반 lock-free 전이를 유지한다. out-ledger 의존은 제거(실패 기록은 이벤트로 — TurnRunner 소관).
 */
import { mkdir, rename, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../shared/fs-atomic.js";
import { errMsg, errCode } from "../shared/errors.js";
import type { SessionPaths } from "../shared/paths.js";
import { serializeEnvelope, parseEnvelope } from "../shared/envelope.js";
import type { Envelope } from "../shared/envelope.js";

/** queue 파일명 형식: <ts_ms>-<id>.msg */
function queueFileName(envelope: Envelope): string {
  return `${Date.now()}-${envelope.id}.msg`;
}

function processingFileName(id: string): string {
  return `${id}.msg`;
}

function idFromQueueFile(filename: string): string {
  const base = filename.replace(/\.msg$/, "");
  const dashIdx = base.indexOf("-");
  return dashIdx === -1 ? base : base.slice(dashIdx + 1);
}

function idFromProcessingFile(filename: string): string {
  return filename.replace(/\.msg$/, "");
}

/** envelope 을 queue 디렉토리에 atomic rename 으로 저장(부분 쓰기 미노출). */
export async function enqueue(paths: SessionPaths, envelope: Envelope): Promise<void> {
  await atomicWrite(join(paths.queueDir, queueFileName(envelope)), serializeEnvelope(envelope));
}

/** queue 에서 다음 envelope 을 꺼내 processing 으로 이동. 큐가 비어 있으면 null. */
export async function claimNext(
  paths: SessionPaths,
): Promise<{ id: string; envelope: Envelope } | null> {
  await mkdir(paths.queueDir, { recursive: true });
  await mkdir(paths.processingDir, { recursive: true });

  let files: string[];
  try {
    files = await readdir(paths.queueDir);
  } catch (err) {
    if (errCode(err) === "ENOENT") return null;
    throw err;
  }

  const msgFiles = files.filter((f) => f.endsWith(".msg")).sort();

  for (const next of msgFiles) {
    const id = idFromQueueFile(next);
    const src = join(paths.queueDir, next);
    const dst = join(paths.processingDir, processingFileName(id));

    try {
      await rename(src, dst);
    } catch (err) {
      if (errCode(err) === "ENOENT") continue; // 경합(다른 워커가 먼저 claim) — 다음 후보로.
      console.error(`queue: claim 실패 (${src}): ${errCode(err) ?? "unknown"}`);
      throw err;
    }

    let envelope: Envelope;
    try {
      envelope = parseEnvelope(await readFile(dst, "utf8"));
    } catch (parseErr) {
      await quarantineCorrupt(paths, id, parseErr);
      continue;
    }

    return { id, envelope };
  }

  return null;
}

/** 손상된 processing 메시지를 격리(poison message 차단) — `.corrupt` 접미(scanProcessing 필터 제외). */
export async function quarantineCorrupt(
  paths: SessionPaths,
  id: string,
  reason: unknown,
): Promise<void> {
  const src = join(paths.processingDir, processingFileName(id));
  const corrupt = `${src}.corrupt`;
  try {
    await rename(src, corrupt);
  } catch (err) {
    if (errCode(err) !== "ENOENT") {
      console.error(`queue: 격리 실패 (${id}): ${errCode(err) ?? "unknown"}`);
    }
  }
  console.error(`queue: 손상 메시지 격리 (${id}): ${errMsg(reason)}`);
}

/** processing 디렉토리 스캔 — 크래시 재개 대상 id 목록. */
export async function scanProcessing(paths: SessionPaths): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(paths.processingDir);
  } catch {
    return [];
  }
  return files.filter((f) => f.endsWith(".msg")).map(idFromProcessingFile);
}

/** processing/<id>.msg 경로를 직접 반환(재처리 복원 등에 사용). */
export function processingFilePath(paths: SessionPaths, id: string): string {
  return join(paths.processingDir, processingFileName(id));
}

/** 턴 완결 후 잉여가 된 processing/<id>.msg 를 제거 — dedup 앵커는 이벤트 기록(turn_end)이므로
 * 이 삭제는 재기동 재적재 판정을 깨지 않고 processing/ 무한 증가만 막는다. */
export async function clearProcessing(paths: SessionPaths, id: string): Promise<void> {
  await unlink(processingFilePath(paths, id)).catch(() => {});
}
