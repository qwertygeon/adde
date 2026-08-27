import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { waitFor } from "../helpers/wait.js";

// idle 세션의 입력 노트는 poll 이 반복돼도 **다시 쓰이지 않아야** 한다. 순수 함수 단언(heal 의
// changed 판정)만으로는 쓰기 지점이 그 판정을 실제로 존중하는지 알 수 없어(conventions CV-3)
// Surface 를 기동해 파일 mtime 으로 관측한다. 불필요 재기록은 동기화 오염과 읽기~쓰기 창의
// 사용자 편집 유실을 낳는다.

const PROJ = "p1";
const POLL_INTERVAL_MS = 2_000; // src/surfaces/markdown/index.ts 실측값
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function makeHarness() {
  const [smMod, routerMod, surfaceMod, pathsMod] = await Promise.all([
    import("../../src/core/session-manager.js"),
    import("../../src/core/router.js"),
    import("../../src/surfaces/markdown/index.js"),
    import("../../src/shared/paths.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
  const sm = smMod.createSessionManager(deps as never);
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
    inboxPath: (sid: string) => pathsMod.vaultPaths(roots.vaultRoot, PROJ, sid).inboxNote,
  };
}

describe("idle 세션 입력 노트의 무의미 재기록 방지", () => {
  it("Happy: 사용자 조작이 없으면 poll 이 여러 번 돌아도 inbox.md 가 다시 쓰이지 않는다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.registerBinding(created.sid, {
      surface: "markdown",
      address: `sessions/${created.sid}/inbox.md`,
      sid: created.sid,
    });
    const inbox = h.inboxPath(created.sid);

    await h.surface.start(undefined as never);
    try {
      // 첫 poll 이 노트를 씨딩한다(이 쓰기는 정상).
      await waitFor(() => fs.existsSync(inbox), { timeoutMs: 5000 });
      const before = fs.statSync(inbox);
      const contentBefore = fs.readFileSync(inbox, "utf8");

      // poll 을 2회 이상 통과시킨다 — 그 사이 사용자 조작은 없다.
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS * 2 + 500));

      const after = fs.statSync(inbox);
      expect(fs.readFileSync(inbox, "utf8")).toBe(contentBefore); // 내용 불변
      expect(after.mtimeMs).toBe(before.mtimeMs); // 쓰기 자체가 없었다
    } finally {
      await h.surface.stop();
    }
  }, 15_000);
});
