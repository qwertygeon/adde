/**
 * 저장소 경량화·보관 이관(FR-033~FR-035, ADR-023·023b) — 옵트인(`vault.backup` 지정 전에는 어떤
 * 파일도 이동하지 않는다, NFR-009). 대상은 `sessions/<sid>/turns/*.md` 만(vault-paths.ts 화이트리스트).
 * `isArchivedTurn` 은 순수 함수로 이관·투영기·rebuild 3소비자가 공유한다(FM-1 방지, ADR-023b).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { safeMove } from "../shared/fs-move.js";
import { atomicWrite } from "../shared/fs-atomic.js";
import { pathsOverlap, retentionLastRunPath } from "../shared/paths.js";
import { vaultPaths } from "../shared/paths.js";

export interface RetentionPolicy {
  /** 보관 위치. null = 비활성(어떤 파일도 이동하지 않는다 — NFR-009). */
  backupDir: string | null;
  /** 보관 일수(기본 2). */
  retentionDays: number;
  /** 주입 clock — 결정론 판정(SC-047). */
  now: () => Date;
}

/** 기본 보관 정책(비활성) — 명시 설정이 없는 프로젝트에서 사용. */
export function defaultRetentionPolicy(now: () => Date = () => new Date()): RetentionPolicy {
  return { backupDir: null, retentionDays: 2, now };
}

/** UTC 자정 경계 기준 날짜 인덱스 — 하루 내 시:분:초 차이(밀리초 단위 실행 지연 포함)에 흔들리지 않는
 * "캘린더 일수" 비교의 기반(SC-045 Edge "경계일" 판정의 정밀도 전제). */
function utcDayIndex(d: Date): number {
  return Math.floor(d.getTime() / (24 * 60 * 60 * 1000));
}

/**
 * 턴 시작 시각이 보관 일수보다 오래됐는지(순수 함수) — 이관·투영·재생성 3소비자가 공유하는 단일 판정.
 * `backupDir === null`(비활성)이면 항상 false(어떤 턴도 대상 아님). 비교는 **캘린더 일수 차이**로
 * 한다(밀리초 단위 경과시간이 아니다) — 그래야 "정확히 cutoff" 경계가 호출 시점의 실행 지연(수 ms)에
 * 따라 결과가 흔들리지 않는다(design.md SC-045 Edge "경계일은 strict `<` 로 유지").
 */
export function isArchivedTurn(policy: RetentionPolicy, turnStartIso: string): boolean {
  if (policy.backupDir === null) return false;
  const turnStart = new Date(turnStartIso);
  if (Number.isNaN(turnStart.getTime())) return false;
  const dayDiff = utcDayIndex(policy.now()) - utcDayIndex(turnStart);
  return dayDiff > policy.retentionDays;
}

/** `<backup>/<턴 시작 날짜>/<vault 상대경로>` — 이관 실행일이 아니라 턴이 일어난 날짜로 고르게 분류(DEC-005).
 * ISO 문자열의 **UTC 캘린더 날짜**를 그대로 쓴다(로컬 타임존 변환 시 자정 경계에서 날짜가 밀리는 것을
 * 방지 — 재렌더 결정론, SC-045/047 의 전제). */
export function backupTargetPath(
  backupDir: string,
  vaultRelPath: string,
  turnStartIso: string,
): string {
  const d = new Date(turnStartIso);
  const p = (n: number): string => String(n).padStart(2, "0");
  const dateFolder = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return join(backupDir, dateFolder, vaultRelPath);
}

/**
 * 보관 위치가 저장소 루트·설정 루트·프로젝트 실행 경로와 겹치면 throw(FR-033·SC-046).
 * `project add`/`project set` 검증 시점과 이관 실행 시점 양쪽에서 호출한다.
 */
export function assertBackupNotOverlapping(
  backupDir: string,
  vaultRoot: string,
  configRoot: string,
  cwd: string,
): void {
  if (pathsOverlap(backupDir, vaultRoot)) {
    throw new Error(`보관 위치(${backupDir})가 저장소 루트(${vaultRoot})와 겹칩니다.`);
  }
  if (pathsOverlap(backupDir, configRoot)) {
    throw new Error(`보관 위치(${backupDir})가 설정 루트(${configRoot})와 겹칩니다.`);
  }
  if (pathsOverlap(backupDir, cwd)) {
    throw new Error(`보관 위치(${backupDir})가 프로젝트 실행 경로(${cwd})와 겹칩니다.`);
  }
}

export interface RetentionReport {
  moved: string[];
  skipped: string[];
}

/**
 * 일간 보관 이관 실행 — `sessions/<sid>/turns/*.md` 중 `isArchivedTurn` 인 파일만 이동한다.
 * 사본 안착 후 원본 제거(safeMove) — 어느 중단점에도 원본·사본 중 최소 하나 보존.
 * materialize 훅으로 이관 전 물질화(동기화 dataless 대응, FR-035) — "skip" 은 그 파일만 건너뛰고 계속.
 */
export async function runRetention(
  ctx: { vaultRoot: string; proj: string; sid: string },
  policy: RetentionPolicy,
  materialize: (p: string) => Promise<"ready" | "skip">,
): Promise<RetentionReport> {
  const moved: string[] = [];
  const skipped: string[] = [];
  if (policy.backupDir === null) return { moved, skipped };

  const vp = vaultPaths(ctx.vaultRoot, ctx.proj, ctx.sid);
  let entries: string[];
  try {
    entries = await readdir(vp.turnsDir);
  } catch {
    return { moved, skipped };
  }

  for (const fileName of entries) {
    if (!fileName.endsWith(".md")) continue;
    const m = /^(\d{4}) (.+)\.md$/.exec(fileName);
    if (!m?.[2]) continue;
    const turnStartIso = filenameTsToIso(m[2]);
    if (!turnStartIso || !isArchivedTurn(policy, turnStartIso)) continue;

    const srcPath = join(vp.turnsDir, fileName);
    const vaultRelPath = relative(vp.projectDir, srcPath);
    const dstPath = backupTargetPath(policy.backupDir, vaultRelPath, turnStartIso);

    try {
      await stat(srcPath);
    } catch {
      continue; // 이미 이관됨(이전 실행 잔여) — 스킵.
    }

    const result = await safeMove(srcPath, dstPath, { materialize });
    if (result.skipped.length > 0) skipped.push(fileName);
    else moved.push(fileName);
  }

  return { moved, skipped };
}

/** 턴 노트 파일명의 시각 표기(`YYYY-MM-DDTHH-mm-ss`, `:` 치환분)를 ISO 로 역변환. 실패 시 null. */
function filenameTsToIso(sanitized: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(sanitized);
  if (!m) return null;
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z`;
}

/** 일간 이관 게이트 겸 최근 실행 결과 — `retentionLastRunPath` 파일의 내용. */
export interface RetentionLastRun {
  /** UTC 날짜(YYYY-MM-DD) — 스케줄러가 "오늘 이미 실행했는가" 판정에 쓴다. */
  date: string;
  moved: number;
  skipped: number;
}

/** 마지막 일간 보관 이관 결과를 읽는다 — 부재·손상은 null(아직 실행 이력 없음으로 간주).
 * 데몬 스케줄러(다음 실행 여부 판정)와 `doctor`(표면화 — 전용 이벤트 스트림 대신 진단 출력만 사용) 양쪽이 소비한다. */
export async function readRetentionLastRun(
  base: string,
  proj: string,
): Promise<RetentionLastRun | null> {
  try {
    const text = await readFile(retentionLastRunPath(base, proj), "utf8");
    const parsed = JSON.parse(text) as Partial<RetentionLastRun>;
    if (typeof parsed.date === "string") {
      return {
        date: parsed.date,
        moved: typeof parsed.moved === "number" ? parsed.moved : 0,
        skipped: typeof parsed.skipped === "number" ? parsed.skipped : 0,
      };
    }
  } catch {
    // 부재·손상 — 실행 이력 없음으로 간주(다음 스윕이 정상 진행).
  }
  return null;
}

/** 일간 보관 이관 실행 후 게이트+결과를 기록(데몬 스케줄러 단일 writer). */
export async function writeRetentionLastRun(
  base: string,
  proj: string,
  info: RetentionLastRun,
): Promise<void> {
  await atomicWrite(retentionLastRunPath(base, proj), JSON.stringify(info, null, 2) + "\n");
}
