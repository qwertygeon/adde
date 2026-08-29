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
import { waitFor } from "../helpers/wait.js";

// SC-023·SC-024 — 팔레트 `stop`·`clear` 체크박스가 실 SessionManager + 실 Surface + 실 파일을
// 관통해 중지·초기화를 트리거한다(conventions CV-3 — 배선 결함은 더블 단위 테스트로 안 잡힌다).
//
// rename 실패 주입은 node:fs/promises 를 통째로 목해야 한다(ESM 네임스페이스 직접 spyOn 은
// read-only 바인딩이라 실패). `failPathIncludes` 로 대상 경로를 좁힌다 — GAP-011 수정
// (session-manager.ts applyStop) 이 onStopApplied(노트 쓰기)를 persist(레코드 쓰기)보다 먼저
// 호출하도록 재배치해, 경로 구분 없이 "다음 rename 1회" 를 실패시키면 실제로는 노트 쓰기가
// 먼저 실패해 소비되고(그 실패는 stopNotePending 으로 흡수될 뿐 상태 전이를 막지 않는다) 뒤이은
// 레코드 persist·processSession 의 즉시 재시도 write 는 정상 성공한다 — design.md SC-023
// Error("중지 실패(**persist** 오류) → 경고 존 + 체크 복원")가 요구하는 시나리오(레코드 저장 자체
// 실패)를 재현하려면 `sessions.d` 레코드 파일 rename 만 표적해야 한다.
const renameCtl = vi.hoisted(() => ({
  failWith: null as (() => Error) | null,
  failPathIncludes: null as string | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const dest = String(args[1]);
      const targeted =
        renameCtl.failPathIncludes === null || dest.includes(renameCtl.failPathIncludes);
      if (renameCtl.failWith && targeted) {
        const err = renameCtl.failWith();
        renameCtl.failWith = null;
        throw err;
      }
      return actual.rename(...args);
    },
  };
});

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  renameCtl.failWith = null;
  renameCtl.failPathIncludes = null;
  cleanupV2TmpRoots(roots);
});

async function makeHarness(overrides: Record<string, unknown> = {}) {
  const [sessionStore, sessionManagerMod, pathsMod, surfaceMod, routerMod] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
    import("../../src/shared/paths.js"),
    import("../../src/surfaces/markdown/index.js"),
    import("../../src/core/router.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const { store: record } = makeFakeRecordStore();
  const deps = makeSessionManagerDeps(
    roots,
    PROJ,
    { acp: fakeDriver.descriptor },
    { record, ...overrides },
  );
  const sm = sessionManagerMod.createSessionManager(deps);
  bindSessionManager(deps, sm);
  const router = routerMod.createRouter({ base: roots.base, proj: PROJ, sessionManager: sm });
  const surface = surfaceMod.createMarkdownSurface({
    base: roots.base,
    vaultRoot: roots.vaultRoot,
    proj: PROJ,
    sessionManager: sm,
    router,
    conf: (deps as { conf: unknown }).conf as never,
  } as never);
  return {
    sm,
    surface,
    sessionStore,
    fakeDriver,
    inboxPath: (sid: string) => pathsMod.vaultPaths(roots.vaultRoot, PROJ, sid).inboxNote,
  };
}

async function checkPaletteItem(inboxPath: string, labelSubstring: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await waitFor(async () => {
    try {
      await fs.access(inboxPath);
      return true;
    } catch {
      return false;
    }
  });
  const content = await fs.readFile(inboxPath, "utf8");
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => l.includes(labelSubstring) && l.includes("[ ]"));
  if (idx === -1) throw new Error(`팔레트 항목을 찾지 못함: ${labelSubstring}\n${content}`);
  lines[idx] = lines[idx]!.replace("[ ]", "[x]");
  await fs.writeFile(inboxPath, lines.join("\n"));
}

describe("SC-023: 팔레트 stop 체크로 그 세션만 중지된다", () => {
  it("Happy: 진행 중 작업 없는 활성 세션에서 stop 체크 → 그 세션만 중지·새 세션 0건·완료 안내", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.surface.start(undefined as never);
    try {
      await checkPaletteItem(h.inboxPath(created.sid), "stop");
      await waitFor(() => h.sm.get(created.sid)?.status === "stopped", { timeoutMs: 8_000 });
      const listBefore = h.sm.list().length;
      expect(listBefore).toBe(1); // 새 세션이 생기지 않는다.
    } finally {
      await h.surface.stop();
      await h.sm.shutdown(); // 실 setInterval 정리 — 안 하면 다음 테스트로 새는 타이머가 배경 부하를 늘린다.
    }
  }, 15000);

  it("Edge: 진행 중 턴이 있으면 stop 체크가 즉시 중지 대신 예약 경로로 처리된다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.sm.admit(created.sid);
    // stop-reservation.test.ts 실측 선례 — admit() 이 반환한 엔진 세션에 직접 engine.send() 하면
    // 큐/TurnRunner 를 거치지 않아 applyStop 의 잔여 판정(pendingWork·turnRunner.state())에 전혀
    // 반영되지 않는다(holdNextTurn() 만으로는 이 경로에서 판별력이 없다). 큐→processing claim 으로
    // "미완결 처리중" 파일을 실제로 만들어 pendingWork>0 을 재현한다.
    const pathsMod = await import("../../src/shared/paths.js");
    const queueMod = await import("../../src/core/queue.js");
    const sp = pathsMod.sessionPaths(roots.base, PROJ, created.sid);
    await queueMod.enqueue(sp, {
      v: 1,
      id: `env-${Math.random().toString(36).slice(2)}`,
      lane: created.sid,
      source: "markdown",
      backend: "acp",
      engine: "acp",
      project: PROJ,
      ts: new Date().toISOString(),
      text: "진행 중 지시",
    } as never);
    await queueMod.claimNext(sp);
    await h.surface.start(undefined as never);
    try {
      await checkPaletteItem(h.inboxPath(created.sid), "stop");
      await waitFor(() => h.sm.get(created.sid)?.stopPending != null, { timeoutMs: 8_000 });
      expect(h.sm.get(created.sid)?.status).toBe("active");
    } finally {
      await h.surface.stop();
      await h.sm.shutdown(); // 실 setInterval 정리 — 안 하면 다음 테스트로 새는 타이머가 배경 부하를 늘린다.
    }
  }, 15000);

  it("Error: 중지 저장(레코드 persist) 실패 시 상태가 롤백되고 경고 존이 남으며 체크는 복원된다(팔레트 재시도 가능)", async () => {
    // design.md SC-023 Error(시나리오 매핑 표): "중지 실패(**persist** 오류) → 경고 존 + 체크
    // 복원" — 노트 쓰기(onStopApplied)가 아니라 세션 레코드(`sessions.d/<sid>.json`) 저장 자체가
    // 실패하는 시나리오다. GAP-011 수정으로 onStopApplied 가 persist 보다 먼저 실행되므로,
    // 경로 구분 없는 "다음 rename 1회 실패" 는 노트 쓰기 쪽에서 소비돼(상태 전이는 막지 않음) 이
    // 시나리오를 재현하지 못한다 — 레코드 파일 rename 만 표적한다.
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.surface.start(undefined as never);
    try {
      renameCtl.failPathIncludes = "sessions.d";
      renameCtl.failWith = () => new Error("simulated persist fail");
      await checkPaletteItem(h.inboxPath(created.sid), "stop");
      await waitFor(
        () => h.sm.get(created.sid)?.warnings.some((w) => w.startsWith("palette-failed:")) ?? false,
        { timeoutMs: 8_000 },
      );
      // persist 가 실패해 롤백되므로 상태는 여전히 active 다(체크박스만 사용자가 눌렀을 뿐 전이는
      // 커밋되지 않았다).
      expect(h.sm.get(created.sid)?.status).toBe("active");
      await waitFor(async () => {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(h.inboxPath(created.sid), "utf8").catch(() => "");
        return /- \[ \] ⏹️ stop/.test(content);
      });
    } finally {
      await h.surface.stop();
      await h.sm.shutdown(); // 실 setInterval 정리 — 안 하면 다음 테스트로 새는 타이머가 배경 부하를 늘린다.
    }
  }, 15000);
});

describe("SC-024: 팔레트 clear 체크로 A 가 중지되고 새 세션 B 가 승계된다", () => {
  it("Happy: clear 체크 → A stopped·B 생성·양방향 링크 안내", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.surface.start(undefined as never);
    try {
      await checkPaletteItem(h.inboxPath(created.sid), "clear");
      await waitFor(() => h.sm.get(created.sid)?.status === "stopped", { timeoutMs: 8_000 });
      const list = h.sm.list();
      expect(list.length).toBe(2);
      const successor = list.find((r) => r.successorOf === created.sid);
      expect(successor).toBeDefined();
      expect(successor?.status).toBe("active");
    } finally {
      await h.surface.stop();
      await h.sm.shutdown(); // 실 setInterval 정리 — 안 하면 다음 테스트로 새는 타이머가 배경 부하를 늘린다.
    }
  }, 15000);

  it("Edge: A 의 초안·기록 존이 중지 노트에도 보존된다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.surface.start(undefined as never);
    try {
      const fs = await import("node:fs/promises");
      await waitFor(async () => {
        try {
          await fs.access(h.inboxPath(created.sid));
          return true;
        } catch {
          return false;
        }
      });
      const before = await fs.readFile(h.inboxPath(created.sid), "utf8");
      const withDraft = before.replace(
        "<!-- adde:compose -->",
        "<!-- adde:compose -->\n보존돼야 할 초안",
      );
      await fs.writeFile(h.inboxPath(created.sid), withDraft);
      await checkPaletteItem(h.inboxPath(created.sid), "clear");
      await waitFor(() => h.sm.get(created.sid)?.status === "stopped", { timeoutMs: 8_000 });
      await new Promise((r) => setTimeout(r, 500));
      const after = await fs.readFile(h.inboxPath(created.sid), "utf8");
      expect(after).toContain("보존돼야 할 초안");
    } finally {
      await h.surface.stop();
      await h.sm.shutdown(); // 실 setInterval 정리 — 안 하면 다음 테스트로 새는 타이머가 배경 부하를 늘린다.
    }
  }, 15000);

  it("Error: 새 세션 쪽 노트 이동 실패는 부분 실패로 경고가 남는다(기존 clear 관행 승계)", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.surface.start(undefined as never);
    try {
      renameCtl.failWith = () => new Error("simulated rename fail");
      await checkPaletteItem(h.inboxPath(created.sid), "clear");
      await waitFor(() => h.sm.get(created.sid)?.status === "stopped", { timeoutMs: 8_000 });
      const successor = h.sm.list().find((r) => r.successorOf === created.sid);
      expect(successor).toBeDefined();
      // (a) 세션 교체 자체는 이미 성공했다 — 노트 이동 실패는 새 세션 쪽 경고로 남는다(부분 실패).
      await waitFor(() => (h.sm.get(successor!.sid)?.warnings.length ?? 0) > 0, {
        timeoutMs: 5_000,
      });
      expect(h.sm.get(successor!.sid)?.warnings.length).toBeGreaterThan(0);
      // (b) 이전(중지된) 세션 쪽에는 사용자 표면 경고가 없다 — 재시도 플래그(stopNotePending)만
      // 이전 세션이 진다(GAP-023 정정 — 경고는 next, 재시도 기전은 old).
      expect(h.sm.get(created.sid)?.warnings.length).toBe(0);
      expect(h.sm.get(created.sid)?.stopNotePending).toBe(true);
      // (c) renameCtl.failWith 는 1회성이라 이미 소비됐다 — control 드레인 tick(2초) 의 자동
      // 재시도가 성공해 이전 세션의 stopNotePending 이 해소되고, 새 세션 쪽 경고도 함께 사라진다.
      await waitFor(() => h.sm.get(created.sid)?.stopNotePending === false, { timeoutMs: 8_000 });
      await waitFor(() => (h.sm.get(successor!.sid)?.warnings.length ?? 0) === 0, {
        timeoutMs: 5_000,
      });
    } finally {
      await h.surface.stop();
      await h.sm.shutdown(); // 실 setInterval 정리 — 안 하면 다음 테스트로 새는 타이머가 배경 부하를 늘린다.
    }
  }, 15000);
});
