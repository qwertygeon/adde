/**
 * 중복 판정 원장(`.adde/sessions/<sid>/dedup.jsonl`, **세션 소유** — FR-027·NFR-006).
 * 정규화(트림·개행 정규화) 후 SHA-256 완전 일치만 다룬다. 판정은 세션당 in-memory 인덱스
 * (첫 판정 시 원장에서 지연 시드, ADR-004) + 원장 append(v2, 최초 발생도 기록)로 이뤄지며, 세션당
 * 단일 체인으로 직렬화한다. 교차 세션 판정·링크는 폐기됐다(FR-027 — 세션마다 독립 원장·인덱스).
 * 이벤트 원본은 dedup 판정과 무관하게 절대 변경하지 않는다.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errCode } from "../shared/errors.js";
import { errMsg } from "../shared/errors.js";
import { sessionVaultPaths } from "../shared/paths.js";
import type { RecordCtx, TurnRef } from "./types.js";

/** 정규화(개행·트림) 후 SHA-256 — `sha256:<hex>` 형식(dedup.jsonl `hash` 필드와 동형). */
export function contentHash(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

interface FirstOccurrence {
  turn: number;
  turnStartIso: string;
}

/** 세션 키(vaultRoot::proj::sid) → (kind:hash) → 최초 발생. in-process(데몬 프로세스 1개 전제). */
const sessionIndex = new Map<string, Map<string, FirstOccurrence>>();
/** 세션당 직렬화 체인(판정 read-modify-write 를 세션 단위로 직렬화 — 세션 간 병렬성 확보). */
const sessionChains = new Map<string, Promise<unknown>>();
/** 지연 시드 완료 여부(세션당 1회) — 시드 자체가 실패해도 재시도 폭주를 막기 위해 시도 시점에 표시한다. */
const seededSessions = new Set<string>();

function sessionKey(vaultRoot: string, proj: string, sid: string): string {
  return `${vaultRoot}::${proj}::${sid}`;
}

function withSessionChain<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prevTail = sessionChains.get(key) ?? Promise.resolve();
  const result = prevTail.then(fn, fn);
  sessionChains.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/**
 * 세션 소유 원장에서 in-memory 인덱스를 시드(세션당 1회, 첫 `classify` 진입 시 지연 수행 — ADR-004).
 * 원장(v2)을 순차 읽어 `t:"first"` 라인으로 인덱스를 복원한다. v1(legacy 프로젝트 스코프) 라인·파손
 * 줄은 스킵 + 경고(원장에는 이 세션 소유 v2 라인만 있어야 하지만 방어적으로 걸러낸다).
 */
export async function seedSessionIndex(ctx: RecordCtx): Promise<void> {
  const key = sessionKey(ctx.vaultRoot, ctx.proj, ctx.sid);
  const { dedupFile } = sessionVaultPaths(ctx.vaultRoot, ctx.proj, ctx.sid);
  const index = new Map<string, FirstOccurrence>();
  let raw: string;
  try {
    raw = await readFile(dedupFile, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      sessionIndex.set(key, index);
      return;
    }
    throw err;
  }
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["v"] !== 2 || parsed["t"] !== "first") continue;
      const idxKey = `${String(parsed["kind"])}:${String(parsed["hash"])}`;
      if (!index.has(idxKey)) {
        index.set(idxKey, {
          turn: Number(parsed["turn"]),
          turnStartIso: String(parsed["turnStartIso"]),
        });
      }
    } catch (err) {
      console.error(`dedup: 원장 파손 줄 스킵 (sid=${ctx.sid}): ${errMsg(err)}`);
    }
  }
  sessionIndex.set(key, index);
}

/** 완전 제거 등으로 세션이 소멸할 때 인덱스를 명시 폐기한다(같은 sid 재생성 불가라 방어적 청소). */
export function dropSessionIndex(ctx: RecordCtx): void {
  const key = sessionKey(ctx.vaultRoot, ctx.proj, ctx.sid);
  sessionIndex.delete(key);
  sessionChains.delete(key);
  seededSessions.delete(key);
}

async function appendLedgerLine(
  vaultRoot: string,
  proj: string,
  sid: string,
  line: Record<string, unknown>,
): Promise<void> {
  const { dedupFile } = sessionVaultPaths(vaultRoot, proj, sid);
  // append-only 파일이라 전량 재작성의 원자성 이득이 없다 — 세션당 단일 체인으로 이미
  // 직렬화되므로 O_APPEND 쓰기 인터리브 우려도 없다(design.md §8 외부 API 확인).
  await mkdir(dirname(dedupFile), { recursive: true });
  await appendFile(dedupFile, JSON.stringify(line) + "\n", "utf8");
}

/**
 * 본문 중복 판정 — 최초 발생이면 인덱스에 기록하고 원장에 `first` 라인, `dupOf: null`.
 * 이미 있으면 `dupOf` 반환 + 원장에 `dup` 라인. **세션 소유**라 교차 세션은 절대 중복으로 판정되지
 * 않는다. `ctx.turn`·`ctx.turnStartIso` 는 TurnRunner 가 현재 턴 정보로 채워 넘긴다.
 */
export async function classify(
  ctx: RecordCtx,
  kind: "user_input" | "assistant",
  text: string,
): Promise<{ dupOf: TurnRef | null }> {
  const key = sessionKey(ctx.vaultRoot, ctx.proj, ctx.sid);
  const hash = contentHash(text);
  const idxKey = `${kind}:${hash}`;
  const turn = ctx.turn ?? 0;
  const turnStartIso = ctx.turnStartIso ?? new Date().toISOString();

  return withSessionChain(key, async () => {
    if (!seededSessions.has(key)) {
      seededSessions.add(key);
      await seedSessionIndex(ctx).catch((err: unknown) => {
        console.error(`dedup: 세션 인덱스 시드 실패(sid=${ctx.sid}): ${errMsg(err)}`);
      });
    }
    let index = sessionIndex.get(key);
    if (!index) {
      index = new Map<string, FirstOccurrence>();
      sessionIndex.set(key, index);
    }
    const existing = index.get(idxKey);
    if (!existing) {
      index.set(idxKey, { turn, turnStartIso });
      await appendLedgerLine(ctx.vaultRoot, ctx.proj, ctx.sid, {
        v: 2,
        t: "first",
        hash,
        kind,
        turn,
        turnStartIso,
        ts: new Date().toISOString(),
      });
      return { dupOf: null };
    }
    await appendLedgerLine(ctx.vaultRoot, ctx.proj, ctx.sid, {
      v: 2,
      t: "dup",
      hash,
      kind,
      first: { turn: existing.turn, turnStartIso: existing.turnStartIso },
      dup: { turn },
      ts: new Date().toISOString(),
    });
    return { dupOf: { turn: existing.turn, turnStartIso: existing.turnStartIso } };
  });
}
