/**
 * queue→processing 도메인 — atomic rename 기반 원자 전이. 소스 enqueue + injector claim 의
 * 2 writer 라 lock-free rewrite 전제(단독 writer)가 성립하지 않아 rename 기반을 유지한다.
 * tmp→rename 으로 부분 쓰기 미노출. out-상태(done/sending/sent/aborted/failed) 도메인은
 * 레인당 단일 구조화 ledger(`src/core/out-ledger.ts`)로 이관됐다.
 */
import { t } from "../shared/i18n.js";
import { mkdir, rename, readdir, readFile, unlink } from "node:fs/promises";
import { join, basename } from "node:path";
import { atomicWrite } from "../shared/fs-atomic.js";
import { errMsg, errCode } from "../shared/errors.js";
import type { LanePaths } from "../shared/paths.js";
import { serializeEnvelope, parseEnvelope } from "../shared/envelope.js";
import type { Envelope } from "../shared/envelope.js";
import { formatException } from "../shared/notify.js";
import { setFailed } from "./out-ledger.js";

/** queue 파일명 형식: <ts_ms>-<id>.msg */
function queueFileName(envelope: Envelope): string {
  const ts = Date.now();
  return `${ts}-${envelope.id}.msg`;
}

/** processing 파일명: <id>.msg */
function processingFileName(id: string): string {
  return `${id}.msg`;
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
  await atomicWrite(join(paths.queueDir, queueFileName(envelope)), serializeEnvelope(envelope));
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

  // 정렬 순서대로 claim 시도 — 경합(ENOENT)·손상(parse 실패)은 건너뛰고 다음 메시지로.
  for (const next of msgFiles) {
    const id = idFromQueueFile(next);
    const src = join(paths.queueDir, next);
    const dst = join(paths.processingDir, processingFileName(id));

    try {
      await rename(src, dst);
    } catch (err) {
      // ENOENT = 경합(다른 워커가 먼저 claim) 또는 파일 소멸 → 다음 후보로.
      // 그 외(EBUSY/EACCES/EXDEV/ENOSPC/NFS 등)는 일시·구조적 FS 오류 → 액션형 로그 후 전파.
      // 흡수해 null 을 돌리면 큐가 안 비었는데 idle 로 빠져 메시지가 무음 방치된다.
      if (errCode(err) === "ENOENT") continue;
      console.error(
        formatException({
          situation: t("queue.claimFail.situation", { code: errCode(err) ?? "unknown", path: src }),
          action: t("queue.claimFail.action"),
        }),
      );
      throw err;
    }

    let envelope: Envelope;
    try {
      envelope = parseEnvelope(await readFile(dst, "utf8"));
    } catch (parseErr) {
      // 손상 메시지(스키마/JSON 깨짐) — 격리 후 다음 후보로. 매 기동 동일 파싱오류 반복 차단.
      await quarantineCorrupt(paths, id, parseErr);
      continue;
    }

    return { id, envelope };
  }

  return null;
}

/**
 * 손상된 processing 메시지를 격리한다(poison message 차단).
 * processing/<id>.msg → processing/<id>.msg.corrupt (scanProcessing 의 `.msg` 필터에서 제외돼
 * 재기동 시 재처리되지 않는다) + out-ledger state="failed" 가시성 기록.
 */
export async function quarantineCorrupt(
  paths: LanePaths,
  id: string,
  reason: unknown,
): Promise<void> {
  const detail = errMsg(reason);
  const src = join(paths.processingDir, processingFileName(id));
  const corrupt = `${src}.corrupt`;
  try {
    await rename(src, corrupt);
  } catch (err) {
    // 이미 격리됐거나(ENOENT) 다른 워커가 처리 — 격리 자체 실패는 로그만(가시성 state=failed 는 계속 기록).
    if (errCode(err) !== "ENOENT") {
      console.error(t("log.queue.quarantineFail", { id, code: errCode(err) ?? "unknown" }));
    }
  }
  await setFailed(
    paths,
    id,
    t("queue.quarantined", { ts: new Date().toISOString(), detail }),
  ).catch((e: unknown) => console.error(t("log.queue.failedWriteFail", { id, error: errMsg(e) })));
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

/** processing/<id>.msg 경로를 직접 반환 (재처리 복원 등에 사용). */
export function processingFilePath(paths: LanePaths, id: string): string {
  return join(paths.processingDir, processingFileName(id));
}

/**
 * 처리 완료(out-ledger state=done 기록) 후 잉여가 된 processing/<id>.msg 를 제거(M5) — dedup 앵커는
 * ledger 이므로(isDone/hasId 가 out-ledger 로 판정) 이 삭제는 재기동 dedup 을 깨지 않고 processing/
 * 무한 증가만 막는다. done 이 기록되기 *전* 실패 경로에서는 호출하지 않는다(at-least-once 재처리
 * 보존 — setFailed 주석). 부재(이미 없음)는 무시.
 */
export async function clearProcessing(paths: LanePaths, id: string): Promise<void> {
  await unlink(processingFilePath(paths, id)).catch(() => {});
}

export { basename };
