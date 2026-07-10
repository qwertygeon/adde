/**
 * markdown 어댑터의 일간 백업 이관·최초 활성 마이그레이션 — 전용 모듈로 분리(markdown.ts 가 이미
 * 커서 유지보수·테스트 격리 향상). deps 주입형 export 라 markdown.ts 의 closure 상태에 의존하지 않는다.
 */
import { readdir, rename, mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { safeMove } from "../shared/fs-move.js";
import { errMsg } from "../shared/errors.js";
import { t } from "../shared/i18n.js";
import { formatDateFolder, dateFolderFromStamp } from "../shared/date-folder.js";

/** 날짜 폴더명 엄격 매치 — stat 없이 이름만으로 판정해 판정 비용이 폴더 수에만 비례하게 한다. */
const DATE_FOLDER_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 아카이브 날짜 파일명 엄격 매치. */
const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

export interface RelocateRoot {
  /** vault 측 원본 디렉터리(예: outboxDir·decidedDir·archiveDir). */
  vaultDir: string;
  /** 백업 측 미러 디렉터리(vault 상대경로 그대로 계승). */
  backupDir: string;
  /** folder=날짜 폴더 통째 이동(outbox/.decided) · file=날짜 파일 단위 이동(archive). */
  unit: "folder" | "file";
}

/**
 * 이관 기준일(cutoffDate)보다 오래된 날짜 폴더/파일을 백업으로 이동한다. 판정은 이름 문자열
 * 비교만(stat 없음). 항목별 실패는 로그 후 계속(fail-open) — 한 루트의 실패가 다른 루트 처리를
 * 막지 않는다.
 */
export async function relocateOldFolders(deps: {
  roots: RelocateRoot[];
  cutoffDate: string;
  materialize: (p: string) => Promise<"ready" | "skip">;
}): Promise<{ moved: string[]; skipped: string[] }> {
  const moved: string[] = [];
  const skipped: string[] = [];

  for (const root of deps.roots) {
    let entries: string[];
    try {
      entries = await readdir(root.vaultDir);
    } catch {
      continue; // 대상 루트 부재 — 아직 산출물 없음(no-op)
    }
    const pattern = root.unit === "folder" ? DATE_FOLDER_RE : DATE_FILE_RE;
    for (const name of entries) {
      if (!pattern.test(name)) continue; // 화이트리스트 밖 — 건너뜀(stat 없음)
      const dateOnly = root.unit === "folder" ? name : name.replace(/\.md$/, "");
      if (!(dateOnly < deps.cutoffDate)) continue; // 경계일(strict <) — 오늘·cutoff 이내는 유지

      const src = join(root.vaultDir, name);
      const dst = join(root.backupDir, name);
      try {
        const res = await safeMove(src, dst, { materialize: deps.materialize });
        for (const p of res.moved) moved.push(root.unit === "folder" ? join(name, p) : p);
        for (const p of res.skipped) skipped.push(root.unit === "folder" ? join(name, p) : p);
      } catch (err) {
        console.error(t("log.markdownRetention.relocateFail", { src, dst, error: errMsg(err) }));
      }
    }
  }

  return { moved, skipped };
}

/** outbox flat 화이트리스트 — `<stamp> <id>.md` 만. 시스템 알림(`_adde-notice.md` 등)·
 * stamp 없는 레거시 `<id>.md` 는 자연 불일치로 제외. 캡처: 1=stamp(YYYYMMDD-HHmmss). */
const OUTBOX_WHITELIST_RE = /^(\d{8}-\d{6}) .+\.md$/;

/**
 * 최초 활성 시 flat 산출물을 날짜 폴더로 1회 정렬한다. 이미 파티셔닝된 항목(날짜 폴더 하위)은
 * 대상 자체가 top-level 스캔에 잡히지 않으므로 자연히 건너뛴다(반복 실행 안전).
 */
export async function migrateFlatToDated(deps: {
  outboxDir: string;
  decidedDir: string;
}): Promise<{ movedOutbox: string[]; movedDecided: string[] }> {
  return {
    movedOutbox: await migrateOutbox(deps.outboxDir),
    movedDecided: await migrateDecided(deps.decidedDir),
  };
}

/** outbox: `<stamp> <id>.md` 화이트리스트만 stamp 파생 날짜 폴더로 이동. */
async function migrateOutbox(outboxDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(outboxDir);
  } catch {
    return [];
  }
  const moved: string[] = [];
  for (const name of entries) {
    const m = OUTBOX_WHITELIST_RE.exec(name);
    if (!m) continue; // 화이트리스트 밖(알림·레거시·이미 파티셔닝된 날짜 폴더) — 건너뜀
    const src = join(outboxDir, name);
    let targetDir: string;
    try {
      targetDir = join(outboxDir, dateFolderFromStamp(m[1]!));
    } catch {
      continue; // 방어적 — 정규식이 stamp 형식을 이미 보장하나 이중 안전망
    }
    try {
      await mkdir(targetDir, { recursive: true });
      await rename(src, join(targetDir, name));
      moved.push(name);
    } catch (err) {
      console.error(t("log.markdownRetention.migrateOutboxFail", { name, error: errMsg(err) }));
    }
  }
  return moved;
}

/**
 * decided: 결정완료 승인 파일은 이름에 stamp 가 없다(reqId 명명) — 결정 시점 근사치로 파일
 * mtime 을 사용한다(moveToDecided 의 rename 은 mtime 을 보존). 날짜 폴더(이미 파티셔닝)·비-md
 * 항목은 파일 타입 필터로 자연 제외.
 */
async function migrateDecided(decidedDir: string): Promise<string[]> {
  let entries: Array<{ name: string; isFile: () => boolean }>;
  try {
    entries = await readdir(decidedDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const moved: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = entry.name;
    const src = join(decidedDir, name);
    let targetDir: string;
    try {
      const s = await stat(src);
      targetDir = join(decidedDir, formatDateFolder(s.mtime));
    } catch (err) {
      console.error(
        t("log.markdownRetention.migrateDecidedMtimeFail", { name, error: errMsg(err) }),
      );
      continue;
    }
    try {
      await mkdir(targetDir, { recursive: true });
      await rename(src, join(targetDir, name));
      moved.push(name);
    } catch (err) {
      console.error(t("log.markdownRetention.migrateDecidedFail", { name, error: errMsg(err) }));
    }
  }
  return moved;
}

/**
 * 기존(v0.1.4 이하) 단일 아카이브 파일을 무파싱 통째로 백업 이동한다(파싱 오류 리스크 회피 —
 * 하이브리드: 신규 기록만 날짜 파일로 쓰고 기존 파일은 통째 이관). 파일이 없으면(신규 설치·이미
 * 마이그레이션됨) no-op — idempotent.
 */
export async function migrateLegacyArchiveFile(deps: {
  legacyArchivePath: string;
  backupDir: string;
}): Promise<{ moved: boolean }> {
  try {
    const s = await stat(deps.legacyArchivePath);
    if (!s.isFile()) return { moved: false }; // 이미 디렉터리(정상 신규 경로) — 대상 아님
  } catch {
    return { moved: false }; // 부재
  }
  const dst = join(deps.backupDir, basename(deps.legacyArchivePath));
  await mkdir(deps.backupDir, { recursive: true });
  await safeMove(deps.legacyArchivePath, dst);
  return { moved: true };
}
