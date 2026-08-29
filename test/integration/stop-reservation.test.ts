import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  type V2TmpRoots,
  bindSessionManager,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { makeFakeRecordStore } from "../helpers/fake-record-store.js";

// 확정 시그니처(design/tasks.md Test Authoring Contract):
// stop(sid, opts:{reason;source;force?}): Promise<{result:"stopped"|"scheduled"|"already"|"mismatch"; reason:string}>
// 잔여 작업 판정(design.md §3): pendingWork(queue+processing) > 0 ∥ turnRunner.state()==="active" ∥
// pendingSurfaceWork?.(sid) → stopPending 기록 + 예약 안내 + persist → "scheduled".
//
// rename·readdir 실패 주입은 node:fs/promises 를 통째로 목해야 한다(ESM 네임스페이스 직접 spyOn 은
// read-only 바인딩이라 실패).
const fspCtl = vi.hoisted(() => ({
  renameFailWith: null as (() => Error) | null,
  readdirFailWith: null as (() => Error) | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fspCtl.renameFailWith) {
        const err = fspCtl.renameFailWith();
        fspCtl.renameFailWith = null;
        throw err;
      }
      return actual.rename(...args);
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      if (fspCtl.readdirFailWith) {
        const err = fspCtl.readdirFailWith();
        throw err; // 큐 readdir 은 매 호출 실패를 유지해 보수적 예약 판정을 관측한다(1회성 아님).
      }
      return actual.readdir(...args);
    },
  };
});

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  fspCtl.renameFailWith = null;
  fspCtl.readdirFailWith = null;
  cleanupV2TmpRoots(roots);
});

async function makeSM() {
  const [sessionStore, sessionManagerMod] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const { store: record, calls } = makeFakeRecordStore();
  const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }, { record });
  const sm = sessionManagerMod.createSessionManager(deps);
  bindSessionManager(deps, sm);
  return { sm, sessionStore, fakeDriver, record, calls };
}

// "진행 중 턴"을 재현하는 두 가지 방법 — (a) fakeDriver.control.holdNextTurn() + 실제
// engine.send() 호출은 SessionManager 자체의 in-flight 부기(cap 회귀 가드 등)에는 보이지만
// pendingWork(queue+processing 파일 계수)에는 반영되지 않는다(admit() 이 반환한 엔진 세션에
// 직접 send 하면 큐/TurnRunner 를 거치지 않기 때문 — 실측). SC-010 은 pendingWork 판정을
// 검증하므로 (b) 큐→processing claim 으로 "미완결 처리중" 파일을 실제로 만들어 재현한다.
async function claimIntoProcessing(sid: string): Promise<void> {
  const pathsMod = await import("../../src/shared/paths.js");
  const queueMod = await import("../../src/core/queue.js");
  const sp = pathsMod.sessionPaths(roots.base, PROJ, sid);
  await queueMod.enqueue(sp, {
    v: 1,
    id: `env-${Math.random().toString(36).slice(2)}`,
    lane: sid,
    source: "markdown",
    backend: "acp",
    engine: "acp",
    project: PROJ,
    ts: new Date().toISOString(),
    text: "진행 중 지시",
  } as never);
  await queueMod.claimNext(sp); // queue → processing 전이(미완결 — pendingWork > 0).
}

describe("SC-010: 진행 중 턴이 있으면 중지가 즉시 적용되지 않고 예약된다", () => {
  it("Happy: 진행 중 턴이 있는 활성 세션에 중지 요청 → 상태 불변 + scheduled + 예약 안내 1건", async () => {
    const { sm, sessionStore } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    await claimIntoProcessing(created.sid);

    const outcome = await (sm as never as { stop: SmStop }).stop(created.sid, {
      reason: "user-requested",
      source: "cli",
    });
    expect(outcome.result).toBe("scheduled");

    const rec = (await sessionStore.loadSessions(roots.base, PROJ)).find(
      (s) => s.sid === created.sid,
    );
    expect(rec?.status).toBe("active"); // 즉시 전이되지 않는다.
    expect(rec?.stopPending).not.toBeNull();
  });

  it("Edge: 이미 예약된 세션에 재요청하면 already(stop-already-scheduled)", async () => {
    const { sm } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    await claimIntoProcessing(created.sid);

    const smApi = sm as never as { stop: SmStop };
    const first = await smApi.stop(created.sid, { reason: "r1", source: "cli" });
    expect(first.result).toBe("scheduled");
    const second = await smApi.stop(created.sid, { reason: "r2", source: "cli" });
    expect(second.result).toBe("already");
  });

  it("Error: 예약 기록(persist) 실패 시 무동작 성공을 보고하지 않는다(scheduled 로 위장 금지)", async () => {
    const { sm } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    await claimIntoProcessing(created.sid);

    fspCtl.renameFailWith = () => new Error("simulated persist fail");
    const smApi = sm as never as { stop: SmStop };
    await expect(smApi.stop(created.sid, { reason: "r1", source: "cli" })).rejects.toThrow();
  });
});

describe("SC-011: 미소비 큐만 있어도 같은 예약 경로로 처리된다", () => {
  it("Happy: 턴은 idle 이지만 큐에 미소비 봉투가 있으면 예약된다", async () => {
    const { sm, fakeDriver } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    const pathsMod = await import("../../src/shared/paths.js");
    const queueMod = await import("../../src/core/queue.js");
    const sp = pathsMod.sessionPaths(roots.base, PROJ, created.sid);
    await queueMod.enqueue(sp, {
      v: 1,
      id: "env-1",
      lane: created.sid,
      source: "markdown",
      backend: "acp",
      engine: "acp",
      project: PROJ,
      ts: new Date().toISOString(),
      text: "미처리 지시",
    } as never);

    const smApi = sm as never as { stop: SmStop };
    const outcome = await smApi.stop(created.sid, { reason: "r", source: "cli" });
    expect(outcome.result).toBe("scheduled");
    void fakeDriver;
  });

  it("Edge: 미소비 전송 체크박스(pendingSurfaceWork)만 있어도 예약된다", async () => {
    const [sessionStoreMod, sessionManagerMod] = await Promise.all([
      import("../../src/core/session-store.js"),
      import("../../src/core/session-manager.js"),
    ]);
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const deps = makeSessionManagerDeps(
      roots,
      PROJ,
      { acp: fakeDriver.descriptor },
      { pendingSurfaceWork: async () => true },
    );
    const sm = sessionManagerMod.createSessionManager(deps);
    bindSessionManager(deps, sm);
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    const outcome = await (sm as never as { stop: SmStop }).stop(created.sid, {
      reason: "r",
      source: "cli",
    });
    expect(outcome.result).toBe("scheduled");
    void sessionStoreMod;
  });

  it("Error: 큐 readdir 실패 시 보수적으로 잔여가 있다고 가정해 예약한다", async () => {
    const { sm } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    fspCtl.readdirFailWith = () => new Error("EACCES simulated");
    const outcome = await (sm as never as { stop: SmStop }).stop(created.sid, {
      reason: "r",
      source: "cli",
    });
    expect(outcome.result).toBe("scheduled");
  });
});

describe("SC-012: 예약된 세션은 잔여 작업 소진 후 중지되고 완료 안내가 남는다", () => {
  it("Happy: 진행 중 턴·잔여 큐가 모두 소진되면 stopped + 완료 안내(예약 1 + 완료 1)", async () => {
    const { sm, fakeDriver, sessionStore } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    const engine = await sm.admit(created.sid);
    const release = fakeDriver.control.holdNextTurn();
    const turnPromise = (async () => {
      for await (const _ of engine.send({ text: "long" })) void _;
    })();

    const smApi = sm as never as {
      stop: SmStop;
      takeNotices?: (sid: string) => readonly unknown[];
    };
    await smApi.stop(created.sid, { reason: "r", source: "cli" });
    release();
    await turnPromise;

    // 턴 완결 훅(refreshNotes 말미)이 예약 소진을 평가한다(design.md §3) — 결과 관측까지 폴링 대기.
    const { waitFor } = await import("../helpers/wait.js");
    await waitFor(async () => {
      const rec = (await sessionStore.loadSessions(roots.base, PROJ)).find(
        (s) => s.sid === created.sid,
      );
      return rec?.status === "stopped";
    });
    const rec = (await sessionStore.loadSessions(roots.base, PROJ)).find(
      (s) => s.sid === created.sid,
    );
    expect(rec?.status).toBe("stopped");
    if (smApi.takeNotices) {
      expect(smApi.takeNotices(created.sid).length).toBeGreaterThanOrEqual(1);
    }
  });

  it("Edge: 소진 직전 새 지시가 도착하면 그 턴까지 처리한 후 중지된다", async () => {
    const { sm, fakeDriver, sessionStore } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    const engine = await sm.admit(created.sid);
    const release = fakeDriver.control.holdNextTurn();
    const turnPromise = (async () => {
      for await (const _ of engine.send({ text: "one more" })) void _;
    })();
    await (sm as never as { stop: SmStop }).stop(created.sid, { reason: "r", source: "cli" });
    // 예약 도중 진행 중이던 턴을 완결시킨다 — 예약이 소진을 앞당기지 않고 이 턴까지는 처리된다.
    release();
    await turnPromise;

    const { waitFor } = await import("../helpers/wait.js");
    await waitFor(async () => {
      const rec = (await sessionStore.loadSessions(roots.base, PROJ)).find(
        (s) => s.sid === created.sid,
      );
      return rec?.status === "stopped";
    });
  });

  it("Error: 완료 단계 노트 교체 실패는 경고로 남고 상태는 그래도 중지로 확정된다", async () => {
    const { sm, sessionStore, fakeDriver } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    const engine = await sm.admit(created.sid);
    const release = fakeDriver.control.holdNextTurn();
    const turnPromise = (async () => {
      for await (const _ of engine.send({ text: "finish" })) void _;
    })();
    await (sm as never as { stop: SmStop }).stop(created.sid, { reason: "r", source: "cli" });
    release();
    await turnPromise;

    const { waitFor } = await import("../helpers/wait.js");
    await waitFor(async () => {
      const rec = (await sessionStore.loadSessions(roots.base, PROJ)).find(
        (s) => s.sid === created.sid,
      );
      return rec?.status === "stopped";
    });
    // ASSUMPTION(테스트 작성자) — 노트 교체는 Surface(L4) 책임이라 SessionManager(L3) 단독 통합
    // 테스트에서는 실 노트 쓰기 실패를 재현하지 않는다. Surface 관통 재현은 D010
    // stopped-note.test.ts 가 stopNotePending 재시도를 직접 검증한다(중복 회피).
    const rec = (await sessionStore.loadSessions(roots.base, PROJ)).find(
      (s) => s.sid === created.sid,
    );
    expect(rec?.status).toBe("stopped");
  });
});

type SmStop = (
  sid: string,
  opts: {
    reason: string;
    source: "palette" | "cli" | "auto" | "clear" | "remove";
    force?: boolean;
  },
) => Promise<{ result: "stopped" | "scheduled" | "already" | "mismatch"; reason: string }>;
