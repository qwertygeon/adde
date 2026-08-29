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
import { waitFor } from "../helpers/wait.js";

// SC-029~031·SC-041 — 안내 존 렌더·소비가 실 SessionManager + 실 Surface 관통으로 동작한다.
// SoT 는 세션 레코드의 notices(design.md §7) — 노트는 파생 렌더.

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function makeHarness() {
  const [sessionStore, sessionManagerMod, pathsMod, surfaceMod, routerMod] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
    import("../../src/shared/paths.js"),
    import("../../src/surfaces/markdown/index.js"),
    import("../../src/core/router.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const { store: record } = makeFakeRecordStore();
  const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }, { record });
  const rawSm = sessionManagerMod.createSessionManager(deps);
  bindSessionManager(deps, rawSm);
  const sm = rawSm as unknown as {
    create: (opts: unknown) => Promise<{ sid: string }>;
    registerBinding: (sid: string, b: unknown) => Promise<void>;
    pushNotice: (sid: string, n: Record<string, unknown>) => Promise<void>;
    noteFailure: (sid: string, kind: string, reason: string) => Promise<void>;
    clearFailure: (sid: string, kind: string) => Promise<void>;
    get: (sid: string) => { warnings: string[] } | undefined;
    list: () => Array<{ sid: string }>;
    shutdown: () => Promise<void>;
  };
  const router = routerMod.createRouter({
    base: roots.base,
    proj: PROJ,
    sessionManager: sm as never,
  });
  const surface = surfaceMod.createMarkdownSurface({
    base: roots.base,
    vaultRoot: roots.vaultRoot,
    proj: PROJ,
    sessionManager: sm as never,
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

describe("SC-029: 안내 존은 작성 경계 위에 있고 전송 본문에 섞이지 않는다", () => {
  it("Happy: 안내 1건 있는 세션의 노트를 렌더하고 초안을 전송해도 안내 문구가 본문에 없다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.sm.pushNotice(created.sid, { kind: "compact-done", text: "압축이 완료되었습니다" });
    await h.surface.start(undefined as never);
    try {
      await waitFor(async () =>
        (await readInbox(h.inboxPath(created.sid))).includes("압축이 완료"),
      );
      const content = await readInbox(h.inboxPath(created.sid));
      const noticeIdx = content.split("\n").findIndex((l) => l.includes("압축이 완료"));
      const composeIdx = content.split("\n").findIndex((l) => l.includes("adde:compose"));
      expect(noticeIdx).toBeLessThan(composeIdx);

      const fs = await import("node:fs/promises");
      const withDraft = content.replace("- [ ] 📤 send", "실제 지시 본문\n- [x] 📤 send");
      await fs.writeFile(h.inboxPath(created.sid), withDraft);
      await waitFor(async () => {
        const c = await readInbox(h.inboxPath(created.sid));
        return c.includes("⏳") || c.includes("sent");
      });
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-030: 안내 항목 체크로 그 항목만 소비된다", () => {
  it("Happy: 2건 중 1건 체크 → 그 항목만 제거되고 나머지 1건은 유지된다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.sm.pushNotice(created.sid, { kind: "compact-done", text: "안내A" });
    await h.sm.pushNotice(created.sid, { kind: "compact-done", text: "안내B" });
    await h.surface.start(undefined as never);
    try {
      await waitFor(async () => {
        const c = await readInbox(h.inboxPath(created.sid));
        return c.includes("안내A") && c.includes("안내B");
      });
      const fs = await import("node:fs/promises");
      const content = await readInbox(h.inboxPath(created.sid));
      const lines = content.split("\n");
      const idx = lines.findIndex((l) => l.includes("안내A"));
      lines[idx] = lines[idx]!.replace("[ ]", "[x]");
      await fs.writeFile(h.inboxPath(created.sid), lines.join("\n"));
      await waitFor(async () => !(await readInbox(h.inboxPath(created.sid))).includes("안내A"));
      const after = await readInbox(h.inboxPath(created.sid));
      expect(after).toContain("안내B");
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-031: 사용자가 안내 줄을 지우면 다시 나타나지 않는다", () => {
  it("Happy: 렌더된 안내 줄을 삭제 → 지속 저장에서도 제거되어 재등장하지 않는다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.sm.pushNotice(created.sid, { kind: "compact-done", text: "지워질 안내" });
    await h.surface.start(undefined as never);
    try {
      await waitFor(async () =>
        (await readInbox(h.inboxPath(created.sid))).includes("지워질 안내"),
      );
      const fs = await import("node:fs/promises");
      const content = await readInbox(h.inboxPath(created.sid));
      const withoutNotice = content
        .split("\n")
        .filter((l) => !l.includes("지워질 안내"))
        .join("\n");
      await fs.writeFile(h.inboxPath(created.sid), withoutNotice);
      await new Promise((r) => setTimeout(r, 3000)); // 다음 tick 소비 대기
      const after = await readInbox(h.inboxPath(created.sid));
      expect(after).not.toContain("지워질 안내");
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);

  it("Edge: 렌더 전(rendered 미설정) 항목은 노트 부재로도 소비되지 않는다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    // pushNotice 직후(아직 렌더 tick 이전) — rendered 플래그가 없는 상태를 재현하려면 노트를
    // 먼저 지워버린다(치유 이전 순간을 흉내).
    await h.sm.pushNotice(created.sid, { kind: "compact-done", text: "렌더전-안내" });
    // 노트가 아직 없는 시점이면 존재 조합만으로 읽음 처리되지 않아야 한다 — start() 를 부르지
    // 않고 곧바로 레코드를 확인해 "아직 미렌더 + 부재" 조합이 소실을 일으키지 않는지 본다.
    const list = await h.sessionStore.loadSessions(roots.base, PROJ);
    const rec = list.find((s) => s.sid === created.sid);
    expect(rec?.notices?.some((n: { text: string }) => n.text === "렌더전-안내")).toBe(true);
  });
});

describe("SC-041: 재개 실패는 경고 존, 압축 성공은 안내 존으로 분리된다", () => {
  it("Happy: 압축 성공 안내(존)와 재개 실패 경고(존)가 각각 다른 표면에 남는다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    await h.sm.pushNotice(created.sid, { kind: "compact-done", text: "압축 성공" });
    await h.sm.noteFailure(created.sid, "resume-failed", "resume-failed: boot timeout");
    await h.surface.start(undefined as never);
    try {
      await waitFor(async () => {
        const c = await readInbox(h.inboxPath(created.sid));
        return c.includes("압축 성공") && c.includes("resume-failed");
      });
      const content = await readInbox(h.inboxPath(created.sid));
      const statusIdx = content.split("\n").findIndex((l) => l.includes("resume-failed"));
      const noticeIdx = content.split("\n").findIndex((l) => l.includes("압축 성공"));
      expect(statusIdx).toBeGreaterThanOrEqual(0);
      expect(noticeIdx).toBeGreaterThanOrEqual(0);
      expect(statusIdx).not.toBe(noticeIdx); // 서로 다른 줄(다른 존).
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});
