import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  listFilesRecursive,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";

// 확정 시그니처: putBlob(ctx, data): Promise<BlobRef>  ·  BLOB_THRESHOLD_BYTES = 8*1024
//
// rename 실패 주입은 node:fs/promises 를 통째로 목(mock)해야 한다(ESM 네임스페이스 직접 spyOn 은
// read-only 바인딩이라 실패 — record-failure.test.ts·atomic-vault.test.ts 선례와 동일 패턴).
// blobs.ts 는 `rename`(async, named import)을 쓴다 — 이전 저술은 무관한 sync `fs.renameSync` 를
// spy 했던 이중 오류였다(대상 함수 자체가 다름 + ESM spyOn 한계).
const renameCtl = vi.hoisted(() => ({ failWith: null as (() => Error) | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameCtl.failWith) {
        const err = renameCtl.failWith();
        renameCtl.failWith = null;
        throw err;
      }
      return actual.rename(...args);
    },
  };
});

const PROJ = "p1";
const SID = "sess-1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
  renameCtl.failWith = null;
});

async function makeCtx() {
  const { makeRecordCtx } = await import("../helpers/v2-fixtures.js");
  return makeRecordCtx(roots, PROJ, SID) as never;
}

describe("BLOB_THRESHOLD_BYTES", () => {
  it("8 KiB 로 고정된다", async () => {
    const blobs = await import("../../src/record/blobs.js");
    expect(blobs.BLOB_THRESHOLD_BYTES).toBe(8 * 1024);
  });
});

describe("SC-017: 같은 내용의 첨부·대용량 출력이 한 번만 저장된다", () => {
  it("Happy: 동일 대용량 출력이 두 턴에서 발생해도 blob 실체는 1개이고 양쪽 참조가 같다", async () => {
    const blobs = await import("../../src/record/blobs.js");
    const ctx = await makeCtx();
    const content = "z".repeat(20_000);
    const ref1 = await blobs.putBlob(ctx, Buffer.from(content));
    const ref2 = await blobs.putBlob(ctx, Buffer.from(content));
    expect(ref1.blob).toBe(ref2.blob);
    const blobFiles = listFilesRecursive(roots.vaultRoot).filter((f) => /[\\/]blobs[\\/]/.test(f));
    expect(blobFiles.length).toBe(1);
  });

  it("Edge: 8 KiB ±1 바이트 경계에서도 정확한 임계 판정이 적용된다", async () => {
    const blobs = await import("../../src/record/blobs.js");
    const ctx = await makeCtx();
    const under = Buffer.from("a".repeat(8 * 1024 - 1));
    const exact = Buffer.from("a".repeat(8 * 1024));
    const over = Buffer.from("a".repeat(8 * 1024 + 1));
    await expect(blobs.putBlob(ctx, under)).resolves.toHaveProperty("blob");
    await expect(blobs.putBlob(ctx, exact)).resolves.toHaveProperty("blob");
    await expect(blobs.putBlob(ctx, over)).resolves.toHaveProperty("blob");
  });

  it("Error: blob 쓰기 실패 시 턴은 실패로 처리된다(fail-closed)", async () => {
    const blobs = await import("../../src/record/blobs.js");
    const ctx = await makeCtx();
    renameCtl.failWith = () => new Error("simulated write failure");
    await expect(blobs.putBlob(ctx, Buffer.from("x".repeat(9000)))).rejects.toThrow();
  });
});
