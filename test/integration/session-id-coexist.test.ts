import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  type V2TmpRoots,
  bindSessionManager,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";

// SC-017 (FR-008·NFR-003) — 구 형식(`<base36 ms>-<8 hex>`)과 신 형식(`YYMMDD-N[-slug]`) 식별자가
// 공존해도 목록·재개·중지·제거가 각각 정상 동작하고 기존 식별자는 변경되지 않는다.

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function makeSM() {
  const [sessionStore, sessionManagerMod] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
  const sm = sessionManagerMod.createSessionManager(deps);
  bindSessionManager(deps, sm);
  return { sm, sessionStore, fakeDriver };
}

/** 구 형식 sid 로 직접 레코드를 심어 legacy 세션을 재현한다. */
async function seedLegacySession(sessionStore: Awaited<ReturnType<typeof makeSM>>["sessionStore"]) {
  const legacySid = sessionStore.newSid();
  const now = new Date().toISOString();
  await sessionStore.saveSession(roots.base, PROJ, {
    v: 1,
    sid: legacySid,
    engine: "acp",
    engineRef: null,
    status: "active",
    title: null,
    createdAt: now,
    lastActivityAt: now,
    successorOf: null,
    engineArgs: [],
    warnings: [],
    bindings: [],
    rev: 0,
    stopReason: null,
    stoppedAt: null,
    stopPending: null,
    stopNotePending: false,
    notices: [],
    // storageLayout 부재 = legacy 구간(design.md 데이터 모델).
  } as never);
  return legacySid;
}

describe("SC-017: 구·신 식별자 형식 공존 시 목록·재개·중지·제거가 각각 정상 동작한다", () => {
  it("Happy: 구·신 형식 세션이 함께 목록에 나타나고 각자 형식이 유지된다", async () => {
    const { sm, sessionStore } = await makeSM();
    const legacySid = await seedLegacySession(sessionStore);
    const created = await sm.create({ engine: "acp" });
    await (sm as unknown as { load(): Promise<void> }).load();

    const list = sm.list();
    expect(list.some((r) => r.sid === legacySid)).toBe(true);
    expect(list.some((r) => r.sid === created.sid)).toBe(true);
    expect(legacySid).toMatch(/^[a-z0-9]+-[0-9a-f]{8}$/);
    expect(created.sid).toMatch(/^\d{6}-\d+/);
  });

  it("Edge: 구 형식 세션에도 신규 안내·중지 노트 적용 경로(stop)가 정상 동작한다", async () => {
    const { sm, sessionStore } = await makeSM();
    const legacySid = await seedLegacySession(sessionStore);
    await (sm as unknown as { load(): Promise<void> }).load();
    const smApi = sm as unknown as {
      stop: (sid: string, opts: { reason: string; source: "cli" }) => Promise<{ result: string }>;
    };
    const outcome = await smApi.stop(legacySid, { reason: "r", source: "cli" });
    expect(["stopped", "scheduled"]).toContain(outcome.result);
    const rec = (await sessionStore.loadSessions(roots.base, PROJ)).find(
      (s) => s.sid === legacySid,
    );
    expect(rec?.sid).toBe(legacySid); // 식별자 자체는 변경되지 않는다.
  });

  it("Error: 구 형식 sid 로 상태 불일치 조작을 시도하면 mismatch 로 안내된다", async () => {
    const { sm, sessionStore } = await makeSM();
    const legacySid = await seedLegacySession(sessionStore);
    await (sm as unknown as { load(): Promise<void> }).load();
    const smApi = sm as unknown as {
      resume: (sid: string) => Promise<{ result: string; reason?: string }>;
    };
    // 아직 active 인 세션에 resume 시도 → mismatch(이미 활성).
    const outcome = await smApi.resume(legacySid);
    expect(outcome.result).toBe("mismatch");
    void sessionStore;
  });
});
