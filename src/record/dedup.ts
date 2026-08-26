/**
 * 중복 판정 원장(`.adde/ledger/dedup.jsonl`, 프로젝트 스코프 — FR-018·NFR-006).
 * 정규화(트림·개행 정규화) 후 SHA-256 완전 일치만 다룬다(ADR-018). 판정은 프로젝트당 in-memory
 * 인덱스(부팅 시 이벤트에서 시드) + 원장 append 로 이뤄지며, 프로젝트당 단일 체인으로 직렬화한다.
 * 이벤트 원본은 dedup 판정과 무관하게 절대 변경하지 않는다.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { atomicWrite } from "../shared/fs-atomic.js";
import { errCode } from "../shared/errors.js";
import { vaultPaths } from "../shared/paths.js";
import { readEvents } from "./events.js";
import type { RecordCtx, TurnRef } from "./types.js";

/** 정규화(개행·트림) 후 SHA-256 — `sha256:<hex>` 형식(dedup.jsonl `hash` 필드와 동형). */
export function contentHash(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  return `sha256:${createHash("sha256").update(normalized, "utf8").digest("hex")}`;
}

interface FirstOccurrence {
  sid: string;
  turn: number;
  turnStartIso: string;
}

/** 프로젝트 키(vaultRoot::proj) → (kind:hash) → 최초 발생. in-process 전역(데몬 프로세스 1개 전제). */
const projectIndex = new Map<string, Map<string, FirstOccurrence>>();
/** 프로젝트당 직렬화 체인(판정 read-modify-write 를 project 단위로 직렬화). */
const projectChains = new Map<string, Promise<unknown>>();

function projectKey(vaultRoot: string, proj: string): string {
  return `${vaultRoot}::${proj}`;
}

function withProjectChain<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prevTail = projectChains.get(key) ?? Promise.resolve();
  const result = prevTail.then(fn, fn);
  projectChains.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/** 이벤트에서 in-memory 인덱스를 시드(부팅 시 1회) — 지정 세션들의 `turn_start`(user_input)·
 * `text_final`(assistant, 비-blob) 을 스캔해 프로젝트 인덱스를 구성한다. L1 은 세션 열거를 모르므로
 * 호출자(SessionManager 부팅 시퀀스)가 sids 를 넘긴다. */
export async function seedProjectIndex(
  base: string,
  vaultRoot: string,
  proj: string,
  sids: readonly string[],
): Promise<void> {
  const key = projectKey(vaultRoot, proj);
  const index = new Map<string, FirstOccurrence>();
  for (const sid of sids) {
    for await (const e of readEvents({ base, vaultRoot, proj, sid })) {
      if (e.t === "turn_start") {
        const hash = contentHash(e.input.text);
        const idxKey = `user_input:${hash}`;
        if (!index.has(idxKey)) {
          index.set(idxKey, { sid, turn: e.turn, turnStartIso: e.ts });
        }
      } else if (e.t === "text_final" && typeof e.text === "string") {
        const hash = contentHash(e.text);
        const idxKey = `assistant:${hash}`;
        if (!index.has(idxKey)) {
          index.set(idxKey, { sid, turn: e.turn, turnStartIso: e.ts });
        }
      }
    }
  }
  projectIndex.set(key, index);
}

async function appendLedgerLine(
  vaultRoot: string,
  proj: string,
  line: Record<string, unknown>,
): Promise<void> {
  const { dedupFile } = vaultPaths(vaultRoot, proj);
  let existing = "";
  try {
    existing = await readFile(dedupFile, "utf8");
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
  await atomicWrite(dedupFile, existing + JSON.stringify(line) + "\n");
}

/**
 * 본문 중복 판정 — 최초 발생이면 인덱스에 기록하고 `dupOf: null`, 이미 있으면 `dupOf` 반환 + 원장 append.
 * `ctx.turn`·`ctx.turnStartIso` 는 TurnRunner 가 현재 턴 정보로 채워 넘긴다(필수 — 미채움 시 turn=0 폴백).
 */
export async function classify(
  ctx: RecordCtx,
  kind: "user_input" | "assistant",
  text: string,
): Promise<{ dupOf: TurnRef | null }> {
  const key = projectKey(ctx.vaultRoot, ctx.proj);
  const hash = contentHash(text);
  const idxKey = `${kind}:${hash}`;
  const turn = ctx.turn ?? 0;
  const turnStartIso = ctx.turnStartIso ?? new Date().toISOString();

  return withProjectChain(key, async () => {
    let index = projectIndex.get(key);
    if (!index) {
      index = new Map<string, FirstOccurrence>();
      projectIndex.set(key, index);
    }
    const existing = index.get(idxKey);
    if (!existing) {
      index.set(idxKey, { sid: ctx.sid, turn, turnStartIso });
      return { dupOf: null };
    }
    await appendLedgerLine(ctx.vaultRoot, ctx.proj, {
      v: 1,
      hash,
      kind,
      first: { sid: existing.sid, turn: existing.turn },
      dup: { sid: ctx.sid, turn },
      ts: new Date().toISOString(),
    });
    return { dupOf: { turn: existing.turn, turnStartIso: existing.turnStartIso } };
  });
}
