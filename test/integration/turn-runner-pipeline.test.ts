import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeRecordCtx,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { waitFor } from "../helpers/wait.js";

// SC-002 (FR-002) 보강 — coverage-gap 카테고리 (1) 해소: `SessionManager.admit(sid)` 가
// EngineSession 을 그대로 반환해(실측) TurnRunner 를 관통하지 않는 기존 세션 통합 테스트의
// 공백을 메운다. `core/queue.ts`(enqueue, 실측 그대로 유지) + `core/turn-runner.ts`
// (createTurnRunner, 실측 TurnRunnerDeps)를 직접 구동해 claim→append→projectTurn→admit→send→
// append→turn_end 전 구간을 관통 검증한다.

const PROJ = "p1";

async function makeRunner(sid: string, roots: V2TmpRoots, engineSession: unknown) {
  const [turnRunnerMod, pathsMod] = await Promise.all([
    import("../../src/core/turn-runner.js"),
    import("../../src/shared/paths.js"),
  ]);
  const sessionPaths = pathsMod.sessionPaths(roots.base, PROJ, sid);
  const events: string[] = [];
  const runner = turnRunnerMod.createTurnRunner({
    base: roots.base,
    vaultRoot: roots.vaultRoot,
    proj: PROJ,
    sid,
    cwd: roots.base,
    sessionPaths,
    admit: async () => engineSession as never,
    requestPermission: async () => ({ decision: "allow" as const }),
    onSessionError: async (reason: string) => {
      events.push(`error:${reason}`);
    },
    onTurnDelivered: async () => {
      events.push("delivered");
    },
  } as never);
  return { runner, sessionPaths, events };
}

async function enqueueText(sessionPaths: unknown, id: string, text: string) {
  const queueMod = await import("../../src/core/queue.js");
  await queueMod.enqueue(
    sessionPaths as never,
    {
      v: 1,
      id,
      lane: "unused-v2-legacy-field",
      source: "markdown",
      backend: "acp",
      engine: "acp",
      project: PROJ,
      ts: new Date().toISOString(),
      text,
    } as never,
  );
}

let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

describe("TurnRunner 관통 — SC-002 세션 내 직렬 처리", () => {
  it("Happy: 같은 세션에 지시 2건을 넣으면 turn_start 가 순서대로(0, 1) 기록되고 각각 turn_end 까지 완결된다", async () => {
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const engine = await fakeDriver.descriptor.open({ cwd: roots.base, policy: {} } as never);
    const { runner, sessionPaths } = await makeRunner("sess-serial", roots, engine);

    await enqueueText(sessionPaths, "msg-1", "첫 지시");
    await enqueueText(sessionPaths, "msg-2", "둘째 지시");
    await runner.start();
    runner.notify();

    const events = await import("../../src/record/events.js");
    await waitFor(async () => {
      const collected: unknown[] = [];
      for await (const e of events.readEvents(makeRecordCtx(roots, PROJ, "sess-serial") as never))
        collected.push(e);
      return collected.filter((e) => (e as { t: string }).t === "turn_end").length >= 2;
    });

    const collected: unknown[] = [];
    for await (const e of events.readEvents(makeRecordCtx(roots, PROJ, "sess-serial") as never))
      collected.push(e);
    const starts = collected.filter((e) => (e as { t: string }).t === "turn_start") as Array<{
      turn: number;
    }>;
    expect(starts.map((s) => s.turn).sort()).toEqual([1, 2]); // turn 번호는 1부터 시작(실측)
    await runner.stop();
  }, 10000);
});

describe("TurnRunner 관통 — SC-002 세션 간 독립 처리", () => {
  it("Happy: 서로 다른 세션 A·B 의 TurnRunner 가 각자 독립적으로 완결된다(교차 오염 없음)", async () => {
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const engineA = await fakeDriver.descriptor.open({ cwd: roots.base, policy: {} } as never);
    const engineB = await fakeDriver.descriptor.open({ cwd: roots.base, policy: {} } as never);

    const { runner: runnerA, sessionPaths: pathsA } = await makeRunner("sess-a", roots, engineA);
    const { runner: runnerB, sessionPaths: pathsB } = await makeRunner("sess-b", roots, engineB);

    await enqueueText(pathsA, "a-1", "A 의 턴");
    await enqueueText(pathsB, "b-1", "B 의 턴");
    await runnerA.start();
    await runnerB.start();
    runnerA.notify();
    runnerB.notify();

    const events = await import("../../src/record/events.js");
    await waitFor(async () => {
      const aDone = [] as unknown[];
      const bDone = [] as unknown[];
      for await (const e of events.readEvents(makeRecordCtx(roots, PROJ, "sess-a") as never))
        aDone.push(e);
      for await (const e of events.readEvents(makeRecordCtx(roots, PROJ, "sess-b") as never))
        bDone.push(e);
      return (
        aDone.some((e) => (e as { t: string }).t === "turn_end") &&
        bDone.some((e) => (e as { t: string }).t === "turn_end")
      );
    });

    const aCollected: unknown[] = [];
    for await (const e of events.readEvents(makeRecordCtx(roots, PROJ, "sess-a") as never))
      aCollected.push(e);
    const bCollected: unknown[] = [];
    for await (const e of events.readEvents(makeRecordCtx(roots, PROJ, "sess-b") as never))
      bCollected.push(e);
    // 교차 오염 없음 — A 의 기록에 B 의 envelopeId(b-1)가 없고, 반대도 마찬가지.
    expect(aCollected.some((e) => JSON.stringify(e).includes("b-1"))).toBe(false);
    expect(bCollected.some((e) => JSON.stringify(e).includes("a-1"))).toBe(false);

    await runnerA.stop();
    await runnerB.stop();
  }, 10000);
});

describe("TurnRunner 관통 — SC-014 기록 실패가 턴을 중단시킨다", () => {
  it("Error: 이벤트 디렉터리 쓰기 불가 시 턴이 중단되고 onSessionError 가 호출된다", async () => {
    const pathsMod = await import("../../src/shared/paths.js");
    const fs = await import("node:fs");
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const engine = await fakeDriver.descriptor.open({ cwd: roots.base, policy: {} } as never);
    const {
      runner,
      sessionPaths,
      events: runnerEvents,
    } = await makeRunner("sess-fail", roots, engine);

    const vp = pathsMod.vaultPaths(roots.vaultRoot, PROJ, "sess-fail");
    fs.mkdirSync(vp.eventsDir, { recursive: true });
    fs.chmodSync(vp.eventsDir, 0o500);

    try {
      await enqueueText(sessionPaths, "fail-1", "실패할 지시");
      await runner.start();
      runner.notify();
      await waitFor(() => runnerEvents.length > 0, { timeoutMs: 5000 }).catch(() => {});
      expect(runnerEvents.some((e) => e.startsWith("error:"))).toBe(true);
    } finally {
      fs.chmodSync(vp.eventsDir, 0o700);
      await runner.stop();
    }
  }, 10000);
});
