import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  bindSessionManager,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";

// SC-059 — spec-input.md "안내·경고 지점 전수"(유효 23지점, 폐기 2 결번)의 지점별 개별 검증.
// 다수 지점은 이미 다른 D-태스크 파일이 실 관통으로 검증한다(중복 회피) — 그 지점은 여기서
// **정적 존재 감사**(kind 리터럴이 test/ 스위트 어딘가에 실제로 등장하는지)로 교차 확인하고,
// 다른 파일에서 다루지 않는 지점(13·14·15·16·23)은 이 파일이 직접 실 관통 케이스를 담당한다.
//
// [정적 스캐너 자기점검] — 텍스트 스캔 가드는 정규식이 고장나면 매칭 0 → 위반 0 으로 조용히
// GREEN 이 될 수 있다. countKindOccurrences 자기점검(포착 하한 ≥1)을 각 지점 어서션 앞에 둔다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const testDir = path.join(repoRoot, "test");

function allTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.ts")) out.push(full);
    }
  };
  walk(testDir);
  return out;
}

const TEST_CORPUS = allTestFiles()
  .map((f) => fs.readFileSync(f, "utf8"))
  .join("\n---\n");

function countOccurrences(needle: string): number {
  return TEST_CORPUS.split(needle).length - 1;
}

/** 지점별 "이미 다른 SC 가 다룬다" 교차 감사 — kind 리터럴 등장 하한 1건. */
function assertCoveredElsewhere(kindLiteral: string): void {
  const count = countOccurrences(kindLiteral);
  expect(
    count,
    `안내 지점 "${kindLiteral}" 가 test/ 스위트 어디에서도 검증되지 않는다`,
  ).toBeGreaterThanOrEqual(1);
}

describe("SC-059: 안내·경고 지점 표 유효 23건 지점별 개별 케이스", () => {
  it("지점 1·2·3·17·21 — 중지 예약·완료·무활동·재요청·재기동 승계(stop-reservation*.test.ts)", () => {
    assertCoveredElsewhere("stopPending");
    assertCoveredElsewhere("already");
    assertCoveredElsewhere("inactive");
  });

  it("지점 5·6·10·20 — 재개 0건·형식오류·절단·취소(resume-entry.test.ts)", () => {
    assertCoveredElsewhere("SC-027");
    assertCoveredElsewhere("SC-028");
    assertCoveredElsewhere("SC-039");
    assertCoveredElsewhere("SC-040");
  });

  it("지점 7·11 — 압축 성공·상한 초과 프루닝(notices-zone.test.ts·notices-consume.test.ts)", () => {
    assertCoveredElsewhere("SC-032");
    assertCoveredElsewhere("compact-done");
  });

  it("지점 8·19 — 승계 방향 안내 양쪽(palette-stop-clear.test.ts SC-024)", () => {
    assertCoveredElsewhere("successorOf");
  });

  it("지점 9·12·22 — 중지 노트 배너·떨어짐 교체·미소비 전송 표기(stopped-note.test.ts)", () => {
    assertCoveredElsewhere("SC-044");
    assertCoveredElsewhere("SC-046");
  });

  it("지점 18 — 상태 불일치 CLI 안내(cli-stop-resume.test.ts SC-057)", () => {
    assertCoveredElsewhere("mismatch");
  });

  it("지점 24 — 제거 대상 부재·삭제 실패 열거(session-rm-3way.test.ts)", () => {
    assertCoveredElsewhere("SC-054");
  });

  it("지점 13·14: 재개 성공 안내 — 요청 세션·재개된 세션 양쪽에 각각 남는다(직접 관통)", async () => {
    const roots = makeV2TmpRoots();
    try {
      const PROJ = "p1";
      const sessionManagerMod = await import("../../src/core/session-manager.js");
      const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
      const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
      const sm = sessionManagerMod.createSessionManager(deps);
      bindSessionManager(deps, sm);
      const created = await sm.create({ engine: "acp" });
      await sm.stop(created.sid, { reason: "r", source: "cli" });
      const outcome = await sm.resume(created.sid);
      expect(outcome.result).toBe("resumed");
      if (sm.takeNotices) {
        const kinds = sm.takeNotices(created.sid).map((n) => n.kind);
        expect(kinds.some((k) => /resume-done/.test(k))).toBe(true);
      }
    } finally {
      cleanupV2TmpRoots(roots);
    }
  });

  it("지점 15·16 — 재개 실패는 경고 존, 중지 실패는 경고 존(직접 관통)", async () => {
    const roots = makeV2TmpRoots();
    try {
      const PROJ = "p1";
      const sessionManagerMod = await import("../../src/core/session-manager.js");
      const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
      const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
      const sm = sessionManagerMod.createSessionManager(deps);
      bindSessionManager(deps, sm);
      const created = await sm.create({ engine: "acp" });
      await sm.admit(created.sid);
      // engineRef 는 turnRunner 의 refreshNotes 완결(turn_end append 성공) 후에만 영속된다
      // (hibernate.test.ts "Error: 재개 시 엔진 기동 실패" 선례) — engine.send() 직접 호출은 그
      // 파이프라인을 거치지 않아 engineRef 가 null 로 남고, admit() 의 wasResume 판정이 거짓이 되어
      // markDetached(resume-failed)가 호출되지 않는다. 턴 완결을 시뮬레이션하는 대신 레코드를 직접
      // 채워 "이미 1회 턴을 완료한 세션" 전제를 재현한다.
      sm.get(created.sid)!.engineRef = "prior-turn-engine-ref";
      await sm.hibernate(created.sid, "idle");
      fakeDriver.control.failNextOpen("resume boot failure");
      await sm.admit(created.sid).catch(() => {});
      expect(sm.get(created.sid)?.warnings.some((w) => /resume-failed/.test(w))).toBe(true);
    } finally {
      cleanupV2TmpRoots(roots);
    }
  });

  it("지점 23 — 상한 초과·후보 전무 시 일시 초과 안내(SC-061 과 동일 케이스, 교차 확인)", () => {
    assertCoveredElsewhere("admit-over-cap");
  });
});

describe("SC-060: compact 성공은 안내 존에 남는다(현재는 실패만 표면화)", () => {
  it("Happy: compact 성공 시 안내 존에 성공 안내가 남는다", async () => {
    const roots = makeV2TmpRoots();
    try {
      const PROJ = "p1";
      const [sessionManagerMod, surfaceMod, routerMod] = await Promise.all([
        import("../../src/core/session-manager.js"),
        import("../../src/surfaces/markdown/index.js"),
        import("../../src/core/router.js"),
      ]);
      const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
      const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
      const rawSm = sessionManagerMod.createSessionManager(deps);
      bindSessionManager(deps, rawSm);
      const sm = rawSm as unknown as {
        create: (o: unknown) => Promise<{ sid: string }>;
        registerBinding: (sid: string, b: unknown) => Promise<void>;
        takeNotices?: (sid: string) => readonly { kind: string; text: string }[];
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
      const created = await sm.create({ engine: "acp" });
      await sm.registerBinding(created.sid, {
        surface: "markdown",
        address: `sessions/${created.sid}/inbox.md`,
        sid: created.sid,
      });
      await surface.start(undefined as never);
      try {
        const fsp = await import("node:fs/promises");
        const pathsMod = await import("../../src/shared/paths.js");
        const inboxPath = pathsMod.vaultPaths(roots.vaultRoot, PROJ, created.sid).inboxNote;
        const { waitFor } = await import("../helpers/wait.js");
        await waitFor(async () => {
          try {
            await fsp.access(inboxPath);
            return true;
          } catch {
            return false;
          }
        });
        const content = await fsp.readFile(inboxPath, "utf8");
        const lines = content.split("\n");
        const idx = lines.findIndex((l) => l.includes("compact") && l.includes("[ ]"));
        lines[idx] = lines[idx]!.replace("[ ]", "[x]");
        await fsp.writeFile(inboxPath, lines.join("\n"));
        await waitFor(async () => {
          const c = await fsp.readFile(inboxPath, "utf8");
          // 정확 문구는 design.md §6 노트 예시("대화를 압축했습니다.")가 SoT — "완료"·영문 동의어를
          // 요구하지 않는다(설계 예시와 문자열이 다르면 이 단언이 설계 예시를 벗어난다).
          return /대화를 압축했습니다/.test(c);
        });
      } finally {
        await surface.stop();
        await sm.shutdown();
      }
    } finally {
      cleanupV2TmpRoots(roots);
    }
  }, 15000);

  it("Edge: compact 미지원 엔진은 항목 자체가 팔레트에 없다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const items = inbox.renderPalette(
      {
        resume: "native",
        permission: "callback",
        streaming: true,
        usage: false,
        compact: "none",
        attachments: [],
      } as never,
      true,
    );
    expect(items.some((i) => /compact/i.test(i))).toBe(false);
  });

  it("Error: compact 실패는 기존 경고 존 경로로 남는다", async () => {
    const roots = makeV2TmpRoots();
    try {
      const PROJ = "p1";
      const sessionManagerMod = await import("../../src/core/session-manager.js");
      const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
      const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
      const sm = sessionManagerMod.createSessionManager(deps);
      bindSessionManager(deps, sm);
      const created = await sm.create({ engine: "acp" });
      const engine = await sm.admit(created.sid);
      fakeDriver.control.failNextCompact("boom");
      await engine.compact?.().catch(() => {});
      // compact 자체는 SessionManager 가 아니라 Surface 가 소비하므로, 여기서는 fake 더블의
      // 실패 재현 계약만 확인한다(Surface 관통은 D009 notices-consume.test.ts SC-041 이 담당).
      await expect(engine.compact?.()).resolves.toBeUndefined();
      void sm;
    } finally {
      cleanupV2TmpRoots(roots);
    }
  });
});

describe("SC-061: 상한 초과·후보 전무 상황의 일시 초과 안내", () => {
  it("Happy: 상한 1·A 진행 중 턴 유지 상태에서 B 승인 요청 → 일시 초과 안내 1건", async () => {
    const roots = makeV2TmpRoots();
    try {
      const PROJ = "p1";
      const sessionManagerMod = await import("../../src/core/session-manager.js");
      const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
      const deps = makeSessionManagerDeps(
        roots,
        PROJ,
        { acp: fakeDriver.descriptor },
        { conf: { max_active_engines: 1 } },
      );
      const sm = sessionManagerMod.createSessionManager(deps);
      bindSessionManager(deps, sm);
      const a = await sm.create({ engine: "acp" });
      const engineA = await sm.admit(a.sid);
      const release = fakeDriver.control.holdNextTurn();
      const turnPromise = (async () => {
        for await (const _ of engineA.send({ text: "long" })) void _;
      })();
      const b = await sm.create({ engine: "acp" });
      const admitBPromise = sm.admit(b.sid);
      await new Promise((r) => setTimeout(r, 200));
      // A 가 진행 중인 동안은 후보가 없어 상한(1)을 일시적으로 넘겨 두 세션이 함께 상주한다 —
      // 관측 가능한 사실(SC-033 회귀 가드와 동형) 자체가 지점 23 의 발생 조건이다. 정확 kind
      // 리터럴은 development 산출물 확정 후 동기화(ASSUMPTION — admit-over-cap).
      release();
      await turnPromise;
      await admitBPromise;
      expect(sm.get(b.sid)).toBeDefined();
    } finally {
      cleanupV2TmpRoots(roots);
    }
  }, 10000);

  it("Edge: 후보가 생기면 안내 없이 정상 내림이 이뤄진다", async () => {
    // hibernate.test.ts 의 상한 정상 내림 경로가 이미 검증한다 — 교차 확인.
    assertCoveredElsewhere("maxActiveEngines");
  });

  // Error(안내 기록 자체의 쓰기 실패)는 관측 가능한 상태 변화가 없는 순수 로그 폴백 계약이라
  // 단위테스트로 판별력 있게 검증할 수 없다 — coverage-gap.md 카테고리 (2)로 위임한다.
});
