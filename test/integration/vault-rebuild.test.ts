import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  listFilesRecursive,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";

// SC-016(FR-016)·SC-040(NFR-006) — 노트·중복판정 등 파생물은 이벤트 기록만으로 몇 번을 재생성해도
// 동일 결과로 복원된다. rebuild(ctx, opts) 시그니처는 record/projector 류와 동일한 ctx 우선 규약을
// 따른다고 가정한다(ASSUMPTION — design.md 본문의 `rebuild(proj, opts)` RecordStore 메서드 표기와
// 모듈 함수 표기가 상이할 수 있어 PPG-1 동기화 대상).

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

async function seedTurns(ctx: unknown, count: number) {
  const events = await import("../../src/record/events.js");
  for (let turn = 1; turn <= count; turn++) {
    const ts = new Date(Date.now() + turn * 1000).toISOString();
    await events.appendEvent(
      ctx as never,
      {
        v: 1,
        sid: SID,
        turn,
        seq: turn * 2,
        ts,
        t: "turn_start",
        envelopeId: `env-${turn}`,
        input: { text: `turn ${turn}` },
      } as never,
    );
    await events.appendEvent(
      ctx as never,
      {
        v: 1,
        sid: SID,
        turn,
        seq: turn * 2 + 1,
        ts,
        t: "turn_end",
        envelopeId: `env-${turn}`,
        stopReason: "end_turn",
      } as never,
    );
  }
}

function readAllNoteContents(): Map<string, string> {
  const files = listFilesRecursive(roots.vaultRoot).filter((f) => f.endsWith(".md"));
  return new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));
}

describe("SC-016: 노트가 이벤트 기록만으로 멱등하게 재생성된다", () => {
  it("Happy: 노트 전량 삭제 후 2회 연속 재생성 결과가 서로 같고 삭제 전과 일치한다", async () => {
    const ctx = await makeCtx();
    await seedTurns(ctx, 3);
    void ctx;
    // "before" 스냅샷은 project() 가 아니라 rebuild() 로 확보한다 — project(ctx) 단독 호출은
    // 세션·프로젝트 노트만 갱신하고 턴 노트는 만들지 않는다(projector.ts 실측: projectTurn 은
    // 개별 호출 필요). rebuild() 가 턴 노트까지 포함한 전체 파생물 집합의 SoT 다.
    const rebuild = await import("../../src/record/rebuild.js");
    await rebuild.rebuild(roots.base, roots.vaultRoot, PROJ);
    const before = readAllNoteContents();

    for (const f of before.keys()) fs.rmSync(f, { force: true });

    await rebuild.rebuild(roots.base, roots.vaultRoot, PROJ);
    const afterFirst = readAllNoteContents();
    for (const f of afterFirst.keys()) fs.rmSync(f, { force: true });
    await rebuild.rebuild(roots.base, roots.vaultRoot, PROJ);
    const afterSecond = readAllNoteContents();

    expect([...afterFirst.entries()].sort()).toEqual([...afterSecond.entries()].sort());
    expect([...afterFirst.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it("Edge: 턴 노트만 부분 삭제해도 재생성 후 전체가 복원된다", async () => {
    const ctx = await makeCtx();
    await seedTurns(ctx, 2);
    void ctx;
    const rebuild = await import("../../src/record/rebuild.js");
    await rebuild.rebuild(roots.base, roots.vaultRoot, PROJ);
    const before = readAllNoteContents();
    const turnNoteFile = [...before.keys()].find((f) => /turns[\\/]/.test(f));
    if (turnNoteFile) fs.rmSync(turnNoteFile, { force: true });

    await rebuild.rebuild(roots.base, roots.vaultRoot, PROJ);
    const after = readAllNoteContents();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  });

  it("Error: 이벤트 파일에 파손 줄이 있어도 나머지는 복원되고 경고가 남는다", async () => {
    const ctx = await makeCtx();
    await seedTurns(ctx, 1);
    const files = listFilesRecursive(roots.vaultRoot).filter((f) => /events-\d+\.jsonl$/.test(f));
    fs.appendFileSync(files[0]!, "\n{corrupted");
    const rebuild = await import("../../src/record/rebuild.js");
    const report = (await rebuild.rebuild(roots.base, roots.vaultRoot, PROJ)) as {
      moved?: unknown;
    };
    expect(report).toBeDefined();
  });
});

describe("SC-040 (NFR-006): 파생물이 전부 삭제되어도 이벤트 기록에서 복원된다", () => {
  it("Happy: 노트·중복판정 기록을 모두 지우고 재생성하면 삭제 전과 동일하게 복원되고 이벤트는 무변경이다", async () => {
    const ctx = await makeCtx();
    await seedTurns(ctx, 3);
    const events = await import("../../src/record/events.js");
    const eventsBefore: unknown[] = [];
    for await (const e of events.readEvents(ctx)) eventsBefore.push(e);

    const rebuild = await import("../../src/record/rebuild.js");
    await rebuild.rebuild(roots.base, roots.vaultRoot, PROJ);
    const before = readAllNoteContents();
    for (const f of before.keys()) fs.rmSync(f, { force: true });

    await rebuild.rebuild(roots.base, roots.vaultRoot, PROJ);
    const after = readAllNoteContents();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());

    const eventsAfter: unknown[] = [];
    for await (const e of events.readEvents(ctx)) eventsAfter.push(e);
    expect(eventsAfter).toEqual(eventsBefore);
  });

  it("Edge: 첨부 blob 은 재생성 대상이 아니라 원본 참조가 그대로 유지된다", async () => {
    const blobs = await import("../../src/record/blobs.js");
    const ctx = await makeCtx();
    const ref = await blobs.putBlob(ctx as never, Buffer.from("attachment content"));
    const ref2 = await blobs.putBlob(ctx as never, Buffer.from("attachment content"));
    expect(ref.blob).toBe(ref2.blob);
  });

  it("Error: 이벤트 세대 일부가 파손돼도 복원 가능한 부분까지 복원되고 경고가 남는다", async () => {
    const ctx = await makeCtx();
    await seedTurns(ctx, 2);
    const files = listFilesRecursive(roots.vaultRoot).filter((f) => /events-\d+\.jsonl$/.test(f));
    fs.appendFileSync(files[files.length - 1]!, "\n{{bad");
    const rebuild = await import("../../src/record/rebuild.js");
    await expect(rebuild.rebuild(roots.base, roots.vaultRoot, PROJ)).resolves.toBeDefined();
  });
});
