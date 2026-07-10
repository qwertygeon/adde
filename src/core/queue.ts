/**
 * atomic 저장·상태 전이·dedup.
 * tmp→rename 으로 부분 쓰기 미노출.
 * queue→processing→out 상태 전이는 원자적 rename.
 */
import { t } from "../shared/i18n.js";
import { mkdir, rename, readdir, access, readFile, unlink, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { atomicWrite } from "../shared/fs-atomic.js";
import { errMsg, errCode } from "../shared/errors.js";
import type { LanePaths } from "../shared/paths.js";
import { serializeEnvelope, parseEnvelope } from "../shared/envelope.js";
import type { Envelope } from "../shared/envelope.js";
import { formatException } from "../shared/notify.js";

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
 * 재기동 시 재처리되지 않는다) + out/<id>.failed 가시성 기록.
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
    // 이미 격리됐거나(ENOENT) 다른 워커가 처리 — 격리 자체 실패는 로그만(가시성 .failed 는 계속 기록).
    if (errCode(err) !== "ENOENT") {
      console.error(t("log.queue.quarantineFail", { id, code: errCode(err) ?? "unknown" }));
    }
  }
  await writeFailed(
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
  /** turn 완료 시각(ISO). */
  ts?: string;
  /** 원본 메시지 전송(enqueue) 시각(envelope.ts) — 채널 렌더의 스탬프 SoT. */
  origin_ts?: string;
  /** 원본 질문 발췌(첫 줄, 마스킹) — 채널 렌더 헤더의 맥락 표시용. */
  question?: string;
}

/**
 * renderOut 힌트(M7) — injector 가 방금 메모리에서 out 에 쓴 텍스트·sidecar 를 그대로 넘겨
 * 어댑터의 디스크 재read 를 생략한다. 부재(크래시 복구 flush 경로 등)면 어댑터가 디스크에서 읽는다.
 */
export interface RenderHint {
  text: string;
  sidecar: OutSidecar | null;
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
  // sidecar 를 먼저 확정한다 — `.out` 이 dedup/done 마커(isDone)이므로 본문을 마지막에 rename 하면
  // "`.out` 존재 ⇒ sidecar 존재" 가 성립한다. 두 rename 사이 크래시에도 done 메시지가 reply_ref 를
  // 잃지 않고, reader 가 `.out` 만 보고 sidecar 부재 창을 만나지 않는다.
  await atomicWrite(join(paths.outDir, `${id}.out.json`), JSON.stringify(sidecar));
  await atomicWrite(join(paths.outDir, `${id}.out`), text);
}

/**
 * 채널 전송 성공 마커 out/<id>.sent 기록(atomic). `.out`(응답 영속·dedup)과 분리해
 * "응답은 기록됐으나 채널 미전송" 상태를 표현 — render 실패 시 재전송 대상 판별에 쓰인다.
 */
export async function markSent(paths: LanePaths, id: string): Promise<void> {
  await atomicWrite(join(paths.outDir, `${id}.sent`), new Date().toISOString());
}

/** out/<id>.sent 존재 여부 — 채널 전송 완료 판정. */
export async function isSent(paths: LanePaths, id: string): Promise<boolean> {
  try {
    await access(join(paths.outDir, `${id}.sent`));
    return true;
  } catch {
    return false;
  }
}

/**
 * render 진행 중 저널 마커 out/<id>.sending 기록(atomic) — 비멱등 소스(telegram) 전송 직전.
 * 프로세스가 이 마커를 남긴 채(=.sent 전) 죽으면 재시작 시 "전달 여부 불확실"로 판정해 재전송하지
 * 않는다(at-most-once across restart). 정상 성공·프로세스 내 실패 시엔 clearSending 으로 제거된다.
 */
export async function markSending(paths: LanePaths, id: string): Promise<void> {
  await atomicWrite(join(paths.outDir, `${id}.sending`), new Date().toISOString());
}

/** out/<id>.sending 존재 여부 — render 진행 중 크래시(전달 불확실) 판정. */
export async function isSending(paths: LanePaths, id: string): Promise<boolean> {
  try {
    await access(join(paths.outDir, `${id}.sending`));
    return true;
  } catch {
    return false;
  }
}

/** out/<id>.sending 저널 제거(전송 성공·프로세스 내 실패 시). 부재는 무시. */
export async function clearSending(paths: LanePaths, id: string): Promise<void> {
  await unlink(join(paths.outDir, `${id}.sending`)).catch(() => {});
}

/**
 * 전달 불확실 종단 마커 out/<id>.aborted 기록(atomic). `.sent`(전달 완료)와 구분해 "전송 시도 중
 * 크래시 — 전달 여부 불확실"을 표현하되, findUnsent 가 종단으로 제외해 재시작마다 반복 통지되지 않는다.
 */
export async function markAborted(paths: LanePaths, id: string): Promise<void> {
  await atomicWrite(join(paths.outDir, `${id}.aborted`), new Date().toISOString());
}

/**
 * 응답은 기록됐으나(out/<id>.out) 채널 전송이 안 된(out/<id>.sent 부재) id 목록.
 * render 실패·크래시로 미전달된 응답의 재전송 대상.
 */
export async function findUnsent(paths: LanePaths): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(paths.outDir);
  } catch {
    return [];
  }
  // 종단(재전송 비대상): .sent(전달 완료) + .aborted(전달 불확실 종단 — markAborted).
  const terminal = new Set<string>();
  for (const f of files) {
    if (f.endsWith(".sent")) terminal.add(f.replace(/\.sent$/, ""));
    else if (f.endsWith(".aborted")) terminal.add(f.replace(/\.aborted$/, ""));
  }
  return files
    .filter((f) => f.endsWith(".out"))
    .map((f) => f.replace(/\.out$/, ""))
    .filter((id) => !terminal.has(id));
}

/**
 * inject 실패 등 처리 실패를 out/<id>.failed 로 기록(E1, 가시성).
 * dedup 마커(.out)가 아니므로 processing/<id>.msg 는 남아 재기동 시 재처리된다(at-least-once 유지).
 */
export async function writeFailed(paths: LanePaths, id: string, reason: string): Promise<void> {
  await atomicWrite(join(paths.outDir, `${id}.failed`), reason);
}

/** processing/<id>.msg 경로를 직접 반환 (재처리 복원 등에 사용). */
export function processingFilePath(paths: LanePaths, id: string): string {
  return join(paths.processingDir, processingFileName(id));
}

/**
 * 처리 완료(out/<id>.out 기록) 후 잉여가 된 processing/<id>.msg 를 제거(M5) — dedup 앵커는 out/ 이므로
 * (hasId/isDone 이 out 으로 판정) 이 삭제는 재기동 dedup 을 깨지 않고 processing/ 무한 증가만 막는다.
 * out 이 기록되기 *전* 실패 경로에서는 호출하지 않는다(at-least-once 재처리 보존 — writeFailed 주석).
 * 부재(이미 없음)는 무시.
 */
export async function clearProcessing(paths: LanePaths, id: string): Promise<void> {
  await unlink(processingFilePath(paths, id)).catch(() => {});
}

/** out/<id>.out.json sidecar 읽기. */
export async function readSidecar(paths: LanePaths, id: string): Promise<OutSidecar | null> {
  const sidecarPath = join(paths.outDir, `${id}.out.json`);
  try {
    const json = await readFile(sidecarPath, "utf8");
    return JSON.parse(json) as OutSidecar;
  } catch {
    return null;
  }
}

/** id 단위 그룹을 구성하는 out/ 파일 접미사(dedup 앵커 전체). */
const OUT_GROUP_SUFFIXES = [".out", ".out.json", ".sent", ".aborted", ".failed"] as const;
/** id 추출용 접미사(위 그룹 + 진행 중 마커) — 긴 접미사(`.out.json`)를 `.out` 보다 먼저 검사해야 오매치를 피한다. */
const ID_EXTRACT_SUFFIXES = [".out.json", ".out", ".sent", ".sending", ".aborted", ".failed"] as const;

/**
 * 마커 파일의 나이(now 기준 경과일)를 판정한다. 내용이 ISO 타임스탬프(markSent/markAborted 가
 * 기록)로 파싱되면 그 값을 우선 사용하고, 아니면(`.failed` 는 사유 문자열이라 파싱 실패) 파일
 * mtime 으로 폴백한다.
 */
async function markerAgeDays(filePath: string, now: Date): Promise<number> {
  let ts: Date | null = null;
  try {
    const content = (await readFile(filePath, "utf8")).trim();
    const d = new Date(content);
    if (!Number.isNaN(d.getTime())) ts = d;
  } catch {
    // 읽기 실패 — mtime 폴백으로 진행
  }
  if (!ts) ts = (await stat(filePath)).mtime;
  return (now.getTime() - ts.getTime()) / (24 * 60 * 60 * 1000);
}

/**
 * state out/ 의 dedup 앵커를 정리(prune)한다. 종단 그룹(`.sent`/`.aborted` 중 하나 이상 존재 —
 * findUnsent 의 종단 정의와 동일 집합)만 대상이며, 전송 진행 중(`.sending`) id 는 절대 제외한다.
 * `.failed` 는 종단이 아니다 — `.out`+`.failed`(전송 실패·재전송 대기) id 는 flushUnsent 재시도
 * 대상이므로 삭제하면 미전달 응답 파괴 + dedup 앵커 소실이 된다(보존). 안전창(safeWindowDays)
 * 경과분만 id 단위 원자 그룹(`.out`/`.out.json`/`.sent`/`.aborted`/`.failed` 동시 unlink — `.failed`
 * 는 종단 판정엔 안 쓰이나 종단 그룹의 잔여 가시성 파일로서 함께 정리, 부재는 무시)으로 삭제한다.
 * flat 유지 — isDone/hasId 의 O(1) access 계약을 깨지 않는다. 재실행은 no-op(idempotent).
 */
export async function pruneOut(
  paths: LanePaths,
  safeWindowDays: number,
  now: Date = new Date(),
): Promise<{ removed: string[] }> {
  let files: string[];
  try {
    files = await readdir(paths.outDir);
  } catch {
    return { removed: [] };
  }

  const ids = new Set<string>();
  for (const f of files) {
    for (const suf of ID_EXTRACT_SUFFIXES) {
      if (f.endsWith(suf)) {
        ids.add(f.slice(0, -suf.length));
        break;
      }
    }
  }

  const removed: string[] = [];
  for (const id of ids) {
    if (await isSending(paths, id)) continue; // 진행 중 — 절대 제외(권한 게이트·미전송 메시지 보호)

    const terminalSuffixes = [".sent", ".aborted"] as const;
    let latestAge: number | null = null;
    for (const suf of terminalSuffixes) {
      try {
        const age = await markerAgeDays(join(paths.outDir, `${id}${suf}`), now);
        if (latestAge === null || age < latestAge) latestAge = age; // 가장 최근(나이 최소) 종단 시각 기준
      } catch {
        // 해당 종단 마커 없음 — 다음 후보
      }
    }
    if (latestAge === null) continue; // 종단 마커 없음(미완료) — 보존
    if (latestAge < safeWindowDays) continue; // 안전창 미경과 — 보존

    await Promise.all(
      OUT_GROUP_SUFFIXES.map((suf) => unlink(join(paths.outDir, `${id}${suf}`)).catch(() => {})),
    );
    removed.push(id);
  }

  return { removed };
}

export { basename };
