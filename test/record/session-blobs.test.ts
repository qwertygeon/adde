import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  listFilesRecursive,
  makeRecordCtx,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";

// SC-068·SC-069 (FR-026) — blob 저장이 세션 소유로 내려가면서 교차 세션 공유는 폐기되고(각자
// 실체 보유) 세션 내 1회 저장 보장은 유지된다(회귀 가드). `putBlob(ctx,data)` 시그니처 불변.
//
// rename 실패 주입은 node:fs/promises 를 통째로 목(mock)해야 한다(ESM 네임스페이스 직접 spyOn 은
// read-only 바인딩이라 실패 — 기존 record/blobs.test.ts 선례와 동일 패턴).
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
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  renameCtl.failWith = null;
  cleanupV2TmpRoots(roots);
});

describe("SC-068: 서로 다른 세션의 동일 출력은 각자 실체를 갖는다(교차 세션 공유 폐기)", () => {
  it("Happy: A·B 에 동일 내용 저장 → 각 세션 하위에 실체 1개씩 + 각자 자기 참조", async () => {
    const blobs = await import("../../src/record/blobs.js");
    const content = Buffer.from("shared-content".repeat(1000));
    const refA = await blobs.putBlob(makeRecordCtx(roots, PROJ, "sess-a") as never, content);
    const refB = await blobs.putBlob(makeRecordCtx(roots, PROJ, "sess-b") as never, content);
    expect(refA.blob).toBe(refB.blob); // 참조값(해시)은 동일 — 내용 주소이므로.

    const pathsMod = await import("../../src/shared/paths.js");
    const aBlobs = listFilesRecursive(
      pathsMod.sessionVaultPaths(roots.vaultRoot, PROJ, "sess-a").blobsDir,
    );
    const bBlobs = listFilesRecursive(
      pathsMod.sessionVaultPaths(roots.vaultRoot, PROJ, "sess-b").blobsDir,
    );
    expect(aBlobs.length).toBe(1);
    expect(bBlobs.length).toBe(1);
    expect(aBlobs[0]).not.toBe(bBlobs[0]); // 물리적으로 별개 실체.
  });

  it("Edge: 동일 내용을 3세션에 저장해도 각 세션 하위에 정확히 1개씩 존재한다", async () => {
    const blobs = await import("../../src/record/blobs.js");
    const pathsMod = await import("../../src/shared/paths.js");
    const content = Buffer.from("triple-shared".repeat(500));
    for (const sid of ["s1", "s2", "s3"]) {
      await blobs.putBlob(makeRecordCtx(roots, PROJ, sid) as never, content);
      const dir = pathsMod.sessionVaultPaths(roots.vaultRoot, PROJ, sid).blobsDir;
      expect(listFilesRecursive(dir).length).toBe(1);
    }
  });

  it("Error: 빈 sid 로 저장 시도하면 throw 한다(프로젝트 스코프 폴백 0)", async () => {
    const blobs = await import("../../src/record/blobs.js");
    await expect(
      blobs.putBlob(makeRecordCtx(roots, PROJ, "") as never, Buffer.from("x")),
    ).rejects.toThrow();
  });
});

describe("SC-069: 같은 세션 안에서는 동일 출력이 1개만 저장된다(세션 내 보장 유지)", () => {
  it("Happy: 같은 세션 두 턴에서 동일 출력 → 실체 1개(세션 내 보장 유지)", async () => {
    const blobs = await import("../../src/record/blobs.js");
    const pathsMod = await import("../../src/shared/paths.js");
    const content = Buffer.from("same-session-twice".repeat(500));
    const ref1 = await blobs.putBlob(makeRecordCtx(roots, PROJ, "sess-x") as never, content);
    const ref2 = await blobs.putBlob(makeRecordCtx(roots, PROJ, "sess-x") as never, content);
    expect(ref1.blob).toBe(ref2.blob);
    const dir = pathsMod.sessionVaultPaths(roots.vaultRoot, PROJ, "sess-x").blobsDir;
    expect(listFilesRecursive(dir).length).toBe(1);
  });

  it("Edge: 8KiB 임계 경계값에서도 세션 내 동일 판정이 유지된다", async () => {
    const blobs = await import("../../src/record/blobs.js");
    const pathsMod = await import("../../src/shared/paths.js");
    const content = Buffer.from("e".repeat(blobs.BLOB_THRESHOLD_BYTES));
    await blobs.putBlob(makeRecordCtx(roots, PROJ, "sess-y") as never, content);
    await blobs.putBlob(makeRecordCtx(roots, PROJ, "sess-y") as never, content);
    const dir = pathsMod.sessionVaultPaths(roots.vaultRoot, PROJ, "sess-y").blobsDir;
    expect(listFilesRecursive(dir).length).toBe(1);
  });

  it("Error: 쓰기 실패는 예외로 전파된다(무음 흡수 0)", async () => {
    const blobs = await import("../../src/record/blobs.js");
    renameCtl.failWith = () => new Error("simulated write failure");
    await expect(
      blobs.putBlob(makeRecordCtx(roots, PROJ, "sess-z") as never, Buffer.from("z".repeat(9000))),
    ).rejects.toThrow();
  });
});
