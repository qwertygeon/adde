/**
 * 대화 이벤트 기록기(events-NNNN.jsonl) — 무손실·fail-closed(FR-012·FR-013·FR-014·NFR-003·NFR-006).
 * 세대 분할(ADR-034, 4 MiB 상한)만 하고 삭제·덮어쓰기는 하지 않는다. append 실패는 throw(ADR-007).
 * 세션당 append 직렬화 체인(현행 `transcript.ts:82` 경로별 직렬화 패턴 계승) — 실패해도 체인은
 * 끊기지 않고(injector.ts `enqueueStep` 패턴) 다음 append 가 이어진다.
 */
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../shared/fs-atomic.js";
import { errCode, errMsg } from "../shared/errors.js";
import { maskSecrets } from "../shared/mask.js";
import { vaultPaths } from "../shared/paths.js";
import type { AddeEvent, RecordCtx } from "./types.js";

/** 세대 분할 상한(ADR-034) — 측정치가 아닌 절충값(research.md ASM-005 미확인 리스크 완화). */
export const EVENTS_GENERATION_MAX_BYTES = 4 * 1024 * 1024;
/** 줄 단위 `v` 필드의 현재 스키마 버전(ADR-026 — 이벤트 기록 스키마 버전 SSOT). */
export const EVENTS_SCHEMA_VERSION = 1;

function generationFileName(gen: number): string {
  return `events-${String(gen).padStart(4, "0")}.jsonl`;
}

function summaryFileName(gen: number): string {
  return `gen-${String(gen).padStart(4, "0")}.summary.json`;
}

async function listGenerations(eventsDir: string): Promise<number[]> {
  let files: string[];
  try {
    files = await readdir(eventsDir);
  } catch (err) {
    if (errCode(err) === "ENOENT") return [];
    throw err;
  }
  const gens: number[] = [];
  for (const f of files) {
    const m = /^events-(\d+)\.jsonl$/.exec(f);
    if (m?.[1]) gens.push(parseInt(m[1], 10));
  }
  return gens.sort((a, b) => a - b);
}

function deepMask(value: unknown): unknown {
  if (typeof value === "string") return maskSecrets(value);
  if (Array.isArray(value)) return value.map(deepMask);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepMask(v);
    return out;
  }
  return value;
}

/** 세션별 append 직렬화 체인 — 항상 resolve(실패해도 다음 append 를 막지 않는다). */
const appendChains = new Map<string, Promise<void>>();

/**
 * 이벤트를 마스킹 후 append. 세대 상한 초과 시 다음 세대로 전환(닫힌 세대 요약 sidecar 기록,
 * 실패해도 append 자체는 계속 — sidecar 는 파생물). append 자체의 실패(디스크 오류 등)는 throw.
 */
export async function appendEvent(ctx: RecordCtx, e: AddeEvent): Promise<void> {
  const { eventsDir } = vaultPaths(ctx.vaultRoot, ctx.proj, ctx.sid);

  const step = async (): Promise<void> => {
    await mkdir(eventsDir, { recursive: true });
    const gens = await listGenerations(eventsDir);
    let gen = gens.length > 0 ? gens[gens.length - 1]! : 1;
    let file = join(eventsDir, generationFileName(gen));
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch (err) {
      if (errCode(err) !== "ENOENT") throw err;
    }
    if (size >= EVENTS_GENERATION_MAX_BYTES) {
      await writeGenerationSummary(ctx, gen).catch((err: unknown) => {
        console.warn(`record/events: 세대 요약 sidecar 기록 실패 (gen=${gen}): ${errMsg(err)}`);
      });
      gen += 1;
      file = join(eventsDir, generationFileName(gen));
    }
    const masked = deepMask(e) as AddeEvent;
    const line = `${JSON.stringify(masked)}\n`;
    // fail-closed(ADR-007) — 여기서 던지면 그대로 호출자(TurnRunner)에 전파된다.
    await appendFile(file, line, "utf8");
  };

  const prevTail = appendChains.get(eventsDir) ?? Promise.resolve();
  const result = prevTail.then(step, step);
  appendChains.set(
    eventsDir,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/** 한 세대 파일의 개별 줄을 파싱해 넘긴다(내부 전용) — v1 이 아닌 줄은 스킵(원문은 파일에 그대로 남음). */
function parseLine(raw: string, ctxLabel: string): AddeEvent | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    console.warn(`record/events: 파싱 실패 줄 스킵 (${ctxLabel}): ${errMsg(err)}`);
    return undefined;
  }
  if (typeof obj !== "object" || obj === null) {
    console.warn(`record/events: 줄이 객체가 아님 — 스킵 (${ctxLabel})`);
    return undefined;
  }
  const o = obj as Record<string, unknown>;
  if (o["v"] !== 1) {
    console.warn(
      `record/events: 미지 스키마 버전(v=${String(o["v"])}) — 원문 보존, 이번 읽기에서는 스킵 (${ctxLabel})`,
    );
    return undefined;
  }
  return obj as AddeEvent;
}

export interface ReadEventsOptions {
  /** 파싱 실패로 스킵된 줄마다 호출(집계용, 선택) — `record/rebuild.ts` 의 파손 줄 카운트가 쓴다.
   * 안전망 note 이벤트(마지막 세대 마지막 줄 절단)는 다음 읽기에서야 관측되므로 그 재관측에
   * 의존하지 않고, 스킵되는 그 순간 직접 호출해 정확한 수를 잡는다. */
  onCorrupted?: (info: { file: string; lineNo: number }) => void;
}

/**
 * 세대 순회 읽기 — 파손된 **마지막 세대의 마지막 줄**은 스킵하고 경고 이벤트를 다음 세대에
 * 기록한다(안전망 L1). 그 외 파싱 실패 줄은 스킵 + 콘솔 경고(무음 흡수는 아니다).
 */
export async function* readEvents(
  ctx: RecordCtx,
  opts?: ReadEventsOptions,
): AsyncIterable<AddeEvent> {
  const { eventsDir } = vaultPaths(ctx.vaultRoot, ctx.proj, ctx.sid);
  const gens = await listGenerations(eventsDir);
  if (gens.length === 0) return;
  const lastGen = gens[gens.length - 1]!;
  let maxSeqSoFar = 0;

  for (const gen of gens) {
    const file = join(eventsDir, generationFileName(gen));
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch (err) {
      if (errCode(err) === "ENOENT") continue;
      throw err;
    }
    const lines = content.split("\n").filter((l) => l.length > 0);
    for (let i = 0; i < lines.length; i++) {
      const isLastLineOfLastGen = gen === lastGen && i === lines.length - 1;
      const parsed = parseLine(lines[i]!, `${file}:${i + 1}`);
      if (parsed) {
        if (parsed.seq > maxSeqSoFar) maxSeqSoFar = parsed.seq;
        yield parsed;
        continue;
      }
      opts?.onCorrupted?.({ file, lineNo: i + 1 });
      if (isLastLineOfLastGen) {
        // 크래시 시 마지막 줄 절단 — at-least-once 재처리 판정은 turn_end 부재로 이미 안전하다.
        // 경고 이벤트를 (지금 열린) 마지막 세대에 남긴다(best-effort — 실패해도 읽기는 계속).
        maxSeqSoFar += 1;
        await appendEvent(ctx, {
          v: 1,
          sid: ctx.sid,
          turn: 0,
          seq: maxSeqSoFar,
          ts: new Date().toISOString(),
          t: "note",
          kind: "warning",
          message: `truncated last line skipped in ${generationFileName(gen)}`,
        }).catch(() => {});
      }
    }
  }
}

/** 지정 세대 파일에서 envelopeId → {turn, ended} 인덱스를 직접 스캔한다(내부 전용). */
async function scanGenerationEnvelopes(
  eventsDir: string,
  gen: number,
): Promise<Record<string, { turn: number; ended: boolean }>> {
  const file = join(eventsDir, generationFileName(gen));
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return {};
    throw err;
  }
  const out: Record<string, { turn: number; ended: boolean }> = {};
  for (const raw of content.split("\n")) {
    if (raw.length === 0) continue;
    const parsed = parseLine(raw, `${file}`);
    if (!parsed) continue;
    if (parsed.t === "turn_start") {
      out[parsed.envelopeId] = { turn: parsed.turn, ended: false };
    } else if (parsed.t === "turn_end") {
      out[parsed.envelopeId] = { turn: parsed.turn, ended: true };
    }
  }
  return out;
}

/**
 * 닫힌 세대 요약 sidecar 기록(부팅 재적재 인덱스 비용 상한 — ADR-010). 파생물이라 삭제해도
 * 재생성 가능(loadResumeIndex 가 부재·손상 시 그 세대만 재파싱 후 재생성).
 */
export async function writeGenerationSummary(ctx: RecordCtx, gen: number): Promise<void> {
  const { eventsDir } = vaultPaths(ctx.vaultRoot, ctx.proj, ctx.sid);
  const envelopes = await scanGenerationEnvelopes(eventsDir, gen);
  await atomicWrite(join(eventsDir, summaryFileName(gen)), JSON.stringify(envelopes));
}

/**
 * envelopeId → {turn, ended} 부팅 인덱스 — 닫힌 세대는 요약 sidecar 만 읽고(비용 상한),
 * 열린 마지막 세대만 전량 파싱한다(ADR-010). sidecar 부재·손상 시 그 세대만 재파싱 후 재생성.
 */
export async function loadResumeIndex(
  ctx: RecordCtx,
): Promise<Map<string, { turn: number; ended: boolean }>> {
  const { eventsDir } = vaultPaths(ctx.vaultRoot, ctx.proj, ctx.sid);
  const gens = await listGenerations(eventsDir);
  const index = new Map<string, { turn: number; ended: boolean }>();
  if (gens.length === 0) return index;
  const lastGen = gens[gens.length - 1]!;

  for (const gen of gens) {
    if (gen === lastGen) {
      const scanned = await scanGenerationEnvelopes(eventsDir, gen);
      for (const [k, v] of Object.entries(scanned)) index.set(k, v);
      continue;
    }
    const sidecarPath = join(eventsDir, summaryFileName(gen));
    try {
      const raw = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<
        string,
        { turn: number; ended: boolean }
      >;
      for (const [k, v] of Object.entries(raw)) index.set(k, v);
    } catch {
      const scanned = await scanGenerationEnvelopes(eventsDir, gen);
      for (const [k, v] of Object.entries(scanned)) index.set(k, v);
      await writeGenerationSummary(ctx, gen).catch(() => {});
    }
  }
  return index;
}

/** 세션의 현재 최대 seq(부팅·admit 시점 카운터 초기화용 — 계약 외 보조 export). */
export async function lastSeq(ctx: RecordCtx): Promise<number> {
  let max = 0;
  for await (const e of readEvents(ctx)) {
    if (e.seq > max) max = e.seq;
  }
  return max;
}
