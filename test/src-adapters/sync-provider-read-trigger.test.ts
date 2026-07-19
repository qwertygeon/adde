import { afterEach, describe, expect, it, vi } from "vitest";

// icloud read-trigger 물질화(018)의 fs 의존 경로 검증 — node:fs/promises 목이 필요해
// sync-provider.test.ts(최상단 sync-provider 모듈 목 보유)와 분리한 파일이다.
// 제어 상태는 vi.hoisted 로 목 factory 와 함께 호이스팅한다(vi.mock 호이스팅 TDZ 회피).
const fsCtl = vi.hoisted(() => ({
  statImpl: undefined as undefined | (() => Promise<{ blocks: number; size: number }>),
  openImpl: undefined as undefined | (() => Promise<unknown>),
  openCalls: 0,
  closeCalls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) =>
      fsCtl.statImpl ? fsCtl.statImpl() : actual.stat(...args),
    open: (...args: Parameters<typeof actual.open>) => {
      if (fsCtl.openImpl) {
        fsCtl.openCalls++;
        return fsCtl.openImpl();
      }
      return actual.open(...args);
    },
  };
});

afterEach(() => {
  fsCtl.statImpl = undefined;
  fsCtl.openImpl = undefined;
  fsCtl.openCalls = 0;
  fsCtl.closeCalls = 0;
  vi.useRealTimers();
});

/** 계약 강제 fake FileHandle — read 인자 오배선(빈 버퍼·비영 offset)은 실제처럼 throw 한다. */
function fakeHandle(readBody: () => Promise<{ bytesRead: number }> | Promise<never>) {
  return {
    read: (buffer: Buffer, offset: number, length: number, position: number) => {
      if (!Buffer.isBuffer(buffer) || buffer.length < 1 || length < 1 || offset !== 0 || position !== 0) {
        throw new Error(`fake FileHandle.read 계약 위반: offset=${offset} length=${length} position=${position}`);
      }
      return readBody();
    },
    close: async () => {
      fsCtl.closeCalls++;
    },
  };
}

describe("icloud read-trigger — 타임아웃·실패 경로 (018 SC-2/SC-3)", () => {
  it("SC-2: read 가 상한(10s)을 넘기면 skip 을 반환하고 fd 를 닫는다(유계화) — read 트리거 발화도 단언", async () => {
    vi.useFakeTimers();
    fsCtl.statImpl = async () => ({ blocks: 0, size: 100 }); // 항상 dataless 로 보고
    fsCtl.openImpl = async () =>
      fakeHandle(() => new Promise(() => {})); // never-resolve — FileProvider 다운로드 블록 quirk 재현
    const { SYNC_PROVIDER_REGISTRY } = await import("../../src/src-adapters/sync-provider.js");
    const pending = SYNC_PROVIDER_REGISTRY["icloud"]!.ensureLocal("/fake/dataless.md");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBe("skip"); // fail-open — 다음 일간 실행 재시도
    expect(fsCtl.openCalls).toBe(1); // read 트리거가 실제로 발화됨
    expect(fsCtl.closeCalls).toBe(1); // 타임아웃 승리에도 close 로 fd 해제(영구 잔존 방지)
  });

  it("SC-3: read 트리거 실패(open 거부)여도 예외 없이 skip 으로 수렴한다", async () => {
    fsCtl.statImpl = async () => ({ blocks: 0, size: 100 });
    fsCtl.openImpl = async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    const { SYNC_PROVIDER_REGISTRY } = await import("../../src/src-adapters/sync-provider.js");
    await expect(SYNC_PROVIDER_REGISTRY["icloud"]!.ensureLocal("/fake/denied.md")).resolves.toBe(
      "skip",
    );
  });

  it("SC-1 보강: read 완료 후 재검증이 물질화(blocks>0)를 확인하면 ready 를 반환하고 fd 를 닫는다", async () => {
    let materialized = false;
    fsCtl.statImpl = async () =>
      materialized ? { blocks: 2048, size: 100 } : { blocks: 0, size: 100 };
    fsCtl.openImpl = async () =>
      fakeHandle(async () => {
        materialized = true; // read 완료 = 다운로드 완료(실측 시맨틱 재현)
        return { bytesRead: 1 };
      });
    const { SYNC_PROVIDER_REGISTRY } = await import("../../src/src-adapters/sync-provider.js");
    await expect(
      SYNC_PROVIDER_REGISTRY["icloud"]!.ensureLocal("/fake/downloading.md"),
    ).resolves.toBe("ready");
    expect(fsCtl.closeCalls).toBe(1); // 정상 경로에서도 fd 정리
  });
});
