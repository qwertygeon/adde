import { afterEach, describe, expect, it, vi } from "vitest";

// doctor 텍스트 모드 스트림 귀속 (SC-017, FR-007·결정 A) — 체크 리스트(PASS/WARN/FAIL 줄+요약)는
// "조회한 진단 결과" payload 로 간주해 stdout 유지, 업데이트 알림만 조언성으로 stderr.

const { runDoctor } = vi.hoisted(() => ({ runDoctor: vi.fn() }));
const { checkForUpdate, formatUpdateNotice } = vi.hoisted(() => ({
  checkForUpdate: vi.fn(),
  formatUpdateNotice: vi.fn(),
}));
vi.mock("../../src/core/diagnostics.js", () => ({ runDoctor }));
vi.mock("../../src/core/update-check.js", () => ({ checkForUpdate, formatUpdateNotice }));

import { runDoctorCli } from "../../src/cli/ops.js";
import type { DoctorCheck } from "../../src/core/diagnostics.js";

const MIXED: DoctorCheck[] = [
  { name: "Node 버전", level: "PASS", detail: "v22.0.0 (≥22)" },
  { name: "설정", level: "WARN", detail: "일부 미설정", hint: "확인 권장" },
  { name: "어댑터 바이너리", level: "FAIL", detail: "부재", hint: "설치 필요" },
];

function captureStdio(): { out: () => string; err: () => string; restore: () => void } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const spyOut = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    outChunks.push(String(s));
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
    errChunks.push(String(s));
    return true;
  });
  return {
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
    restore: () => {
      spyOut.mockRestore();
      spyErr.mockRestore();
    },
  };
}

afterEach(() => vi.clearAllMocks());

describe("doctor 텍스트 모드 — 체크줄+요약은 stdout (SC-017 Happy)", () => {
  it("PASS/WARN/FAIL 각 줄과 요약이 stdout 에 나타나고 stderr 에는 없다", async () => {
    runDoctor.mockResolvedValue(MIXED);
    checkForUpdate.mockResolvedValue(null); // 알림 없음(변수 통제)
    const cap = captureStdio();
    await runDoctorCli(["demo"]);
    cap.restore();
    expect(cap.out()).toMatch(/PASS/);
    expect(cap.out()).toMatch(/WARN/);
    expect(cap.out()).toMatch(/FAIL/);
    expect(cap.out()).toMatch(/설치 필요|확인 권장/); // hint 동반(체크 payload 일부)
    expect(cap.err()).toBe("");
  });
});

describe("doctor 텍스트 모드 — 업데이트 알림은 stderr (SC-017 Happy)", () => {
  it("업데이트 알림이 있으면 stderr 에만 나타나고 stdout 에는 없다", async () => {
    runDoctor.mockResolvedValue(MIXED);
    checkForUpdate.mockResolvedValue({ latest: "9.9.9", current: "0.0.0" });
    formatUpdateNotice.mockReturnValue("새 버전 9.9.9 사용 가능");
    const cap = captureStdio();
    await runDoctorCli(["demo"]);
    cap.restore();
    expect(cap.err()).toContain("새 버전 9.9.9 사용 가능");
    expect(cap.out()).not.toContain("새 버전 9.9.9 사용 가능");
  });
});
