/**
 * 세션 레코드 스토어(`<base>/projects/<proj>/sessions.d/<sid>.json`) — v2 세션 모델의 영속 SoT.
 * 바인딩은 세션 레코드 안에 배열로 보유한다(ADR-013 — 세션 삭제 = 바인딩 동시 소멸, 2파일 정합 문제 제거).
 * 손상 레코드 1건은 로드에서 격리(로그)하고 나머지 로드를 막지 않는다(A-P002 비침해).
 */
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../shared/fs-atomic.js";
import { errCode, errMsg } from "../shared/errors.js";
import { projectPaths, sessionPaths } from "../shared/paths.js";
import type { Binding } from "../surfaces/types.js";

/** 영속 세션 상태 — 4상태(FR-003). 턴 처리 중 실패로 인한 일시적 "오류" 표시는 이 필드에 쓰지 않고
 * (SessionRecord 는 회복 가능한 영속 상태만 담는다) SessionManager 의 in-memory 오버레이 +
 * `state` 이벤트로 표면화한다(design.md 턴 흐름 "세션 error" 서술의 구현 해석 — GAP 기록 참조). */
export type SessionStatus = "active" | "hibernated" | "detached" | "archived";

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
}

const SESSION_STATUSES: readonly SessionStatus[] = ["active", "hibernated", "detached", "archived"];

function defaultRand(): string {
  return randomBytes(4).toString("hex");
}

/** 세션 식별자 생성 — `<base36 ms>-<8 hex>`(정렬 가능·경로 안전, ADR-004). */
export function newSid(now: number = Date.now(), rand: () => string = defaultRand): string {
  return `${now.toString(36)}-${rand()}`;
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
  if (typeof o["status"] !== "string" || !SESSION_STATUSES.includes(o["status"] as SessionStatus)) {
    throw new Error(`${source}: invalid status`);
  }
  if (typeof o["engine"] !== "string") throw new Error(`${source}: engine missing`);
  if (typeof o["createdAt"] !== "string" || typeof o["lastActivityAt"] !== "string") {
    throw new Error(`${source}: timestamps missing`);
  }
  const bindings = Array.isArray(o["bindings"]) ? (o["bindings"] as Binding[]) : [];
  const warnings = Array.isArray(o["warnings"]) ? (o["warnings"] as string[]) : [];
  const engineArgs = Array.isArray(o["engineArgs"]) ? (o["engineArgs"] as string[]) : [];
  return {
    v: 1,
    sid: o["sid"],
    engine: o["engine"],
    engineRef: typeof o["engineRef"] === "string" ? o["engineRef"] : null,
    status: o["status"] as SessionStatus,
    title: typeof o["title"] === "string" ? o["title"] : null,
    createdAt: o["createdAt"],
    lastActivityAt: o["lastActivityAt"],
    successorOf: typeof o["successorOf"] === "string" ? o["successorOf"] : null,
    engineArgs,
    warnings,
    bindings,
  };
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
