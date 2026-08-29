import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  listFilesRecursive,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";

// 확정 시그니처: contentHash(text): string
// classify(ctx, kind: "user_input"|"assistant", text): Promise<{ dupOf: TurnRef | null }>

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

describe("SC-018: 본문 중복이 링크와 판정 기록으로 대체된다", () => {
  it("Happy: 동일 입력을 두 번 넣으면 두 번째는 dupOf 를 받고 원장에 최초/중복 참조가 남으며 이벤트 원본은 둘 다 보존된다", async () => {
    const dedup = await import("../../src/record/dedup.js");
    const events = await import("../../src/record/events.js");
    const ctx = await makeCtx();
    const text = "동일한 사용자 입력입니다";

    const first = await dedup.classify(ctx, "user_input", text);
    expect(first.dupOf).toBeNull();
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 0,
      ts: new Date().toISOString(),
      t: "turn_start",
      envelopeId: "env-1",
      input: { text },
    } as never);

    const second = await dedup.classify(ctx, "user_input", text);
    expect(second.dupOf).not.toBeNull();
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 2,
      seq: 1,
      ts: new Date().toISOString(),
      t: "turn_start",
      envelopeId: "env-2",
      input: { text },
    } as never);

    const ledgerFiles = listFilesRecursive(roots.vaultRoot).filter((f) =>
      f.endsWith("dedup.jsonl"),
    );
    expect(ledgerFiles.length).toBe(1);
    // 006 이관(D001 baseline 마이그레이션) — 원장이 v2 완전 인덱스로 승격되어 최초 발생도
    // `first` 라인으로 기록한다(ADR-004). 이전엔 중복(`dup`)만 1줄이었으나 이제 최초 1 + 중복 1 = 2줄.
    expect(fs.readFileSync(ledgerFiles[0]!, "utf8").trim().split("\n").length).toBe(2);

    const collected: unknown[] = [];
    for await (const e of events.readEvents(ctx)) collected.push(e);
    expect(collected.filter((e) => (e as { t: string }).t === "turn_start")).toHaveLength(2);
  });

  it("Edge: 공백·개행만 다른 입력은 정규화 후 동일 판정된다", async () => {
    const dedup = await import("../../src/record/dedup.js");
    const ctx = await makeCtx();
    await dedup.classify(ctx, "user_input", "hello world");
    const second = await dedup.classify(ctx, "user_input", "hello world\n  ");
    expect(second.dupOf).not.toBeNull();
  });

  it("Error: dedup 인덱스가 손상돼도 rebuild 로 복원 가능하다", async () => {
    await makeCtx();
    const ledgerFiles = listFilesRecursive(roots.vaultRoot).filter((f) =>
      f.endsWith("dedup.jsonl"),
    );
    for (const f of ledgerFiles) fs.rmSync(f, { force: true });
    const rebuild = await import("../../src/record/rebuild.js");
    await expect(rebuild.rebuild(roots.base, roots.vaultRoot, PROJ)).resolves.toBeDefined();
  });
});

describe("contentHash — 정규화 후 sha256(순수 함수)", () => {
  it("트림·개행 정규화 후 동일 문자열은 같은 해시를 산출한다", async () => {
    const dedup = await import("../../src/record/dedup.js");
    expect(dedup.contentHash("abc\n")).toBe(dedup.contentHash("abc"));
    expect(dedup.contentHash("  abc  ")).toBe(dedup.contentHash("abc"));
  });
});
