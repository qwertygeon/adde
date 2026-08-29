import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  type V2TmpRoots,
  bindSessionManager,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { waitFor } from "../helpers/wait.js";
import { makeSessionRecordFixture } from "../helpers/session-record-fixture.js";

// 신규 세션 부트스트랩 관통 — Surface 를 **실제로 기동**해 "세션 레코드만 존재 → 입력 노트 생성 →
// 지시 적재" 를 검증한다. 기존 markdown 스위트는 순수 함수(sendingLine·parseInbox 등)만 단언해
// 발견 경로(knownSids → ensureInboxSkeleton)가 한 번도 실행되지 않았고, 그 공백이 신규 세션이
// 영원히 입력 노트를 받지 못하는 교착을 통과시켰다(conventions CV-3 — 배선 결함은 더블·순수 함수
// 단언으로 잡히지 않는다).

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

interface Harness {
  sm: import("../../src/core/session-manager.js").SessionManagerWithLoad;
  surface: import("../../src/surfaces/types.js").Surface;
  inboxPath: (sid: string) => string;
  queueDir: (sid: string) => string;
}

/** 데몬 조립을 흉내낸다 — SessionManager + Router + markdown Surface(실 fs). */
async function makeHarness(): Promise<Harness> {
  const [smMod, routerMod, surfaceMod, pathsMod] = await Promise.all([
    import("../../src/core/session-manager.js"),
    import("../../src/core/router.js"),
    import("../../src/surfaces/markdown/index.js"),
    import("../../src/shared/paths.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  // 더블 엔진은 매 턴 권한 요청을 1회 방출한다 — 기본 harness 의 no-op askPermission 으로는 게이트가
  // 결정을 못 받아 턴이 기본 600초 타임아웃까지 완결되지 않는다. 턴 완결을 관측하는 케이스가 있으므로
  // 자동 승인으로 배선한다(권한 게이트 자체의 검증은 별 스위트 소관).
  const smHolder: { sm?: import("../../src/core/session-manager.js").SessionManagerWithLoad } = {};
  const deps = makeSessionManagerDeps(
    roots,
    PROJ,
    { acp: fakeDriver.descriptor },
    {
      askPermission: async (sid: string, req: { reqId: string }) => {
        smHolder.sm?.resolvePermissionDecision(sid, req.reqId, "allow");
      },
    },
  );
  const sm = smMod.createSessionManager(deps);
  bindSessionManager(deps, sm);
  smHolder.sm = sm;
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
    inboxPath: (sid) => pathsMod.vaultPaths(roots.vaultRoot, PROJ, sid).inboxNote,
    queueDir: (sid) => pathsMod.sessionPaths(roots.base, PROJ, sid).queueDir,
  };
}

/** 별 프로세스(CLI)가 세션 레코드를 쓴 상태를 만든다 — 데몬은 이 레코드를 로드하지 않은 상태다. */
async function writeRecordOutOfBand(
  sid: string,
  opts: { status?: "active" | "hibernated" | "stopped"; markdownBinding?: boolean } = {},
): Promise<void> {
  const store = await import("../../src/core/session-store.js");
  const withBinding = opts.markdownBinding !== false;
  await store.saveSession(
    roots.base,
    PROJ,
    makeSessionRecordFixture(sid, {
      status: opts.status ?? "active",
      bindings: withBinding
        ? [{ surface: "markdown", address: `sessions/${sid}/inbox.md`, sid }]
        : [],
    }),
  );
}

describe("SC-1: 레코드만 존재하는 신규 세션이 입력 노트를 받는다", () => {
  it("Happy: 데몬이 로드하지 않은 세션 레코드도 poll 에서 흡수되어 inbox.md 가 생성된다", async () => {
    const h = await makeHarness();
    await writeRecordOutOfBand("sess-new");
    // vault 디렉터리는 아직 없다 — 이전 구현은 이 상태에서 영원히 씨딩하지 않았다.
    expect(fs.existsSync(path.dirname(h.inboxPath("sess-new")))).toBe(false);

    await h.surface.start(undefined as never);
    try {
      await waitFor(() => fs.existsSync(h.inboxPath("sess-new")));
      const content = fs.readFileSync(h.inboxPath("sess-new"), "utf8");
      expect(content).toContain("adde:compose"); // 작성 경계
      expect(content).toContain("adde:records"); // 기록 존
      expect(content).toMatch(/send/); // 전송 트리거
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-2: 생성된 입력 노트의 지시가 재기동 없이 적재된다", () => {
  it("Happy: 작성 영역에 텍스트를 넣고 send 를 체크하면 세션 큐에 envelope 이 적재된다", async () => {
    const h = await makeHarness();
    await writeRecordOutOfBand("sess-send");
    await h.surface.start(undefined as never);
    try {
      await waitFor(() => fs.existsSync(h.inboxPath("sess-send")));
      const before = fs.readFileSync(h.inboxPath("sess-send"), "utf8");
      // 작성 경계 뒤에 본문을 넣고 send 를 체크 상태로 바꾼다(사용자 편집 재현).
      const edited = before
        .replace("<!-- adde:compose -->", "<!-- adde:compose -->\n첫 지시")
        .replace(/- \[ \] (.*send.*)/, "- [x] $1");
      fs.writeFileSync(h.inboxPath("sess-send"), edited);

      // 적재된 envelope 는 무장된 TurnRunner 가 곧바로 소비해 processing 으로 옮기므로, 큐 디렉터리에
      // 파일이 남아 있는지로 단언하면 경합에 걸린다(전체 스위트 부하에서 실패 관측). 대신 지시가
      // 실제로 턴으로 접수됐다는 결과 — 이벤트 기록의 turn_start — 를 단언한다.
      const events = await import("../../src/record/events.js");
      const { makeRecordCtx } = await import("../helpers/v2-fixtures.js");
      const ctx = makeRecordCtx(roots, PROJ, "sess-send") as never;
      await waitFor(async () => {
        for await (const e of events.readEvents(ctx)) {
          const ev = e as { t: string; input?: { text?: string } };
          if (ev.t === "turn_start" && (ev.input?.text ?? "").includes("첫 지시")) return true;
        }
        return false;
      });
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-3: refresh 가 기존 세션의 in-memory 상태를 덮어쓰지 않는다", () => {
  it("Happy: 디스크에 구 상태가 남아 있어도 이미 알고 있는 세션의 in-memory 레코드는 유지된다", async () => {
    const h = await makeHarness();
    await writeRecordOutOfBand("sess-keep", { status: "active" });
    await h.sm.load();

    // 런타임이 상태를 진행시켰다고 가정 — 디스크에는 여전히 active 가 남아 있는 상황을 만든다.
    const rec = h.sm.get("sess-keep");
    expect(rec).toBeDefined();
    rec!.status = "hibernated";
    rec!.engineRef = "engine-ref-live";

    const result = await h.sm.refresh();

    expect(result.added).not.toContain("sess-keep"); // 이미 아는 세션은 추가 대상 아님
    expect(h.sm.get("sess-keep")?.status).toBe("hibernated"); // 디스크(active)로 되돌아가지 않음
    expect(h.sm.get("sess-keep")?.engineRef).toBe("engine-ref-live");
  });
});

describe("SC-4: 씨딩 대상은 markdown 바인딩 보유 세션으로 한정된다", () => {
  it("Edge: 바인딩 없는(승계로 stopped 된) 세션의 잔존 vault 디렉터리는 재씨딩되지 않는다", async () => {
    const h = await makeHarness();
    await writeRecordOutOfBand("sess-arch", { status: "stopped", markdownBinding: false });
    // 과거 사용 흔적으로 vault 디렉터리만 남아 있는 상태를 만든다.
    fs.mkdirSync(path.dirname(h.inboxPath("sess-arch")), { recursive: true });

    // 대조군 — 정상 세션 1개를 함께 두어 poll 이 실제로 돌았음을 확인한다.
    await writeRecordOutOfBand("sess-live");

    await h.surface.start(undefined as never);
    try {
      await waitFor(() => fs.existsSync(h.inboxPath("sess-live")));
      expect(fs.existsSync(h.inboxPath("sess-arch"))).toBe(false);
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-5: 기동 시점에 hibernated 인 세션도 지시를 받을 수 있다", () => {
  it("Happy: 부팅 시 hibernated 였던 세션에 지시를 넣으면 적재되고 TurnRunner 가 존재한다", async () => {
    const h = await makeHarness();
    await writeRecordOutOfBand("sess-hib", { status: "hibernated" });
    await h.sm.load();
    await h.sm.resumeAllOnBoot(); // active 가 아니므로 재개 대상에서 제외된다

    await h.surface.start(undefined as never);
    try {
      await waitFor(() => fs.existsSync(h.inboxPath("sess-hib")));
      // 부팅 시 hibernated 세션은 admit 을 거치지 않아 런타임이 없었고, 그 결과 router 의
      // notify() 가 no-op 이 되어 큐에 적재된 지시가 소비되지 않았다.
      expect(h.sm.turnRunner("sess-hib"), "hibernated 세션에 TurnRunner 가 없다").toBeDefined();
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-6: 턴 0회 세션은 재개 핸들을 남기지 않는다", () => {
  it("Happy: 턴 없이 엔진만 열린 세션은 engineRef 가 영속되지 않고, 첫 턴 완결 후에 영속된다", async () => {
    const h = await makeHarness();
    await writeRecordOutOfBand("sess-ref");
    await h.sm.load();

    // 엔진만 연다(턴 없음) — 이 시점의 엔진 전사는 아직 디스크에 없다(실 어댑터 실측).
    await h.sm.admit("sess-ref");
    expect(h.sm.get("sess-ref")?.engineRef, "턴 0회인데 재개 핸들이 남았다").toBeNull();

    // 디스크 레코드에도 남지 않아야 한다 — 재기동 후 재개 시도를 유발하면 detached 로 죽는다.
    const store = await import("../../src/core/session-store.js");
    const persisted = (await store.loadSessions(roots.base, PROJ)).find(
      (r) => r.sid === "sess-ref",
    );
    expect(persisted?.engineRef).toBeNull();

    // 턴 1회 완결 — 입력 노트 경로를 거쳐 실제 턴을 돌린다.
    await h.surface.start(undefined as never);
    try {
      await waitFor(() => fs.existsSync(h.inboxPath("sess-ref")));
      const before = fs.readFileSync(h.inboxPath("sess-ref"), "utf8");
      fs.writeFileSync(
        h.inboxPath("sess-ref"),
        before
          .replace("<!-- adde:compose -->", "<!-- adde:compose -->\n지시")
          .replace(/- \[ \] (.*send.*)/, "- [x] $1"),
      );
      // in-memory 세팅과 persist() 사이에 await 경계가 있어, in-memory 값으로 대기하면 디스크
      // 읽기가 그 사이에 끼어들 수 있다(경합) — 영속된 값 자체를 대기 조건으로 둔다.
      await waitFor(async () => {
        const r = (await store.loadSessions(roots.base, PROJ)).find((x) => x.sid === "sess-ref");
        return r?.engineRef != null;
      });
      const after = (await store.loadSessions(roots.base, PROJ)).find((r) => r.sid === "sess-ref");
      expect(after?.engineRef, "첫 턴 완결 후에도 재개 핸들이 없다").not.toBeNull();
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 20000);
});
