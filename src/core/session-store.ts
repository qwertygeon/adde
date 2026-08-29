/**
 * 세션 레코드 스토어(`<base>/projects/<proj>/sessions.d/<sid>.json`) — v2 세션 모델의 영속 SoT.
 * 바인딩은 세션 레코드 안에 배열로 보유한다(ADR-013 — 세션 삭제 = 바인딩 동시 소멸, 2파일 정합 문제 제거).
 * 손상 레코드 1건은 로드에서 격리(로그)하고 나머지 로드를 막지 않는다(A-P002 비침해).
 */
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, reserveNewFile } from "../shared/fs-atomic.js";
import { errCode, errMsg } from "../shared/errors.js";
import { assertSafeSegment, projectPaths, sessionPaths, vaultPaths } from "../shared/paths.js";
import type { Binding } from "../surfaces/types.js";

/** 영속 세션 상태 — 4상태. `archived`(구 보존종료)는 값 집합에서 제거되어 wire 값으로만
 * 존재한다 — 읽을 때 `stopped` 로 정규화한다. 턴 처리 중 실패로 인한 일시적 "오류" 표시는
 * 이 필드에 쓰지 않고(SessionRecord 는 회복 가능한 영속 상태만 담는다) SessionManager 의 in-memory
 * 오버레이 + `state` 이벤트로 표면화한다. */
export type SessionStatus = "active" | "hibernated" | "stopped" | "detached";

/** wire 에서 수락하는 값 — `archived` 는 레거시 레코드 하위호환을 위해서만 유지한다. */
const STATUS_WIRE_VALUES = ["active", "hibernated", "stopped", "detached", "archived"] as const;
type StatusWireValue = (typeof STATUS_WIRE_VALUES)[number];

/** wire → 도메인 정규화. 레거시 `archived` 는 중지로 해석한다. 로드 경로에는 save 가
 * 없으므로(사실 1) 이 정규화는 레코드 파일을 고쳐 쓰지 않는다(SC-002 바이트 불변). */
function normalizeStatus(raw: StatusWireValue): SessionStatus {
  return raw === "archived" ? "stopped" : raw;
}

/** 중지 요청의 발원(design.md §3) — `applyStop` 3경로(팔레트·CLI·자동)에 `clear`·`remove` 파생을 더한다. */
export type StopSource = "palette" | "cli" | "auto" | "clear" | "remove";

/** 중지 예약 — 진행 중 턴·잔여 큐가 있어 즉시 중지할 수 없을 때 기록한다. */
export interface StopPending {
  requestedAt: string;
  reason: string;
  source: StopSource;
}

/** 안내 존 항목 — 세션 레코드가 SoT, 노트는 파생 렌더다. */
export interface NoticeEntry {
  /** base36 8자 식별자 — 노트 센티널(`<!-- n:{id} -->`)과 대응. */
  id: string;
  mode: "read" | "prompt";
  /** 안내 지점 식별자(design.md §13). */
  kind: string;
  /** 살균 완료 본문. */
  text: string;
  /** ISO 시각. */
  at: string;
  /** 노트에 렌더된 적 있음 — 렌더 성공 후에만 세운다(부재를 "읽음"으로 오판하지 않기 위함). */
  rendered?: boolean;
  /** 프루닝 요약 병합 카운트. */
  count?: number;
  /** mode:"prompt" 전용 — 재개 목록 등 응답 대기 옵션. */
  options?: Array<{ token: string; label: string }>;
  /** 절단 안내 등 말미 문구. */
  footer?: string;
}

export interface SessionRecord {
  v: 1;
  sid: string;
  engine: string;
  engineRef: string | null;
  status: SessionStatus;
  title: string | null;
  createdAt: string;
  lastActivityAt: string;
  successorOf: string | null;
  engineArgs: string[];
  warnings: string[];
  bindings: Binding[];
  /** 단조 증가 — 외부(CLI/데몬) 동시 writer 의 되쓰기를 CAS 로 차단한다. 부재 레코드는 0. */
  rev: number;
  /** 중지·떨어짐 사유(살균 후 저장). */
  stopReason: string | null;
  /** 중지 시각(ISO) — 중지·떨어짐이 아니면 null. */
  stoppedAt: string | null;
  /** 중지 예약 — 잔여 작업 소진 후 적용 대상이면 non-null. */
  stopPending: StopPending | null;
  /** 노트 교체 미완(부분 실패) — true 인 동안 폴 대상에 유지되어 재시도된다. */
  stopNotePending: boolean;
  /** 중지·떨어짐 배너의 부가 안내(승계 등, 원 호출자만 아는 정보) — 재시도·재렌더가 같은 내용을
   * 다시 쓸 수 있도록 레코드에 영속한다(단일 writer 원칙, 미지정 시 undefined). */
  stopNoteExtras?: string[];
  /** 안내 존 SoT(상한이 크기를 억제, FR-014·FR-015). */
  notices: NoticeEntry[];
  /** 신규 저장 배치로 **생성된** 세션 표식. 부재 = legacy 구간. */
  storageLayout?: "session";
}

function defaultRand(): string {
  return randomBytes(4).toString("hex");
}

/** 세션 식별자 생성(레거시) — `<base36 ms>-<8 hex>`(정렬 가능·경로 안전). 신규 세션은
 * `nextSessionId`(사람이 고를 수 있는 `YYMMDD-N[-slug]`)를 쓴다 — 기존 형식과 공존한다. */
export function newSid(now: number = Date.now(), rand: () => string = defaultRand): string {
  return `${now.toString(36)}-${rand()}`;
}

/** 식별자 slug 상한. */
export const SLUG_MAX_LEN = 32;

/** 세그먼트 안전 문자셋 밖 문자를 `-` 로 치환·연속 축약·양끝 정리·상한 절단 후, 남는 문자가 없으면
 * null(slug 미부여, SC-016). 안전 문자셋만 남기므로 결과는 항상 `assertSafeSegment` 를 통과한다. */
export function slugify(title: string | null | undefined): string | null {
  if (!title) return null;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LEN)
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
}

/** 생성 시점의 **로컬** 날짜 — `YYMMDD`. */
export function localDatePart(now: Date): string {
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

async function listDirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if (errCode(err) === "ENOENT") return [];
    throw err;
  }
}

/** 그 날짜 접두(`YYMMDD-N` 또는 `YYMMDD-N-<slug>`)가 세 위치 중 어디에라도 존재하는지. */
function prefixTaken(entries: readonly string[], datePart: string, n: number): boolean {
  const literal = `${datePart}-${n}`;
  return entries.some((e) => e === literal || e.startsWith(`${literal}-`));
}

/**
 * 채번 후보 스캔(관측 스냅샷) — **3위치**(레코드·vault 세션 디렉터리·이벤트 디렉터리)를 조회해
 * 그 날짜 접두의 최대 순번을 찾는다. 일반 제거로 레코드만 사라지고 남은 디렉터리도 포함한다.
 * 관측 시점의 스냅샷일 뿐이므로 이 결과만으로 sid 를 확정하면 동시 호출 간 경합을 막지 못한다
 * (실측: `session-model.test.ts` SC-002 의 동시 `create()` 2건이 이 스캔으로 **같은** sid 를
 * 얻어 레코드 파일 rename 충돌을 일으켰다 — 채번이 "관측" 이지 "예약" 이 아니었다). 예약이
 * 필요하면 이 스캔 결과를 시작점으로 배타 생성까지 수행하는 `reserveSessionId` 를 쓴다.
 */
async function scanSessionIdCandidates(args: {
  base: string;
  proj: string;
  vaultRoot: string;
  now: Date;
}): Promise<{ datePart: string; entries: string[]; startN: number }> {
  const datePart = localDatePart(args.now);
  const prefixRe = new RegExp(`^${datePart}-(\\d+)(?:-.*)?$`);

  const { sessionsDir } = projectPaths(args.base, args.proj);
  const vp = vaultPaths(args.vaultRoot, args.proj);
  const recordEntries = (await listDirSafe(sessionsDir))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
  const noteEntries = await listDirSafe(vp.sessionDir);
  const eventEntries = await listDirSafe(vp.eventsDir);
  const entries = [...recordEntries, ...noteEntries, ...eventEntries];

  let maxN = 0;
  for (const e of entries) {
    const m = prefixRe.exec(e);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (n > maxN) maxN = n;
    }
  }
  return { datePart, entries, startN: maxN + 1 };
}

/**
 * 신규 세션 식별자 채번(관측만, 예약 아님) — `YYMMDD-N[-slug]`. 슬러그가 달라도 같은 접두 재사용은
 * 금지(ASM-009). **동시 호출 간 유일성을 보장하지 않는다** — 실제 세션 생성 경로(`create`·`clear`)
 * 는 이 함수 대신 `reserveSessionId` 를 쓴다. 이 함수는 미리보기·테스트 등 순수 조회 용도로 남긴다.
 */
export async function nextSessionId(args: {
  base: string;
  proj: string;
  vaultRoot: string;
  now: Date;
  title?: string | null;
}): Promise<string> {
  const { datePart, entries, startN } = await scanSessionIdCandidates(args);
  const slug = slugify(args.title ?? null);

  let n = startN;
  let tries = 0;
  while (prefixTaken(entries, datePart, n)) {
    n += 1;
    tries += 1;
    if (tries > 1000) {
      throw new Error(`session-store: 세션 식별자 채번 1000회 초과 (${datePart}) — 무한 루프 방지`);
    }
  }

  const sid = slug ? `${datePart}-${n}-${slug}` : `${datePart}-${n}`;
  assertSafeSegment("session", sid);
  return sid;
}

/**
 * 신규 세션 식별자 **예약** — 채번 후보를 관측만 하는 `nextSessionId` 와 달리, 후보 sid 의 레코드
 * 파일을 배타 생성(`reserveNewFile`)해 실제로 선점한다. 다른 프로세스가 그 사이 같은 후보를
 * 선점했으면(`EEXIST`) 다음 번호로 넘어가 재시도한다(파일시스템의 원자성이 경합을 없앤다 —
 * 프로세스 내 락은 CLI↔데몬처럼 **별 프로세스**의 동시 생성을 막지 못해 불충분하다). `buildRecord`
 * 는 확정된 sid 로 완결된 `SessionRecord` 를 만들어야 한다 — 예약 성공 시 그 레코드가 **그대로**
 * 디스크의 최초 내용이 된다(고아 placeholder 없음, 나중에 다시 쓰지 않는다). 반환값은 그 레코드다
 * (호출자가 `records.set()` 으로 메모리에 등록하면 된다 — `persist()` 를 다시 거칠 필요 없다).
 */
export async function reserveSessionId<T extends SessionRecord>(args: {
  base: string;
  proj: string;
  vaultRoot: string;
  now: Date;
  title?: string | null;
  buildRecord: (sid: string) => T;
}): Promise<T> {
  const { datePart, entries, startN } = await scanSessionIdCandidates(args);
  const slug = slugify(args.title ?? null);

  let n = startN;
  let tries = 0;
  for (;;) {
    if (prefixTaken(entries, datePart, n)) {
      n += 1;
      tries += 1;
      if (tries > 1000) {
        throw new Error(
          `session-store: 세션 식별자 예약 1000회 초과 (${datePart}) — 무한 루프 방지`,
        );
      }
      continue;
    }
    const sid = slug ? `${datePart}-${n}-${slug}` : `${datePart}-${n}`;
    assertSafeSegment("session", sid);
    const rec = args.buildRecord(sid);
    const { recordFile } = sessionPaths(args.base, args.proj, sid);
    try {
      await reserveNewFile(recordFile, JSON.stringify(rec, null, 2) + "\n");
      return rec;
    } catch (err) {
      if (errCode(err) === "EEXIST") {
        n += 1;
        tries += 1;
        if (tries > 1000) {
          throw new Error(
            `session-store: 세션 식별자 예약 1000회 초과 (${datePart}) — 무한 루프 방지`,
            { cause: err },
          );
        }
        continue;
      }
      throw err;
    }
  }
}

/** 최소 형태 검증 — 손상·불완전 레코드를 조기에 거부(throw)한다(loadSessions 가 격리 처리). */
function validateSessionRecord(raw: unknown, source: string): SessionRecord {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${source}: not an object`);
  }
  const o = raw as Record<string, unknown>;
  if (o["v"] !== 1) throw new Error(`${source}: v must be 1`);
  if (typeof o["sid"] !== "string" || o["sid"].length === 0) {
    throw new Error(`${source}: sid missing`);
  }
  if (
    typeof o["status"] !== "string" ||
    !(STATUS_WIRE_VALUES as readonly string[]).includes(o["status"])
  ) {
    throw new Error(`${source}: invalid status`);
  }
  if (typeof o["engine"] !== "string") throw new Error(`${source}: engine missing`);
  if (typeof o["createdAt"] !== "string" || typeof o["lastActivityAt"] !== "string") {
    throw new Error(`${source}: timestamps missing`);
  }
  const bindings = Array.isArray(o["bindings"]) ? (o["bindings"] as Binding[]) : [];
  const warnings = Array.isArray(o["warnings"]) ? (o["warnings"] as string[]) : [];
  const engineArgs = Array.isArray(o["engineArgs"]) ? (o["engineArgs"] as string[]) : [];
  const notices = Array.isArray(o["notices"]) ? (o["notices"] as NoticeEntry[]) : [];
  const stopPending =
    typeof o["stopPending"] === "object" && o["stopPending"] !== null
      ? (o["stopPending"] as StopPending)
      : null;
  const rec: SessionRecord = {
    v: 1,
    sid: o["sid"],
    engine: o["engine"],
    engineRef: typeof o["engineRef"] === "string" ? o["engineRef"] : null,
    status: normalizeStatus(o["status"] as StatusWireValue),
    title: typeof o["title"] === "string" ? o["title"] : null,
    createdAt: o["createdAt"],
    lastActivityAt: o["lastActivityAt"],
    successorOf: typeof o["successorOf"] === "string" ? o["successorOf"] : null,
    engineArgs,
    warnings,
    bindings,
    rev: typeof o["rev"] === "number" ? o["rev"] : 0,
    stopReason: typeof o["stopReason"] === "string" ? o["stopReason"] : null,
    stoppedAt: typeof o["stoppedAt"] === "string" ? o["stoppedAt"] : null,
    stopPending,
    stopNotePending: o["stopNotePending"] === true,
    notices,
  };
  if (o["storageLayout"] === "session") rec.storageLayout = "session";
  return rec;
}

/** 프로젝트의 전 세션 레코드 로드. `sessions.d/` 부재는 빈 배열(신규 프로젝트와 동치). */
export async function loadSessions(base: string, proj: string): Promise<SessionRecord[]> {
  const { sessionsDir } = projectPaths(base, proj);
  let files: string[];
  try {
    files = await readdir(sessionsDir);
  } catch (err) {
    if (errCode(err) === "ENOENT") return [];
    throw err;
  }

  const records: SessionRecord[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const filePath = join(sessionsDir, f);
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      records.push(validateSessionRecord(raw, filePath));
    } catch (err) {
      // 손상 레코드 1건이 나머지 로드를 막지 않는다(격리) — 진단·session ls 가 별도로 표면화할 수 있다.
      console.error(`session-store: 손상 레코드 무시 (${filePath}): ${errMsg(err)}`);
    }
  }
  return records;
}

/** 단일 세션 레코드 로드(없으면 undefined). */
export async function loadSession(
  base: string,
  proj: string,
  sid: string,
): Promise<SessionRecord | undefined> {
  const { recordFile } = sessionPaths(base, proj, sid);
  try {
    const raw = JSON.parse(await readFile(recordFile, "utf8")) as unknown;
    return validateSessionRecord(raw, recordFile);
  } catch (err) {
    if (errCode(err) === "ENOENT") return undefined;
    console.error(`session-store: 손상 레코드 무시 (${recordFile}): ${errMsg(err)}`);
    return undefined;
  }
}

/** 세션 레코드를 원자적으로 기록(tmp→rename). */
export async function saveSession(base: string, proj: string, rec: SessionRecord): Promise<void> {
  const { recordFile } = sessionPaths(base, proj, rec.sid);
  await atomicWrite(recordFile, JSON.stringify(rec, null, 2) + "\n");
}

/** 안내 존 항목 식별자(8자 hex) — 노트 센티널(`<!-- n:{id} -->`)과 대응. */
export function generateNoticeId(): string {
  return randomBytes(4).toString("hex");
}

/** 프루닝 요약 안내의 고정 kind — 병합 판정(기존 요약 발견)에 쓰인다. */
export const NOTICES_PRUNED_KIND = "notices-pruned";

/**
 * 안내 존 상한 접기 — `mode:"prompt"` 항목(재개 목록 등 응답 대기)은 프루닝
 * 비대상이다. `cap<=0` 은 무제한. 초과분은 오래된 것부터 제거하고 기존
 * 프루닝 요약이 있으면 카운트를 병합한다(`records-cap` 선례와 동형 — `inbox.ts:planRecordsCap`).
 */
export function planNoticeCap(
  notices: readonly NoticeEntry[],
  cap: number,
): { kept: NoticeEntry[]; prunedCount: number } {
  if (cap <= 0) return { kept: [...notices], prunedCount: 0 };
  const prompts = notices.filter((n) => n.mode === "prompt");
  const existingSummary = notices.find((n) => n.kind === NOTICES_PRUNED_KIND) ?? null;
  const reads = notices.filter((n) => n.mode !== "prompt" && n.kind !== NOTICES_PRUNED_KIND);
  if (reads.length <= cap) return { kept: [...notices], prunedCount: 0 };
  const keepReads = reads.slice(reads.length - cap);
  const pruned = reads.length - keepReads.length;
  const mergedCount = (existingSummary?.count ?? 0) + pruned;
  const summary: NoticeEntry = {
    id: existingSummary?.id ?? generateNoticeId(),
    mode: "read",
    kind: NOTICES_PRUNED_KIND,
    text: `안내 ${mergedCount}건이 상한을 초과해 정리되었습니다.`,
    at: new Date().toISOString(),
    count: mergedCount,
  };
  return { kept: [...prompts, summary, ...keepReads], prunedCount: pruned };
}
