import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runSessions } from "../../src/cli/ops.js";
import { lanePaths } from "../../src/shared/paths.js";

// sessions 파싱 정리 + --json (FR-002·FR-003) — SC-003·SC-004·SC-005·SC-024(sessions 부분).
// readLedger(core/session-ledger)는 실 fs 로 채운 sessions.json 을 그대로 읽으므로 격리 tmp ADDE_HOME
// 만으로 결정적 검증이 가능하다(모킹 불요).

let tmpBase: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-sessions-json-"));
  prevHome = process.env["ADDE_HOME"];
  process.env["ADDE_HOME"] = tmpBase;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevHome;
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function captureStdout(): { out: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  return { out: () => chunks.join(""), restore: () => spy.mockRestore() };
}

function writeLedgerFixture(
  proj: string,
  lane: string,
  entries: Array<{ id: string; createdAt: string; lastActivityAt: string; label?: string }>,
  currentId?: string,
): void {
  const paths = lanePaths(tmpBase, proj, lane);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(paths.sessionsFile, JSON.stringify(entries, null, 2) + "\n");
  if (currentId !== undefined) fs.writeFileSync(paths.sessionIdFile, currentId);
}

describe("sessions 플래그 위치 무관 파싱 (SC-003)", () => {
  it("`sessions --json <proj> <lane>` 과 `sessions <proj> <lane> --json` 이 동일하게 해석된다", async () => {
    writeLedgerFixture("p", "l", [
      { id: "s1", createdAt: "2026-01-01T00:00:00Z", lastActivityAt: "2026-01-01T00:00:00Z" },
    ]);

    const cap1 = captureStdout();
    const code1 = await runSessions(["--json", "p", "l"]);
    const out1 = cap1.out();
    cap1.restore();

    const cap2 = captureStdout();
    const code2 = await runSessions(["p", "l", "--json"]);
    const out2 = cap2.out();
    cap2.restore();

    expect(code1).toBe(0);
    expect(code2).toBe(0);
    const parsed1 = JSON.parse(out1) as unknown[];
    const parsed2 = JSON.parse(out2) as unknown[];
    expect(parsed1).toEqual(parsed2);
    expect(parsed1).toHaveLength(1);
  });

  it("`--json` 이 proj/lane 값으로 오인되지 않는다(선두 위치에서도)", async () => {
    writeLedgerFixture("p", "l", [
      { id: "s1", createdAt: "2026-01-01T00:00:00Z", lastActivityAt: "2026-01-01T00:00:00Z" },
    ]);
    const cap = captureStdout();
    const code = await runSessions(["--json", "p", "l"]);
    cap.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out()) as unknown[];
    expect(parsed).toHaveLength(1); // proj="--json" 오인 시 장부를 못 찾아 빈 결과가 됨
  });
});

describe("sessions --json 항목 직렬화 (SC-004)", () => {
  it("N개 항목(id·label·lastActivityAt)과 현재 세션 표시가 파싱된다", async () => {
    writeLedgerFixture(
      "p",
      "l",
      [
        {
          id: "s1",
          createdAt: "2026-01-01T00:00:00Z",
          lastActivityAt: "2026-01-02T00:00:00Z",
          label: "hello",
        },
        { id: "s2", createdAt: "2026-01-01T00:00:00Z", lastActivityAt: "2026-01-03T00:00:00Z" },
      ],
      "s2",
    );
    const cap = captureStdout();
    const code = await runSessions(["p", "l", "--json"]);
    cap.restore();
    expect(code).toBe(0);
    const parsed = JSON.parse(cap.out()) as Array<{
      id: string;
      label: string | null;
      lastActivityAt: string;
      current: boolean;
    }>;
    expect(parsed).toHaveLength(2);
    expect(parsed.filter((e) => e.current)).toHaveLength(1);
    expect(parsed.find((e) => e.current)?.id).toBe("s2");
    expect(parsed.find((e) => e.id === "s1")?.label).toBe("hello");
    // label 미기재 항목은 텍스트 fallback 문자열이 아니라 null 로 안정 파싱된다.
    expect(parsed.find((e) => e.id === "s2")?.label).toBeNull();
  });
});

describe("sessions --json 빈 장부 (SC-005)", () => {
  it("빈 배열을 나타내는 유효 JSON + exit 0", async () => {
    writeLedgerFixture("p", "l", []);
    const cap = captureStdout();
    const code = await runSessions(["p", "l", "--json"]);
    cap.restore();
    expect(code).toBe(0);
    expect(JSON.parse(cap.out())).toEqual([]);
  });
});

describe("sessions 비-json 경로 불변 (SC-024)", () => {
  it("--json 없이 호출하면 기존 텍스트 목록 출력·exit code 가 불변이다", async () => {
    writeLedgerFixture("p", "l", [
      { id: "s1", createdAt: "2026-01-01T00:00:00Z", lastActivityAt: "2026-01-01T00:00:00Z" },
    ]);
    const cap = captureStdout();
    const code = await runSessions(["p", "l"]);
    cap.restore();
    expect(code).toBe(0);
    expect(() => JSON.parse(cap.out())).toThrow(); // 텍스트 목록이지 JSON 배열이 아님
  });

  it("빈 장부의 텍스트 출력도 불변이다", async () => {
    writeLedgerFixture("p", "l", []);
    const cap = captureStdout();
    const code = await runSessions(["p", "l"]);
    cap.restore();
    expect(code).toBe(0);
    expect(() => JSON.parse(cap.out())).toThrow();
  });
});
