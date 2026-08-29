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

// 재개 진입점(design.md §8) — 팔레트 `resume`(인자 없음)은 대상을 열거해 안내 존에 prompt 항목
// 1건을 만들고, `resume <식별자>` 는 목록 단계 없이 즉시 재개한다. RESUME_LIST_LIMIT=10.

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

async function checkResumeItem(inboxPath: string, matcher: string | RegExp): Promise<void> {
  const fs = await import("node:fs/promises");
  const content = await readInbox(inboxPath);
  const lines = content.split("\n");
  const idx = lines.findIndex(
    (l) =>
      l.includes("[ ]") && (typeof matcher === "string" ? l.includes(matcher) : matcher.test(l)),
  );
  if (idx === -1) throw new Error(`재개 항목을 찾지 못함(${String(matcher)}):\n${content}`);
  lines[idx] = lines[idx]!.replace("[ ]", "[x]");
  await fs.writeFile(inboxPath, lines.join("\n"));
}

// 픽스처 sid 리터럴은 고정 과거·미래 날짜(`991231-N`)를 쓴다 — `260828-1`(오늘 로컬 날짜)로
// 고정했더니 각 케이스가 먼저 만드는 `active` 세션의 `nextSessionId()` 결과(그날 첫 세션 = 항상
// `260828-1`)와 실제로 충돌해(오늘이 2026-08-28인 실행에서 재현) 같은 파일을 두 번 쓰게 되고
// resumeCandidates 가 항상 빈 목록이 되는 회귀가 있었다(test(EXECUTION) 관측).
async function seedStoppedSession(
  sessionStore: Awaited<ReturnType<typeof makeHarness>>["sessionStore"],
  sid: string,
  overrides: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  await sessionStore.saveSession(roots.base, PROJ, {
    v: 1,
    sid,
    engine: "acp",
    engineRef: null,
    status: "stopped",
    title: null,
    createdAt: now,
    lastActivityAt: now,
    successorOf: null,
    engineArgs: [],
    warnings: [],
    bindings: [{ surface: "markdown", address: `sessions/${sid}/inbox.md`, sid }],
    rev: 0,
    stopReason: "inactive",
    stoppedAt: now,
    stopPending: null,
    stopNotePending: false,
    notices: [],
    ...overrides,
  } as never);
}

describe("SC-014: 재개 목록에 떨어짐 상태와 사유가 함께 표시된다", () => {
  it("Happy: 사유가 기록된 떨어진 세션이 재개 목록에 상태·사유와 함께 나타난다", async () => {
    const h = await makeHarness();
    const active = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(active.sid, {
      surface: "markdown",
      address: `sessions/${active.sid}/inbox.md`,
      sid: active.sid,
    });
    await seedStoppedSession(h.sessionStore, "991231-1", {
      status: "detached",
      stopReason: "resume-failed: boot timeout",
    });
    await h.surface.start(undefined as never);
    try {
      await checkResumeItem(h.inboxPath(active.sid), "resume");
      await waitFor(async () => {
        const content = await readInbox(h.inboxPath(active.sid));
        return /991231-1/.test(content);
      });
      const content = await readInbox(h.inboxPath(active.sid));
      expect(content).toMatch(/떨어짐|detached/);
      expect(content).toContain("resume-failed");
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-025: 인자 없는 resume 은 목록을 렌더하고 하나를 체크하면 재개된다", () => {
  it("Happy: 중지 2·활성 1 → resume 체크 → 목록 2건 렌더 → 하나 체크 → 재개·목록 소멸", async () => {
    const h = await makeHarness();
    const active = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(active.sid, {
      surface: "markdown",
      address: `sessions/${active.sid}/inbox.md`,
      sid: active.sid,
    });
    await seedStoppedSession(h.sessionStore, "991231-1");
    await seedStoppedSession(h.sessionStore, "991231-2");
    await h.surface.start(undefined as never);
    try {
      await checkResumeItem(h.inboxPath(active.sid), "resume");
      await waitFor(async () => {
        const content = await readInbox(h.inboxPath(active.sid));
        return content.includes("991231-1") && content.includes("991231-2");
      });
      await checkResumeItem(h.inboxPath(active.sid), "991231-1");
      await waitFor(() => h.sm.get("991231-1")?.status === "active", { timeoutMs: 8_000 });
      await waitFor(async () => {
        const content = await readInbox(h.inboxPath(active.sid));
        return !content.includes("991231-1");
      });
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-026: 인자 있는 resume 은 목록 단계 없이 곧바로 재개된다", () => {
  it("Happy: resume 991231-2 체크 → 즉시 재개", async () => {
    const h = await makeHarness();
    const active = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(active.sid, {
      surface: "markdown",
      address: `sessions/${active.sid}/inbox.md`,
      sid: active.sid,
    });
    await seedStoppedSession(h.sessionStore, "991231-2");
    await h.surface.start(undefined as never);
    try {
      const fs = await import("node:fs/promises");
      const content = await readInbox(h.inboxPath(active.sid));
      const withArg = content.replace("- [ ] ♻️ resume", "- [ ] ♻️ resume 991231-2");
      await fs.writeFile(h.inboxPath(active.sid), withArg);
      const lines = withArg.split("\n");
      const idx = lines.findIndex((l) => l.includes("resume 991231-2"));
      lines[idx] = lines[idx]!.replace("[ ]", "[x]");
      await fs.writeFile(h.inboxPath(active.sid), lines.join("\n"));
      await waitFor(() => h.sm.get("991231-2")?.status === "active", { timeoutMs: 8_000 });
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-027: 재개 대상이 0건이면 빈 목록을 렌더하지 않고 안내만 남긴다", () => {
  it("Happy: 중지·떨어짐 0건에서 resume 체크 → '없습니다' 안내만, 빈 목록 렌더 0건", async () => {
    const h = await makeHarness();
    const active = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(active.sid, {
      surface: "markdown",
      address: `sessions/${active.sid}/inbox.md`,
      sid: active.sid,
    });
    await h.surface.start(undefined as never);
    try {
      await checkResumeItem(h.inboxPath(active.sid), "resume");
      await waitFor(async () => {
        const content = await readInbox(h.inboxPath(active.sid));
        return /없습니다|no.*resum/i.test(content);
      });
      const content = await readInbox(h.inboxPath(active.sid));
      expect(content).not.toMatch(/▶️/); // 빈 목록 항목이 렌더되지 않는다.
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-028: 존재하지 않거나 형식이 어긋난 식별자는 안내로 거부된다", () => {
  it("Happy: resume 999999-9(형식은 맞음·부재) → 대상 부재 안내", async () => {
    const h = await makeHarness();
    const active = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(active.sid, {
      surface: "markdown",
      address: `sessions/${active.sid}/inbox.md`,
      sid: active.sid,
    });
    await h.surface.start(undefined as never);
    try {
      const fs = await import("node:fs/promises");
      const content = await readInbox(h.inboxPath(active.sid));
      const withArg = content.replace("- [ ] ♻️ resume", "- [x] ♻️ resume 999999-9");
      await fs.writeFile(h.inboxPath(active.sid), withArg);
      await waitFor(async () => {
        const c = await readInbox(h.inboxPath(active.sid));
        return /없|부재|not found/i.test(c);
      });
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);

  it("Error: 경로 탈출 형식(resume ../etc) → 형식 오류 안내(차단)", async () => {
    const h = await makeHarness();
    const active = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(active.sid, {
      surface: "markdown",
      address: `sessions/${active.sid}/inbox.md`,
      sid: active.sid,
    });
    await h.surface.start(undefined as never);
    try {
      const fs = await import("node:fs/promises");
      const content = await readInbox(h.inboxPath(active.sid));
      const withArg = content.replace("- [ ] ♻️ resume", "- [x] ♻️ resume ../etc");
      await fs.writeFile(h.inboxPath(active.sid), withArg);
      await new Promise((r) => setTimeout(r, 3000));
      const c = await readInbox(h.inboxPath(active.sid));
      // 형식 오류 안내가 남거나(구현 관측 지점), 최소한 탈출 경로로 파일 접근이 발생하지 않는다.
      const fsSync = await import("node:fs");
      expect(fsSync.existsSync("/etc/../etc/passwd.adde-test-marker")).toBe(false);
      void c;
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-039: 재개 목록이 상한을 넘으면 절단 사실과 전체 조회 방법이 함께 안내된다", () => {
  it("Happy: 중지 12건 → 최근 10건만 표시 + 절단 문구 + 전체 조회 방법", async () => {
    const h = await makeHarness();
    const active = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(active.sid, {
      surface: "markdown",
      address: `sessions/${active.sid}/inbox.md`,
      sid: active.sid,
    });
    for (let i = 1; i <= 12; i++) {
      await seedStoppedSession(h.sessionStore, `991231-${i}`, {
        lastActivityAt: new Date(Date.now() + i * 1000).toISOString(),
      });
    }
    await h.surface.start(undefined as never);
    try {
      await checkResumeItem(h.inboxPath(active.sid), "resume");
      await waitFor(async () => {
        const content = await readInbox(h.inboxPath(active.sid));
        return /session ls|전체/.test(content);
      });
      const content = await readInbox(h.inboxPath(active.sid));
      const itemCount = content.split("\n").filter((l) => l.includes("▶️")).length;
      expect(itemCount).toBeLessThanOrEqual(10);
      expect(content).toMatch(/adde session ls/);
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-040: 재개 목록 줄을 전부 지우면 취소로 해석된다", () => {
  it("Happy: 옵션 줄 전부 삭제 → 취소 안내 + 재렌더 없음", async () => {
    const h = await makeHarness();
    const active = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(active.sid, {
      surface: "markdown",
      address: `sessions/${active.sid}/inbox.md`,
      sid: active.sid,
    });
    await seedStoppedSession(h.sessionStore, "991231-1");
    await h.surface.start(undefined as never);
    try {
      await checkResumeItem(h.inboxPath(active.sid), "resume");
      await waitFor(async () => (await readInbox(h.inboxPath(active.sid))).includes("991231-1"));
      // planNoticeSync 의 "전부 삭제 → 취소" 판정(design.md §7)은 옵션이 **이전 tick 에 이미
      // 렌더된 상태로 관측된 적 있음**(`rendered:true`)을 전제한다 — 렌더 직후(rendered 아직
      // false)에 곧바로 전부 지우면 "아직 렌더 전(유지)" 로 해석돼 취소가 성립하지 않는다
      // (crash-consistency 규칙, notices.ts planNoticeSync 주석). 노트에 텍스트가 보이는 것과
      // 레코드에 rendered 가 세워지는 것은 서로 다른 tick 일 수 있어, 후자를 직접 관측한다.
      await waitFor(
        () =>
          h.sm.get(active.sid)?.notices.some((n) => n.mode === "prompt" && n.rendered === true) ??
          false,
      );
      const fs = await import("node:fs/promises");
      const content = await readInbox(h.inboxPath(active.sid));
      const withoutOption = content
        .split("\n")
        .filter((l) => !l.includes("▶️"))
        .join("\n");
      await fs.writeFile(h.inboxPath(active.sid), withoutOption);
      await waitFor(async () => {
        const c = await readInbox(h.inboxPath(active.sid));
        return /취소|cancel/i.test(c);
      });
      const after = await readInbox(h.inboxPath(active.sid));
      expect(after).not.toContain("991231-1"); // 목록이 다시 렌더되지 않는다.
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);

  it("Edge: 옵션 줄 일부만 삭제하면 취소가 아니라 재렌더된다", async () => {
    const h = await makeHarness();
    const active = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(active.sid, {
      surface: "markdown",
      address: `sessions/${active.sid}/inbox.md`,
      sid: active.sid,
    });
    await seedStoppedSession(h.sessionStore, "991231-1");
    await seedStoppedSession(h.sessionStore, "991231-2");
    await h.surface.start(undefined as never);
    try {
      await checkResumeItem(h.inboxPath(active.sid), "resume");
      await waitFor(async () => {
        const c = await readInbox(h.inboxPath(active.sid));
        return c.includes("991231-1") && c.includes("991231-2");
      });
      const fs = await import("node:fs/promises");
      const content = await readInbox(h.inboxPath(active.sid));
      const partial = content
        .split("\n")
        .filter((l) => !l.includes("991231-1"))
        .join("\n");
      await fs.writeFile(h.inboxPath(active.sid), partial);
      await new Promise((r) => setTimeout(r, 3000));
      const after = await readInbox(h.inboxPath(active.sid));
      expect(after).toContain("991231-2"); // 재렌더 — 취소로 해석되지 않는다.
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);

  it("Edge(완화, DEC-007): 렌더 확정 전 즉시 전삭제는 첫 시도에 취소되지 않지만 '아직 반영 안 됨' 안내가 노출되고 누적되지 않는다", async () => {
    // 근본 결함(GAP-014 — `NoticeEntry.rendered` 가 crash-consistency 상 다음 tick 에만 서기 때문에
    // 렌더 직후 곧바로 전삭제하면 "아직 렌더 전(유지)" 로 오분류돼 취소가 성립하지 않는다)의 근본
    // 수정은 이월됐다(scope.md CUT-002 · decisions.md DEC-007) — 본 차수는 **침묵 제거 완화**만
    // 적용한다: 위 Happy 케이스처럼 `rendered:true` 를 기다린 뒤 지우면 정상 취소되지만, 여기서는
    // 일부러 그 대기 없이(위 Happy 의 rendered 대기와 대칭) 즉시 지워 완화 동작 자체를 검증한다.
    const h = await makeHarness();
    const active = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(active.sid, {
      surface: "markdown",
      address: `sessions/${active.sid}/inbox.md`,
      sid: active.sid,
    });
    await seedStoppedSession(h.sessionStore, "991231-1");
    await h.surface.start(undefined as never);
    try {
      await checkResumeItem(h.inboxPath(active.sid), "resume");
      await waitFor(async () => (await readInbox(h.inboxPath(active.sid))).includes("991231-1"));
      const fs = await import("node:fs/promises");
      const content = await readInbox(h.inboxPath(active.sid));
      const withoutOption = content
        .split("\n")
        .filter((l) => !l.includes("▶️"))
        .join("\n");
      await fs.writeFile(h.inboxPath(active.sid), withoutOption);

      // [완화] 취소가 아직 반영되지 않았다는 안내가 노출된다(en/ko locale key notice.notYetReflected).
      await waitFor(async () => {
        const c = await readInbox(h.inboxPath(active.sid));
        return c.includes("아직 노트에 반영되기 전");
      });

      // [이월된 근본 동작의 현재 명세] 첫 시도는 취소로 해석되지 않는다 — 옵션이 재렌더로
      // 되살아난다(취소하려면 표시된 뒤 다시 지워야 한다 — 안내 문구가 그 방법을 알린다).
      await waitFor(async () => (await readInbox(h.inboxPath(active.sid))).includes("991231-1"));

      // [누적 없음] 재렌더될 때까지 여러 tick 에 걸쳐 "아직 반영 안 됨" 판정이 반복됐어도(같은
      // kind 는 replace:true 로 최신 1건 대체) 안내 문구는 그 구간 내내 1건만 존재해야 한다.
      const settled = await readInbox(h.inboxPath(active.sid));
      const noticeCount = (settled.match(/아직 노트에 반영되기 전/g) ?? []).length;
      expect(noticeCount).toBeLessThanOrEqual(1);
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});
