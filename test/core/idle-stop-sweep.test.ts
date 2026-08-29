import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  type V2TmpRoots,
  bindSessionManager,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { makeFakeRecordStore } from "../helpers/fake-record-store.js";
import { makeFakeClock } from "../helpers/fake-clock.js";
import { makeManualScheduler } from "../helpers/manual-scheduler.js";
import { waitFor } from "../helpers/wait.js";

// design.md §2 전이표 T2·ADR-014 — runIdleSweep 은 (내부 비공개 함수) 단일 분기에서 중지 조건을
// 유휴 조건보다 **먼저** 평가한다. 실시간 60초 타이머를 기다리지 않고 makeManualScheduler() 로
// 내부 setInterval 콜백을 결정론적으로 1틱 트리거해 관통 검증한다(fake-clock.ts 의 scheduler 주입
// 관례와 동형). 개별 SC 는 design.md §SC별 시나리오 매핑 표를 SoT 로 삼는다.

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function makeSM(confOverrides: Record<string, unknown> = {}) {
  const [sessionStore, sessionManagerMod] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const { store: record, calls } = makeFakeRecordStore();
  const clock = makeFakeClock();
  const scheduler = makeManualScheduler();
  const deps = makeSessionManagerDeps(
    roots,
    PROJ,
    { acp: fakeDriver.descriptor },
    {
      clock: { now: () => clock.nowMs() },
      scheduler,
      conf: {
        idle_hibernate: true,
        hibernate_after_min: 30,
        idle_stop: true,
        stop_after_min: 60,
        ...confOverrides,
      },
      record,
    },
  );
  const sm = sessionManagerMod.createSessionManager(deps);
  bindSessionManager(deps, sm);
  return { sm, sessionStore, fakeDriver, record, calls, clock, scheduler };
}

// idleTimer 콜백은 프로덕션에서 fire-and-forget(`void runIdleSweep()`)이라 scheduler.fireAll()
// 직후 곧바로 레코드를 읽으면 스윕의 비동기 persist 가 아직 반영되지 않은 상태를 관측하는 경합이
// 생긴다(waitFor 매체 폴링 관례 — design.md §테스트 전략). 목표 상태가 될 때까지 폴링한다.
async function waitForStatus(
  sessionStore: {
    loadSessions: (base: string, proj: string) => Promise<Array<{ sid: string; status: string }>>;
  },
  base: string,
  sid: string,
  status: string,
): Promise<{ sid: string; status: string; [k: string]: unknown } | undefined> {
  await waitFor(async () => {
    const rec = (await sessionStore.loadSessions(base, PROJ)).find((s) => s.sid === sid);
    return rec?.status === status;
  });
  return (await sessionStore.loadSessions(base, PROJ)).find((s) => s.sid === sid) as never;
}

describe("SC-006: 무활동 61분 경과 세션이 자동 중지되고 사유가 남는다", () => {
  it("Happy: 유휴 30·중지 60, 61분 경과 → stopped + 사유 inactive", async () => {
    const { sm, sessionStore, clock, scheduler } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    clock.advanceMinutes(61);
    scheduler.fireAll();

    const rec = await waitForStatus(sessionStore, roots.base, created.sid, "stopped");
    expect(rec?.status).toBe("stopped");
    // ASSUMPTION(테스트 작성자) — 사유 문자열의 정확 리터럴은 design.md §13 안내 지점 3 이
    // "reason=inactive" 로만 지정한다. 정확 표기가 다르면 development 가 runs/pipeline-log 로
    // 동기화한다(PPG-1 2차 방어).
    expect(rec?.stopReason ?? "").toMatch(/inactive|무활동/);
  });

  it("Edge: 59분59초 경과는 아직 중지 대상이 아니다(유휴로만 전이될 수 있다)", async () => {
    const { sm, sessionStore, clock, scheduler } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    clock.advanceMs(59 * 60_000 + 59_000);
    scheduler.fireAll();

    const rec = (await sessionStore.loadSessions(roots.base, PROJ)).find(
      (s) => s.sid === created.sid,
    );
    expect(rec?.status).not.toBe("stopped");
  });

  it("Error: 중지 적용 중 엔진 close 실패 → error 이벤트를 남기고 상태는 그래도 stopped 로 전이한다", async () => {
    const { sm, clock, scheduler, sessionStore, calls } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    const engine = await sm.admit(created.sid);
    engine.close = async () => {
      throw new Error("close failed");
    };
    clock.advanceMinutes(61);
    scheduler.fireAll();

    const rec = await waitForStatus(sessionStore, roots.base, created.sid, "stopped");
    expect(rec?.status).toBe("stopped"); // close 실패해도 슬롯은 비우고 상태 전이는 완결한다(hibernate 관행 승계).
    expect(calls.appendEvent.some((c: unknown) => JSON.stringify(c).includes("error"))).toBe(true);
  });
});

describe("SC-007: 중지 임계가 유휴 임계 이하이면 유휴를 건너뛰고 곧바로 중지된다", () => {
  it("Happy: 중지 20·유휴 30, 21분 경과 → 유휴 임계(30) 미도달 상태에서 곧바로 stopped", async () => {
    const { sm, sessionStore, clock, scheduler } = await makeSM({
      stop_after_min: 20,
      hibernate_after_min: 30,
    });
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    clock.advanceMinutes(21);
    scheduler.fireAll();

    const rec = await waitForStatus(sessionStore, roots.base, created.sid, "stopped");
    expect(rec?.status).toBe("stopped");
  });

  it("Edge: 두 임계가 동일(30=30)이면 중지가 우선한다(hibernated 로 남지 않는다)", async () => {
    const { sm, sessionStore, clock, scheduler } = await makeSM({
      stop_after_min: 30,
      hibernate_after_min: 30,
    });
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    clock.advanceMinutes(31);
    scheduler.fireAll();

    const rec = await waitForStatus(sessionStore, roots.base, created.sid, "stopped");
    expect(rec?.status).toBe("stopped");
  });

  it("Error: stop_after_min 무효값은 기본값(60)으로 폴백해 정상 동작을 유지한다", async () => {
    const conf = await import("../../src/shared/conf.js");
    const parsed = conf.parseProjectConf(`v=1\nvault=${roots.vaultRoot}\nstop_after_min=abc\n`);
    expect(parsed.stop_after_min).toBe(conf.DEFAULT_STOP_AFTER_MIN); // 파서 폴백 확인(전제)
    const { sm, sessionStore, clock, scheduler } = await makeSM({
      stop_after_min: parsed.stop_after_min,
    });
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    clock.advanceMinutes(conf.DEFAULT_STOP_AFTER_MIN + 1);
    scheduler.fireAll();

    const rec = await waitForStatus(sessionStore, roots.base, created.sid, "stopped");
    expect(rec?.status).toBe("stopped"); // 무효값이 스윕을 영구 무력화하지 않는다.
  });
});

describe("SC-009: 자동 중지가 꺼져 있으면 어떤 세션도 중지되지 않는다(유휴 전이는 그대로 동작)", () => {
  it("Happy: idle_stop=false + 중지 임계를 훨씬 넘겨도 중지 0건, 유휴는 계속 동작한다", async () => {
    const { sm, sessionStore, clock, scheduler } = await makeSM({
      idle_stop: false,
      hibernate_after_min: 30,
      stop_after_min: 60,
    });
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    clock.advanceMinutes(200);
    scheduler.fireAll();

    const rec = await waitForStatus(sessionStore, roots.base, created.sid, "hibernated");
    expect(rec?.status).toBe("hibernated"); // 유휴는 옵트아웃 대상이 아니다 — 중지만 꺼진다.
  });

  it("Edge: 중지 임계를 매우 작게 잡아도(1분) idle_stop=false 면 여전히 중지되지 않는다", async () => {
    const { sm, sessionStore, clock, scheduler } = await makeSM({
      idle_stop: false,
      stop_after_min: 1,
      hibernate_after_min: 30,
    });
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    clock.advanceMinutes(2);
    scheduler.fireAll();

    const rec = (await sessionStore.loadSessions(roots.base, PROJ)).find(
      (s) => s.sid === created.sid,
    );
    expect(rec?.status).not.toBe("stopped");
  });

  it("Error: idle_stop 무효값은 기본 켬(true)으로 해석되어 중지가 정상 동작한다", async () => {
    const conf = await import("../../src/shared/conf.js");
    // parseBoolDefaultOn: 명시 "false" 만 OFF — 그 외 무효값은 전부 ON.
    const parsed = conf.parseProjectConf(`v=1\nvault=${roots.vaultRoot}\nidle_stop=notabool\n`);
    expect(parsed.idle_stop).toBe(true);
    const { sm, sessionStore, clock, scheduler } = await makeSM({ idle_stop: parsed.idle_stop });
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    clock.advanceMinutes(61);
    scheduler.fireAll();

    const rec = await waitForStatus(sessionStore, roots.base, created.sid, "stopped");
    expect(rec?.status).toBe("stopped");
  });
});
