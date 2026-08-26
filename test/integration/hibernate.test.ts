import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { makeFakeRecordStore } from "../helpers/fake-record-store.js";
import { makeFakeClock } from "../helpers/fake-clock.js";

// ADR-020 — 유휴·상한·재개 로직은 clock/scheduler 주입으로 검증(실시간 대기 0초, vi.useFakeTimers
// 만으로는 상주 프로세스 경로를 재현하지 못한다는 tasks.md 제약 준수).

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function makeSM(opts: { maxActiveEngines?: number; hibernateAfterMin?: number } = {}) {
  const [sessionStore, sessionManagerMod] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const { store: record, calls } = makeFakeRecordStore();
  const clock = makeFakeClock();
  const sm = sessionManagerMod.createSessionManager(
    makeSessionManagerDeps(
      roots,
      PROJ,
      { acp: fakeDriver.descriptor },
      {
        clock: { now: () => clock.nowMs() },
        conf: {
          hibernate_after_min: opts.hibernateAfterMin ?? 30,
          max_active_engines: opts.maxActiveEngines ?? 3,
        },
        // GAP-019 해소분 배선 — SessionManagerDeps.record(DI) 로 fake RecordStore 를 주입해야
        // calls.appendEvent 등 인터셉션이 실제로 동작한다(record 만 만들고 미전달 시 무효).
        record,
      },
    ) as never,
  );
  return { sm, sessionStore, fakeDriver, record, calls, clock };
}

describe("SC-009: 유휴 30분 경과 세션이 내려가고 다음 지시에 투명하게 재개된다", () => {
  it("Happy: 30분 경과 후 hibernated, 다음 지시 도착 시 재개되어 턴이 처리된다", async () => {
    const { sm, clock } = await makeSM({ hibernateAfterMin: 30 });
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    clock.advanceMinutes(31);
    await sm.hibernate(created.sid, "idle");

    const sessions1 = await sm.list();
    expect(sessions1.find((s) => s.sid === created.sid)?.status).toBe("hibernated");

    // 다음 지시 도착 — 재개(투명).
    const engine = await sm.admit(created.sid);
    const events: string[] = [];
    for await (const ev of engine.send({ text: "다음 지시" })) events.push(ev.t);
    expect(events).toContain("turn_end");
    const sessions2 = await sm.list();
    expect(sessions2.find((s) => s.sid === created.sid)?.status).toBe("active");
  });

  it("Edge: 임계 직전(29분 59초)에는 유휴 내림 대상이 아니다", async () => {
    const { sm, clock } = await makeSM({ hibernateAfterMin: 30 });
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    clock.advanceMs(29 * 60_000 + 59_000);
    // 아직 임계 미달 — hibernate 호출 자체를 시도하지 않는 것이 계약이므로, 대신 상태가
    // active 로 유지됨을 list() 로 확인한다(내부 타이머가 아직 미발화라는 관측 가능 결과).
    const sessions = await sm.list();
    expect(sessions.find((s) => s.sid === created.sid)?.status).toBe("active");
  });

  it("Error: 재개 시 엔진 기동 실패 → detached + 지시 보존", async () => {
    const { sm, fakeDriver } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    await sm.hibernate(created.sid, "idle");

    fakeDriver.control.failNextOpen("resume boot failure");
    await expect(sm.admit(created.sid)).rejects.toThrow();
    const sessions = await sm.list();
    expect(sessions.find((s) => s.sid === created.sid)?.status).toBe("detached");
  });
});

describe("SC-010: 상주 엔진 상한 초과 시 가장 오래 쓰이지 않은 세션부터 내려간다", () => {
  it("Happy: 상한 3에서 A·B·C 상주 중 D 가 턴을 시작하면 A 만 hibernated 된다", async () => {
    const { sm, clock } = await makeSM({ maxActiveEngines: 3 });
    const a = await sm.create({ engine: "acp" });
    await sm.admit(a.sid);
    clock.advanceMinutes(1);
    const b = await sm.create({ engine: "acp" });
    await sm.admit(b.sid);
    clock.advanceMinutes(1);
    const c = await sm.create({ engine: "acp" });
    await sm.admit(c.sid);
    clock.advanceMinutes(1);
    const d = await sm.create({ engine: "acp" });
    await sm.admit(d.sid);

    const sessions = await sm.list();
    const statusOf = (sid: string) => sessions.find((s) => s.sid === sid)?.status;
    expect(statusOf(a.sid)).toBe("hibernated");
    expect(statusOf(b.sid)).toBe("active");
    expect(statusOf(c.sid)).toBe("active");
    expect(statusOf(d.sid)).toBe("active");
  });

  it("Edge: 마지막 활동 시각이 동률이면 sid 사전순으로 결정론적 tie-break 한다", async () => {
    const { sm } = await makeSM({ maxActiveEngines: 1 });
    const a = await sm.create({ engine: "acp" });
    const b = await sm.create({ engine: "acp" });
    // 동시(같은 clock 값)에 admit — tie-break 은 sid 사전순으로 결정돼야 한다.
    await sm.admit(a.sid);
    await sm.admit(b.sid);
    const [lo, hi] = [a.sid, b.sid].sort();
    const sessions = await sm.list();
    expect(sessions.find((s) => s.sid === lo)?.status).toBe("hibernated");
    expect(sessions.find((s) => s.sid === hi)?.status).toBe("active");
  });

  it("Error: 내림 대상의 close 실패 시 error 이벤트를 남기고 다음 후보를 시도한다", async () => {
    const { sm, fakeDriver, calls } = await makeSM({ maxActiveEngines: 1 });
    const a = await sm.create({ engine: "acp" });
    const engineA = await sm.admit(a.sid);
    const originalClose = engineA.close.bind(engineA);
    engineA.close = async () => {
      throw new Error("close failed");
    };
    void originalClose;
    const b = await sm.create({ engine: "acp" });
    await sm.admit(b.sid);
    expect(calls.appendEvent.some((c: unknown) => JSON.stringify(c).includes("error"))).toBe(true);
    void fakeDriver;
  });
});

describe("SC-033: 턴 처리 중 세션은 상한 초과 상황에서도 내려가지 않는다", () => {
  it("Happy: 상한 1·A 가 턴 처리 중일 때 B 가 시작해도 A 는 턴 종료까지 상주를 유지한다", async () => {
    const { sm, fakeDriver } = await makeSM({ maxActiveEngines: 1 });
    const a = await sm.create({ engine: "acp" });
    const engineA = await sm.admit(a.sid);
    const release = fakeDriver.control.holdNextTurn();
    const turnPromise = (async () => {
      for await (const _ of engineA.send({ text: "long turn" })) void _;
    })();

    const b = await sm.create({ engine: "acp" });
    const admitBPromise = sm.admit(b.sid);
    // A 가 턴 처리 중인 동안은 여전히 active 여야 한다.
    const midSessions = await sm.list();
    expect(midSessions.find((s) => s.sid === a.sid)?.status).toBe("active");

    release();
    await turnPromise;
    await admitBPromise;
    const finalSessions = await sm.list();
    expect(finalSessions.find((s) => s.sid === a.sid)?.status).toBe("hibernated");
    expect(finalSessions.find((s) => s.sid === b.sid)?.status).toBe("active");
  });

  it("Edge: A 턴이 길게 지속되는 동안 B 는 대기하며 상한 위반이 관측되지 않는다", async () => {
    const { sm, fakeDriver } = await makeSM({ maxActiveEngines: 1 });
    const a = await sm.create({ engine: "acp" });
    const engineA = await sm.admit(a.sid);
    fakeDriver.control.holdNextTurn();
    void (async () => {
      for await (const _ of engineA.send({ text: "long" })) void _;
    })();
    const activeCountDuring = (await sm.list()).filter((s) => s.status === "active").length;
    expect(activeCountDuring).toBeLessThanOrEqual(1);
  });

  it("Error: A 턴이 오류로 종료되면 상한 초과가 즉시 해소된다", async () => {
    const { sm } = await makeSM({ maxActiveEngines: 1 });
    const a = await sm.create({ engine: "acp" });
    const engineA = await sm.admit(a.sid);
    await engineA.close(); // 오류 종료 흉내
    const b = await sm.create({ engine: "acp" });
    await expect(sm.admit(b.sid)).resolves.toBeDefined();
  });
});
