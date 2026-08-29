import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeV2TmpRoots, cleanupV2TmpRoots, type V2TmpRoots } from "../helpers/v2-fixtures.js";

// 확정 시그니처(design/tasks.md Test Authoring Contract):
// export type SessionStatus = "active" | "hibernated" | "stopped" | "detached";
// 레거시 wire 값 `archived` 는 로드 시 `stopped` 로 정규화한다(ADR-001) — 로드 경로에 save 가
// 없으므로(research 사실 1) 정규화는 파일을 고쳐 쓰지 않는다(SC-002 바이트 불변).
//
// src/core/session-store.ts 는 development(T002) 산출물로 AUTHORING 시점에 필드가 미완일 수
// 있어 개별 테스트 단위로 지연 import 한다(PROC-R15).

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

function sessionsDir(): string {
  return path.join(roots.base, "projects", PROJ, "sessions.d");
}

/** saveSession() 을 거치지 않고 raw wire JSON 을 직접 써 legacy·손상 레코드를 재현한다. */
function writeRawRecord(sid: string, raw: Record<string, unknown>): string {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  const filePath = path.join(sessionsDir(), `${sid}.json`);
  fs.writeFileSync(filePath, JSON.stringify(raw, null, 2) + "\n");
  return filePath;
}

function baseRawFields(sid: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    v: 1,
    sid,
    engine: "acp",
    engineRef: null,
    title: null,
    createdAt: now,
    lastActivityAt: now,
    successorOf: null,
    engineArgs: [],
    warnings: [],
    bindings: [],
  };
}

describe("SC-001: 상태 값 stopped 가 유효값으로 수락된다", () => {
  it("Happy: status:'stopped' 레코드 로드 → 목록에 stopped 로 나타난다", async () => {
    const mod = await loadSessionStore();
    const sid = "sc001-happy";
    writeRawRecord(sid, { ...baseRawFields(sid), status: "stopped" });
    const loaded = await mod.loadSessions(roots.base, PROJ);
    expect(loaded.find((s) => s.sid === sid)?.status).toBe("stopped");
  });

  it("Edge: 4상태(active·hibernated·stopped·detached) 전부 왕복 로드된다", async () => {
    const mod = await loadSessionStore();
    const statuses = ["active", "hibernated", "stopped", "detached"] as const;
    for (const status of statuses) {
      writeRawRecord(`sc001-${status}`, { ...baseRawFields(`sc001-${status}`), status });
    }
    const loaded = await mod.loadSessions(roots.base, PROJ);
    for (const status of statuses) {
      expect(loaded.find((s) => s.sid === `sc001-${status}`)?.status).toBe(status);
    }
  });

  it("Error: 미지 상태 문자열 레코드는 격리되고(로드 계속) 나머지는 정상 로드된다", async () => {
    const mod = await loadSessionStore();
    writeRawRecord("sc001-good", { ...baseRawFields("sc001-good"), status: "active" });
    writeRawRecord("sc001-bad", { ...baseRawFields("sc001-bad"), status: "no-such-status" });
    const loaded = await mod.loadSessions(roots.base, PROJ);
    expect(loaded.find((s) => s.sid === "sc001-good")?.status).toBe("active");
    expect(loaded.find((s) => s.sid === "sc001-bad")).toBeUndefined();
  });
});

describe("SC-002: 레거시 archived 레코드는 로드 시 stopped 로 해석되고 파일은 불변이다", () => {
  it("Happy: status:'archived' 레코드 로드 → stopped 로 나타나고 로드 후 파일 바이트가 동일하다", async () => {
    const mod = await loadSessionStore();
    const sid = "sc002-happy";
    const filePath = writeRawRecord(sid, { ...baseRawFields(sid), status: "archived" });
    const before = fs.readFileSync(filePath);

    const loaded = await mod.loadSessions(roots.base, PROJ);
    expect(loaded.find((s) => s.sid === sid)?.status).toBe("stopped");

    const after = fs.readFileSync(filePath);
    expect(after.equals(before)).toBe(true); // 로드 경로에 save 가 없다(바이트 불변, SC-002).
  });

  it("Edge: archived + 신설 필드(rev·stopReason 등) 부재 조합도 안전하게 stopped 로 해석된다", async () => {
    const mod = await loadSessionStore();
    const sid = "sc002-edge";
    // 006 이전(legacy) 레코드 형태 그대로 — rev·stopReason·stoppedAt·stopPending·stopNotePending·
    // notices·storageLayout 등 신설 필드가 전부 부재.
    writeRawRecord(sid, { ...baseRawFields(sid), status: "archived" });
    const loaded = await mod.loadSessions(roots.base, PROJ);
    const rec = loaded.find((s) => s.sid === sid);
    expect(rec?.status).toBe("stopped");
    expect(rec).toBeDefined();
  });

  it("Error: 손상된 JSON 레코드 1건이 있어도 archived 레코드 로드는 계속된다", async () => {
    const mod = await loadSessionStore();
    const sid = "sc002-corrupt-sibling";
    writeRawRecord(sid, { ...baseRawFields(sid), status: "archived" });
    fs.mkdirSync(sessionsDir(), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), "broken.json"), "{not json");

    const loaded = await mod.loadSessions(roots.base, PROJ);
    expect(loaded.find((s) => s.sid === sid)?.status).toBe("stopped");
    expect(loaded).toHaveLength(1); // 손상분은 목록에서 제외된다(격리, A-P002 비침해).
  });
});
