/**
 * 워크플로 스토리지 기동 전제조건 fail-closed 판정 — 어떤 스토어를 열기 전에 ①내장
 * `node:sqlite` 모듈 획득 가능성과 ②검사용 in-memory 연결에서 실제로 읽은 링크 SQLite
 * 라이브러리 버전을 같은 판정 블록에서 확인한다. 어떤 경로에서도 throw 하지 않는다 —
 * 완료되지 못한 검사는 성공이 아니라 실패(indeterminate)로 수렴한다.
 */
import type { DatabaseSync } from "node:sqlite";
import type { SqliteModule } from "./sqlite.js";
import { openWorkflowDatabase, readSqliteLibraryVersion } from "./sqlite.js";
import { REQUIRED_SQLITE_LIBRARY_VERSION } from "./constants.js";
import { declaredNodeFloor } from "../shared/node-floor.js";

export type PreconditionFailureReason =
  "module_absent" | "module_behind_flag" | "library_version_below_floor" | "indeterminate";

export interface StoragePreconditionOk {
  readonly ok: true;
  readonly sqliteLibraryVersion: string;
  readonly requiredSqliteLibraryVersion: string;
  readonly nodeVersion: string;
}
export interface StoragePreconditionFailure {
  readonly ok: false;
  readonly reason: PreconditionFailureReason;
  readonly detail: string;
  readonly requiredSqliteLibraryVersion: string;
  readonly requiredNodeFloor: string | undefined;
  readonly detectedSqliteLibraryVersion?: string;
  readonly nodeVersion: string;
}
export type StoragePreconditionResult = StoragePreconditionOk | StoragePreconditionFailure;

export interface StoragePreconditionDeps {
  /** 미지정 시 () => import("node:sqlite"). 테스트가 부재·플래그·예외를 주입한다. */
  readonly importSqlite?: () => Promise<unknown>;
  /** 미지정 시 process.versions.node. */
  readonly nodeVersion?: string;
}

/** 오류 메시지에 이 문자열이 포함될 때만 "플래그 뒤"로 분류한다(진단 목적 — 안전망 절 참조). */
const EXPERIMENTAL_FLAG_HINT = "--experimental-sqlite";

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 점으로 구분된 정수 버전 문자열 비교. 비파싱 입력은 undefined(판정 불가). */
function isAtLeast(actual: string, floor: string): boolean | undefined {
  const parse = (v: string): number[] | undefined => {
    const nums = v.trim().split(".").map(Number);
    if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n < 0)) return undefined;
    return nums;
  };
  const a = parse(actual);
  const f = parse(floor);
  if (a === undefined || f === undefined) return undefined;
  const len = Math.max(a.length, f.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const fv = f[i] ?? 0;
    if (av !== fv) return av > fv;
  }
  return true;
}

export async function checkStoragePreconditions(
  deps: StoragePreconditionDeps = {},
): Promise<StoragePreconditionResult> {
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const requiredNodeFloor = declaredNodeFloor();
  const importSqlite: () => Promise<unknown> = deps.importSqlite ?? (() => import("node:sqlite"));

  let sqlite: SqliteModule;
  try {
    sqlite = (await importSqlite()) as SqliteModule;
  } catch (err) {
    const detail = messageOf(err);
    const reason: PreconditionFailureReason = detail.includes(EXPERIMENTAL_FLAG_HINT)
      ? "module_behind_flag"
      : "module_absent";
    return {
      ok: false,
      reason,
      detail,
      requiredSqliteLibraryVersion: REQUIRED_SQLITE_LIBRARY_VERSION,
      requiredNodeFloor,
      nodeVersion,
    };
  }

  let db: DatabaseSync | undefined;
  try {
    db = openWorkflowDatabase(sqlite, ":memory:");
    const detected = readSqliteLibraryVersion(db);
    const atLeast = isAtLeast(detected, REQUIRED_SQLITE_LIBRARY_VERSION);
    if (atLeast === undefined) {
      return {
        ok: false,
        reason: "indeterminate",
        detail: `링크된 SQLite 라이브러리 버전(${detected})을 판정할 수 없습니다.`,
        requiredSqliteLibraryVersion: REQUIRED_SQLITE_LIBRARY_VERSION,
        requiredNodeFloor,
        detectedSqliteLibraryVersion: detected,
        nodeVersion,
      };
    }
    if (!atLeast) {
      return {
        ok: false,
        reason: "library_version_below_floor",
        detail: `링크된 SQLite 라이브러리 버전(${detected})이 요구 하한(${REQUIRED_SQLITE_LIBRARY_VERSION}) 미만입니다.`,
        requiredSqliteLibraryVersion: REQUIRED_SQLITE_LIBRARY_VERSION,
        requiredNodeFloor,
        detectedSqliteLibraryVersion: detected,
        nodeVersion,
      };
    }
    return {
      ok: true,
      sqliteLibraryVersion: detected,
      requiredSqliteLibraryVersion: REQUIRED_SQLITE_LIBRARY_VERSION,
      nodeVersion,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "indeterminate",
      detail: `전제조건 판정을 완료하지 못했습니다: ${messageOf(err)}`,
      requiredSqliteLibraryVersion: REQUIRED_SQLITE_LIBRARY_VERSION,
      requiredNodeFloor,
      nodeVersion,
    };
  } finally {
    db?.close();
  }
}
