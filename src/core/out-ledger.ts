/**
 * out-상태 SSOT(레인당 `out/<lane>/ledger.json`) — id → {state, sidecar} 단일 구조화 레코드.
 * `.out.json`/`.sent`/`.sending`/`.aborted`/`.failed` 마커 존재조합을 대체한다(013-out-state-ledger).
 * 응답 본문은 여전히 `<id>.out` 파일로 분리 유지(대용량 텍스트가 ledger 를 오염시키지 않도록).
 * 종단(TERMINAL_STATES)·재주입비대상(DONE_STATES) 정의는 여기 한 곳에만 있고 모든 리더가 소비한다.
 * 상태 전이는 각 1회 atomic tmp→rename rewrite — 단독 writer(injector) + in-process 직렬화로 락 불요.
 */
import { readFile, unlink, access, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../shared/fs-atomic.js";
import { errMsg, errCode } from "../shared/errors.js";
import { t } from "../shared/i18n.js";
import { formatException } from "../shared/notify.js";
import type { LanePaths } from "../shared/paths.js";

export type OutState = "done" | "sending" | "sent" | "aborted" | "failed";

export interface OutSidecar {
  reply_ref?: { channel_msg_id: string; thread?: string };
  /** 전이 시각(ISO) — turn 완료 등 개별 호출측이 스탬프를 고정하고 싶을 때 지정. */
  ts?: string;
  /** 원본 메시지 전송(enqueue) 시각(envelope.ts) — 채널 렌더의 스탬프 SoT. */
  origin_ts?: string;
  /** 원본 질문 발췌(첫 줄, 마스킹) — 채널 렌더 헤더의 맥락 표시용. */
  question?: string;
}

export interface OutEntry extends OutSidecar {
  state: OutState;
  /** 이 entry 의 최신 전이 시각(ISO). */
  ts: string;
  /** failed 상태 사유(가시성) — 구 `.failed` 사이드카 동등. */
  reason?: string;
}

export interface OutLedger {
  v: 1;
  entries: Record<string, OutEntry>;
}

/**
 * renderOut 힌트 — injector 가 방금 메모리에서 기록한 텍스트·sidecar 를 그대로 넘겨 어댑터의
 * 디스크 재read 를 생략한다(hot-path). 부재(크래시 복구 flush 경로 등)면 어댑터가 디스크에서 읽는다.
 */
export interface RenderHint {
  text: string;
  sidecar: OutSidecar | null;
}

/** 재전송 비대상 종단의 단일 정의 — findUnsent·pruneOut 이 공유 소비한다(리더별 독립 재도출 금지). */
export const TERMINAL_STATES: ReadonlySet<OutState> = new Set(["sent", "aborted"]);
/** 재주입 비대상(dedup) — failed·entry 부재는 not-done(재처리 대상). */
export const DONE_STATES: ReadonlySet<OutState> = new Set(["done", "sending", "sent", "aborted"]);
/** 응답은 기록됐으나 미전송(DONE_STATES 이면서 TERMINAL_STATES 아님) — DONE_STATES/TERMINAL_STATES 에서
 * 파생해 findUnsent 가 별도 리터럴로 재도출하지 않게 한다(상태모델 변경 시 두 상수만 갱신하면 전파). */
export const UNSENT_STATES: ReadonlySet<OutState> = new Set(
  [...DONE_STATES].filter((s) => !TERMINAL_STATES.has(s)),
);

/** 레거시 마커 접미사(마이그레이션 스캔 대상) — 긴 접미사를 먼저 검사해 오매치를 피한다. */
const LEGACY_SUFFIXES = [".out.json", ".out", ".sent", ".sending", ".aborted", ".failed"] as const;
type LegacySuffix = (typeof LEGACY_SUFFIXES)[number];

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 경과일(now 기준) — 파싱 불가 ts 는 NaN 이 되어 안전창 비교(>=)에서 항상 false(보존 방향). */
function ageDays(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000);
}

/** 레거시 마커 내용을 ISO 로 우선 파싱하고, 실패하면 mtime 폴백(구 markerAgeDays 와 동형). */
async function markerTimestamp(filePath: string): Promise<string> {
  try {
    const content = (await readFile(filePath, "utf8")).trim();
    const parsed = new Date(content);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  } catch {
    // 읽기 실패 — mtime 폴백으로 진행
  }
  try {
    return (await stat(filePath)).mtime.toISOString();
  } catch {
    return new Date().toISOString(); // 파일 자체가 사라짐(경합) — 현재 시각 폴백
  }
}

/**
 * ledger JSON 파싱 — fail-open 정책. 파싱 불가/형태 이상은 보조 빈값(entries={})으로 흡수하고
 * 액션형 로그로 가시화한다(무음 흡수 금지). `v` 미지(상위 버전)는 알려진 필드만 best-effort 로 읽고
 * 로그만 남긴다(파일 자체를 여기서 덮어쓰지 않음).
 */
function parseLedgerContent(content: string, filePath: string): OutLedger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.error(
      formatException({
        situation: t("outLedger.corrupt.situation", { path: filePath, error: errMsg(err) }),
        action: t("outLedger.corrupt.action"),
      }),
    );
    return { v: 1, entries: {} };
  }
  if (typeof parsed !== "object" || parsed === null) {
    console.error(
      formatException({
        situation: t("outLedger.corrupt.situation", {
          path: filePath,
          error: "not an object",
        }),
        action: t("outLedger.corrupt.action"),
      }),
    );
    return { v: 1, entries: {} };
  }
  const obj = parsed as { v?: unknown; entries?: unknown };
  if (obj.v !== 1) {
    console.error(
      formatException({
        situation: t("outLedger.unknownVersion.situation", { path: filePath, v: String(obj.v) }),
        action: t("outLedger.unknownVersion.action"),
      }),
    );
  }
  const entries =
    obj.entries && typeof obj.entries === "object" ? (obj.entries as Record<string, OutEntry>) : {};
  return { v: 1, entries };
}

/**
 * 락 없이 파일을 읽어 파싱한다(마이그레이션 트리거 없음) — `withLedgerQueue` 로 이미 직렬화된
 * 쓰기 경로 내부에서 재진입 마이그레이션에 의한 자기 교착을 피하기 위한 내부 전용 read.
 * 마이그레이션은 공개 `readOutLedger`/`migrateLegacyOut` 가 담당한다.
 */
async function readLedgerFileOrEmpty(paths: LanePaths): Promise<OutLedger> {
  let content: string;
  try {
    content = await readFile(paths.outLedgerFile, "utf8");
  } catch (err) {
    if (errCode(err) !== "ENOENT") {
      console.error(
        formatException({
          situation: t("outLedger.readFail.situation", {
            path: paths.outLedgerFile,
            error: errMsg(err),
          }),
          action: t("outLedger.readFail.action"),
        }),
      );
    }
    return { v: 1, entries: {} };
  }
  return parseLedgerContent(content, paths.outLedgerFile);
}

const ledgerWriteQueues = new Map<string, Promise<void>>();

/**
 * 동일 ledger 파일에 대한 read-modify-write 를 in-process 로 직렬화한다. injector(턴 전이)와
 * markdown 어댑터의 retention 유지보수(폴마다 독립 트리거, runRetentionMaintenance)가 같은
 * ledger.json 을 서로 다른 호출 경로에서 갱신할 수 있어(단일 프로세스지만 호출측이 둘) 직렬화
 * 없이는 무관한 id 간에도 lost-update 가 발생한다(전체 rewrite 방식이라 파일이 하나뿐이므로).
 */
function withLedgerQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prevTail = ledgerWriteQueues.get(filePath) ?? Promise.resolve();
  const result = prevTail.then(fn, fn);
  ledgerWriteQueues.set(
    filePath,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/**
 * ledger 읽기 — 부재/파손은 빈 ledger 로 fail-open. 마이그레이션은 여기서 트리거하지 않는다 —
 * injector `start()` 가 findUnsent 시드·scanProcessing 이전에 명시적으로 1회 호출한다.
 * 모든 read 호출마다 암묵적으로 마이그레이션을 시도하면, "레거시 `.out`만 존재"와 "신규 ledger
 * 전이 중(body 기록 후 setDone 전) 크래시로 생긴 orphan body" 를 파일 증거만으로 구분할 수 없어
 * 후자를 오인해 `done` 으로 승격시킬 위험이 있다 — 그러면 크래시 재개 시 scanProcessing 이 이미
 * done 으로 오판해 재처리(엔진 재주입) 없이 processing 잔존 파일을 지워버려 무유실 불변식이
 * 깨진다. 마이그레이션을 `start()` 명시 호출로 한정하면 이 read-path 부작용이 제거된다.
 */
export async function readOutLedger(paths: LanePaths): Promise<OutLedger> {
  return readLedgerFileOrEmpty(paths);
}

export async function setDone(paths: LanePaths, id: string, sidecar: OutSidecar): Promise<void> {
  await withLedgerQueue(paths.outLedgerFile, async () => {
    const ledger = await readLedgerFileOrEmpty(paths);
    ledger.entries[id] = { ...sidecar, state: "done", ts: sidecar.ts ?? new Date().toISOString() };
    await atomicWrite(paths.outLedgerFile, JSON.stringify(ledger));
  });
}

export async function setSending(paths: LanePaths, id: string): Promise<void> {
  await withLedgerQueue(paths.outLedgerFile, async () => {
    const ledger = await readLedgerFileOrEmpty(paths);
    ledger.entries[id] = { ...ledger.entries[id], state: "sending", ts: new Date().toISOString() };
    await atomicWrite(paths.outLedgerFile, JSON.stringify(ledger));
  });
}

export async function setSent(paths: LanePaths, id: string): Promise<void> {
  await withLedgerQueue(paths.outLedgerFile, async () => {
    const ledger = await readLedgerFileOrEmpty(paths);
    ledger.entries[id] = { ...ledger.entries[id], state: "sent", ts: new Date().toISOString() };
    await atomicWrite(paths.outLedgerFile, JSON.stringify(ledger));
  });
}

export async function setAborted(paths: LanePaths, id: string): Promise<void> {
  await withLedgerQueue(paths.outLedgerFile, async () => {
    const ledger = await readLedgerFileOrEmpty(paths);
    ledger.entries[id] = { ...ledger.entries[id], state: "aborted", ts: new Date().toISOString() };
    await atomicWrite(paths.outLedgerFile, JSON.stringify(ledger));
  });
}

export async function setFailed(paths: LanePaths, id: string, reason: string): Promise<void> {
  await withLedgerQueue(paths.outLedgerFile, async () => {
    const ledger = await readLedgerFileOrEmpty(paths);
    ledger.entries[id] = {
      ...ledger.entries[id],
      state: "failed",
      ts: new Date().toISOString(),
      reason,
    };
    await atomicWrite(paths.outLedgerFile, JSON.stringify(ledger));
  });
}

export async function getEntry(paths: LanePaths, id: string): Promise<OutEntry | undefined> {
  const ledger = await readOutLedger(paths);
  return ledger.entries[id];
}

/** ledger DONE_STATES 소비 — 재주입 비대상(dedup) 판정. `<id>.out` 파일 존재가 아니다. */
export async function isDone(paths: LanePaths, id: string): Promise<boolean> {
  const entry = await getEntry(paths, id);
  return entry !== undefined && DONE_STATES.has(entry.state);
}

/**
 * 해당 id 가 out(ledger)/처리/큐 어디든 이미 존재하는지 검사 — 크래시 재개 시 중복 enqueue 방지.
 * out 판정만 ledger 로 바뀌고 processing/queue 판정은 현행(rename 기반) 유지.
 *
 * `getEntry`/`isDone`/`findUnsent` 와 달리 여기서만 부재 시 마이그레이션을 시도한다 — `hasId` 는
 * 소스 어댑터가 "이 id 를 시스템 어디선가(레거시 포함) 이미 처리했는가"를 묻는 넓은 존재 판정이라
 * (구 API 의 "`.out` 존재=완료" 의미를 그대로 승계), injector `start()` 를 거치지 않고도(예: 어댑터
 * 자체 start()) 레거시 `.out` 파일을 인식해야 한다. 반대로 `getEntry` 등은 ledger 전이의 순수
 * 진실만 반영해야 하므로(body-first 전이 중 크래시를 "완료"로 오인하면 안 됨) 여기서 마이그레이션을
 * 트리거하지 않는다.
 */
export async function hasId(paths: LanePaths, id: string): Promise<boolean> {
  if (!(await pathExists(paths.outLedgerFile))) {
    await migrateLegacyOut(paths).catch((err: unknown) => {
      console.error(
        formatException({
          situation: t("outLedger.readFail.situation", {
            path: paths.outLedgerFile,
            error: errMsg(err),
          }),
          action: t("outLedger.readFail.action"),
        }),
      );
    });
  }
  if (await isDone(paths, id)) return true;
  try {
    await access(join(paths.processingDir, `${id}.msg`));
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

/** 응답은 기록됐으나(state=done) 또는 전송 진행 중(state=sending)인 id 목록 — 재전송 대상. */
export async function findUnsent(paths: LanePaths): Promise<string[]> {
  const ledger = await readOutLedger(paths);
  return Object.entries(ledger.entries)
    .filter(([, entry]) => UNSENT_STATES.has(entry.state))
    .map(([id]) => id);
}

/**
 * entry/sidecar 에서 OutSidecar 필드만 투영 — `exactOptionalPropertyTypes` 하에서 값이 정의된
 * 키만 담아야 하므로(부재 ≠ 명시적 undefined) 조건부로 구성한다.
 */
export function projectSidecar(src: OutSidecar): OutSidecar {
  return {
    ...(src.reply_ref !== undefined ? { reply_ref: src.reply_ref } : {}),
    ...(src.ts !== undefined ? { ts: src.ts } : {}),
    ...(src.origin_ts !== undefined ? { origin_ts: src.origin_ts } : {}),
    ...(src.question !== undefined ? { question: src.question } : {}),
  };
}

/** ledger entry → OutSidecar 투영(renderOut 계약 보존, ASM-003) — 채널 어댑터가 소비. */
export async function readSidecar(paths: LanePaths, id: string): Promise<OutSidecar | null> {
  const entry = await getEntry(paths, id);
  if (!entry) return null;
  return projectSidecar(entry);
}

/** 응답 본문 기록 — `<id>.out` 만(atomic). ledger 에는 텍스트를 중복 저장하지 않는다. */
export async function writeOutBody(paths: LanePaths, id: string, text: string): Promise<void> {
  await atomicWrite(join(paths.outDir, `${id}.out`), text);
}

export async function readOutBody(paths: LanePaths, id: string): Promise<string> {
  return readFile(join(paths.outDir, `${id}.out`), "utf8");
}

/**
 * 안전창(safeWindowDays) 경과한 종단(TERMINAL_STATES) 그룹만 id 단위 원자 삭제한다.
 * `sending`(진행 중)·`done`(미전송)·`failed`(재전송 대기, PR #44 quirk)는 절대 제외.
 * body 삭제(선행) → ledger entry 제거(커밋)의 순서는 done 전이 순서와 동형 — 중간 크래시 시
 * entry 가 남아있으면 다음 실행이 재시도(수렴), entry 가 이미 지워졌으면 body 재삭제는 무해(unlink
 * 는 부재를 흡수)하다. 재실행은 no-op(멱등).
 */
export async function pruneOut(
  paths: LanePaths,
  safeWindowDays: number,
  now: Date = new Date(),
): Promise<{ removed: string[] }> {
  const ledger = await readOutLedger(paths);
  const idsToRemove = Object.entries(ledger.entries)
    .filter(
      ([, entry]) => TERMINAL_STATES.has(entry.state) && ageDays(entry.ts, now) >= safeWindowDays,
    )
    .map(([id]) => id);

  if (idsToRemove.length === 0) return { removed: [] };

  for (const id of idsToRemove) {
    await unlink(join(paths.outDir, `${id}.out`)).catch(() => {});
  }
  await withLedgerQueue(paths.outLedgerFile, async () => {
    const fresh = await readLedgerFileOrEmpty(paths);
    for (const id of idsToRemove) delete fresh.entries[id];
    await atomicWrite(paths.outLedgerFile, JSON.stringify(fresh));
  });

  return { removed: idsToRemove };
}

/**
 * 첫 ledger-형식 기동 시(레인당) 1회성 자동 마이그레이션 — 레거시 out/ 마커
 * (`.out`/`.out.json`/`.sent`/`.sending`/`.aborted`/`.failed`)를 ledger 로 흡수한 뒤 aux 마커를
 * 제거한다. `<id>.out` body 는 항상 보존. ledger.json 이 이미 있으면 즉시 no-op(idempotent
 * — 트리거는 ledger.json 부재).
 *
 * crash-safe: ledger 원자 기록(commit)이 aux 마커 삭제보다 선행한다 — 기록 후 삭제 중 크래시해도
 * ledger 가 authoritative 이고 잔존 aux 마커는 신 리더가 무시(무해). 기록 전 크래시하면 ledger.json
 * 이 여전히 부재라 다음 기동이 동일 마커를 재스캔해 동일 결과로 수렴(idempotent).
 */
export async function migrateLegacyOut(paths: LanePaths): Promise<{ migrated: number }> {
  if (await pathExists(paths.outLedgerFile)) return { migrated: 0 };

  let files: string[];
  try {
    files = await readdir(paths.outDir);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
    files = [];
  }

  const markersById = new Map<string, Set<LegacySuffix>>();
  for (const f of files) {
    for (const suf of LEGACY_SUFFIXES) {
      if (f.endsWith(suf)) {
        const id = f.slice(0, -suf.length);
        if (!markersById.has(id)) markersById.set(id, new Set());
        markersById.get(id)!.add(suf);
        break;
      }
    }
  }

  const entries: Record<string, OutEntry> = {};
  for (const [id, markers] of markersById) {
    const hasOut = markers.has(".out");
    const hasSent = markers.has(".sent");
    const hasAborted = markers.has(".aborted");
    const hasSending = markers.has(".sending");
    const hasFailed = markers.has(".failed");

    let state: OutState;
    if (hasOut && hasSent) state = "sent";
    else if (hasOut && hasAborted) state = "aborted";
    else if (hasOut && hasSending) state = "sending";
    else if (hasOut) {
      // `.out` 만 있는 조합은 두 가지 원인이 파일 증거만으로 구분 불가: (a) 구 시스템에서 완료된
      // 메시지(legacy, processing 은 이미 정리됨) 또는 (b) 신 시스템의 body-first 크래시(setDone
      // 미도달 — processing/<id>.msg 잔존). processing 파일이 남아있으면 (b)로 간주해
      // entry 를 만들지 않는다(미완료로 남겨 scanProcessing 재처리로 안전 수렴 — 무유실 우선).
      if (await pathExists(join(paths.processingDir, `${id}.msg`))) continue;
      state = "done";
    } else if (hasFailed) state = "failed";
    else continue; // 알 수 없는 조합(.out/.failed 둘 다 없음) — 스킵(entries 미생성, aux 삭제도 대상 제외)

    let sidecar: OutSidecar = {};
    if (markers.has(".out.json")) {
      try {
        sidecar = JSON.parse(
          await readFile(join(paths.outDir, `${id}.out.json`), "utf8"),
        ) as OutSidecar;
      } catch {
        // sidecar 파손 — 보조 데이터라 무시하고 진행
      }
    }

    const stampFile = hasSent
      ? `${id}.sent`
      : hasAborted
        ? `${id}.aborted`
        : hasSending
          ? `${id}.sending`
          : hasFailed
            ? `${id}.failed`
            : `${id}.out`;
    const ts = sidecar.ts ?? (await markerTimestamp(join(paths.outDir, stampFile)));

    entries[id] = { ...sidecar, state, ts };
    if (state === "failed") {
      try {
        entries[id].reason = (await readFile(join(paths.outDir, `${id}.failed`), "utf8")).trim();
      } catch {
        // 무시(가시성 보조 텍스트)
      }
    }
  }

  await withLedgerQueue(paths.outLedgerFile, async () => {
    if (await pathExists(paths.outLedgerFile)) return; // 동시 마이그레이션 경합 — 이미 완료
    const ledgerToWrite: OutLedger = { v: 1, entries };
    await atomicWrite(paths.outLedgerFile, JSON.stringify(ledgerToWrite));
  });

  const auxSuffixes = [".out.json", ".sent", ".sending", ".aborted", ".failed"] as const;
  for (const id of Object.keys(entries)) {
    for (const suf of auxSuffixes) {
      await unlink(join(paths.outDir, `${id}${suf}`)).catch(() => {});
    }
  }

  return { migrated: Object.keys(entries).length };
}
