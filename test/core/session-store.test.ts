import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeV2TmpRoots, cleanupV2TmpRoots, type V2TmpRoots } from "../helpers/v2-fixtures.js";

// 확정 시그니처(design/tasks.md Test Authoring Contract):
// SessionRecord { v:1; sid; engine; engineRef; status: "active"|"hibernated"|"detached"|"archived";
//   title; createdAt; lastActivityAt; successorOf; engineArgs; warnings; bindings: Binding[] }
// newSid(now?, rand?): string   loadSessions(base, proj): Promise<SessionRecord[]>
// saveSession(base, proj, rec): Promise<void>
//
// src/core/session-store.ts 는 T003 산출물로 AUTHORING 시점에 미존재 — 개별 테스트 단위로
// 지연 import 해 파일 전체 수집 붕괴를 방지한다(PROC-R15).

type SessionStoreMod = typeof import("../../src/core/session-store.js");
async function loadSessionStore(): Promise<SessionStoreMod> {
  return import("../../src/core/session-store.js");
}

let roots: V2TmpRoots;
const PROJ = "p1";

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

function fixtureRecord(
  mod: SessionStoreMod,
  overrides: Partial<Awaited<ReturnType<SessionStoreMod["loadSessions"]>>[number]> = {},
) {
  const now = new Date().toISOString();
  return {
    v: 1 as const,
    sid: mod.newSid(),
    engine: "acp",
    engineRef: null,
    status: "active" as const,
    title: null,
    createdAt: now,
    lastActivityAt: now,
    successorOf: null,
    engineArgs: [],
    warnings: [],
    bindings: [],
    ...overrides,
  };
}

describe("SC-003: 4가지 세션 상태가 구분되어 조회된다", () => {
  it("Happy: active·hibernated·detached·archived 4개 세션이 각자 상태로 로드된다", async () => {
    const mod = await loadSessionStore();
    const statuses = ["active", "hibernated", "detached", "archived"] as const;
    for (const status of statuses) {
      await mod.saveSession(roots.base, PROJ, fixtureRecord(mod, { status }));
    }
    const loaded = await mod.loadSessions(roots.base, PROJ);
    expect(loaded).toHaveLength(4);
    expect(new Set(loaded.map((s) => s.status))).toEqual(new Set(statuses));
  });

  it("Edge: archived 세션도 목록에 포함되어 읽기 전용으로 조회 가능하다", async () => {
    const mod = await loadSessionStore();
    const rec = fixtureRecord(mod, { status: "archived", successorOf: null });
    await mod.saveSession(roots.base, PROJ, rec);
    const loaded = await mod.loadSessions(roots.base, PROJ);
    expect(loaded.find((s) => s.sid === rec.sid)?.status).toBe("archived");
  });

  it("Error: 손상된 세션 레코드 1건이 나머지 로드를 막지 않는다(격리 — 실측: 손상분은 목록에서 제외되고 로그로만 표면화)", async () => {
    const mod = await loadSessionStore();
    const good = fixtureRecord(mod, { status: "active" });
    await mod.saveSession(roots.base, PROJ, good);
    // 손상 파일을 직접 sessions.d 에 주입 — saveSession API 를 거치지 않은 파손 시나리오.
    const sessionsDir = path.join(roots.base, "projects", PROJ, "sessions.d");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "corrupt-broken.json"), "{not json");

    const loaded = await mod.loadSessions(roots.base, PROJ);
    // 정상 레코드 로드는 손상 파일 존재와 무관하게 성공한다(A-P002 비침해 — 격리).
    expect(loaded.find((s) => s.sid === good.sid)).toEqual(good);
    expect(loaded).toHaveLength(1); // 손상분은 목록에 나타나지 않는다(loadSessions 실측 동작)
  });
});

describe("newSid — 정렬 가능·안전 세그먼트 형식(ADR-004)", () => {
  it("Happy: `<base36 ms>-<8 hex>` 형식이고 안전 세그먼트 문자셋만 포함한다", async () => {
    const mod = await loadSessionStore();
    const sid = mod.newSid();
    expect(sid).toMatch(/^[a-z0-9]+-[0-9a-f]{8}$/);
  });

  it("Edge: 같은 now 값이 주입돼도 rand 주입값이 다르면 sid 가 달라진다", async () => {
    const mod = await loadSessionStore();
    const now = 1_700_000_000_000;
    const a = mod.newSid(now, () => "aaaaaaaa");
    const b = mod.newSid(now, () => "bbbbbbbb");
    expect(a).not.toBe(b);
  });
});

describe("saveSession — 바인딩 배열 왕복 보존(ADR-013)", () => {
  it("Happy: 저장한 바인딩 배열이 로드 시 그대로 보존된다", async () => {
    const mod = await loadSessionStore();
    const rec = fixtureRecord(mod, {
      bindings: [{ surface: "markdown", address: "sessions/s1/inbox.md", sid: "s1" }],
    });
    await mod.saveSession(roots.base, PROJ, rec);
    const loaded = await mod.loadSessions(roots.base, PROJ);
    expect(loaded.find((s) => s.sid === rec.sid)?.bindings).toEqual(rec.bindings);
  });
});
