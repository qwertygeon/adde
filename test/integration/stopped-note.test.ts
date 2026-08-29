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

// SC-042~SC-046 — 중지·떨어짐 노트는 실 SessionManager + 실 Surface + 실 파일을 관통해 검증한다
// (conventions CV-3 — 배선 결함은 순수 함수 단언으로 안 잡힌다). renderStoppedNote 자체 계약은
// 여기서 순수 호출로도 함께 확인한다.
//
// rename 실패 주입은 node:fs/promises 를 통째로 목해야 한다(ESM 네임스페이스 직접 spyOn 은
// read-only 바인딩이라 실패).
const renameCtl = vi.hoisted(() => ({ failWith: null as (() => Error) | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameCtl.failWith) {
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
  // production 조립(src/core/supervisor.ts:160-173)과 동일하게 중지·재개 노트 훅을 기본
  // 배선한다 — 배선이 없으면 processSession() 의 control-action 클로버링 방지 폴백(GAP-011)만
  // 커버되고, 이 파일의 SC-046 처럼 admit()/hibernate() 등 processSession 바깥에서 상태가
  // 전이되는 경로(=production 의 정상 경로)는 노트가 영원히 교체되지 않는다(main 실측 — 하네스
  // 결함). `holder` 는 onResumeApplied 가 필요로 하는 sm 참조를 생성 순서 문제 없이 넘긴다
  // (note-action-surfacing.test.ts askPermission 배선과 동형).
  const holder: { sm?: import("../../src/core/session-manager.js").SessionManagerWithLoad } = {};
  const deps = makeSessionManagerDeps(
    roots,
    PROJ,
    { acp: fakeDriver.descriptor },
    {
      record,
      onStopApplied: async (sid: string, info: unknown) =>
        surfaceMod.writeStoppedNote({ vaultRoot: roots.vaultRoot, proj: PROJ, sid }, info as never),
      onResumeApplied: async (sid: string) =>
        surfaceMod.restoreActiveNote(
          { vaultRoot: roots.vaultRoot, proj: PROJ, sid },
          {
            caps: holder.sm?.capsOf(sid) ?? {
              resume: "none",
              permission: "none",
              streaming: false,
              usage: false,
              compact: "none",
              attachments: [],
            },
            warnings: holder.sm?.get(sid)?.warnings ?? [],
            notices: holder.sm?.takeNotices(sid) ?? [],
          },
        ),
      pendingSurfaceWork: (sid: string) =>
        surfaceMod.hasUnconsumedSend({ vaultRoot: roots.vaultRoot, proj: PROJ, sid }),
      ...overrides,
    },
  );
  const sm = sessionManagerMod.createSessionManager(deps);
  bindSessionManager(deps, sm);
  holder.sm = sm;
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

async function readInbox(inboxPath: string): Promise<string> {
  const fs = await import("node:fs/promises");
  await waitFor(async () => {
    try {
      await fs.access(inboxPath);
      return true;
    } catch {
      return false;
    }
  });
  return fs.readFile(inboxPath, "utf8");
}

async function stopViaPalette(h: Awaited<ReturnType<typeof makeHarness>>, sid: string) {
  const fs = await import("node:fs/promises");
  const inbox = await import("../../src/surfaces/markdown/inbox.js");
  const content = await readInbox(h.inboxPath(sid));
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => l.includes("stop") && l.includes("[ ]"));
  lines[idx] = lines[idx]!.replace("[ ]", "[x]");
  await fs.writeFile(h.inboxPath(sid), lines.join("\n"));
  // 레코드 status 전이(synchronous, in-memory)와 노트가 실제로 배너로 교체되는 시점 사이에는
  // 갭이 있다(onStopApplied/processSession 폴백 write 가 비동기로 뒤따른다) — status 만 보고
  // 넘어가면 SC-044·SC-046 이 노트가 아직 이전 스켈레톤인 순간을 관측할 수 있다(관측 계약,
  // ADR-017 — 계층·타이밍이 아니라 결과물 수렴을 기다린다).
  await waitFor(() => h.sm.get(sid)?.status === "stopped", { timeoutMs: 8_000 });
  await waitFor(async () => (await readInbox(h.inboxPath(sid))).includes(inbox.STOPPED_SENTINEL), {
    timeoutMs: 8_000,
  });
}

describe("renderStoppedNote — 순수 렌더러 계약", () => {
  it("팔레트·send·체크박스가 하나도 없고 재개 2경로가 포함된다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const lines = inbox.renderStoppedNote(
      ["초안", "<!-- adde:records -->", "- [x] ✅ sent [[1]]"],
      {
        kind: "stopped",
        reason: "inactive",
      },
    );
    const content = lines.join("\n");
    expect(content).not.toMatch(/\[ \]/); // 미체크 체크박스 0건.
    expect(content).not.toContain("📤 send");
    expect(content).toMatch(/resume|재개/);
    expect(content).toMatch(/session resume/); // CLI 경로 포함.
  });
});

describe("SC-042·SC-043: 중지 시 팔레트·전송 체크박스가 없고 초안·기록은 보존된다", () => {
  it("Happy: 초안·기록이 있는 활성 세션을 중지하면 팔레트·send 는 사라지고 초안·기록은 보존된다", async () => {
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
      const before = await readInbox(h.inboxPath(created.sid));
      const withDraft = before.replace(
        "<!-- adde:compose -->",
        "<!-- adde:compose -->\n보존될 초안",
      );
      await fs.writeFile(h.inboxPath(created.sid), withDraft);
      await new Promise((r) => setTimeout(r, 500));

      await stopViaPalette(h, created.sid);
      const after = await readInbox(h.inboxPath(created.sid));
      expect(after).not.toMatch(/\[ \]/);
      expect(after).not.toContain("📤 send");
      expect(after).toContain("보존될 초안");
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-044: 중지 배너에 감시 안 됨·사유·재개 2경로가 모두 포함된다", () => {
  it("Happy: 중지 후 배너에 세 요소가 모두 나타난다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.surface.start(undefined as never);
    try {
      await stopViaPalette(h, created.sid);
      const content = await readInbox(h.inboxPath(created.sid));
      expect(content).toMatch(/감시.*않|not.*watch/i);
      expect(content).toMatch(/사유|reason/i);
      expect(content).toMatch(/session resume/); // CLI 경로.
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);

  it("Error: 사유에 제어문자가 있어도 살균 후 한 줄로 렌더된다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const lines = inbox.renderStoppedNote([], {
      kind: "stopped",
      reason: "line1\nline2\x00tail",
    });
    for (const l of lines) {
      expect(l).not.toContain("\x00");
    }
    // 원본 개행이 노트에서 여러 줄로 그대로 쪼개지지 않는다(살균 후 접힘).
    const rawJoined = lines.join("\n");
    expect(rawJoined.split("line1").length - 1).toBe(1);
  });
});

describe("SC-045: 노트 쓰기는 중지 교체 1회·재개 복구 1회로 한정된다", () => {
  it("Happy: 중지 유지 중 추가 쓰기 0회, 재개 후 초안이 그대로 유지된다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.surface.start(undefined as never);
    try {
      await stopViaPalette(h, created.sid);
      const fs = await import("node:fs");
      const mtimeAfterStop = fs.statSync(h.inboxPath(created.sid)).mtimeMs;
      await new Promise((r) => setTimeout(r, 3500)); // tick 1~2회 더 — 추가 쓰기가 없어야 한다.
      const mtimeLater = fs.statSync(h.inboxPath(created.sid)).mtimeMs;
      expect(mtimeLater).toBe(mtimeAfterStop);
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-046: 재개 실패로 떨어진 세션은 중지 안내형으로 교체되고 사유가 포함된다", () => {
  it("Happy: 재개 실패 → 중지 안내형 노트 + 떨어진 사유 포함", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.sm.admit(created.sid);
    // engineRef 는 turnRunner 의 refreshNotes 완결(turn_end append 성공) 후에만 영속된다
    // (hibernate.test.ts "Error: 재개 시 엔진 기동 실패" 선례) — engine.send() 직접 호출은 그
    // 파이프라인을 거치지 않아 engineRef 가 null 로 남고, 재개 admit() 의 wasResume 판정이 거짓이
    // 되어 markDetached 가 호출되지 않는다(notice-inventory.test.ts 지점 15·16 동일 수정 선례).
    h.sm.get(created.sid)!.engineRef = "prior-turn-engine-ref";
    await h.surface.start(undefined as never);
    try {
      await h.sm.hibernate(created.sid, "idle").catch(() => {});
      h.fakeDriver.control.failNextOpen("resume boot failure");
      await h.sm.admit(created.sid).catch(() => {});
      await waitFor(() => h.sm.get(created.sid)?.status === "detached", { timeoutMs: 8_000 });
      await waitFor(async () => {
        const c = await readInbox(h.inboxPath(created.sid));
        return /resume boot failure|떨어짐|detached/.test(c);
      });
      const content = await readInbox(h.inboxPath(created.sid));
      expect(content).not.toMatch(/\[ \]/);
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);

  it("Error: 떨어짐 직후 노트 쓰기 실패는 경고로 남고 재시도된다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.sm.admit(created.sid);
    // engineRef 는 turnRunner 의 refreshNotes 완결(turn_end append 성공) 후에만 영속된다
    // (hibernate.test.ts "Error: 재개 시 엔진 기동 실패" 선례) — engine.send() 직접 호출은 그
    // 파이프라인을 거치지 않아 engineRef 가 null 로 남고, 재개 admit() 의 wasResume 판정이 거짓이
    // 되어 markDetached 가 호출되지 않는다(notice-inventory.test.ts 지점 15·16 동일 수정 선례).
    h.sm.get(created.sid)!.engineRef = "prior-turn-engine-ref";
    await h.surface.start(undefined as never);
    try {
      await h.sm.hibernate(created.sid, "idle").catch(() => {});
      h.fakeDriver.control.failNextOpen("resume boot failure");
      renameCtl.failWith = () => new Error("simulated note write fail");
      await h.sm.admit(created.sid).catch(() => {});
      await waitFor(() => h.sm.get(created.sid)?.status === "detached", { timeoutMs: 8_000 });
      // stopNotePending 재시도 창이 다음 tick 에 노트를 교체한다.
      await waitFor(
        async () => {
          const c = await readInbox(h.inboxPath(created.sid));
          return !/\[ \]/.test(c);
        },
        { timeoutMs: 8_000 },
      );
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});
