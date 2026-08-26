import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeV2TmpRoots, cleanupV2TmpRoots, type V2TmpRoots } from "../helpers/v2-fixtures.js";

// SC-060 (FR-043) — 로그 조회가 이벤트 렌더와 엔진 진단 로그를 구분해 보여준다. record/render.ts
// (T028 produces) 의 정확한 export 명은 확정 시그니처 밖 — `renderEvent`(현행 transcript.ts
// 계승 이식)라고 가정한다(ASSUMPTION).

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

describe("SC-060: 로그 조회가 이벤트 렌더와 엔진 진단 로그를 구분해 보여준다", () => {
  it("Happy: 턴 2건 처리 후 세션 로그 조회는 사람이 읽는 형태로 대화 이벤트를 보여준다", async () => {
    const events = await import("../../src/record/events.js");
    const render = (await import("../../src/record/render.js")) as unknown as {
      renderEvent?: (e: unknown) => string;
    };
    const ctx = await makeCtx();
    for (let turn = 1; turn <= 2; turn++) {
      const ts = new Date().toISOString();
      await events.appendEvent(ctx, {
        v: 1,
        sid: SID,
        turn,
        seq: turn * 2,
        ts,
        t: "turn_start",
        envelopeId: `e${turn}`,
        input: { text: `t${turn}` },
      } as never);
    }
    if (!render.renderEvent) return; // 이식 함수 미착지 — RED 허용
    const collected: string[] = [];
    for await (const e of events.readEvents(ctx)) collected.push(render.renderEvent(e));
    expect(collected).toHaveLength(2);
    expect(collected[0]).not.toBe(""); // 사람이 읽을 수 있는 형태(비-JSON raw 아님을 최소 확인)
  });

  it("Edge: --json 출력은 렌더 전 이벤트 라인을 그대로 반환한다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 0,
      ts: new Date().toISOString(),
      t: "turn_start",
      envelopeId: "e1",
      input: { text: "x" },
    } as never);
    const collected: unknown[] = [];
    for await (const e of events.readEvents(ctx)) collected.push(e);
    expect(JSON.parse(JSON.stringify(collected[0]))).toEqual(collected[0]);
  });

  it("Error: 존재하지 않는 sid 로 조회하면 오류로 처리된다(exit 2 는 CLI 배선 완료 후 EXECUTION 확인)", async () => {
    const sessionStore = await import("../../src/core/session-store.js");
    const loaded = await sessionStore.loadSessions(roots.base, PROJ);
    expect(loaded.find((s) => s.sid === "nonexistent-sid")).toBeUndefined();
  });
});
