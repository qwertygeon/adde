/**
 * 멱등 재생성(vault rebuild, L1) — FR-016·FR-034·NFR-006. 이벤트 전량 재생 → 노트·dedup 원장
 * 재구성. 보관 정책을 필수 입력으로 받아 이미 이관된 턴 노트를 vault 에 재생성하지 않는다.
 *
 * **계약 편차 고지**: tasks.md 확정 시그니처는 `rebuild(proj, opts)` 이나, 세션 열거·경로
 * 해석에 `base`(설정 루트)·`vaultRoot`(저장소 루트)가 반드시 필요해 두 인자를 **선두에 추가**했다
 * (opts 트레일링 확장으로는 흡수 불가능한 유일한 편차 — 나머지 태스크는 opts 확장으로 흡수했다).
 */
import { readdir } from "node:fs/promises";
import { atomicWrite } from "../shared/fs-atomic.js";
import { isSafeSegment, sessionVaultPaths, vaultPaths } from "../shared/paths.js";
import { readEvents } from "./events.js";
import { projectTurn, project } from "./projector.js";
import { contentHash } from "./dedup.js";
import { isArchivedTurn } from "./retention.js";
import type { RetentionPolicy } from "./retention.js";
import type { AddeEvent, RecordCtx } from "./types.js";

export interface RebuildReport {
  sids: string[];
  turnsRendered: number;
  dedupEntries: number;
  corruptedLinesSkipped: number;
}

async function listProjectSids(vaultRoot: string, proj: string): Promise<string[]> {
  const vp = vaultPaths(vaultRoot, proj);
  try {
    const entries = await readdir(vp.sessionDir);
    return entries.filter((e) => isSafeSegment(e));
  } catch {
    return [];
  }
}

/**
 * dedup 원장 재구성 — **세션 단위**로 세션 내 ts 순 재생해 최초/중복 매핑을 결정론적으로
 * 재도출하고 v2 라인(최초 발생 포함)을 그 세션 소유 파일에 쓴다. 교차 세션 정렬은 하지 않는다
 * (세션별 독립 판정 — 교차 세션 판정은 폐기됐다). 반환값은 전 세션 라인(first+dup) 합계.
 */
async function rebuildDedup(
  base: string,
  vaultRoot: string,
  proj: string,
  sids: readonly string[],
): Promise<number> {
  interface Tagged {
    kind: "user_input" | "assistant";
    text: string;
    turn: number;
    ts: string;
  }
  let totalLines = 0;
  for (const sid of sids) {
    const tagged: Tagged[] = [];
    const turnStartTimes = new Map<number, string>();
    for await (const e of readEvents({ base, vaultRoot, proj, sid })) {
      if (e.t === "turn_start") {
        turnStartTimes.set(e.turn, e.ts);
        tagged.push({ kind: "user_input", text: e.input.text, turn: e.turn, ts: e.ts });
      } else if (e.t === "text_final" && typeof e.text === "string") {
        tagged.push({ kind: "assistant", text: e.text, turn: e.turn, ts: e.ts });
      }
    }
    tagged.sort((a, b) => a.ts.localeCompare(b.ts));

    const first = new Map<string, Tagged>();
    const lines: string[] = [];
    for (const item of tagged) {
      const hash = contentHash(item.text);
      const key = `${item.kind}:${hash}`;
      const seen = first.get(key);
      if (!seen) {
        first.set(key, item);
        lines.push(
          JSON.stringify({
            v: 2,
            t: "first",
            hash,
            kind: item.kind,
            turn: item.turn,
            turnStartIso: turnStartTimes.get(item.turn) ?? item.ts,
            ts: item.ts,
          }),
        );
        continue;
      }
      lines.push(
        JSON.stringify({
          v: 2,
          t: "dup",
          hash,
          kind: item.kind,
          first: { turn: seen.turn, turnStartIso: turnStartTimes.get(seen.turn) ?? seen.ts },
          dup: { turn: item.turn },
          ts: item.ts,
        }),
      );
    }

    const { dedupFile } = sessionVaultPaths(vaultRoot, proj, sid);
    await atomicWrite(dedupFile, lines.length > 0 ? lines.join("\n") + "\n" : "");
    totalLines += lines.length;
  }
  return totalLines;
}

/**
 * 이벤트에서 종료된(turn_end 존재) 턴 번호 목록과 파손 줄 수를 뽑는다(부분 아티팩트는 재생성 대상
 * 아님). 파손 줄 수는 `readEvents`(record/events.ts) 의 `onCorrupted` 훅으로 스킵되는 즉시 집계한다
 * (세대·위치 무관 전체 파싱 실패 줄 — 마지막 세대 마지막 줄 절단에 한정되지 않는다).
 */
async function endedTurns(ctx: RecordCtx): Promise<{ turns: number[]; corrupted: number }> {
  const turns = new Set<number>();
  let corrupted = 0;
  for await (const e of readEvents(ctx, {
    onCorrupted: () => {
      corrupted += 1;
    },
  })) {
    const withTurn = e as AddeEvent & { turn: number };
    if (withTurn.t === "turn_end") turns.add(withTurn.turn);
  }
  return { turns: [...turns].sort((a, b) => a - b), corrupted };
}

/**
 * 프로젝트(또는 지정 세션)의 노트·dedup 원장을 이벤트에서 재생성한다. 2회 연속 실행 결과가
 * 바이트 동일해야 한다 — 모든 쓰기는 `projectTurn`/`project`(atomicWrite) 경유.
 */
export async function rebuild(
  base: string,
  vaultRoot: string,
  proj: string,
  opts?: { sid?: string; retention?: RetentionPolicy },
): Promise<RebuildReport> {
  const sids = opts?.sid ? [opts.sid] : await listProjectSids(vaultRoot, proj);
  let turnsRendered = 0;
  let corruptedLinesSkipped = 0;

  for (const sid of sids) {
    const ctx: RecordCtx = { base, vaultRoot, proj, sid };
    const { turns, corrupted } = await endedTurns(ctx);
    corruptedLinesSkipped += corrupted;
    for (const turn of turns) {
      if (opts?.retention && isArchivedTurn(opts.retention, await turnStartIsoOf(ctx, turn))) {
        continue; // 이관된 턴은 재생성하지 않는다 — 세션 노트가 "보관됨" 으로 표기.
      }
      await projectTurn(ctx, turn, "final", opts?.retention);
      turnsRendered += 1;
    }
    await project(ctx, { ...(opts?.retention ? { retention: opts.retention } : {}) });
  }

  const dedupEntries = await rebuildDedup(base, vaultRoot, proj, sids);
  return { sids, turnsRendered, dedupEntries, corruptedLinesSkipped };
}

async function turnStartIsoOf(ctx: RecordCtx, turn: number): Promise<string> {
  for await (const e of readEvents(ctx)) {
    if (e.turn === turn && e.t === "turn_start") return e.ts;
  }
  return new Date(0).toISOString();
}
