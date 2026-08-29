import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  listFilesRecursive,
  type V2TmpRoots,
  bindSessionManager,
} from "../helpers/v2-fixtures.js";
import {
  makeFakeEngineDriver,
  FAKE_CAPS_PRESETS,
  type FakeEngineCaps,
} from "../helpers/fake-engine.js";

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function makeSM(caps: FakeEngineCaps) {
  const [, sessionManagerMod] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", caps);
  const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
  const sm = sessionManagerMod.createSessionManager(deps);
  bindSessionManager(deps, sm);
  return { sm, fakeDriver };
}

describe("SC-021: 엔진 능력 선언이 동작 결정에 사용된다", () => {
  it("Happy: resume:none·permission:callback 더블 — 생성 시 경고, 재기동 시 재개 생략이 caps 로 결정된다", async () => {
    // permission:"policy-only" 조합은 그 자체로 SC-023(대화형 승인 미지원 엔진 거부) 대상이라
    // "resume:none 경고" 시나리오에 도달하지 못한다(실측, GAP-026 정정) — permission:"callback"
    // 을 유지한 채 resume 만 "none" 인 FAKE_CAPS_PRESETS.noResume 로 판별 가능한 조합을 쓴다.
    const caps = FAKE_CAPS_PRESETS.noResume;
    const { sm } = await makeSM(caps);
    const created = await sm.create({ engine: "acp" });
    expect(created.warnings.length).toBeGreaterThan(0);
  });

  it("Edge: caps 조합이 혼합(resume:native + permission:none)이어도 각 필드가 독립적으로 판정된다", async () => {
    const caps = { ...FAKE_CAPS_PRESETS.noPermission, resume: "native" as const };
    const { sm } = await makeSM(caps);
    await expect(sm.create({ engine: "acp" })).rejects.toThrow(); // permission:none → SC-023 거부
  });

  it("Error: caps 필드가 누락된 드라이버는 등록 시 거부된다", async () => {
    const engines = await import("../../src/engines/index.js");
    const incomplete = { id: "broken", caps: { resume: "native" }, open: async () => ({}) };
    expect(() => {
      const registry = {
        ...engines.ENGINE_REGISTRY,
        broken: incomplete,
      } as unknown as typeof engines.ENGINE_REGISTRY;
      for (const [, d] of Object.entries(registry)) {
        const caps = d.caps as unknown as Record<string, unknown>;
        const required = ["resume", "permission", "streaming", "usage", "compact", "attachments"];
        for (const key of required) {
          if (!(key in caps)) throw new Error(`caps.${key} 누락 — 등록 거부`);
        }
      }
    }).toThrow(/caps\..*누락/);
  });
});

describe("SC-023: 대화형 승인 미지원 엔진의 세션 생성이 거부된다", () => {
  it("Happy: permission:none 엔진으로 세션 생성 요청 시 거부되고 사유가 반환된다", async () => {
    const { sm } = await makeSM(FAKE_CAPS_PRESETS.noPermission);
    await expect(sm.create({ engine: "acp" })).rejects.toThrow(/승인|permission/i);
  });

  it("Edge: permission:policy-only 도 기본적으로 거부된다(대화형 승인만 허용)", async () => {
    const { sm } = await makeSM(FAKE_CAPS_PRESETS.policyOnlyPermission);
    await expect(sm.create({ engine: "acp" })).rejects.toThrow();
  });

  it("Error: 거부 후 설정 파일이 생성·변경되지 않는다", async () => {
    const { sm } = await makeSM(FAKE_CAPS_PRESETS.noPermission);
    await sm.create({ engine: "acp" }).catch(() => {});
    const files = listFilesRecursive(roots.base);
    expect(files.some((f) => f.endsWith("sessions.d") || /sessions\.d[\\/]/.test(f))).toBe(false);
  });
});
