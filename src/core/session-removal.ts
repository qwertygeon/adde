/**
 * 세션 제거(신규, L3) — 대화형 3분기(완전 제거·일반 제거·취소)의 계획 산출과 실행을 분리한다
 * (design.md §10 — 순수 계획 + fs 실행 분리로 테스트 가능성 확보). 삭제 전 `session-manager.ts`
 * 의 control op "remove"(applyStop(force) → turnRunner.stop() → remove())가 먼저 통과해야 한다
 * (ADR-015 — 데몬이 레코드를 들고 있으면 폴 tick 이 노트·레이아웃을 되만든다).
 */
import { access, readdir, readFile, rm } from "node:fs/promises";
import { atomicWrite } from "../shared/fs-atomic.js";
import { errCode, errMsg } from "../shared/errors.js";
import { projectPaths, sessionPaths, vaultPaths } from "../shared/paths.js";
import { loadSession } from "./session-store.js";
import { scanProcessing } from "./queue.js";

export interface RemovalTargets {
  /** 설정 루트(sessions.d/<sid>.json · runtime/sessions/<sid>/) — 두 분기 공통 삭제 대상. */
  configPaths: string[];
  /** vault(입력·세션·턴·승인 노트 + 이벤트·blob·dedup) — 완전 제거만. 일반 제거는 빈 배열(전부 보존). */
  vaultPaths: string[];
  /** legacy 원장(프로젝트 스코프) 경로 — 완전 제거 + legacy 구간 세션일 때만 non-null. */
  legacyLedger: string | null;
}

export interface RemovalPlan {
  sid: string;
  mode: "purge" | "record";
  turnCount: number;
  inFlightTurn: boolean;
  /** `storageLayout` 부재 = 배치 변경 이전 세션 — 완전 제거의 한계 안내 대상. */
  legacyEra: boolean;
  targets: RemovalTargets;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 제거 대상 인벤토리 산출(순수 조회, 부수효과 없음) — 대상이 전혀 없으면 `null`(FR-020 "없음" 안내).
 */
export async function planSessionRemoval(a: {
  base: string;
  proj: string;
  vaultRoot: string;
  sid: string;
  mode: "purge" | "record";
}): Promise<RemovalPlan | null> {
  const sp = sessionPaths(a.base, a.proj, a.sid);
  const vp = vaultPaths(a.vaultRoot, a.proj, a.sid);
  const legacy = vaultPaths(a.vaultRoot, a.proj);

  const rec = await loadSession(a.base, a.proj, a.sid);
  const [recordExists, vaultSessionExists, eventsExist] = await Promise.all([
    pathExists(sp.recordFile),
    pathExists(vp.sessionDir),
    pathExists(vp.eventsDir),
  ]);
  if (!recordExists && !vaultSessionExists && !eventsExist) return null;

  const legacyEra = !rec || rec.storageLayout !== "session";

  let turnCount = 0;
  try {
    const turnFiles = await readdir(vp.turnsDir);
    turnCount = turnFiles.filter((f) => f.endsWith(".md")).length;
  } catch {
    // 부재 — 턴 0건과 동치.
  }
  const inFlightTurn = (await scanProcessing(sp).catch(() => [])).length > 0;

  const runtimeSessionDir = `${projectPaths(a.base, a.proj).runtimeDir}/sessions/${a.sid}`;
  const configPaths = [sp.recordFile, runtimeSessionDir];
  // vp.sessionDir(입력·세션·턴·승인 노트) + vp.eventsDir(이벤트·세대 sidecar — sessionVaultPaths()
  // 의 blobs·dedup.jsonl 이 그 하위이므로 이 한 경로 삭제로 함께 정리된다).
  const vaultTargets = a.mode === "purge" ? [vp.sessionDir, vp.eventsDir] : [];
  const targets: RemovalTargets = {
    configPaths,
    vaultPaths: vaultTargets,
    legacyLedger: a.mode === "purge" && legacyEra ? legacy.legacyDedupFile : null,
  };
  return { sid: a.sid, mode: a.mode, turnCount, inFlightTurn, legacyEra, targets };
}

/** legacy 원장에서 그 sid 를 가리키는 라인만 제거한다 — 다른 라인은 바이트 불변. */
async function filterLegacyLedgerLine(path: string, sid: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return; // 없으면 지울 것도 없다.
    throw err;
  }
  const kept = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      try {
        const parsed = JSON.parse(line) as { first?: { sid?: string }; dup?: { sid?: string } };
        return parsed.first?.sid !== sid && parsed.dup?.sid !== sid;
      } catch {
        return true; // 파손 줄은 판단 불가 — 보존(성공 위장 금지).
      }
    });
  await atomicWrite(path, kept.length > 0 ? kept.join("\n") + "\n" : "");
}

/**
 * 계획을 실행한다 — 실패는 모아서 반환하고(부분 삭제가 성공으로 승격되지 않는다, NFR-009) 계속
 * 진행한다. 다른 세션의 파일은 경로 자체가 그 세션 소유 디렉터리로 완결되므로 건드릴 수 없다(구조적
 * 완전성 — 참조 계산 없음).
 */
export async function executeSessionRemoval(
  plan: RemovalPlan,
): Promise<{ removed: string[]; failures: Array<{ path: string; reason: string }> }> {
  const removed: string[] = [];
  const failures: Array<{ path: string; reason: string }> = [];
  for (const target of [...plan.targets.configPaths, ...plan.targets.vaultPaths]) {
    try {
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    } catch (err) {
      failures.push({ path: target, reason: errMsg(err) });
    }
  }
  if (plan.targets.legacyLedger) {
    try {
      await filterLegacyLedgerLine(plan.targets.legacyLedger, plan.sid);
      removed.push(`${plan.targets.legacyLedger}#${plan.sid}`);
    } catch (err) {
      failures.push({ path: plan.targets.legacyLedger, reason: errMsg(err) });
    }
  }
  return { removed, failures };
}
