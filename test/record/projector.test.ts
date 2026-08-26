import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  listFilesRecursive,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";

// 확정 시그니처: turnNoteName(turn, turnStartIso) · preview(text, max?) ·
// projectTurn(ctx, turn, phase, policy?) · project(ctx, opts?)

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

async function appendTurn(ctx: unknown, turn: number, text: string) {
  const events = await import("../../src/record/events.js");
  const ts = new Date().toISOString();
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
      input: { text },
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

describe("turnNoteName — 결정론적 파일명(ADR-017)", () => {
  it("Happy: `NNNN <ts>.md` 형식이고 같은 입력이면 항상 같은 이름을 산출한다", async () => {
    const projector = await import("../../src/record/projector.js");
    const iso = "2026-08-25T20:30:00.000Z";
    const name1 = projector.turnNoteName(7, iso);
    const name2 = projector.turnNoteName(7, iso);
    expect(name1).toBe(name2);
    expect(name1).toMatch(/^0007 /);
    expect(name1.endsWith(".md")).toBe(true);
  });

  it("Edge: 턴 번호가 4자리를 넘어가도 zero-pad 규칙이 무너지지 않는다", async () => {
    const projector = await import("../../src/record/projector.js");
    const name = projector.turnNoteName(12345, "2026-08-25T20:30:00.000Z");
    expect(name).toMatch(/^12345 /);
  });
});

describe("SC-015: 턴·세션·프로젝트 노트가 결정론적 파일명으로 만들어지고 서로 링크된다", () => {
  it("Happy: 턴 2건 처리 후 턴 노트 2개·세션 노트 1개·프로젝트 노트 1개가 있고 상호 링크된다", async () => {
    const ctx = await makeCtx();
    await appendTurn(ctx, 1, "첫 턴");
    await appendTurn(ctx, 2, "둘째 턴");
    const projector = await import("../../src/record/projector.js");
    // project(ctx) 단독 호출은 턴 노트를 만들지 않는다(세션·프로젝트 노트만 — 실측, PPG-1
    // rework3/GAP-020 정정). 턴 노트는 projectTurn() 을 턴마다 명시 호출해야 생성된다.
    await projector.projectTurn(ctx, 1, "final");
    await projector.projectTurn(ctx, 2, "final");
    await projector.project(ctx, {
      projectSessions: [
        { sid: SID, status: "active", title: null, lastActivityAt: new Date().toISOString() },
      ],
    } as never);

    const files = listFilesRecursive(roots.vaultRoot);
    const turnNotes = files.filter((f) => /turns[\\/]\d+ .*\.md$/.test(f));
    const sessionNotes = files.filter((f) => f.endsWith("session.md"));
    const projectNotes = files.filter((f) => f.endsWith("project.md"));
    expect(turnNotes.length).toBe(2);
    expect(sessionNotes.length).toBe(1);
    expect(projectNotes.length).toBe(1);

    const sessionNoteContent = fs.readFileSync(sessionNotes[0]!, "utf8");
    for (const turnNote of turnNotes) {
      const base = turnNote.split(/[\\/]/).pop()!.replace(/\.md$/, "");
      expect(sessionNoteContent).toContain(base);
      const turnContent = fs.readFileSync(turnNote, "utf8");
      // 위키링크는 확장자 없이 `[[sessions/<sid>/session]]` 형태로 렌더된다(실측).
      expect(turnContent).toMatch(/\[\[sessions\/[^/]+\/session]]/);
    }
  });

  it("Edge: 같은 초에 2턴이 발생해도 턴 번호로 구분된다", async () => {
    const ctx = await makeCtx();
    const events = await import("../../src/record/events.js");
    const sameTs = new Date().toISOString();
    for (const turn of [1, 2]) {
      await events.appendEvent(ctx, {
        v: 1,
        sid: SID,
        turn,
        seq: turn,
        ts: sameTs,
        t: "turn_start",
        envelopeId: `env-${turn}`,
        input: { text: `t${turn}` },
      } as never);
    }
    const projector = await import("../../src/record/projector.js");
    const name1 = projector.turnNoteName(1, sameTs);
    const name2 = projector.turnNoteName(2, sameTs);
    expect(name1).not.toBe(name2);
  });

  it("Error: 노트 디렉터리가 부재해도 project() 가 디렉터리를 만들고 진행한다", async () => {
    const ctx = await makeCtx();
    await appendTurn(ctx, 1, "턴");
    const projector = await import("../../src/record/projector.js");
    await expect(projector.project(ctx)).resolves.toBeUndefined();
  });
});

describe("SC-019: 턴 목록 미리보기가 기계 발췌로 만들어진다", () => {
  it("Happy: 임계 길이를 넘는 본문의 미리보기가 앞부분을 그대로 자른 문자열이다", async () => {
    const projector = await import("../../src/record/projector.js");
    const text = "가".repeat(50) + "나".repeat(50);
    const preview = projector.preview(text, 50);
    expect(preview.startsWith("가".repeat(50).slice(0, 40))).toBe(true);
    expect(preview).not.toContain("생성");
  });

  it("Edge: 본문이 정확히 임계 길이면 잘림 표시 없이 전문이 그대로 나온다", async () => {
    const projector = await import("../../src/record/projector.js");
    const text = "다".repeat(30);
    const preview = projector.preview(text, 30);
    expect(preview).toContain(text);
  });

  it("Error: 본문이 blob 참조뿐이면 참조 표기로 보여준다(생성 문구 없음)", async () => {
    const projector = await import("../../src/record/projector.js");
    const preview = projector.preview("sha256:abcdef0123456789", 50);
    expect(preview).not.toMatch(/요약|자동\s*생성/);
  });
});
