import { afterEach, describe, expect, it, vi } from "vitest";

// SC-015(FR-015) — 환경 점검 텍스트 모드가 등급별 건수를 담은 요약 줄을 출력하고, 그 건수는
// 렌더한 checks 배열에서 직접 집계한 값과 일치한다(SC-015 E9 — 별도 카운터 유지 금지). --json
// 경로는 요약 없음(usage 문구와 일치). 부분 모듈 모킹 — runStatus 미호출 경로라 diagnostics 를
// { runDoctor } 만으로 모킹해도 안전하다(선례 ops-doctor-stream.test.ts).

const { runDoctor } = vi.hoisted(() => ({ runDoctor: vi.fn() }));
const { checkForUpdate, formatUpdateNotice } = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  formatUpdateNotice: vi.fn(),
}));
vi.mock("../../src/core/diagnostics.js", () => ({ runDoctor }));
vi.mock("../../src/core/update-check.js", () => ({ checkForUpdate, formatUpdateNotice }));

import { runDoctorCli } from "../../src/cli/ops.js";
import type { DoctorCheck } from "../../src/core/diagnostics.js";

function captureStdio(): { out: () => string; restore: () => void } {
  const outChunks: string[] = [];
  const spyOut = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    outChunks.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return {
    out: () => outChunks.join(""),
    restore: () => spyOut.mockRestore(),
  };
}

const MIXED_4: DoctorCheck[] = [
  { name: "node", level: "PASS", detail: "v22" },
  { name: "config", level: "WARN", detail: "일부 미설정" },
  { name: "binary", level: "FAIL", detail: "부재" },
  { name: "legacy", level: "INFO", detail: "구 데이터" },
];

const SKEWED: DoctorCheck[] = [
  { name: "a", level: "PASS", detail: "1" },
  { name: "b", level: "PASS", detail: "2" },
  { name: "c", level: "PASS", detail: "3" },
  { name: "d", level: "WARN", detail: "4" },
  { name: "e", level: "FAIL", detail: "5" },
];

afterEach(() => vi.clearAllMocks());

describe("SC-015: 환경 점검 텍스트 모드 요약 줄", () => {
  it("Happy: 텍스트 모드 마지막에 등급별 건수를 담은 요약 줄이 1건 출력된다", async () => {
    runDoctor.mockResolvedValue(MIXED_4);
    checkForUpdate.mockResolvedValue(null);
    const cap = captureStdio();
    await runDoctorCli(["demo"]);
    cap.restore();
    const lines = cap.out().trim().split("\n");
    const summaryLine = lines[lines.length - 1] ?? "";
    expect(summaryLine).toMatch(/1/); // PASS 1건
    expect(summaryLine).toMatch(/PASS/);
    expect(summaryLine).toMatch(/WARN/);
    expect(summaryLine).toMatch(/FAIL/);
    expect(summaryLine).toMatch(/INFO/);
  });

  it("Edge: 등급 분포를 바꿔도 요약 건수가 실제 출력 항목과 일치한다", async () => {
    runDoctor.mockResolvedValue(SKEWED);
    checkForUpdate.mockResolvedValue(null);
    const cap = captureStdio();
    await runDoctorCli(["demo"]);
    cap.restore();
    const out = cap.out();
    const passCount = SKEWED.filter((c) => c.level === "PASS").length;
    const warnCount = SKEWED.filter((c) => c.level === "WARN").length;
    const failCount = SKEWED.filter((c) => c.level === "FAIL").length;
    const infoCount = SKEWED.filter((c) => c.level === "INFO").length;
    const lines = out.trim().split("\n");
    const summaryLine = lines[lines.length - 1] ?? "";
    expect(summaryLine).toContain(String(passCount));
    expect(summaryLine).toContain(String(warnCount));
    expect(summaryLine).toContain(String(failCount));
    expect(summaryLine).toContain(String(infoCount));
  });

  it("Error: --json 출력에는 요약 줄이 없다", async () => {
    runDoctor.mockResolvedValue(MIXED_4);
    checkForUpdate.mockResolvedValue(null);
    const cap = captureStdio();
    await runDoctorCli(["demo", "--json"]);
    cap.restore();
    const out = cap.out();
    // --json 경로는 무변경(요약 없음) — 출력이 { v, checks } JSON 한 덩어리와 정확히 일치해야
    // 한다(추가된 요약 줄이 있으면 이 등가 비교가 깨진다).
    const expected = JSON.stringify({ v: 1, checks: MIXED_4 }, null, 2) + "\n";
    expect(out).toBe(expected);
  });
});
