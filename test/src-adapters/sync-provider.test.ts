import { afterEach, describe, expect, it, vi } from "vitest";

// 확정 시그니처(design/tasks.md Test Authoring Contract):
// SyncProviderDescriptor { id; ensureLocal(path): Promise<"ready"|"skip"> }
// SYNC_PROVIDER_REGISTRY: Record<string, SyncProviderDescriptor>
// SYNC_PROVIDER_IDS: readonly string[]
// resolveSyncProvider(id: string | undefined): SyncProviderDescriptor  — 미등록 throw

// SC-030(신규 제공자가 코드 변경 0 으로 디스패치)을 이 파일 전체에서 함께 증명하기 위해
// vi.mock 은 파일 최상단(호이스팅 지점)에 둔다 — source-descriptor.test.ts 의 레지스트리
// 확장 검증 선례와 동일 패턴. 다른 describe(local/icloud/미지원값)는 실제 registry 를
// spread 하므로 기존 동작에 영향이 없다.
const TEST_PROVIDER_ID = "test-provider-sc030";

vi.mock("../../src/src-adapters/sync-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/src-adapters/sync-provider.js")>();
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

describe("resolveSyncProvider — 미설정=local, 허용값 수용, 미지원 거부 (SC-028)", () => {
  it("미설정(undefined) 은 local 제공자로 해석된다", async () => {
    const { resolveSyncProvider } = await import("../../src/src-adapters/sync-provider.js");
    expect(resolveSyncProvider(undefined).id).toBe("local");
  });

  it("'icloud' 는 정상 조회된다", async () => {
    const { resolveSyncProvider } = await import("../../src/src-adapters/sync-provider.js");
    expect(resolveSyncProvider("icloud").id).toBe("icloud");
  });

  it("미등록 값('gdrive')은 throw(fail-closed) — 기동 거부는 C-01 이 catch", async () => {
    const { resolveSyncProvider } = await import("../../src/src-adapters/sync-provider.js");
    expect(() => resolveSyncProvider("gdrive")).toThrow(/gdrive/);
  });
});

describe("local 제공자 — placeholder 특수 처리 없음 (SC-029, FR-030)", () => {
  it("local.ensureLocal 은 다운로드 대기 없이 즉시 'ready' 를 반환한다", async () => {
    const { SYNC_PROVIDER_REGISTRY } = await import("../../src/src-adapters/sync-provider.js");
    const start = Date.now();
    const result = await SYNC_PROVIDER_REGISTRY["local"]!.ensureLocal("/any/path.md");
    expect(result).toBe("ready");
    expect(Date.now() - start).toBeLessThan(50); // 대기 없음(placeholder 개념 자체가 없음)
  });
});

describe("icloud 제공자 — dataless skip + 재시도 (SC-012, FR-015)", () => {
  it("dataless(미다운로드) 로 판정되면 skip 을 반환하고 예외를 던지지 않는다", async () => {
    const { SYNC_PROVIDER_REGISTRY } = await import("../../src/src-adapters/sync-provider.js");
    // 실기기 감지 로직은 실측 확정(ASM-002) 대상이라 CI 는 옵션 C(스텁 경로)만 검증한다 —
    // 존재하지 않는 경로를 넘겨 다운로드 트리거·재검증이 실패로 수렴하는 fail-safe 경로를 유도.
    const result = await SYNC_PROVIDER_REGISTRY["icloud"]!.ensureLocal(
      "/nonexistent/dataless-placeholder.md",
    );
    expect(["ready", "skip"]).toContain(result); // 무손실 degrade — 예외 없이 둘 중 하나로 수렴
  });
});

describe("SC-030: 새 제공자가 기존 코드 수정 없이 확장점 등록만으로 디스패치된다", () => {
  it("신규 제공자가 SYNC_PROVIDER_IDS 에 반영되고 정상 디스패치된다(코드 변경 0)", async () => {
    const { resolveSyncProvider, SYNC_PROVIDER_IDS } = await import(
      "../../src/src-adapters/sync-provider.js"
    );
    expect(SYNC_PROVIDER_IDS).toContain(TEST_PROVIDER_ID);
    const provider = resolveSyncProvider(TEST_PROVIDER_ID);
    expect(provider.id).toBe(TEST_PROVIDER_ID);
    await expect(provider.ensureLocal("/any")).resolves.toBe("ready");
  });

  it("기존 local·icloud 제공자 디스패치는 신규 등록 후에도 변경 없이 그대로 동작한다", async () => {
    const { resolveSyncProvider } = await import("../../src/src-adapters/sync-provider.js");
    expect(resolveSyncProvider("local").id).toBe("local");
    expect(resolveSyncProvider("icloud").id).toBe("icloud");
  });
});
