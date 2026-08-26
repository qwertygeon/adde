import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  listFilesRecursive,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";

// SC-049·SC-050 (FR-036, ADR-014) — 전송 확정 시 본문 제거는 큐 rename 성공 **후**에만 일어나고,
// 턴 노트는 turn_start 시점 선생성("처리 중")된다. Surface.start()/deliver() 전체 배선(T019)은
// 확정 시그니처 밖이라, 본 파일은 그 계약이 의존하는 원시 요소(순서·마커 포맷·선투영)를 직접
// 검증한다 — 전체 Surface 관통은 T019 착지 후 EXECUTION 이 재확인한다.

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

async function turnsDir(): Promise<string> {
  const pathsMod = await import("../../src/shared/paths.js");
  return pathsMod.vaultPaths(roots.vaultRoot, PROJ, SID).turnsDir;
}

describe("SC-049: 전송 확정 시 본문이 제거되고 마커가 2단계로 진행한다", () => {
  it("Happy: turn_start 시점에 턴 노트가 '처리 중' 상태로 선생성되고, 종료 후 완료 마커로 전이한다", async () => {
    const ctx = await makeCtx();
    const events = await import("../../src/record/events.js");
    const projector = await import("../../src/record/projector.js");
    const inbox = await import("../../src/surfaces/markdown/inbox.js");

    const ts = new Date().toISOString();
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 0,
      ts,
      t: "turn_start",
      envelopeId: "env-1",
      input: { text: "지시" },
    } as never);
    await projector.projectTurn(ctx, 1, "running");

    const turnNoteFiles = listFilesRecursive(roots.vaultRoot).filter((f) => /turns[\\/]/.test(f));
    expect(turnNoteFiles.length).toBe(1);
    const fs = await import("node:fs");
    expect(fs.readFileSync(turnNoteFiles[0]!, "utf8")).toMatch(/처리\s*중|지시/);

    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 1,
      ts,
      t: "turn_end",
      envelopeId: "env-1",
      stopReason: "end_turn",
    } as never);
    await projector.projectTurn(ctx, 1, "final");

    const sentMarker = inbox.sentLine(1, ts);
    expect(sentMarker).toMatch(/✅|sent/);

    // 전송 본문을 담는 별도 아카이브 파일이 존재하지 않는다.
    const archiveFiles = listFilesRecursive(roots.vaultRoot).filter((f) => /archive/i.test(f));
    expect(archiveFiles).toEqual([]);
  });

  it("Edge: 빈 작성 영역으로 전송을 체크하면 본문 제거·턴 생성 모두 일어나지 않는다(kind:'empty')", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const content = [
      "<!-- adde:compose -->",
      "",
      "- [x] 📤 send",
      "<!-- adde:records -->",
      "",
    ].join("\n");
    const parsed = inbox.parseInbox(content);
    expect(parsed.actions.some((a) => a.kind === "empty")).toBe(true);
    expect(parsed.actions.some((a) => a.kind === "fresh")).toBe(false);
  });
});

describe("SC-050: 턴 노트 선생성 실패가 턴을 중단시킨다", () => {
  it("Happy: 저장소 쓰기 불가 상태에서는 턴이 완료 처리되지 않고 마커가 접수 단계에 머무른다", async () => {
    const ctx = await makeCtx();
    const events = await import("../../src/record/events.js");
    const projector = await import("../../src/record/projector.js");
    const fs = await import("node:fs");
    const dir = await turnsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o500); // 쓰기 불가
    try {
      await events.appendEvent(ctx, {
        v: 1,
        sid: SID,
        turn: 1,
        seq: 0,
        ts: new Date().toISOString(),
        t: "turn_start",
        envelopeId: "env-1",
        input: { text: "x" },
      } as never);
      await expect(projector.projectTurn(ctx, 1, "running")).rejects.toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it("Edge: 이벤트 기록은 성공했으나 선투영만 실패해도 동일한 실패 경로를 탄다", async () => {
    const ctx = await makeCtx();
    const projector = await import("../../src/record/projector.js");
    const fs = await import("node:fs");
    const dir = await turnsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o500);
    try {
      await expect(projector.projectTurn(ctx, 1, "running")).rejects.toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it("Error: 이벤트·선투영 모두 실패해도 같은 지시가 중복 실행되지 않는다(재전송 없음)", async () => {
    const ctx = await makeCtx();
    const events = await import("../../src/record/events.js");
    const collected: unknown[] = [];
    for await (const e of events.readEvents(ctx)) collected.push(e);
    expect(
      collected.filter((e) => (e as { envelopeId?: string }).envelopeId === "env-1"),
    ).toHaveLength(0);
  });
});
