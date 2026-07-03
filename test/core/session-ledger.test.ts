import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { lanePaths } from "../../src/shared/paths.js";
import {
  readLedger,
  recordSession,
  touchSession,
  resolveResumeControl,
  formatWhen,
} from "../../src/core/session-ledger.js";
import type { SessionEntry } from "../../src/core/session-ledger.js";

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-ledger-"));
  paths = lanePaths(tmpBase, "p", "lane");
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("세션 장부 기록·갱신", () => {
  it("recordSession 은 신규 항목을 만들고 재호출 시 lastActivityAt 만 갱신한다(중복 없음)", async () => {
    await recordSession(paths, "s1");
    await recordSession(paths, "s1");
    const entries = await readLedger(paths);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe("s1");
  });

  it("touchSession 은 미기재 label 만 채우고 기존 label 은 보존한다", async () => {
    await recordSession(paths, "s1");
    await touchSession(paths, "s1", "첫 질문");
    await touchSession(paths, "s1", "둘째 질문");
    const entries = await readLedger(paths);
    expect(entries[0]!.label).toBe("첫 질문");
  });

  it("최신 활동순 정렬 + 상한 20 회전", async () => {
    // 결정론 확보: 연속 기록은 ms 동률로 정렬이 흔들릴 수 있어 시각을 명시한 픽스처를 심는다.
    const seeded = Array.from({ length: 21 }, (_, i) => ({
      id: `s${i + 1}`,
      createdAt: new Date(Date.UTC(2026, 6, 1, 0, i + 1)).toISOString(),
      lastActivityAt: new Date(Date.UTC(2026, 6, 1, 0, i + 1)).toISOString(),
    }));
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(paths.sessionsFile, JSON.stringify(seeded));

    await recordSession(paths, "s22"); // now(2026-07) > 픽스처 시각 → 최신

    const entries = await readLedger(paths);
    expect(entries).toHaveLength(20);
    expect(entries[0]!.id).toBe("s22"); // 최신이 맨 앞
    expect(entries.some((e) => e.id === "s1")).toBe(false); // 가장 오래된 것부터 회전 제거
    expect(entries.some((e) => e.id === "s2")).toBe(false);
  });

  it("장부 파손·부재는 빈 목록(fail-open)", async () => {
    expect(await readLedger(paths)).toEqual([]);
    fs.mkdirSync(paths.stateDir, { recursive: true });
    fs.writeFileSync(paths.sessionsFile, "{ not json");
    expect(await readLedger(paths)).toEqual([]);
  });
});

describe("resolveResumeControl (채널 공통 인자 해석)", () => {
  const entries: SessionEntry[] = [
    { id: "new-est", createdAt: "2026-07-03T10:00:00Z", lastActivityAt: "2026-07-03T12:00:00Z" },
    { id: "old-er", createdAt: "2026-07-02T10:00:00Z", lastActivityAt: "2026-07-02T12:00:00Z" },
  ];

  it("무인자 → 목록 조회(sessions)", () => {
    expect(resolveResumeControl(undefined, entries)).toEqual({ kind: "sessions" });
  });

  it("번호 → 최신순 해당 세션 id", () => {
    expect(resolveResumeControl("2", entries)).toEqual({ kind: "resume", sessionId: "old-er" });
  });

  it("범위 밖 번호 → sessionId 미지정(수신측이 부재 통지)", () => {
    expect(resolveResumeControl("9", entries)).toEqual({ kind: "resume" });
  });

  it("세션 id 직접 지정", () => {
    expect(resolveResumeControl("abc-123", entries)).toEqual({
      kind: "resume",
      sessionId: "abc-123",
    });
  });

  it("허용 문자셋 위반 인자는 sessionId 로 쓰지 않는다(주입 방어)", () => {
    expect(resolveResumeControl("../evil", entries)).toEqual({ kind: "resume" });
  });
});

describe("formatWhen", () => {
  it("ISO → 로컬 MM-DD HH:mm, 파싱 불가 문자열은 원문 유지", () => {
    expect(formatWhen(new Date(2026, 6, 3, 9, 5).toISOString())).toBe("07-03 09:05");
    expect(formatWhen("not-a-date")).toBe("not-a-date");
  });
});
