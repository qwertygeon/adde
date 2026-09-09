/**
 * SQLite 연결 단일 팩토리 — 본 저장소에서 `new DatabaseSync(` 를 호출하는 유일한 지점이다.
 * `node:sqlite` 는 타입으로만 참조한다(런타임 값은 호출자가 동적 import 로 얻어 주입한다) —
 * 정적 값 import 는 모듈 없는 Node 에서 import 시점에 프로세스를 중단시킨다.
 */
import type { DatabaseSync } from "node:sqlite";
import { SQLITE_BUSY_TIMEOUT_MS } from "./constants.js";

export interface SqliteModule {
  readonly DatabaseSync: new (path: string, options?: { timeout?: number }) => DatabaseSync;
}

export interface OpenWorkflowDatabaseOptions {
  /** 미지정 시 SQLITE_BUSY_TIMEOUT_MS. 0 이하·비유한값은 거부(throw). */
  readonly timeoutMs?: number;
}

/** 본 차수의 유일한 연결 개설 지점. timeout 을 항상 명시 전달한다. */
export function openWorkflowDatabase(
  sqlite: SqliteModule,
  location: string,
  opts?: OpenWorkflowDatabaseOptions,
): DatabaseSync {
  const timeoutMs = opts?.timeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `openWorkflowDatabase: timeoutMs 는 유한한 양수여야 합니다(받음: ${String(timeoutMs)})`,
    );
  }
  return new sqlite.DatabaseSync(location, { timeout: timeoutMs });
}

/** 열린 연결에서 링크된 SQLite 라이브러리 버전을 읽는다. */
export function readSqliteLibraryVersion(db: DatabaseSync): string {
  const row = db.prepare("select sqlite_version() as v").get() as { v?: unknown } | undefined;
  const version = row?.v;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("readSqliteLibraryVersion: sqlite_version() 이 문자열을 반환하지 않았습니다.");
  }
  return version;
}
