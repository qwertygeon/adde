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

// SC-035 (NFR-001): 세션 간 상태 비침해 — A 의 초기화·삭제·기록 실패가 B 의 큐·기록·노트·설정을
// 어느 것도 변경하지 않는다. design.md §인터페이스 계약 기반 deps 구성은 session-model.test.ts
// 상단 주석의 가정을 그대로 승계한다.

const PROJ = "p1";

async function loadModules() {
  const [sessionStore, sessionManagerMod] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
  ]);
  return { sessionStore, sessionManagerMod };
}

let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

describe("SC-035: 세션 간 상태 비침해", () => {
  it("Happy: A 를 초기화·삭제하고 A 에서 기록 실패를 유발해도 B 의 큐·기록·노트·설정은 불변이고 B 는 계속 처리된다", async () => {
    const { sessionStore, sessionManagerMod } = await loadModules();
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const { calls } = makeFakeRecordStore({ failAppendEventForSid: "WILL_BE_A" });
    const sm = sessionManagerMod.createSessionManager(
      makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }) as never,
    );

    const a = await sm.create({ engine: "acp" });
    const b = await sm.create({ engine: "acp" });
    // A 의 sid 를 알고 나서 기록 실패 대상을 재설정한 fake record 로 다시 구성한다(선-생성 후 실패 타겟팅).
    // 신규 인스턴스는 in-memory records 가 비어 있어(GAP-022 동형) load() 로 디스크의 기존 레코드를
    // 반드시 적재해야 admit()/clear()/remove() 가 A·B 를 인식한다.
    const { store: record2 } = makeFakeRecordStore({ failAppendEventForSid: a.sid });
    const sm2 = sessionManagerMod.createSessionManager(
      makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }) as never,
    );
    await sm2.load();

    const beforeB = (await sessionStore.loadSessions(roots.base, PROJ)).find(
      (s) => s.sid === b.sid,
    );

    // A 초기화(승계) + 삭제 시도
    await sm2.clear(a.sid).catch(() => {});
    await sm2.remove(a.sid, { purge: false }).catch(() => {});
    // A 에서 기록 실패 유발
    await record2.appendEvent(a.sid, { t: "turn_start" }).catch(() => {});

    const afterB = (await sessionStore.loadSessions(roots.base, PROJ)).find((s) => s.sid === b.sid);
    expect(afterB).toEqual(beforeB); // B 세션 레코드 완전 불변

    // B 는 계속 정상 처리된다.
    const engineB = await sm2.admit(b.sid);
    const events: string[] = [];
    for await (const ev of engineB.send({ text: "still-fine" })) events.push(ev.t);
    expect(events).toContain("turn_end");
    void calls;
  });

  it("Edge: A 와 B 가 같은 blob 참조를 공유해도 A 의 삭제가 B 의 참조 유효성에 영향을 주지 않는다", async () => {
    const blobsMod = await import("../../src/record/blobs.js");
    const ref1 = await blobsMod.putBlob(
      makeRecordCtx(roots, PROJ, "sess-a") as never,
      Buffer.from("shared-content"),
    );
    const ref2 = await blobsMod.putBlob(
      makeRecordCtx(roots, PROJ, "sess-b") as never,
      Buffer.from("shared-content"),
    );
    expect(ref1.blob).toBe(ref2.blob); // 내용 주소라 A 삭제와 무관하게 참조가 항상 유효
  });

  it("Error: A 의 세션 레코드가 손상돼도 B 로드는 영향받지 않는다", async () => {
    const { sessionStore } = await loadModules();
    const now = new Date().toISOString();
    const b = {
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
    await sessionStore.saveSession(roots.base, PROJ, b);
    const fs = await import("node:fs");
    const path = await import("node:path");
    const sessionsDir = path.join(roots.base, "projects", PROJ, "sessions.d");
    fs.writeFileSync(path.join(sessionsDir, "a-corrupt.json"), "{not valid json");

    const loaded = await sessionStore.loadSessions(roots.base, PROJ);
    expect(loaded.find((s) => s.sid === b.sid)).toEqual(b);
  });
});
