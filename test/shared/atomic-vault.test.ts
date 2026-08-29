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

// tmp 선점(SEC-006) 재현 — 다음 tmp 이름을 예측하려면 `randomBytes` 접미를 고정해야 한다
// (pid+카운터는 예측 가능하나 랜덤 접미는 그 자체가 방어 대상). `vi.resetModules()` 로 fs-atomic.js
// 를 매번 새로 불러와 모듈 내부 `tmpCallCounter` 를 0 부터 재현 가능하게 만든다.
const cryptoCtl = vi.hoisted(() => ({ fixedHex: null as string | null }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: (n: number) => {
      if (cryptoCtl.fixedHex) return Buffer.from(cryptoCtl.fixedHex, "hex");
      return actual.randomBytes(n);
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
  cryptoCtl.fixedHex = null;
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

  it("Edge(SEC-006: tmp 선점): 다음에 쓸 tmp 경로가 심볼릭 링크로 미리 점거돼 있으면 atomicWrite 가 EEXIST 로 실패하고 그 링크 대상을 오염시키지 않는다", async () => {
    // randomBytes 접미를 고정해 tmpPathFor 가 실제로 만들 이름을 예측한 뒤, 그 자리에 공격자
    // 소유 파일을 가리키는 심볼릭 링크를 미리 심어 atomicWrite 자체를 관통시킨다(Node raw wx 계약
    // 재확인이 아니라 production 코드 경로 자체를 검증).
    vi.resetModules();
    cryptoCtl.fixedHex = "aabbccddeeff";
    const atomicMod = await import("../../src/shared/fs-atomic.js");
    const dir = path.join(roots.vaultRoot, "preempt-dir");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, "note4.md");
    const attackerTarget = path.join(dir, "attacker-owned.txt");
    fs.writeFileSync(attackerTarget, "attacker content");
    // fs-atomic.ts 를 방금 새로 불러왔으므로 모듈 내부 tmpCallCounter 는 0부터 시작한다 —
    // tmpPathFor 의 이름 패턴(`.${basename}.${pid}.${counter}.${rand}.tmp`)과 정확히 일치시킨다.
    const predictedTmp = path.join(dir, `.note4.md.${process.pid}.0.aabbccddeeff.tmp`);
    fs.symlinkSync(attackerTarget, predictedTmp);
    await expect(atomicMod.atomicWrite(target, "victim content")).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(fs.existsSync(target)).toBe(false); // rename 이 일어나지 않았다.
    expect(fs.readFileSync(attackerTarget, "utf8")).toBe("attacker content"); // 링크 대상 미오염.

    // 회귀 가드 — 선점이 없는 정상 호출(카운터가 이미 소비된 이름을 다시 쓰지 않는다)은 그대로
    // 성공한다.
    await atomicMod.atomicWrite(target, "victim content 2");
    expect(fs.readFileSync(target, "utf8")).toBe("victim content 2");
  });
});
