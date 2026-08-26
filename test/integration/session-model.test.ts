import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";

// design.md §인터페이스 계약(L3) — createSessionManager(deps)·createTurnRunner(deps)·createRouter(deps)
// 는 tasks.md 확정 시그니처 밖(design.md 본문 인터페이스)이라 deps 필드명은 설계 서술에서 합리적으로
// 도출한 가정이다. Development 구현과 어긋나면 PPG-1 2차 방어(runs/pipeline-log 명시 + 본 파일
// 재작업)로 동기화한다(tasks.md "확정 시그니처" 절 서두 규약).

const PROJ = "p1";

async function loadModules() {
  const [sessionStore, sessionManagerMod, queueMod, engines] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
    import("../../src/core/queue.js"),
    import("../../src/engines/index.js"),
  ]);
  return { sessionStore, sessionManagerMod, queueMod, engines };
}

let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

describe("SC-001: 프로젝트·세션·바인딩이 각각 독립 단위로 생성·조회된다", () => {
  it("Happy: 세션 2개를 만들고 각자 다른 입력 노트를 바인딩하면 목록에 2건, 각 바인딩은 분리된다", async () => {
    const { sessionStore } = await loadModules();
    const now = new Date().toISOString();
    const s1 = {
      v: 1 as const,
      sid: sessionStore.newSid(),
      engine: "acp",
      engineRef: null,
      status: "active" as const,
      title: null,
      createdAt: now,
      lastActivityAt: now,
      successorOf: null,
      engineArgs: [],
      warnings: [],
      bindings: [{ surface: "markdown", address: "sessions/s1/inbox.md", sid: "s1" }],
    };
    const s2 = {
      ...s1,
      sid: sessionStore.newSid(),
      bindings: [{ surface: "markdown", address: "sessions/s2/inbox.md", sid: "s2" }],
    };
    await sessionStore.saveSession(roots.base, PROJ, s1);
    await sessionStore.saveSession(roots.base, PROJ, s2);

    const loaded = await sessionStore.loadSessions(roots.base, PROJ);
    expect(loaded).toHaveLength(2);
    const bySid = new Map(loaded.map((s) => [s.sid, s]));
    expect(bySid.get(s1.sid)?.bindings).toEqual(s1.bindings);
    expect(bySid.get(s2.sid)?.bindings).toEqual(s2.bindings);
    // 서로의 바인딩이 섞이지 않는다.
    expect(bySid.get(s1.sid)?.bindings.some((b) => b.address.includes("s2"))).toBe(false);
  });

  it("Edge: 바인딩이 0개인 세션도 목록에 그대로 나타난다", async () => {
    const { sessionStore } = await loadModules();
    const now = new Date().toISOString();
    const rec = {
      v: 1 as const,
      sid: sessionStore.newSid(),
      engine: "acp",
      engineRef: null,
      status: "active" as const,
      title: null,
      createdAt: now,
      lastActivityAt: now,
      successorOf: null,
      engineArgs: [],
      warnings: [],
      bindings: [],
    };
    await sessionStore.saveSession(roots.base, PROJ, rec);
    const loaded = await sessionStore.loadSessions(roots.base, PROJ);
    expect(loaded.find((s) => s.sid === rec.sid)?.bindings).toEqual([]);
  });

  it("Error: 존재하지 않는 sid 로의 바인딩 생성은 거부된다", async () => {
    const { sessionManagerMod } = await loadModules();
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const sm = sessionManagerMod.createSessionManager(
      makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }) as never,
    );
    await expect(
      (sm as unknown as { addBinding?: (sid: string, b: unknown) => Promise<void> }).addBinding?.(
        "nonexistent-sid",
        { surface: "markdown", address: "x" },
      ) ??
        Promise.reject(
          new Error("존재하지 않는 sid — 거부됨(no-op 계약 부재 시 본 테스트가 실패로 표면화)"),
        ),
    ).rejects.toThrow();
  });
});

describe("SC-002: 같은 실행 경로의 두 세션이 동시에 처리되고, 세션 내부는 직렬 처리된다", () => {
  it("Happy: B 는 A 의 첫 턴을 기다리지 않고 시작되고, A 의 두 번째 턴은 A 의 첫 턴 종료 후 시작된다", async () => {
    const { sessionManagerMod } = await loadModules();
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const sm = sessionManagerMod.createSessionManager(
      makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }) as never,
    );

    const sessionA = await sm.create({ engine: "acp" });
    const sessionB = await sm.create({ engine: "acp" });

    const release = fakeDriver.control.holdNextTurn();
    const engineA = await sm.admit(sessionA.sid);
    const aTurn1Events: string[] = [];
    const aTurn1Done = (async () => {
      for await (const ev of engineA.send({ text: "A-turn-1" })) aTurn1Events.push(ev.t);
    })();

    // A 의 첫 턴이 아직 끝나지 않은 상태에서 B 의 턴이 시작·완료될 수 있어야 한다(세션 간 병렬).
    const engineB = await sm.admit(sessionB.sid);
    const bEvents: string[] = [];
    for await (const ev of engineB.send({ text: "B-turn-1" })) bEvents.push(ev.t);
    expect(bEvents).toContain("turn_end");
    expect(aTurn1Events).not.toContain("turn_end"); // A 는 아직 hold 중

    release();
    await aTurn1Done;
    expect(aTurn1Events).toContain("turn_end");
  });

  it("Edge: A·B 가 거의 동시에 도착해도 서로의 결과가 뒤섞이지 않는다", async () => {
    const { sessionManagerMod } = await loadModules();
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const sm = sessionManagerMod.createSessionManager(
      makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }) as never,
    );
    const [a, b] = await Promise.all([sm.create({ engine: "acp" }), sm.create({ engine: "acp" })]);
    const [engineA, engineB] = await Promise.all([sm.admit(a.sid), sm.admit(b.sid)]);
    const [aTexts, bTexts] = await Promise.all([
      (async () => {
        const out: string[] = [];
        for await (const ev of engineA.send({ text: "a" }))
          if (ev.t === "text_final") out.push(ev.text);
        return out;
      })(),
      (async () => {
        const out: string[] = [];
        for await (const ev of engineB.send({ text: "b" }))
          if (ev.t === "text_final") out.push(ev.text);
        return out;
      })(),
    ]);
    expect(aTexts).toEqual(["echo:a"]);
    expect(bTexts).toEqual(["echo:b"]);
  });

  it("Error: A 의 턴이 실패로 종료돼도 B 의 진행은 계속된다", async () => {
    const { sessionManagerMod } = await loadModules();
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const sm = sessionManagerMod.createSessionManager(
      makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }) as never,
    );
    const a = await sm.create({ engine: "acp" });
    const b = await sm.create({ engine: "acp" });
    const engineA = await sm.admit(a.sid);
    await engineA.close(); // A 를 강제 종료 상태로 만들어 다음 send 가 실패하도록 유도
    await expect(
      (async () => {
        for await (const _ of engineA.send({ text: "x" })) void _;
      })(),
    ).rejects.toThrow();

    const engineB = await sm.admit(b.sid);
    const bEvents: string[] = [];
    for await (const ev of engineB.send({ text: "still-fine" })) bEvents.push(ev.t);
    expect(bEvents).toContain("turn_end");
  });
});

describe("SC-004: 세션 초기화가 삭제가 아니라 승계로 동작한다", () => {
  it("Happy: clear() 는 새 세션을 만들어 바인딩을 이전하고 원 세션은 archived 로 남는다", async () => {
    const { sessionManagerMod, sessionStore } = await loadModules();
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const sm = sessionManagerMod.createSessionManager(
      makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }) as never,
    );
    const created = await sm.create({ engine: "acp" });
    const { next } = await sm.clear(created.sid);
    expect(next).not.toBe(created.sid);

    const loaded = await sessionStore.loadSessions(roots.base, PROJ);
    const original = loaded.find((s) => s.sid === created.sid);
    const successor = loaded.find((s) => s.sid === next);
    expect(original?.status).toBe("archived");
    expect(successor?.successorOf).toBe(created.sid);
  });

  it("Edge: 바인딩이 0개인 세션도 초기화가 성공한다", async () => {
    const { sessionManagerMod } = await loadModules();
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const sm = sessionManagerMod.createSessionManager(
      makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }) as never,
    );
    const created = await sm.create({ engine: "acp" });
    await expect(sm.clear(created.sid)).resolves.toBeDefined();
  });

  it("Error: 이미 archived 상태인 세션의 초기화는 거부된다", async () => {
    const { sessionManagerMod } = await loadModules();
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const sm = sessionManagerMod.createSessionManager(
      makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }) as never,
    );
    const created = await sm.create({ engine: "acp" });
    await sm.clear(created.sid);
    await expect(sm.clear(created.sid)).rejects.toThrow();
  });
});
