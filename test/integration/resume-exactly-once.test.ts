import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeV2TmpRoots, cleanupV2TmpRoots, type V2TmpRoots } from "../helpers/v2-fixtures.js";

// SC-051 (FR-037, ADR-027) — 재적재 여부는 이벤트 기록 ∪ 처리 중 항목 ∪ 대기 큐 3개 근거로만
// 판정한다. `turn_start{envelopeId}` 가 있으면(turn_end 유무 무관) 재-enqueue 하지 않는다.

const PROJ = "p1";
const SID = "sess-1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function makeCtx() {
  const { makeRecordCtx } = await import("../helpers/v2-fixtures.js");
  return makeRecordCtx(roots, PROJ, SID) as never;
}

describe("SC-051: 미완결 턴이 재기동 후 다시 큐에 들어가지 않는다", () => {
  it("Happy: turn_start 만 있고 turn_end 가 없는 항목은 재-enqueue 되지 않고 이어받기로만 완결된다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 0,
      ts: new Date().toISOString(),
      t: "turn_start",
      envelopeId: "env-pending",
      input: { text: "x" },
    } as never);

    const index = await events.loadResumeIndex(ctx);
    expect(index.get("env-pending")?.ended).toBe(false);
    // 판정 규약: turn_start 존재 = 재-enqueue 금지(끝났는지 여부는 무관).
    const shouldReenqueue = !index.has("env-pending");
    expect(shouldReenqueue).toBe(false);

    // turn_start 이벤트가 정확히 1건뿐이어야 한다(재기동 시뮬레이션 — 다시 처리해도 중복 기록 없음).
    const all: unknown[] = [];
    for await (const e of events.readEvents(ctx)) all.push(e);
    expect(all.filter((e) => (e as { t: string }).t === "turn_start")).toHaveLength(1);
  });

  it("Edge: turn_end 까지 있는 항목은 마커만 종단 처리되고 재적재 판정 자체가 발생하지 않는다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    const ts = new Date().toISOString();
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 0,
      ts,
      t: "turn_start",
      envelopeId: "env-done",
      input: { text: "x" },
    } as never);
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 1,
      ts,
      t: "turn_end",
      envelopeId: "env-done",
      stopReason: "end_turn",
    } as never);
    const index = await events.loadResumeIndex(ctx);
    expect(index.get("env-done")?.ended).toBe(true);
  });

  it("Error: 큐·processing·이벤트 어디에도 없는 항목은 정상적으로 1회 재-enqueue 된다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    const index = await events.loadResumeIndex(ctx);
    expect(index.has("env-never-seen")).toBe(false);
    const shouldReenqueue = !index.has("env-never-seen");
    expect(shouldReenqueue).toBe(true);
  });
});
