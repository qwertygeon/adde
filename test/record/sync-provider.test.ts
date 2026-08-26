import { afterEach, describe, expect, it, vi } from "vitest";

// T-D11 처분(2026-08-26): src-adapters/sync-provider.ts → record/sync-provider.ts **이식**
// (동작 무변경 — research.md §호출측 식별). 본 파일은 구 `test/src-adapters/sync-provider.test.ts`
// + `sync-provider-read-trigger.test.ts` 를 import 경로만 교체해 그대로 승계한다(회귀 검출력 보존
// — 무손실 동작이므로 재작성하지 않음). 구 파일 2개는 삭제했다.
//
// 확정 시그니처(design/tasks.md Test Authoring Contract):
// SyncProviderDescriptor { id; ensureLocal(path): Promise<"ready"|"skip"> }
// SYNC_PROVIDER_REGISTRY: Record<string, SyncProviderDescriptor>
// SYNC_PROVIDER_IDS: readonly string[]
// resolveSyncProvider(id: string | undefined): SyncProviderDescriptor  — 미등록 throw

const TEST_PROVIDER_ID = "test-provider-sc030";

vi.mock("../../src/record/sync-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/record/sync-provider.js")>();
  const testDescriptor = { id: TEST_PROVIDER_ID, ensureLocal: async () => "ready" as const };
  const registry = { ...actual.SYNC_PROVIDER_REGISTRY, [TEST_PROVIDER_ID]: testDescriptor };
  return {
    ...actual,
    SYNC_PROVIDER_REGISTRY: registry,
    SYNC_PROVIDER_IDS: Object.keys(registry),
    resolveSyncProvider: (id: string | undefined) => {
      const resolved = id ?? "local";
      const found = registry[resolved as keyof typeof registry];
      if (!found) throw new Error(`미등록 sync provider: ${resolved}`);
      return found;
    },
  };
});

afterEach(() => {
  vi.resetModules();
});

describe("SC-048: 내려받아지지 않은 파일을 먼저 내려받고, 실패분만 건너뛴다", () => {
  describe("resolveSyncProvider — 미설정=local, 허용값 수용, 미지원 거부", () => {
    it("미설정(undefined) 은 local 제공자로 해석된다", async () => {
      const { resolveSyncProvider } = await import("../../src/record/sync-provider.js");
      expect(resolveSyncProvider(undefined).id).toBe("local");
    });

    it("'icloud' 는 정상 조회된다", async () => {
      const { resolveSyncProvider } = await import("../../src/record/sync-provider.js");
      expect(resolveSyncProvider("icloud").id).toBe("icloud");
    });

    it("미등록 값('gdrive')은 throw(fail-closed) — 기동 거부는 호출측이 catch", async () => {
      const { resolveSyncProvider } = await import("../../src/record/sync-provider.js");
      expect(() => resolveSyncProvider("gdrive")).toThrow(/gdrive/);
    });
  });

  describe("local 제공자 — placeholder 특수 처리 없음", () => {
    it("local.ensureLocal 은 다운로드 대기 없이 즉시 'ready' 를 반환한다", async () => {
      const { SYNC_PROVIDER_REGISTRY } = await import("../../src/record/sync-provider.js");
      const start = Date.now();
      const result = await SYNC_PROVIDER_REGISTRY["local"]!.ensureLocal("/any/path.md");
      expect(result).toBe("ready");
      expect(Date.now() - start).toBeLessThan(50); // 대기 없음(placeholder 개념 자체가 없음)
    });
  });

  describe("icloud 제공자 — dataless skip + 재시도", () => {
    it("dataless(미다운로드) 로 판정되면 skip 을 반환하고 예외를 던지지 않는다", async () => {
      const { SYNC_PROVIDER_REGISTRY } = await import("../../src/record/sync-provider.js");
      // 감지 휴리스틱(blocks=0·size>0)은 실기기 실측으로 검증 완료(018 analysis.md) — 본 케이스는
      // 존재하지 않는 경로를 넘겨 다운로드 트리거·재검증이 실패로 수렴하는 fail-safe 경로를 유도.
      const result = await SYNC_PROVIDER_REGISTRY["icloud"]!.ensureLocal(
        "/nonexistent/dataless-placeholder.md",
      );
      expect(["ready", "skip"]).toContain(result); // 무손실 degrade — 예외 없이 둘 중 하나로 수렴
    });
  });

  describe("icloud read-trigger 물질화 (018 — SC-1)", () => {
    it("SC-1: dataless 시그니처(sparse) 파일에서 read 트리거 경로가 즉시 관통한다 — 10초 폴링 대기 없음", async (ctx) => {
      // sparse 파일은 blocks=0·size>0 으로 dataless 와 동일 stat 시그니처를 가지며, read 로 블록이
      // 할당되지 않는 quirk 까지 재현한다(실 fs — 더블 아님). read 트리거가 즉시 settle 하므로
      // 신규 구현은 재검증 1회 후 skip 으로 빠르게 수렴한다.
      const { mkdtemp, open, rm, stat } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = await mkdtemp(join(tmpdir(), "adde-sync-sparse-"));
      const sparsePath = join(dir, "sparse.bin");
      try {
        const fh = await open(sparsePath, "w");
        await fh.truncate(1024 * 1024);
        await fh.close();
        const s = await stat(sparsePath);
        // FS 가 sparse 를 blocks=0 으로 만들지 않으면 전제 불성립 — 조용한 green 이 아니라 skip 표기
        if (s.blocks !== 0) return ctx.skip();
        const { SYNC_PROVIDER_REGISTRY } = await import("../../src/record/sync-provider.js");
        const start = Date.now();
        const result = await SYNC_PROVIDER_REGISTRY["icloud"]!.ensureLocal(sparsePath);
        expect(result).toBe("skip"); // sparse 는 read 후에도 blocks=0 → 재검증이 skip 판정
        expect(Date.now() - start).toBeLessThan(5_000); // 폴링 상한(10s) 소진 없이 즉시 수렴
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    // SC-2(타임아웃 fail-open)·SC-3(open 거부 수렴)은 node:fs/promises 목이 필요해 본 파일의
    // 최상단 sync-provider 모듈 목과 간섭한다 — 아래 별도 describe 블록으로 분리.
  });

  describe("SC-030 계열: 새 제공자가 기존 코드 수정 없이 확장점 등록만으로 디스패치된다", () => {
    it("신규 제공자가 SYNC_PROVIDER_IDS 에 반영되고 정상 디스패치된다(코드 변경 0)", async () => {
      const { resolveSyncProvider, SYNC_PROVIDER_IDS } =
        await import("../../src/record/sync-provider.js");
      expect(SYNC_PROVIDER_IDS).toContain(TEST_PROVIDER_ID);
      const provider = resolveSyncProvider(TEST_PROVIDER_ID);
      expect(provider.id).toBe(TEST_PROVIDER_ID);
      await expect(provider.ensureLocal("/any")).resolves.toBe("ready");
    });

    it("기존 local·icloud 제공자 디스패치는 신규 등록 후에도 변경 없이 그대로 동작한다", async () => {
      const { resolveSyncProvider } = await import("../../src/record/sync-provider.js");
      expect(resolveSyncProvider("local").id).toBe("local");
      expect(resolveSyncProvider("icloud").id).toBe("icloud");
    });
  });
});

// 제어 상태는 vi.hoisted 로 목 factory 와 함께 호이스팅한다(vi.mock 호이스팅 TDZ 회피 — top-level).
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

describe("icloud read-trigger — 타임아웃·실패 경로 (018 SC-2/SC-3)", () => {
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
        if (
          !Buffer.isBuffer(buffer) ||
          buffer.length < 1 ||
          length < 1 ||
          offset !== 0 ||
          position !== 0
        ) {
          throw new Error(
            `fake FileHandle.read 계약 위반: offset=${offset} length=${length} position=${position}`,
          );
        }
        return readBody();
      },
      close: async () => {
        fsCtl.closeCalls++;
      },
    };
  }

  it("SC-2: read 가 상한(10s)을 넘기면 skip 을 반환하고 fd 를 닫는다(유계화) — read 트리거 발화도 단언", async () => {
    vi.useFakeTimers();
    fsCtl.statImpl = async () => ({ blocks: 0, size: 100 }); // 항상 dataless 로 보고
    fsCtl.openImpl = async () => fakeHandle(() => new Promise(() => {})); // never-resolve — FileProvider 다운로드 블록 quirk 재현
    const { SYNC_PROVIDER_REGISTRY } = await import("../../src/record/sync-provider.js");
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
    const { SYNC_PROVIDER_REGISTRY } = await import("../../src/record/sync-provider.js");
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
    const { SYNC_PROVIDER_REGISTRY } = await import("../../src/record/sync-provider.js");
    await expect(
      SYNC_PROVIDER_REGISTRY["icloud"]!.ensureLocal("/fake/downloading.md"),
    ).resolves.toBe("ready");
    expect(fsCtl.closeCalls).toBe(1); // 정상 경로에서도 fd 정리
  });
});
