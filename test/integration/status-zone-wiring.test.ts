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

// 상태 존은 세션 레코드 경고의 파생물이다. 렌더 함수 단언만으로는 Surface 가 레코드를 실제로 읽어
// 넘기는지 알 수 없어(conventions CV-3 — 미배선은 순수 함수 단언을 통과한다) Surface 를 기동해
// 노트 파일 내용으로 관측한다.

const PROJ = "p1";
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

describe("상태 존 배선(레코드 경고 → 입력 노트)", () => {
  it("Happy: 레코드 경고가 노트 상태 존으로 렌더되고, 해소되면 노트에서 사라진다", async () => {
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
      await waitFor(() => fs.existsSync(inbox), { timeoutMs: 5000 });
      // 경고가 없는 동안에는 존이 없다.
      expect(fs.readFileSync(inbox, "utf8")).not.toContain("<!-- adde:status -->");

      // 저장 실패가 기록된 상태를 만든다(경로는 SessionManager 내부이므로 레코드를 직접 조작).
      h.sm.get(created.sid)!.warnings = ["storage-failed: 턴 3 노트 저장 실패"];

      await waitFor(() => fs.readFileSync(inbox, "utf8").includes("<!-- adde:status -->"), {
        timeoutMs: 8000,
      });
      const withZone = fs.readFileSync(inbox, "utf8");
      expect(withZone).toContain("노트 저장 실패");
      // 작성 경계보다 앞이어야 한다 — 뒤면 다음 지시 본문으로 엔진에 전달된다.
      expect(withZone.indexOf("<!-- adde:status -->")).toBeLessThan(
        withZone.indexOf("<!-- adde:compose -->"),
      );

      // 해소 — 다음 poll 에서 존이 사라진다.
      h.sm.get(created.sid)!.warnings = [];
      await waitFor(() => !fs.readFileSync(inbox, "utf8").includes("<!-- adde:status -->"), {
        timeoutMs: 8000,
      });
    } finally {
      await h.surface.stop();
    }
  }, 30_000);
});
