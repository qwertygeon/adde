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

// 노트 액션(전송 적재·팔레트)의 실패는 성공과 노트 결과가 같았다 — 치유가 체크를 미체크로
// 되돌리므로 사용자에게는 "체크가 저절로 풀렸다"·"눌렀는데 아무 일도 없다" 로만 보였다. 또한 한
// 세션의 노트 처리 예외가 같은 주기의 나머지 세션 처리를 건너뛰게 해 원인 세션과 피해 세션이
// 달랐다. Surface 를 실제로 기동해 노트·레코드 파일로 관측한다(미배선은 순수 함수 단언을 통과한다).

const PROJ = "p1";
let roots: V2TmpRoots;
const chmodded: string[] = [];

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  for (const dir of chmodded.splice(0)) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* 이미 삭제됨 */
    }
  }
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
  const holder: { sm?: import("../../src/core/session-manager.js").SessionManagerWithLoad } = {};
  const deps = makeSessionManagerDeps(
    roots,
    PROJ,
    { acp: fakeDriver.descriptor },
    {
      askPermission: async (sid: string, req: { reqId: string }) => {
        holder.sm?.resolvePermissionDecision(sid, req.reqId, "allow");
      },
    },
  );
  const sm = smMod.createSessionManager(deps as never);
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
  return { sm, surface, paths: pathsMod, fakeDriver };
}

async function bind(
  sm: import("../../src/core/session-manager.js").SessionManagerWithLoad,
  sid: string,
): Promise<void> {
  await sm.registerBinding(sid, {
    surface: "markdown",
    address: `sessions/${sid}/inbox.md`,
    sid,
  });
}

function warningsOf(paths: typeof import("../../src/shared/paths.js"), sid: string): string[] {
  try {
    const recordFile = paths.sessionPaths(roots.base, PROJ, sid).recordFile;
    return (JSON.parse(fs.readFileSync(recordFile, "utf8")) as { warnings: string[] }).warnings;
  } catch {
    return [];
  }
}

/**
 * 노트에 초안 + 체크된 전송을 써 넣는다(사용자가 체크한 상태 재현).
 * 폴 tick 말미의 치유 쓰기와 경합할 수 있어(사용자 편집도 실제로 같은 경합에 놓인다) 조건이
 * 충족될 때까지 미체크 상태를 발견하면 다시 체크한다 — 실환경의 사용자 재시도와 같은 동작이다.
 */
async function submitUntil(inbox: string, text: string, cond: () => boolean): Promise<void> {
  await waitFor(
    () => {
      if (cond()) return true;
      const content = fs.readFileSync(inbox, "utf8");
      if (content.includes("- [ ] 📤 send")) {
        fs.writeFileSync(inbox, content.replace("- [ ] 📤 send", `${text}\n- [x] 📤 send`));
      }
      return cond();
    },
    { timeoutMs: 20_000 },
  );
}

/** 팔레트 항목 체크 — 위와 같은 경합이 있어 조건 충족까지 재체크한다. */
async function checkPaletteUntil(inbox: string, label: string, cond: () => boolean): Promise<void> {
  await waitFor(
    () => {
      if (cond()) return true;
      const content = fs.readFileSync(inbox, "utf8");
      if (content.includes(`- [ ] ${label}`)) {
        fs.writeFileSync(inbox, content.replace(`- [ ] ${label}`, `- [x] ${label}`));
      }
      return cond();
    },
    { timeoutMs: 20_000 },
  );
}

describe("전송 적재 실패의 표면화", () => {
  it("Happy: 적재 실패가 경고로 남고, 적재가 다시 성공하면 사라진다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await bind(h.sm, created.sid);
    const inbox = h.paths.vaultPaths(roots.vaultRoot, PROJ, created.sid).inboxNote;

    await h.surface.start(undefined as never);
    try {
      await waitFor(() => fs.existsSync(inbox), { timeoutMs: 8000 });

      // 큐 디렉터리를 쓰기 불가로 — 적재(enqueue)만 실패하는 상황(권한·마운트 재현).
      const queueDir = h.paths.sessionPaths(roots.base, PROJ, created.sid).queueDir;
      fs.mkdirSync(queueDir, { recursive: true });
      fs.chmodSync(queueDir, 0o500);
      chmodded.push(queueDir);

      await submitUntil(inbox, "첫 지시", () =>
        warningsOf(h.paths, created.sid).some((w) => w.startsWith("enqueue-failed:")),
      );
      expect(warningsOf(h.paths, created.sid).some((w) => w.includes("지시 적재 실패"))).toBe(true);

      // 원인 제거 후 다시 체크 — 성공 적재가 경고를 지운다.
      fs.chmodSync(queueDir, 0o700);
      await submitUntil(
        inbox,
        "두번째 지시",
        () => !warningsOf(h.paths, created.sid).some((w) => w.startsWith("enqueue-failed:")),
      );
    } finally {
      await h.surface.stop();
    }
  }, 30_000);
});

describe("팔레트 제어 실패의 표면화", () => {
  it("Happy: 재개(resume) 실패가 경고로 남는다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await bind(h.sm, created.sid);
    const inbox = h.paths.vaultPaths(roots.vaultRoot, PROJ, created.sid).inboxNote;

    await h.surface.start(undefined as never);
    try {
      await waitFor(() => fs.existsSync(inbox), { timeoutMs: 8000 });

      h.fakeDriver.control.failNextOpen("엔진 기동 거부");
      await checkPaletteUntil(inbox, "♻️ resume", () =>
        warningsOf(h.paths, created.sid).some((w) => w.startsWith("palette-failed:")),
      );
      expect(warningsOf(h.paths, created.sid).some((w) => w.includes("엔진 재개 실패"))).toBe(true);
    } finally {
      await h.surface.stop();
    }
  }, 30_000);

  it("Happy: 재개가 성공하면 이전 팔레트 실패 경고가 사라진다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await bind(h.sm, created.sid);
    const inbox = h.paths.vaultPaths(roots.vaultRoot, PROJ, created.sid).inboxNote;

    await h.surface.start(undefined as never);
    try {
      await waitFor(() => fs.existsSync(inbox), { timeoutMs: 8000 });
      h.sm.get(created.sid)!.warnings = ["palette-failed: 이전 실패"];

      await checkPaletteUntil(
        inbox,
        "♻️ resume",
        () =>
          warningsOf(h.paths, created.sid).some((w) => w.startsWith("palette-failed:")) === false,
      );
    } finally {
      await h.surface.stop();
    }
  }, 30_000);
});

describe("손상 메시지 격리의 표면화", () => {
  it("Happy: 손상 봉투가 격리되고 경고로 남는다", async () => {
    const h = await makeHarness();
    const created = await h.sm.create({ engine: "acp" });
    await h.sm.admit(created.sid); // 런타임·런너 확보

    const sp = h.paths.sessionPaths(roots.base, PROJ, created.sid);
    fs.mkdirSync(sp.queueDir, { recursive: true });
    fs.writeFileSync(`${sp.queueDir}/1-corrupt-env.msg`, "{ 이건 봉투가 아니다");

    h.sm.turnRunner(created.sid)?.notify();

    await waitFor(
      () => warningsOf(h.paths, created.sid).some((w) => w.startsWith("quarantined:")),
      {
        timeoutMs: 10_000,
      },
    );
    // 격리 자체(재발화 차단)도 함께 확인한다 — 경고만 남고 파일이 남으면 무한 재시도가 된다.
    expect(fs.readdirSync(sp.processingDir).some((f) => f.endsWith(".corrupt"))).toBe(true);
  }, 30_000);
});

describe("세션 단위 격리", () => {
  it("Happy: 앞 세션의 노트 처리 실패가 뒤 세션의 처리를 막지 않는다", async () => {
    const h = await makeHarness();
    const first = await h.sm.create({ engine: "acp" });
    const second = await h.sm.create({ engine: "acp" });
    await bind(h.sm, first.sid);
    await bind(h.sm, second.sid);

    // 앞 세션의 vault 세션 디렉터리를 쓰기 불가로 — 레이아웃 보장 단계에서 예외가 난다.
    const firstDir = h.paths.vaultPaths(roots.vaultRoot, PROJ, first.sid).sessionDir;
    fs.mkdirSync(firstDir, { recursive: true });
    fs.chmodSync(firstDir, 0o500);
    chmodded.push(firstDir);

    const secondInbox = h.paths.vaultPaths(roots.vaultRoot, PROJ, second.sid).inboxNote;
    await h.surface.start(undefined as never);
    try {
      // 뒤 세션은 정상적으로 노트를 받아야 한다(굶지 않음).
      await waitFor(() => fs.existsSync(secondInbox), { timeoutMs: 10_000 });

      // 뒤 세션의 전송도 실제로 적재돼야 한다 — 노트 생성만으로는 액션 소비 단계 도달을 못 본다.
      await submitUntil(secondInbox, "뒤 세션 지시", () =>
        /sending|sent/.test(fs.readFileSync(secondInbox, "utf8")),
      );

      // 앞 세션에는 실패가 경고로 남는다(조용히 굶지 않는다).
      await waitFor(
        () => warningsOf(h.paths, first.sid).some((w) => w.startsWith("note-failed:")),
        {
          timeoutMs: 10_000,
        },
      );
    } finally {
      await h.surface.stop();
    }
  }, 30_000);
});
