import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { makeFakeRecordStore } from "../helpers/fake-record-store.js";

// SC-052 (FR-038, ADR-030) — 팔레트 resume 항목은 detached·hibernated 세션을 다시 연다(인자 없음).
// 팔레트 체크박스 자체의 markdown 배선(T019)은 확정 시그니처 밖이므로, 본 파일은 그 트리거가
// 위임할 SessionManager.admit() 재시도 계약을 직접 검증한다.

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
  const { store: record } = makeFakeRecordStore();
  const sm = sessionManagerMod.createSessionManager(
    makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }, { record }) as never,
  );
  return { sm, sessionStore, sessionManagerMod, fakeDriver, record };
}

/**
 * "데몬이 active 상태로 죽었다가 재기동" 시나리오 재현(GAP-022 동형) — 같은 인스턴스에서
 * admit() 직후 resumeAllOnBoot() 를 부르면 in-memory 상주 상태 때문에 재개 로직 자체가
 * 트리거되지 않는다(resumeAllOnBoot() 는 status==="active" 레코드만 처리하는데, hibernate() 를
 * 거치면 상태가 "hibernated" 로 바뀌어 그 대상에서도 제외된다). 신규 SessionManager 인스턴스가
 * load() 로 디스크의 active 레코드를 다시 읽어야 실제 재개 시도가 일어난다.
 */
async function makeFreshSMWithLoad(
  sessionManagerMod: Awaited<ReturnType<typeof makeSM>>["sessionManagerMod"],
  fakeDriver: Awaited<ReturnType<typeof makeSM>>["fakeDriver"],
  record: Awaited<ReturnType<typeof makeSM>>["record"],
) {
  const sm2 = sessionManagerMod.createSessionManager(
    makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }, { record }) as never,
  ) as unknown as { load(): Promise<void> } & Awaited<
    ReturnType<typeof sessionManagerMod.createSessionManager>
  >;
  await sm2.load();
  return sm2;
}

describe("SC-052: 팔레트 재개 재시도가 동작하고 체크박스가 복원된다", () => {
  it("Happy: detached 세션에서 resume 체크 → 재개 재시도 성공 시 active 로 전환된다", async () => {
    const { sm, sessionStore, sessionManagerMod, fakeDriver, record } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid); // status: active (in-memory + 영속)

    fakeDriver.control.failNextOpen("first resume fails");
    const sm2 = await makeFreshSMWithLoad(sessionManagerMod, fakeDriver, record);
    await sm2.resumeAllOnBoot().catch(() => {});
    let list = await sessionStore.loadSessions(roots.base, PROJ);
    expect(list.find((s) => s.sid === created.sid)?.status).toBe("detached");

    // 팔레트 resume 재시도(성공) — 현재(재기동 후) 인스턴스인 sm2 에서 재시도한다.
    await sm2.admit(created.sid);
    list = await sessionStore.loadSessions(roots.base, PROJ);
    expect(list.find((s) => s.sid === created.sid)?.status).toBe("active");
  });

  it("Edge: hibernated 세션에서 resume 은 즉시 재개된다", async () => {
    const { sm, sessionStore } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    await sm.hibernate(created.sid, "idle").catch(() => {});
    await sm.admit(created.sid);
    const list = await sessionStore.loadSessions(roots.base, PROJ);
    expect(list.find((s) => s.sid === created.sid)?.status).toBe("active");
  });

  it("Error: 재개 재실패 시 detached 사유가 갱신된다", async () => {
    const { sm, sessionStore, fakeDriver } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    await sm.hibernate(created.sid, "idle").catch(() => {});
    fakeDriver.control.failNextOpen("resume fails again");
    await expect(sm.admit(created.sid)).rejects.toThrow();
    const list = await sessionStore.loadSessions(roots.base, PROJ);
    expect(list.find((s) => s.sid === created.sid)?.status).toBe("detached");
  });
});

describe("SC-053: 지원하지 않는 기능은 팔레트에 나타나지 않는다", () => {
  it("Happy: caps.compact:'none' 선언 세션의 팔레트에 compact 항목이 렌더되지 않는다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const items = inbox.renderPalette(
      {
        resume: "native",
        permission: "callback",
        streaming: true,
        usage: false,
        compact: "none",
        attachments: [],
      },
      true,
    );
    expect(items.some((i) => /compact/i.test(i))).toBe(false);
  });

  it("Edge: caps.compact:'prompt' 선언 세션은 compact 항목이 렌더된다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const items = inbox.renderPalette(
      {
        resume: "native",
        permission: "callback",
        streaming: true,
        usage: false,
        compact: "prompt",
        attachments: [],
      },
      true,
    );
    expect(items.some((i) => /compact/i.test(i))).toBe(true);
  });

  it("Error: 팔레트 자체가 비활성(markdown.palette=off)이면 전체 미렌더", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const items = inbox.renderPalette(
      {
        resume: "native",
        permission: "callback",
        streaming: true,
        usage: false,
        compact: "native",
        attachments: [],
      },
      false,
    );
    expect(items).toEqual([]);
  });
});
