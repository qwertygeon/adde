/**
 * 세션 장부(state/<lane>/sessions.json) — /resume 목록·마지막 대화 시각의 SSOT.
 * ACP session/list 는 어댑터 구현이 미확인이고 엔진 무관성이 필요해 ADDE 가 자체 관리한다.
 * 갱신 주체는 직렬(injector·기동 시 supervisor)이라 파일 락 없이 atomic rewrite 로 충분.
 */
import { readFile } from "node:fs/promises";
import type { LanePaths } from "../shared/paths.js";
import type { ControlRequest } from "../shared/envelope.js";
import { atomicWrite } from "../shared/fs-atomic.js";

/** 장부 보존 상한 — 초과 시 마지막 대화가 오래된 항목부터 회전 제거. */
const MAX_ENTRIES = 20;

export interface SessionEntry {
  id: string;
  /** ISO — 세션 생성 시각. */
  createdAt: string;
  /** ISO — 마지막 대화(턴 종료) 시각. 목록 표기·회전 기준. */
  lastActivityAt: string;
  /** 첫 프롬프트 발췌(마스킹) — 목록에서 세션 식별용. 첫 턴에서 1회 채움. */
  label?: string;
}

/** 장부 읽기 — 부재·파손은 빈 장부(보조 데이터, fail-open). */
export async function readLedger(paths: LanePaths): Promise<SessionEntry[]> {
  try {
    const raw = JSON.parse(await readFile(paths.sessionsFile, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is SessionEntry =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as SessionEntry).id === "string" &&
        typeof (e as SessionEntry).createdAt === "string" &&
        typeof (e as SessionEntry).lastActivityAt === "string",
    );
  } catch {
    return [];
  }
}

async function writeLedger(paths: LanePaths, entries: SessionEntry[]): Promise<void> {
  const sorted = [...entries]
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
    .slice(0, MAX_ENTRIES);
  await atomicWrite(paths.sessionsFile, JSON.stringify(sorted, null, 2) + "\n");
}

/** 세션 목록의 시각 표기 — 로컬 `MM-DD HH:mm`(목록 가독 우선, 정밀 시각은 장부 파일에 보존). */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 세션 id 허용 문자셋 — envelope 검증(CHANNEL_MSG_ID_RE)과 동일 계약(주입 방어). */
const SESSION_ID_RE = /^[A-Za-z0-9_:-]+$/;

/**
 * resume 인자 → ControlRequest 해석(채널 공통). 무인자=목록(sessions), 숫자=장부 최신순
 * 번호, 그 외=세션 id 직접 지정(문자셋 위반·번호 범위 밖은 sessionId 미지정 — 수신측이
 * "재개할 세션 없음" 통지, fail-closed).
 */
export function resolveResumeControl(
  arg: string | undefined,
  entries: SessionEntry[],
): ControlRequest {
  if (!arg) return { kind: "sessions" };
  if (/^\d+$/.test(arg)) {
    const entry = entries[parseInt(arg, 10) - 1];
    return entry ? { kind: "resume", sessionId: entry.id } : { kind: "resume" };
  }
  return SESSION_ID_RE.test(arg) ? { kind: "resume", sessionId: arg } : { kind: "resume" };
}

/** 세션 생성/복귀 시 upsert — 기존 항목이면 lastActivityAt 만 갱신. */
export async function recordSession(paths: LanePaths, id: string): Promise<void> {
  const now = new Date().toISOString();
  const entries = await readLedger(paths);
  const existing = entries.find((e) => e.id === id);
  if (existing) {
    existing.lastActivityAt = now;
  } else {
    entries.push({ id, createdAt: now, lastActivityAt: now });
  }
  await writeLedger(paths, entries);
}

/** 턴 종료 시 마지막 대화 시각 갱신(+미기재 label 이면 발췌 기록). 항목 부재 시 생성. */
export async function touchSession(
  paths: LanePaths,
  id: string,
  labelIfEmpty?: string,
): Promise<void> {
  const now = new Date().toISOString();
  const entries = await readLedger(paths);
  const existing = entries.find((e) => e.id === id);
  if (existing) {
    existing.lastActivityAt = now;
    if (labelIfEmpty && !existing.label) existing.label = labelIfEmpty;
  } else {
    entries.push({
      id,
      createdAt: now,
      lastActivityAt: now,
      ...(labelIfEmpty ? { label: labelIfEmpty } : {}),
    });
  }
  await writeLedger(paths, entries);
}
