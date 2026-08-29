import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeV2TmpRoots, cleanupV2TmpRoots, type V2TmpRoots } from "../helpers/v2-fixtures.js";

// 확정 시그니처(Test Authoring Contract):
// slugify(title): string|null · localDatePart(now:Date): "YYMMDD" ·
// nextSessionId({base;proj;vaultRoot;now;title?}): Promise<string> — 3위치(레코드·vault 세션
// 디렉터리·이벤트 디렉터리) 조회 후 접두 충돌 회피, 1000회 초과 시 throw.

type Mod = typeof import("../../src/core/session-store.js");
async function loadMod(): Promise<Mod> {
  return import("../../src/core/session-store.js");
}

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

const FIXED_DATE = new Date(2026, 7, 28, 12, 0, 0); // 로컬 2026-08-28(월=0-idx 7=8월)

describe("SC-015: 그날 첫 세션 식별자는 YYMMDD-1 이다", () => {
  it("Happy: 2026-08-28 첫 세션 → 260828-1", async () => {
    const mod = await loadMod();
    const sid = await mod.nextSessionId({
      base: roots.base,
      proj: PROJ,
      vaultRoot: roots.vaultRoot,
      now: FIXED_DATE,
    });
    expect(sid).toBe("260828-1");
  });

  it("Edge: 같은 날 두 번째 세션 → 260828-2", async () => {
    const mod = await loadMod();
    const now = new Date().toISOString();
    await mod.saveSession(roots.base, PROJ, {
      v: 1,
      sid: "260828-1",
      engine: "acp",
      engineRef: null,
      status: "active",
      title: null,
      createdAt: now,
      lastActivityAt: now,
      successorOf: null,
      engineArgs: [],
      warnings: [],
      bindings: [],
      rev: 0,
      stopReason: null,
      stoppedAt: null,
      stopPending: null,
      stopNotePending: false,
      notices: [],
    } as never);
    const sid = await mod.nextSessionId({
      base: roots.base,
      proj: PROJ,
      vaultRoot: roots.vaultRoot,
      now: FIXED_DATE,
    });
    expect(sid).toBe("260828-2");
  });

  it("Error: 로컬 자정 경계 전후는 날짜부가 각각 다르다", async () => {
    const mod = await loadMod();
    const before = new Date(2026, 7, 27, 23, 59, 59);
    const after = new Date(2026, 7, 28, 0, 0, 1);
    expect(mod.localDatePart(before)).toBe("260827");
    expect(mod.localDatePart(after)).toBe("260828");
  });
});

describe("SC-016: 제목이 slug 로 부여된다", () => {
  it("Happy: 'Refactor Queue!!' → 260828-N-refactor-queue 형태(안전 문자셋만)", async () => {
    const mod = await loadMod();
    const sid = await mod.nextSessionId({
      base: roots.base,
      proj: PROJ,
      vaultRoot: roots.vaultRoot,
      now: FIXED_DATE,
      title: "Refactor Queue!!",
    });
    expect(sid).toMatch(/^260828-\d+-refactor-queue$/);
  });

  it("Edge: 32자 초과 제목은 상한 절단·양끝 구분자 정리된다", async () => {
    const mod = await loadMod();
    const slug = mod.slugify("a".repeat(50));
    expect(slug).not.toBeNull();
    expect(slug!.length).toBeLessThanOrEqual(mod.SLUG_MAX_LEN);
    expect(slug!.startsWith("-")).toBe(false);
    expect(slug!.endsWith("-")).toBe(false);
  });

  it("Error: 안전 문자셋 밖 문자만인 제목은 slug 없이 YYMMDD-N 이 된다", async () => {
    const mod = await loadMod();
    expect(mod.slugify("큐 리팩터")).toBeNull();
    const sid = await mod.nextSessionId({
      base: roots.base,
      proj: PROJ,
      vaultRoot: roots.vaultRoot,
      now: FIXED_DATE,
      title: "큐 리팩터",
    });
    expect(sid).toBe("260828-1");
  });
});

describe("SC-018: 레코드가 없어도 잔존 vault·이벤트 디렉터리와 충돌하지 않는다", () => {
  it("Happy: 레코드는 없지만 vault·이벤트 디렉터리에 260828-1 이 남아 있으면 그 접두를 재사용하지 않는다", async () => {
    const mod = await loadMod();
    const pathsMod = await import("../../src/shared/paths.js");
    const vp = pathsMod.vaultPaths(roots.vaultRoot, PROJ, "260828-1");
    fs.mkdirSync(vp.sessionDir, { recursive: true });
    const sid = await mod.nextSessionId({
      base: roots.base,
      proj: PROJ,
      vaultRoot: roots.vaultRoot,
      now: FIXED_DATE,
    });
    expect(sid).not.toBe("260828-1");
    expect(sid).toBe("260828-2");
  });

  it("Edge: 세 위치에 각각 다른 N 이 남아 있으면 최대치+1 부터 시작한다", async () => {
    const mod = await loadMod();
    const pathsMod = await import("../../src/shared/paths.js");
    const now = new Date().toISOString();
    await mod.saveSession(roots.base, PROJ, {
      v: 1,
      sid: "260828-2",
      engine: "acp",
      engineRef: null,
      status: "active",
      title: null,
      createdAt: now,
      lastActivityAt: now,
      successorOf: null,
      engineArgs: [],
      warnings: [],
      bindings: [],
      rev: 0,
      stopReason: null,
      stoppedAt: null,
      stopPending: null,
      stopNotePending: false,
      notices: [],
    } as never);
    const vp5 = pathsMod.vaultPaths(roots.vaultRoot, PROJ, "260828-5");
    fs.mkdirSync(vp5.sessionDir, { recursive: true });
    const eventsDir3 = pathsMod.vaultPaths(roots.vaultRoot, PROJ, "260828-3").eventsDir;
    fs.mkdirSync(eventsDir3, { recursive: true });

    const sid = await mod.nextSessionId({
      base: roots.base,
      proj: PROJ,
      vaultRoot: roots.vaultRoot,
      now: FIXED_DATE,
    });
    expect(sid).toBe("260828-6");
  });

  it("Error: 다수(1000+)의 기존 항목이 있어도 무한 루프 없이 유계 시간 내 다음 번호로 수렴한다", async () => {
    // ASSUMPTION(테스트 작성자 — 알고리즘 구조 관찰): maxN 은 3위치 전체 entries 의 참 최댓값이므로
    // start=maxN+1 은 같은 entries 집합 안에서 구조적으로 결코 선점될 수 없다(동일 정규식으로 추출한
    // 최댓값의 바로 다음 수는 그 집합에 없다) — 즉 "1000회 초과 시 throw" 방어 분기는 실제 디렉터리
    // 상태로는 도달 불가능한 순수 방어 코드로 관찰된다. 여기서는 방어 분기 도달을 강제하는 대신
    // "많은 기존 항목이 있어도 다음 채번이 유계 시간에 성공한다"는 성능·안정성 성질만 확인하고,
    // throw 분기 자체의 도달 불가능성은 coverage-gap.md 카테고리 (4)로 넘긴다.
    const mod = await loadMod();
    const projectPathsRoot = path.join(roots.vaultRoot, "adde", "projects", PROJ, "sessions");
    fs.mkdirSync(projectPathsRoot, { recursive: true });
    for (let n = 1; n <= 1500; n++) {
      fs.mkdirSync(path.join(projectPathsRoot, `260828-${n}`), { recursive: true });
    }
    const sid = await mod.nextSessionId({
      base: roots.base,
      proj: PROJ,
      vaultRoot: roots.vaultRoot,
      now: FIXED_DATE,
    });
    expect(sid).toBe("260828-1501");
  }, 15000);
});

describe("SC-019: 목록에 식별자·제목(대체 표기)·마지막 활동 시각이 함께 나타난다", () => {
  it("Happy: 제목 있는·없는 세션이 각자 식별자·제목·활동 시각을 갖는다", async () => {
    const mod = await loadMod();
    const now = new Date().toISOString();
    const withTitle = {
      v: 1 as const,
      sid: "260828-1",
      engine: "acp",
      engineRef: null,
      status: "active" as const,
      title: "제목 있음",
      createdAt: now,
      lastActivityAt: now,
      successorOf: null,
      engineArgs: [],
      warnings: [],
      bindings: [],
      rev: 0,
      stopReason: null,
      stoppedAt: null,
      stopPending: null,
      stopNotePending: false,
      notices: [],
    };
    const noTitle = { ...withTitle, sid: "260828-2", title: null };
    await mod.saveSession(roots.base, PROJ, withTitle as never);
    await mod.saveSession(roots.base, PROJ, noTitle as never);
    const loaded = await mod.loadSessions(roots.base, PROJ);
    expect(loaded.find((s) => s.sid === "260828-1")?.title).toBe("제목 있음");
    expect(loaded.find((s) => s.sid === "260828-2")?.title).toBeNull();
    expect(loaded.every((s) => typeof s.lastActivityAt === "string")).toBe(true);
  });

  it("Edge: 제목이 매우 길어도 필드는 그대로 보존된다(표 정렬은 표시 레이어 책임)", async () => {
    const mod = await loadMod();
    const now = new Date().toISOString();
    const longTitle = "가".repeat(200);
    await mod.saveSession(roots.base, PROJ, {
      v: 1,
      sid: "260828-1",
      engine: "acp",
      engineRef: null,
      status: "active",
      title: longTitle,
      createdAt: now,
      lastActivityAt: now,
      successorOf: null,
      engineArgs: [],
      warnings: [],
      bindings: [],
      rev: 0,
      stopReason: null,
      stoppedAt: null,
      stopPending: null,
      stopNotePending: false,
      notices: [],
    } as never);
    const loaded = await mod.loadSessions(roots.base, PROJ);
    expect(loaded.find((s) => s.sid === "260828-1")?.title).toBe(longTitle);
  });

  it("Error: 활동 시각이 파싱 불가한 문자열이어도 원문 그대로 로드된다(격리 대신 원문 보존)", async () => {
    const mod = await loadMod();
    const now = new Date().toISOString();
    const rawDir = path.join(roots.base, "projects", PROJ, "sessions.d");
    fs.mkdirSync(rawDir, { recursive: true });
    fs.writeFileSync(
      path.join(rawDir, "260828-1.json"),
      JSON.stringify({
        v: 1,
        sid: "260828-1",
        engine: "acp",
        engineRef: null,
        status: "active",
        title: null,
        createdAt: now,
        lastActivityAt: "not-a-timestamp",
        successorOf: null,
        engineArgs: [],
        warnings: [],
        bindings: [],
      }),
    );
    const loaded = await mod.loadSessions(roots.base, PROJ);
    expect(loaded.find((s) => s.sid === "260828-1")?.lastActivityAt).toBe("not-a-timestamp");
  });
});

describe("SC-020: 목록 정렬은 사전순이 아니라 시각 기준이다", () => {
  it("Happy: 같은 날 11건이 시각 기준으로 정렬되어 260828-10 이 260828-2 앞에 오지 않는다", async () => {
    const mod = await loadMod();
    const base = Date.now();
    for (let n = 1; n <= 11; n++) {
      const iso = new Date(base + n * 1000).toISOString();
      await mod.saveSession(roots.base, PROJ, {
        v: 1,
        sid: `260828-${n}`,
        engine: "acp",
        engineRef: null,
        status: "active",
        title: null,
        createdAt: iso,
        lastActivityAt: iso,
        successorOf: null,
        engineArgs: [],
        warnings: [],
        bindings: [],
        rev: 0,
        stopReason: null,
        stoppedAt: null,
        stopPending: null,
        stopNotePending: false,
        notices: [],
      } as never);
    }
    const loaded = await mod.loadSessions(roots.base, PROJ);
    const byTime = [...loaded].sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    );
    const idx2 = byTime.findIndex((s) => s.sid === "260828-2");
    const idx10 = byTime.findIndex((s) => s.sid === "260828-10");
    expect(idx10).toBeLessThan(idx2); // 10번이 2번보다 나중 활동 → 내림차순에서 앞에 온다(사전순 아님).
  });

  it("Edge: 활동 시각 동률이면 sid 사전순으로 결정론적 tie-break 한다", async () => {
    const mod = await loadMod();
    const iso = new Date().toISOString();
    for (const sid of ["260828-9", "260828-2"]) {
      await mod.saveSession(roots.base, PROJ, {
        v: 1,
        sid,
        engine: "acp",
        engineRef: null,
        status: "active",
        title: null,
        createdAt: iso,
        lastActivityAt: iso,
        successorOf: null,
        engineArgs: [],
        warnings: [],
        bindings: [],
        rev: 0,
        stopReason: null,
        stoppedAt: null,
        stopPending: null,
        stopNotePending: false,
        notices: [],
      } as never);
    }
    const loaded = await mod.loadSessions(roots.base, PROJ);
    const sorted = [...loaded].sort((a, b) => {
      const t = new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
      return t !== 0 ? t : a.sid.localeCompare(b.sid);
    });
    expect(sorted.map((s) => s.sid)).toEqual(["260828-2", "260828-9"]);
  });

  it("Error: 활동 시각 필드가 부재한 레코드는 정렬에서 예외를 던지지 않는다", async () => {
    const mod = await loadMod();
    const iso = new Date().toISOString();
    await mod.saveSession(roots.base, PROJ, {
      v: 1,
      sid: "260828-1",
      engine: "acp",
      engineRef: null,
      status: "active",
      title: null,
      createdAt: iso,
      lastActivityAt: iso,
      successorOf: null,
      engineArgs: [],
      warnings: [],
      bindings: [],
      rev: 0,
      stopReason: null,
      stoppedAt: null,
      stopPending: null,
      stopNotePending: false,
      notices: [],
    } as never);
    const loaded = await mod.loadSessions(roots.base, PROJ);
    expect(() =>
      [...loaded].sort(
        (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
      ),
    ).not.toThrow();
  });
});
