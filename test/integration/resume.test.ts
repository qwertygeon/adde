import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
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

async function makeSM(driverCaps: FakeEngineCaps) {
  const [sessionStore, sessionManagerMod] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", driverCaps);
  const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
  const sm = sessionManagerMod.createSessionManager(deps);
  bindSessionManager(deps, sm);
  return { sm, sessionStore, sessionManagerMod, fakeDriver };
}

/**
 * "데몬이 active 상태로 죽었다가 재기동" 시나리오 재현(GAP-022) — 최초 `sm` 로 세션을
 * create()+admit() 해 영속 레코드를 status:"active" 로 남긴 뒤, **별도(신규) SessionManager
 * 인스턴스**를 만들어 `load()` 로 그 레코드를 다시 읽고 `resumeAllOnBoot()` 를 호출한다. 같은
 * `sm` 인스턴스에서 곧바로 resumeAllOnBoot() 를 부르면 admit() 이 이미 만든 in-memory 상주
 * 상태 때문에 "이미 상주 중"으로 취급돼 재개 로직 자체가 트리거되지 않는다(실측 — 부팅 재개는
 * in-memory 상태가 없는 새 프로세스를 전제).
 */
async function makeFreshSMWithLoad(
  sessionManagerMod: unknown,
  fakeDriver: ReturnType<typeof makeFakeEngineDriver>,
) {
  const mod = sessionManagerMod as typeof import("../../src/core/session-manager.js");
  const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
  const sm2 = mod.createSessionManager(deps);
  bindSessionManager(deps, sm2);
  await sm2.load();
  return sm2;
}

// GAP-022 정정(PPG-1 rework4): resumeAllOnBoot() 는 design.md §부팅 시퀀스 6번 항목대로
// status==="active" 레코드만 처리한다(`if (rec.status !== "active") continue;`). 세션을
// hibernate() 로 먼저 내리면 resumeAllOnBoot 순회 대상에서 제외돼 "hibernated" 로 남는다(SC-007
// 이 검증하려는 "데몬이 active 상태로 죽었다가 재기동" 시나리오가 아니게 됨). create()+admit()
// 직후 세션 레코드는 이미 status:"active" 이므로 hibernate() 호출을 제거해 그 상태를 그대로
// resumeAllOnBoot() 에 전달한다(SC-007 의 본질 — 재개 실패 시 detached+통지 — 는 그대로 유지).
describe("SC-007: 재개 실패가 조용한 새 세션 폴백으로 처리되지 않는다", () => {
  it("Happy: 재개 실패 더블에 묶인 세션은 detached 로 전환되고 사유가 기록되며 새 세션은 생성되지 않는다", async () => {
    const { sm, sessionStore, sessionManagerMod, fakeDriver } = await makeSM(
      FAKE_CAPS_PRESETS.fullNative,
    );
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    const beforeCount = (await sessionStore.loadSessions(roots.base, PROJ)).length;

    // 데몬 재기동 재현 — in-memory 상태가 없는 신규 인스턴스로 load()+resumeAllOnBoot().
    const sm2 = await makeFreshSMWithLoad(sessionManagerMod, fakeDriver);
    fakeDriver.control.failNextOpen("session/load rejected");
    const report = await sm2.resumeAllOnBoot();
    void report;

    const after = await sessionStore.loadSessions(roots.base, PROJ);
    expect(after.length).toBe(beforeCount); // 새 세션(새 재개 핸들) 미생성
    expect(after.find((s) => s.sid === created.sid)?.status).toBe("detached");
    expect(after.find((s) => s.sid === created.sid)?.warnings.length).toBeGreaterThan(0);
  });

  it("Edge: 세션 2개 중 1개만 재개 실패하면 나머지는 정상 재개된다", async () => {
    const { sm, sessionStore, sessionManagerMod, fakeDriver } = await makeSM(
      FAKE_CAPS_PRESETS.fullNative,
    );
    const a = await sm.create({ engine: "acp" });
    const b = await sm.create({ engine: "acp" });
    await sm.admit(a.sid);
    await sm.admit(b.sid);

    const sm2 = await makeFreshSMWithLoad(sessionManagerMod, fakeDriver);
    fakeDriver.control.failNextOpen("only-a-fails"); // 1회성 — 재개 순회 중 첫 open() 호출만 실패
    await sm2.resumeAllOnBoot();
    const after = await sessionStore.loadSessions(roots.base, PROJ);
    const aStatus = after.find((s) => s.sid === a.sid)?.status;
    const bStatus = after.find((s) => s.sid === b.sid)?.status;
    expect([aStatus, bStatus]).toContain("detached");
    expect([aStatus, bStatus]).toContain("active");
  });

  it("Error: 재개 중 엔진 spawn 자체 실패도 동일하게 detached 로 귀결한다", async () => {
    const { sm, sessionStore, sessionManagerMod, fakeDriver } = await makeSM(
      FAKE_CAPS_PRESETS.fullNative,
    );
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    const sm2 = await makeFreshSMWithLoad(sessionManagerMod, fakeDriver);
    fakeDriver.control.failNextOpen("ENOENT: spawn failed");
    await sm2.resumeAllOnBoot();
    const after = await sessionStore.loadSessions(roots.base, PROJ);
    expect(after.find((s) => s.sid === created.sid)?.status).toBe("detached");
  });
});

describe("SC-008: 재개 미지원 엔진은 생성 시점에 경고한다", () => {
  it("Happy: caps.resume:none 엔진으로 생성하면 성공하되 경고가 생성 응답에 포함된다", async () => {
    const { sm } = await makeSM(FAKE_CAPS_PRESETS.noResume);
    const created = await sm.create({ engine: "acp" });
    expect(created.warnings.some((w) => /재기동|재개|resume/i.test(w))).toBe(true);
  });

  it("Edge: 경고가 있는 세션을 재기동하면 재개가 생략되고 맥락 리셋이 기록된다", async () => {
    const { sm, sessionStore } = await makeSM(FAKE_CAPS_PRESETS.noResume);
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    const report = await sm.resumeAllOnBoot();
    void report;
    const after = await sessionStore.loadSessions(roots.base, PROJ);
    // resume:"none" 세션은 detached 로 취급되지 않고 hibernated 로 남아 다음 지시에 새 엔진 세션을 연다.
    expect(after.find((s) => s.sid === created.sid)?.status).toBe("hibernated");
  });

  it("Error: 미등록 엔진 id 를 지정하면 세션 생성이 거부된다", async () => {
    const { sm } = await makeSM(FAKE_CAPS_PRESETS.noResume);
    await expect(sm.create({ engine: "unknown-engine-id" })).rejects.toThrow();
  });
});
