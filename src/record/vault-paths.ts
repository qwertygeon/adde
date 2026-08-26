/**
 * vault 레이아웃 보장 + 동기화 충돌 파일 판정(FR-029·NFR-007). 보관 이관(retention.ts) 의 대상
 * 화이트리스트(`sessions/<sid>/turns/*.md` 만)는 이 모듈이 제공하는 `vaultPaths`(shared/paths.ts)
 * 계약으로 고정된다 — retention.ts 는 오직 `turnsDir` 안의 파일만 이동한다.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { vaultPaths } from "../shared/paths.js";

/** vault 서브트리(프로젝트·세션·이벤트·blob·dedup 디렉터리)를 보장한다(mkdir -p 동형). */
export async function ensureVaultLayout(
  vaultRoot: string,
  proj: string,
  sid?: string,
): Promise<void> {
  const vp = vaultPaths(vaultRoot, proj, sid);
  await mkdir(vp.projectDir, { recursive: true });
  await mkdir(vp.blobsDir, { recursive: true });
  await mkdir(dirname(vp.dedupFile), { recursive: true });
  if (sid !== undefined) {
    await mkdir(vp.sessionDir, { recursive: true });
    await mkdir(vp.approvalsDir, { recursive: true });
    await mkdir(vp.turnsDir, { recursive: true });
    await mkdir(vp.eventsDir, { recursive: true });
  }
}

/** 동기 충돌 파일 판별(Obsidian Sync/Syncthing 등) — 입력 스캔에서 제외(이동·삭제하지 않음, ADR-033). */
export function isConflictFile(filename: string): boolean {
  return /\.sync-conflict|conflicted copy|\.conflicted\./i.test(filename);
}

/**
 * ISO 타임스탬프를 파일명 안전 표기로 변환 — 밀리초·`Z` 제거, `:` → `-`.
 * 예: `2026-08-25T20:30:00.000Z` → `2026-08-25T20-30-00`(turnNoteName 등이 사용, FR-015 결정론).
 */
export function sanitizeIsoForFilename(iso: string): string {
  return iso
    .replace(/\.\d{3}Z$/, "")
    .replace(/Z$/, "")
    .replace(/:/g, "-");
}
