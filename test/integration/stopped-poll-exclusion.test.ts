import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// design.md §2 knownSids() — 중지·떨어짐 세션은 in-memory 레코드 판정만으로 폴 대상에서 제외되어
// 입력 노트·승인 디렉터리 파일 접근이 tick 당 0회다(FR-002·NFR-001). 예외는 stopNotePending(노트
// 교체 재시도 창)뿐이다. fs 접근 자체를 계수해야 판정 가능하므로 node:fs/promises 를 스파이한다
// (ESM 네임스페이스 직접 spyOn 은 read-only 바인딩이라 실패 — blobs.test.ts 선례와 동일 패턴).

const readCalls = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (p: unknown, ...rest: unknown[]) => {
      readCalls.paths.push(String(p));
      return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    },
    readdir: async (p: unknown, ...rest: unknown[]) => {
      readCalls.paths.push(String(p));
      return (actual.readdir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    },
  };
});

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
  readCalls.paths = [];
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

function accessCountFor(sid: string): number {
  const marker = path.join("sessions", sid);
  return readCalls.paths.filter((p) => p.includes(marker)).length;
}

async function makeSurface(overrides: Record<string, unknown> = {}) {
  const [sessionStore, sessionManagerMod, pathsMod, surfaceMod, routerMod] = await Promise.all([
    import("../../src/core/session-store.js"),
    import("../../src/core/session-manager.js"),
    import("../../src/shared/paths.js"),
    import("../../src/surfaces/markdown/index.js"),
    import("../../src/core/router.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  // fullNative caps 는 permission:"callback" 이라 실 큐→TurnRunner 경유(투명 재개 등)로 디스패치된
  // 턴은 게이트를 반드시 거친다. `askPermission` 은 통지 훅일 뿐(결정은 별도 API) — 결정을 아무도
  // 제출하지 않으면 게이트가 `DEFAULT_GATE_TIMEOUT_MS`(10분)까지 대기해 테스트가 하드 타임아웃으로
  // 멈춘다(SC-005 관측 — note-action-surfacing.test.ts 의 askPermission 자동 승인 배선과 동형으로
  // 해소). holder 는 생성 순서 문제 없이 sm 참조를 넘긴다.
  const holder: { sm?: import("../../src/core/session-manager.js").SessionManagerWithLoad } = {};
  const deps = makeSessionManagerDeps(
    roots,
    PROJ,
    { acp: fakeDriver.descriptor },
    {
      askPermission: async (sid: string, req: { reqId: string }) => {
        holder.sm?.resolvePermissionDecision(sid, req.reqId, "allow");
      },
      ...overrides,
    },
  );
  const sm = sessionManagerMod.createSessionManager(deps);
  bindSessionManager(deps, sm);
  holder.sm = sm;
  const smBoot = sm as unknown as { load(): Promise<void>; resumeAllOnBoot(): Promise<unknown> };
  await smBoot.load();
  // load() 자체는 records 만 채우고 TurnRunner 를 무장(armRunner)하지 않는다(4779aae 부터의 기존
  // 계약 — 실 부팅 순서는 supervisor.ts 가 load() 다음에 resumeAllOnBoot() 를 호출해 active·
  // hibernated 러너를 무장한다, resume.test.ts 등 선례). 이 호출이 없으면 hibernated 세션의 큐가
  // TurnRunner 부재로 영원히 소비되지 않는다(SC-005 관측).
  await smBoot.resumeAllOnBoot();
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
    approvalsDir: (sid: string) => pathsMod.vaultPaths(roots.vaultRoot, PROJ, sid).approvalsDir,
  };
}

/** 별 프로세스(CLI)가 세션 레코드를 쓴 상태를 만든다 — 데몬 로드 이전에 CLI 가 레코드를 확정한 상태 재현. */
async function writeRecord(sid: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const store = await import("../../src/core/session-store.js");
  const now = new Date().toISOString();
  await store.saveSession(roots.base, PROJ, {
    v: 1,
    sid,
    engine: "acp",
    engineRef: null,
    status: "active",
    title: null,
    createdAt: now,
    lastActivityAt: now,
    successorOf: null,
    engineArgs: [],
    warnings: [],
    bindings: [{ surface: "markdown", address: `sessions/${sid}/inbox.md`, sid }],
    rev: 0,
    stopReason: null,
    stoppedAt: null,
    stopPending: null,
    stopNotePending: false,
    notices: [],
    ...overrides,
  } as never);
}

const TICK_WAIT_MS = 4_500; // POLL_INTERVAL_MS(2000) * 2 + 여유(inbox-no-churn.test.ts 선례).

describe("SC-003: 중지 세션은 폴 tick 에서 파일 접근이 0회다", () => {
  it("Happy: 중지 세션 1개만 있는 프로젝트에서 tick 2회에도 그 세션 노트·승인 접근이 0회", async () => {
    await writeRecord("sess-stopped", { status: "stopped", stoppedAt: new Date().toISOString() });
    const h = await makeSurface();
    await h.surface.start(undefined as never);
    try {
      await new Promise((r) => setTimeout(r, TICK_WAIT_MS));
      expect(accessCountFor("sess-stopped")).toBe(0);
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);

  it("Edge: 중지·활성 혼재 시 활성 세션만 접근되고 중지 세션은 0회다", async () => {
    await writeRecord("sess-stopped-2", { status: "stopped", stoppedAt: new Date().toISOString() });
    await writeRecord("sess-active-1", { status: "active" });
    const h = await makeSurface();
    await h.surface.start(undefined as never);
    try {
      await waitFor(() => accessCountFor("sess-active-1") > 0, { timeoutMs: 6_000 });
      expect(accessCountFor("sess-stopped-2")).toBe(0);
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);

  it("Error: 중지 세션의 노트 파일이 아예 없어도 새로 생성되지 않는다", async () => {
    await writeRecord("sess-stopped-nonote", {
      status: "stopped",
      stoppedAt: new Date().toISOString(),
    });
    const h = await makeSurface();
    await h.surface.start(undefined as never);
    try {
      await new Promise((r) => setTimeout(r, TICK_WAIT_MS));
      const fs = await import("node:fs");
      expect(fs.existsSync(h.inboxPath("sess-stopped-nonote"))).toBe(false);
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});

describe("SC-004: 떨어진 세션은 폴 tick 에서 파일 접근이 0회다(stopNotePending 예외)", () => {
  it("Happy: 떨어진 세션 tick → 접근 0회", async () => {
    await writeRecord("sess-detached-1", {
      status: "detached",
      stopReason: "resume-failed: boom",
    });
    const h = await makeSurface();
    await h.surface.start(undefined as never);
    try {
      await new Promise((r) => setTimeout(r, TICK_WAIT_MS));
      expect(accessCountFor("sess-detached-1")).toBe(0);
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);

  it("Edge: 노트 교체가 1회 실패해도 L4 접근은 0회이고, 유계 시간 내 중지 배너로 수렴한 뒤 되돌려지지 않는다", async () => {
    // design.md §노트 교체 재시도 관측 계약(ADR-017, 개정 2026-08-28) — 재시도 주체는 L3(control
    // 드레인 tick)이고 L4 폴 집합에는 예외를 두지 않는다. 재시도 주체·계층·tick 횟수는 단언하지
    // 않고 [MUST] 결과 수렴·되돌림 없음·폴 격리·부분 실패 표면 4항만 관측한다.
    const sid = "sess-detached-pending";
    await writeRecord(sid, {
      status: "detached",
      stopReason: "resume-failed: boom",
      // 이미 1회 실패한 상태를 Given 으로 재현 — L3 control tick 이 이 상태를 발견해 재시도한다.
      stopNotePending: true,
      warnings: ["stop-note-failed: simulated prior failure"],
    });
    // L3 재시도가 실제로 노트를 쓰게 하려면 onStopApplied 훅을 실 Surface 함수로 배선해야 한다
    // (design.md 인터페이스 계약 — surfaces/markdown/index.ts 의 standalone export). 공유
    // makeSurface() 자체는 건드리지 않고, 이 케이스에서만 overrides 로 주입한다.
    const surfaceIndexMod = await import("../../src/surfaces/markdown/index.js");
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const h = await makeSurface({
      onStopApplied: async (s: string, info: unknown) =>
        surfaceIndexMod.writeStoppedNote(
          { vaultRoot: roots.vaultRoot, proj: PROJ, sid: s },
          info as never,
        ),
    });
    await h.surface.start(undefined as never);
    try {
      // [MUST] 부분 실패 표면 — 아직 L3 control tick(2초 주기)이 돌기 전이면 경고·플래그가 잔존한다.
      expect(h.sm.get(sid)?.stopNotePending).toBe(true);
      expect(h.sm.get(sid)?.warnings.some((w) => w.startsWith("stop-note-failed:"))).toBe(true);

      // [MUST] 결과 수렴 — 유계 시간 내에 노트가 중지 배너 형태(센티널·팔레트 0건·send 0건)가 된다.
      const fs = await import("node:fs/promises");
      await waitFor(
        async () => {
          try {
            const content = await fs.readFile(h.inboxPath(sid), "utf8");
            return (
              content.includes(inbox.STOPPED_SENTINEL) &&
              !content.includes("📤 send") &&
              !/\[ \]/.test(content)
            );
          } catch {
            return false;
          }
        },
        { timeoutMs: 10_000 },
      );

      // [MUST] 폴 격리 — approvals 디렉터리(L3 는 절대 접근하지 않는 L4 전용 경로)에 대한 접근이
      // 0회다. inbox.md 자체는 L3 재시도도 읽으므로(같은 경로) 되돌림 없음 쪽에서 간접 증명한다.
      const approvalsMarker = path.join("sessions", sid, "approvals");
      expect(readCalls.paths.filter((p) => p.includes(approvalsMarker)).length).toBe(0);

      // [MUST] 부분 실패 해소 — 성공 후에는 플래그·경고가 해소된다.
      await waitFor(() => h.sm.get(sid)?.stopNotePending === false, { timeoutMs: 5_000 });
      expect(h.sm.get(sid)?.warnings.some((w) => w.startsWith("stop-note-failed:"))).toBe(false);

      // [MUST] 되돌림 없음 — 추가 폴 tick 이 지나도 정상 스켈레톤(팔레트·send)으로 되돌아가지 않는다.
      await new Promise((r) => setTimeout(r, TICK_WAIT_MS));
      const later = await fs.readFile(h.inboxPath(sid), "utf8");
      expect(later.includes(inbox.STOPPED_SENTINEL)).toBe(true);
      expect(later).not.toContain("📤 send");
      expect(/\[ \]/.test(later)).toBe(false);
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 20000);

  it("Error: 떨어짐 노트 파일이 부재해도 예외 없이 스킵된다", async () => {
    await writeRecord("sess-detached-nonote", {
      status: "detached",
      stopReason: "resume-failed: boom",
    });
    const h = await makeSurface();
    await expect(h.surface.start(undefined as never)).resolves.toBeUndefined();
    await h.surface.stop();
    await h.sm.shutdown();
  }, 15000);
});

describe("SC-005: 유휴 세션은 제외 대상이 아니다(회귀 가드)", () => {
  it("Happy: 유휴 세션 노트의 체크된 send → 지시가 적재되고 투명 재개된다", async () => {
    await writeRecord("sess-hibernated-1", { status: "hibernated" });
    const h = await makeSurface();
    const fs = await import("node:fs/promises");
    await h.surface.start(undefined as never);
    try {
      await waitFor(async () => {
        try {
          await fs.access(h.inboxPath("sess-hibernated-1"));
          return true;
        } catch {
          return false;
        }
      });
      const content = await fs.readFile(h.inboxPath("sess-hibernated-1"), "utf8");
      const checked = content.replace("- [ ] 📤 send", "지시\n- [x] 📤 send");
      await fs.writeFile(h.inboxPath("sess-hibernated-1"), checked);
      await waitFor(async () => {
        const rec = h.sm.get("sess-hibernated-1");
        return rec?.status === "active";
      });
      expect(h.sm.get("sess-hibernated-1")?.status).toBe("active");
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);

  it("Edge: 유휴·중지 세션이 공존하면 유휴만 처리되고 중지는 접근되지 않는다", async () => {
    await writeRecord("sess-hib-2", { status: "hibernated" });
    await writeRecord("sess-stop-3", { status: "stopped", stoppedAt: new Date().toISOString() });
    const h = await makeSurface();
    await h.surface.start(undefined as never);
    try {
      await waitFor(() => accessCountFor("sess-hib-2") > 0, { timeoutMs: 6_000 });
      expect(accessCountFor("sess-stop-3")).toBe(0);
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);

  it("Error: 유휴 세션 재개 실패 시 detached 로 전이되고 지시는 보존된다", async () => {
    await writeRecord("sess-hib-fail", { status: "hibernated", engineRef: "prior-ref" });
    const h = await makeSurface();
    h.fakeDriver.control.failNextOpen("resume boot failure");
    const fs = await import("node:fs/promises");
    await h.surface.start(undefined as never);
    try {
      await waitFor(async () => {
        try {
          await fs.access(h.inboxPath("sess-hib-fail"));
          return true;
        } catch {
          return false;
        }
      });
      const content = await fs.readFile(h.inboxPath("sess-hib-fail"), "utf8");
      const checked = content.replace("- [ ] 📤 send", "지시 보존 확인\n- [x] 📤 send");
      await fs.writeFile(h.inboxPath("sess-hib-fail"), checked);
      await waitFor(() => h.sm.get("sess-hib-fail")?.status === "detached", { timeoutMs: 8_000 });
      expect(h.sm.get("sess-hib-fail")?.status).toBe("detached");
      // 지시(초안)는 소실되지 않는다 — enqueue 실패 시 마커 미기록으로 재시도 가능 상태 보존(design.md
      // 안전망 표 "노트 교체 실패" 동형: 실패는 흡수돼도 사용자 입력은 흡수되지 않는다).
      const after = await fs.readFile(h.inboxPath("sess-hib-fail"), "utf8");
      expect(after).toContain("지시 보존 확인");
    } finally {
      await h.surface.stop();
      await h.sm.shutdown();
    }
  }, 15000);
});
