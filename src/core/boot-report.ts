/**
 * 데몬 부팅 리포트(v2 — 세션 스코프) — supervisorUp 완료 시 세션별 최종 상태를 단조 boot id 와
 * 함께 기록한다. 데몬 프로세스 단일 writer, CLI 프로세스 reader.
 */
import { readFile } from "node:fs/promises";
import { atomicWrite } from "../shared/fs-atomic.js";
import { maskSecrets } from "../shared/mask.js";
import { daemonBootReportPath } from "../shared/paths.js";
import type { SessionStatusRow } from "./supervisor.js";

export interface BootReportSession {
  sid: string;
  status: "active" | "hibernated" | "detached" | "archived";
  error?: string;
}

export interface BootReport {
  v: 1;
  bootId: number;
  bootedAt: string;
  sessions: BootReportSession[];
  /** status==="active" 세션 수. */
  running: number;
  /**
   * 부팅 시점에만 의미가 있는 안내(현재 소비자: 자동 허용 티어 기동 배너). 해소 대상이 아닌
   * 상태 공지라 세션 경고(미해소 실패 뷰)에 넣지 않고 여기에 싣는다.
   */
  notices?: string[];
}

export async function readBootReport(base: string, proj: string): Promise<BootReport | null> {
  const path = daemonBootReportPath(base, proj);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || (parsed as { v?: unknown }).v !== 1) {
      return null;
    }
    return parsed as BootReport;
  } catch {
    return null;
  }
}

export async function writeBootReport(
  base: string,
  proj: string,
  sessions: SessionStatusRow[],
  now?: () => number,
  notices?: readonly string[],
): Promise<number> {
  const prev = await readBootReport(base, proj);
  const bootId = (prev?.bootId ?? 0) + 1;
  const reportSessions: BootReportSession[] = sessions.map((s) => ({
    sid: s.sid,
    status: s.status,
    ...(s.status === "detached" ? { error: maskSecrets("detached") } : {}),
  }));
  const report: BootReport = {
    v: 1,
    bootId,
    bootedAt: new Date(now?.() ?? Date.now()).toISOString(),
    sessions: reportSessions,
    running: reportSessions.filter((s) => s.status === "active").length,
    ...(notices && notices.length > 0 ? { notices: notices.map((n) => maskSecrets(n)) } : {}),
  };
  await atomicWrite(daemonBootReportPath(base, proj), JSON.stringify(report));
  return bootId;
}
