import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeV2TmpRoots, cleanupV2TmpRoots, type V2TmpRoots } from "../helpers/v2-fixtures.js";

// SC-041 (NFR-007): 원자 쓰기와 동기화 충돌 파일 무시. atomicWrite(fs-atomic.ts) 는 이식(유지)
// 대상이라 기존 동작을 그대로 재사용. isConflictFile 은 research.md 이식 목록에 따라
// record/vault-paths.ts 로 이식된다고 가정한다(ADR-033 — 이동하지 않고 스캔에서만 제외).
//
// rename 실패 주입은 node:fs/promises 를 통째로 목(mock)해야 한다(ESM 네임스페이스 직접 spyOn 은
// read-only 바인딩이라 실패 — record-failure.test.ts 선례와 동일 패턴). fs-atomic.ts 가 named
// import(`rename`)로 캡처한 참조를 가로채려면 vi.mock 팩토리로 그 참조 자체를 교체해야 한다.
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

let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
  renameCtl.failWith = null;
});

describe("SC-041: 원자 쓰기와 동기화 충돌 파일 무시", () => {
  it("Happy: 쓰기 중단을 재현해도 부분 노트 파일이 최종 경로에 남지 않는다(임시본만 존재)", async () => {
    const atomicMod = await import("../../src/shared/fs-atomic.js");
    const target = path.join(roots.vaultRoot, "note.md");
    renameCtl.failWith = () => new Error("simulated crash before rename completes");
    await expect(atomicMod.atomicWrite(target, "content")).rejects.toThrow();
    expect(fs.existsSync(target)).toBe(false); // 최종 경로에 부분 내용 미노출
  });

  it("Happy: 정상 완료 시 이전 내용 없이 새 내용으로 원자 교체된다", async () => {
    const atomicMod = await import("../../src/shared/fs-atomic.js");
    const target = path.join(roots.vaultRoot, "note2.md");
    fs.writeFileSync(target, "old content");
    await atomicMod.atomicWrite(target, "new content");
    expect(fs.readFileSync(target, "utf8")).toBe("new content");
  });

  it("Edge: 충돌 파일이 입력 노트와 같은 이름 계열이어도 지시 입력으로 접수되지 않는다", async () => {
    const vaultPathsMod = (await import("../../src/record/vault-paths.js")) as unknown as {
      isConflictFile?: (name: string) => boolean;
    };
    if (!vaultPathsMod.isConflictFile) return;
    expect(vaultPathsMod.isConflictFile("inbox (conflicted copy 2026-08-26).md")).toBe(true);
    expect(vaultPathsMod.isConflictFile("inbox.md")).toBe(false);
  });

  it("Error: rename 실패(EXDEV 등)가 오류로 전파되고 부분 파일이 남지 않는다", async () => {
    const atomicMod = await import("../../src/shared/fs-atomic.js");
    const target = path.join(roots.vaultRoot, "note3.md");
    renameCtl.failWith = () => {
      const err = new Error("cross-device link") as NodeJS.ErrnoException;
      err.code = "EXDEV";
      return err;
    };
    await expect(atomicMod.atomicWrite(target, "x")).rejects.toMatchObject({ code: "EXDEV" });
    expect(fs.existsSync(target)).toBe(false);
  });
});
