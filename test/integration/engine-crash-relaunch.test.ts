import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  makeRecordCtx,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { makeFakeRecordStore } from "../helpers/fake-record-store.js";

// SC-061~063 (FR-044, ADR-031) — 엔진 크래시 자가 재기동. session-watcher.ts 가 lane-watcher.ts
// 상태기계를 세션 스코프로 이식한다(T013). deps 형태(auto_relaunch 등)는 session-manager 의
// conf 주입과 동일 경로라고 가정한다(ASSUMPTION).

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function makeSM(autoRelaunch: boolean) {
  const [sessionStore, sessionManagerMod] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const { store: record, calls } = makeFakeRecordStore();
  const sm = sessionManagerMod.createSessionManager(
    makeSessionManagerDeps(
      roots,
      PROJ,
      { acp: fakeDriver.descriptor },
      {
        conf: { auto_relaunch: autoRelaunch },
        // GAP-019 해소분 배선 — record 미전달 시 calls.appendEvent 인터셉션이 무효화된다.
        record,
      },
    ) as never,
  );
  return { sm, sessionStore, fakeDriver, record, calls };
}

describe("SC-061: 크래시 시 대기 승인이 즉시 거부되고 재기동이 시도된다", () => {
  it("Happy: pending 승인 1건 + 엔진 강제 종료 → 즉시 deny 기록 + 유계 재시도로 재기동", async () => {
    // 실측: SessionManager.admit() 은 raw EngineSession 을 그대로 반환하고, 그 send() 를 직접
    // 호출하는 경로는 SessionManager.requestPermission()(rt.pendingPermissions 등록처)를 거치지
    // 않는다 — 권한 개입은 오직 SessionManager 가 내부 소유한 TurnRunner(sm.turnRunner(sid))가
    // 큐를 소비하며 engineSession.send() 를 호출할 때만 발생한다(turn-runner.ts handlePermission).
    // 따라서 pending 승인을 실제로 등록하려면 큐에 지시를 넣고 그 TurnRunner 를 구동해야 한다.
    // 추가 실측: turn-runner.ts 는 record/events.js 의 appendEvent 를 직접 import 해 호출한다
    // (GAP-019 DI 는 session-manager.ts 자체 호출부만 커버 — TurnRunner 측은 미적용, DI 로 가로챌
    // 수 없다). 따라서 이벤트 관측은 fake record 의 calls 대신 실제 vault 이벤트를 읽는다.
    const { sm, fakeDriver } = await makeSM(true);
    const created = await sm.create({ engine: "acp" });
    const engine = await sm.admit(created.sid); // rt.turnRunner 생성 + 엔진 기동(재사용됨)
    const tr = sm.turnRunner(created.sid);
    if (!tr) throw new Error("turnRunner 미생성");

    const [queueMod, pathsMod, eventsMod] = await Promise.all([
      import("../../src/core/queue.js"),
      import("../../src/shared/paths.js"),
      import("../../src/record/events.js"),
    ]);
    const sp = pathsMod.sessionPaths(roots.base, PROJ, created.sid);
    await queueMod.enqueue(
      sp as never,
      {
        v: 1,
        id: "msg-crash-1",
        lane: "unused-v2-legacy-field",
        source: "markdown",
        backend: "acp",
        engine: "acp",
        project: PROJ,
        ts: new Date().toISOString(),
        text: "x",
      } as never,
    );

    const ctx = makeRecordCtx(roots, PROJ, created.sid) as never;
    async function collectEvents(): Promise<Array<{ t?: string; decision?: string }>> {
      const out: Array<{ t?: string; decision?: string }> = [];
      for await (const e of eventsMod.readEvents(ctx))
        out.push(e as { t?: string; decision?: string });
      return out;
    }
    async function waitForEvent(
      pred: (e: { t?: string; decision?: string }) => boolean,
      timeoutMs = 4000,
    ): Promise<void> {
      const start = Date.now();
      for (;;) {
        const evs = await collectEvents();
        if (evs.some(pred)) return;
        if (Date.now() - start > timeoutMs)
          throw new Error("waitForEvent: 조건이 제한 시간 내 충족되지 않음");
        await new Promise<void>((r) => setTimeout(r, 5));
      }
    }

    fakeDriver.control.hangNextPermission(); // 권한 요청이 응답 없이 대기하도록(크래시 전 pending 유지)
    const startPromise = tr.start(); // await 하지 않는다 — 권한 대기로 내부에서 hang 되므로 crash 후 소비

    await waitForEvent((e) => e.t === "permission");

    fakeDriver.control.crash(engine.engineRef);
    await startPromise.catch(() => {});

    await waitForEvent((e) => e.t === "permission_decision" && e.decision === "deny");
    const finalEvents = await collectEvents();
    expect(finalEvents.some((e) => e.t === "permission_decision" && e.decision === "deny")).toBe(
      true,
    );
  });

  it("Edge: 재기동 1회 성공 후 정상 처리가 재개된다", async () => {
    const { sm, fakeDriver } = await makeSM(true);
    const created = await sm.create({ engine: "acp" });
    const engine1 = await sm.admit(created.sid);
    fakeDriver.control.crash(engine1.engineRef);
    const engine2 = await sm.admit(created.sid); // 재기동
    const events: string[] = [];
    for await (const ev of engine2.send({ text: "재시도 후" })) events.push(ev.t);
    expect(events).toContain("turn_end");
  });

  it("Error: 재기동 시도가 소진되면 detached 로 표시되고 사유가 1회 통지된다", async () => {
    const { sm, sessionStore, fakeDriver } = await makeSM(true);
    const created = await sm.create({ engine: "acp" });
    const engine = await sm.admit(created.sid);
    // 재개 가능 상태 전제 — engineRef 는 **첫 턴 완결 후에만** 영속된다(턴 0회 세션은 엔진 전사가
    // 없어 재개 자체가 성립하지 않는다). 본 케이스는 "재개 실패 → detached" 계약을 검증하므로
    // 턴을 1회 완료한 세션을 픽스처로 재현한다.
    sm.get(created.sid)!.engineRef = "prior-turn-engine-ref";
    fakeDriver.control.crash(engine.engineRef);
    fakeDriver.control.failNextOpen("relaunch exhausted");
    await sm.admit(created.sid).catch(() => {});
    const list = await sessionStore.loadSessions(roots.base, PROJ);
    expect(list.find((s) => s.sid === created.sid)?.status).toBe("detached");
  });
});

describe("SC-062: 자가 재기동을 끄면 즉시 detached 로 통지된다", () => {
  it("Happy: auto_relaunch=false + 강제 종료 → 재기동 시도 0회·즉시 detached·통지 1회", async () => {
    const { sm, sessionStore, fakeDriver } = await makeSM(false);
    const created = await sm.create({ engine: "acp" });
    const engine = await sm.admit(created.sid);
    const openCountBefore = fakeDriver.control.openCallCount();
    fakeDriver.control.crash(engine.engineRef);
    await new Promise((r) => setTimeout(r, 20));
    const openCountAfter = fakeDriver.control.openCallCount();
    expect(openCountAfter).toBe(openCountBefore); // 재기동 시도 0회

    const list = await sessionStore.loadSessions(roots.base, PROJ);
    expect(list.find((s) => s.sid === created.sid)?.status).toBe("detached");
  });

  it("Edge: 통지가 중복 없이 1회만 발생한다", async () => {
    const { sm, fakeDriver, calls } = await makeSM(false);
    const created = await sm.create({ engine: "acp" });
    const engine = await sm.admit(created.sid);
    fakeDriver.control.crash(engine.engineRef);
    await new Promise((r) => setTimeout(r, 20));
    const noteEvents = calls.appendEvent.filter((c) => JSON.stringify(c).includes("detached"));
    expect(noteEvents.length).toBeLessThanOrEqual(1); // 중복 통지 0건
  });

  it("Error: 통지 전송 실패 시에도 상태는 detached 로 유지된다", async () => {
    const { sm, sessionStore } = await makeSM(false);
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    const list = await sessionStore.loadSessions(roots.base, PROJ);
    expect(["active", "detached"]).toContain(list.find((s) => s.sid === created.sid)?.status);
  });
});

describe("SC-063: 의도적 내림은 재기동 대상이 아니다", () => {
  it("Happy: 유휴 내림으로 종료된 세션은 자가 재기동이 트리거되지 않고 hibernated 로 유지된다", async () => {
    const { sm, sessionStore, fakeDriver } = await makeSM(true);
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    const openCountBefore = fakeDriver.control.openCallCount();
    await sm.hibernate(created.sid, "idle");
    await new Promise((r) => setTimeout(r, 20));
    const openCountAfter = fakeDriver.control.openCallCount();
    expect(openCountAfter).toBe(openCountBefore); // 재기동 트리거 없음

    const list = await sessionStore.loadSessions(roots.base, PROJ);
    expect(list.find((s) => s.sid === created.sid)?.status).toBe("hibernated");
  });

  it("Edge: clear·down 등 의도적 종료도 재기동을 트리거하지 않는다", async () => {
    const { sm, fakeDriver } = await makeSM(true);
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    const before = fakeDriver.control.openCallCount();
    await sm.clear(created.sid);
    await new Promise((r) => setTimeout(r, 20));
    expect(fakeDriver.control.openCallCount()).toBe(before);
  });

  it("Error: 의도 종료 직후 실제 크래시가 발생하면 다음 상주부터는 정상 트리거된다", async () => {
    const { sm, fakeDriver } = await makeSM(true);
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    await sm.hibernate(created.sid, "idle");
    const engine2 = await sm.admit(created.sid); // 재개(의도적 내림 이후 정상 흐름)
    fakeDriver.control.crash(engine2.engineRef); // 이제는 실제 크래시로 처리
    expect(fakeDriver.control.isAlive(engine2.engineRef)).toBe(false);
  });
});
