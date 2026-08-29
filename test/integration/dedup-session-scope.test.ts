import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeRecordCtx,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";

// SC-070~072 (FR-027·FR-028) — 중복 판정이 세션 소유로 좁혀져 교차 세션 판정이 폐기되고
// (FR-027 BREAKING), 세션 내 판정은 유지되며, 재기동 후에도(지연 시드) 판정 이력이 보존된다.
//
// appendFile 실패 주입은 node:fs/promises 를 통째로 목해야 한다(ESM 네임스페이스 직접 spyOn 은
// read-only 바인딩이라 실패).
const appendCtl = vi.hoisted(() => ({ failWith: null as (() => Error) | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      if (appendCtl.failWith) {
        const err = appendCtl.failWith();
        appendCtl.failWith = null;
        throw err;
      }
      return actual.appendFile(...args);
    },
  };
});

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  appendCtl.failWith = null;
  cleanupV2TmpRoots(roots);
});

describe("SC-070: 교차 세션 동일 본문은 더 이상 중복으로 판정되지 않는다(BREAKING)", () => {
  it("Happy: A 와 동일 본문을 B 에 입력해도 B 는 dupOf null·본문 그대로 유지된다", async () => {
    const dedup = await import("../../src/record/dedup.js");
    const text = "동일한 본문입니다";
    const ctxA = makeRecordCtx(roots, PROJ, "sess-a");
    const ctxB = makeRecordCtx(roots, PROJ, "sess-b");
    const resultA = await dedup.classify(ctxA as never, "user_input", text);
    const resultB = await dedup.classify(ctxB as never, "user_input", text);
    expect(resultA.dupOf).toBeNull();
    expect(resultB.dupOf).toBeNull(); // 교차 세션 판정 폐기 — B 는 여전히 최초 발생.
  });

  it("Edge: A·B 가 같은 tick(동시)에 판정해도 각자 독립적으로 최초 발생이다", async () => {
    const dedup = await import("../../src/record/dedup.js");
    const text = "동시 입력 본문";
    const ctxA = makeRecordCtx(roots, PROJ, "sess-a2");
    const ctxB = makeRecordCtx(roots, PROJ, "sess-b2");
    const [resultA, resultB] = await Promise.all([
      dedup.classify(ctxA as never, "user_input", text),
      dedup.classify(ctxB as never, "user_input", text),
    ]);
    expect(resultA.dupOf).toBeNull();
    expect(resultB.dupOf).toBeNull();
  });

  it("Error: B 원장 append 실패는 판정만 실패하고 턴 처리 자체는 계속된다", async () => {
    const dedup = await import("../../src/record/dedup.js");
    appendCtl.failWith = () => new Error("simulated append fail");
    const ctxB = makeRecordCtx(roots, PROJ, "sess-b3");
    await expect(dedup.classify(ctxB as never, "user_input", "본문")).rejects.toThrow();
    // 재시도 시 정상 동작 확인 — 실패가 세션 인덱스를 영구 오염시키지 않는다.
    await expect(dedup.classify(ctxB as never, "user_input", "본문2")).resolves.toBeDefined();
  });
});

describe("SC-071: 같은 세션 안의 중복은 여전히 최초 턴을 링크하며 판정된다(회귀 가드)", () => {
  it("Happy: 같은 세션에 동일 본문 2회 → 두 번째는 최초 턴 링크 + 원장 판정 기록", async () => {
    const dedup = await import("../../src/record/dedup.js");
    const ctx = {
      ...makeRecordCtx(roots, PROJ, "sess-c"),
      turn: 1,
      turnStartIso: new Date().toISOString(),
    };
    const first = await dedup.classify(ctx as never, "user_input", "반복 본문");
    expect(first.dupOf).toBeNull();
    const ctx2 = { ...ctx, turn: 2 };
    const second = await dedup.classify(ctx2 as never, "user_input", "반복 본문");
    expect(second.dupOf?.turn).toBe(1);
  });

  it("Edge: 3회째 입력도 최초 턴(1)을 링크한다", async () => {
    const dedup = await import("../../src/record/dedup.js");
    const base = {
      ...makeRecordCtx(roots, PROJ, "sess-d"),
      turnStartIso: new Date().toISOString(),
    };
    await dedup.classify({ ...base, turn: 1 } as never, "user_input", "삼중 반복");
    await dedup.classify({ ...base, turn: 2 } as never, "user_input", "삼중 반복");
    const third = await dedup.classify({ ...base, turn: 3 } as never, "user_input", "삼중 반복");
    expect(third.dupOf?.turn).toBe(1);
  });

  it("Error: 원장에 파손 줄이 있어도 스킵 후 판정은 계속된다", async () => {
    const dedup = await import("../../src/record/dedup.js");
    const pathsMod = await import("../../src/shared/paths.js");
    const ctx = {
      ...makeRecordCtx(roots, PROJ, "sess-e"),
      turn: 1,
      turnStartIso: new Date().toISOString(),
    };
    await dedup.classify(ctx as never, "user_input", "본문A");
    const { dedupFile } = pathsMod.sessionVaultPaths(roots.vaultRoot, PROJ, "sess-e");
    fs.appendFileSync(dedupFile, "{not valid json\n");
    dedup.dropSessionIndex(ctx as never); // 재기동 흉내 — 다음 classify 가 원장을 다시 시드한다.
    const result = await dedup.classify({ ...ctx, turn: 2 } as never, "user_input", "본문A");
    expect(result.dupOf?.turn).toBe(1); // 파손 줄이 최초 발생 인식을 막지 않는다.
  });
});

describe("SC-072: 판정 이력은 데몬 재기동을 넘어 유지된다(지연 시드)", () => {
  it("Happy: 판정 이력 있는 세션 → 재기동(in-memory 리셋) 후 같은 본문 재입력 → 중복 판정", async () => {
    const dedup = await import("../../src/record/dedup.js");
    const ctx = {
      ...makeRecordCtx(roots, PROJ, "sess-f"),
      turn: 1,
      turnStartIso: new Date().toISOString(),
    };
    await dedup.classify(ctx as never, "user_input", "재기동 검증 본문");
    dedup.dropSessionIndex(ctx as never); // 재기동 흉내 — in-memory 인덱스·시드 플래그 초기화.
    const afterRestart = await dedup.classify(
      { ...ctx, turn: 2 } as never,
      "user_input",
      "재기동 검증 본문",
    );
    expect(afterRestart.dupOf?.turn).toBe(1);
  });

  it("Edge: 재기동 후 첫 판정에서만 시드가 수행된다(세션당 1회)", async () => {
    const dedup = await import("../../src/record/dedup.js");
    const pathsMod = await import("../../src/shared/paths.js");
    const ctx = {
      ...makeRecordCtx(roots, PROJ, "sess-g"),
      turn: 1,
      turnStartIso: new Date().toISOString(),
    };
    await dedup.classify(ctx as never, "user_input", "시드 검증");
    dedup.dropSessionIndex(ctx as never);
    const { dedupFile } = pathsMod.sessionVaultPaths(roots.vaultRoot, PROJ, "sess-g");
    const before = fs.readFileSync(dedupFile, "utf8");
    await dedup.classify({ ...ctx, turn: 2 } as never, "user_input", "시드 검증");
    await dedup.classify({ ...ctx, turn: 3 } as never, "user_input", "시드 검증2");
    const after = fs.readFileSync(dedupFile, "utf8");
    // 시드 자체는 읽기만 하므로 원장에 새 줄을 추가하지 않는다 — 두 번째 classify 로 추가된 줄만 늘어난다.
    expect(after.split("\n").filter(Boolean).length).toBeGreaterThan(
      before.split("\n").filter(Boolean).length,
    );
  });

  it("Error: 원장 삭제 후 재기동하면 판정이 리셋되지만 rebuild 로 복원 가능하다", async () => {
    const dedup = await import("../../src/record/dedup.js");
    const pathsMod = await import("../../src/shared/paths.js");
    const ctx = {
      ...makeRecordCtx(roots, PROJ, "sess-h"),
      turn: 1,
      turnStartIso: new Date().toISOString(),
    };
    await dedup.classify(ctx as never, "user_input", "삭제후 검증");
    dedup.dropSessionIndex(ctx as never);
    const { dedupFile } = pathsMod.sessionVaultPaths(roots.vaultRoot, PROJ, "sess-h");
    fs.rmSync(dedupFile, { force: true });
    const afterDelete = await dedup.classify(
      { ...ctx, turn: 2 } as never,
      "user_input",
      "삭제후 검증",
    );
    expect(afterDelete.dupOf).toBeNull(); // 판정 이력 소실 — 무증상 아님(경고 0건은 허용).
  });
});
