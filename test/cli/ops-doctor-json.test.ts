import { afterEach, describe, expect, it, vi } from "vitest";

// doctor --json (FR-001) — SC-001·SC-002·SC-024(doctor 부분).
// runDoctor 자체(core/diagnostics)는 core/diagnostics.test.ts 가 커버 — 여기서는 CLI 계층(runDoctorCli)의
// --json 분기(구조·부가출력 억제·종료코드)만 결정적으로 검증하기 위해 runDoctor 를 주입 모킹한다.

const { runDoctor } = vi.hoisted(() => ({ runDoctor: vi.fn() }));
vi.mock("../../src/core/diagnostics.js", () => ({ runDoctor }));

import { runDoctorCli } from "../../src/cli/ops.js";
import type { DoctorCheck } from "../../src/core/diagnostics.js";

function captureStdout(): { out: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  return { out: () => chunks.join(""), restore: () => spy.mockRestore() };
}

const PASS_ONLY: DoctorCheck[] = [{ name: "Node 버전", level: "PASS", detail: "v22.0.0 (≥22)" }];
const WITH_FAIL: DoctorCheck[] = [
  ...PASS_ONLY,
  { name: "어댑터 바이너리", level: "FAIL", detail: "부재", hint: "설치 필요" },
];

afterEach(() => vi.clearAllMocks());

describe("doctor --json 구조·부가출력 억제 (SC-001 Happy)", () => {
  it("stdout 은 DoctorCheck[] 그대로 JSON 파싱되고 사람용 심볼·요약·업데이트 텍스트가 섞이지 않는다", async () => {
    runDoctor.mockResolvedValue(WITH_FAIL);
    const cap = captureStdout();
    await runDoctorCli(["demo", "--json"]);
    cap.restore();
    const parsed = JSON.parse(cap.out()) as DoctorCheck[];
    expect(parsed).toEqual(WITH_FAIL);
    // 사람용 심볼(✔▲✘)·요약 문구가 JSON 출력에 섞이지 않는다.
    expect(cap.out()).not.toMatch(/[✔▲✘]/);
  });

  it("PASS 항목은 hint 필드가 없고 FAIL/WARN 항목만 hint 를 포함한다(유효 JSON 형태 유지)", async () => {
    runDoctor.mockResolvedValue(WITH_FAIL);
    const cap = captureStdout();
    await runDoctorCli(["demo", "--json"]);
    cap.restore();
    const parsed = JSON.parse(cap.out()) as DoctorCheck[];
    const pass = parsed.find((c) => c.level === "PASS");
    const fail = parsed.find((c) => c.level === "FAIL");
    expect(pass?.hint).toBeUndefined();
    expect(fail?.hint).toBeTruthy();
  });
});

describe("doctor --json exit code (SC-002)", () => {
  it("FAIL 1건 이상이면 exit 1", async () => {
    runDoctor.mockResolvedValue(WITH_FAIL);
    const cap = captureStdout();
    const code = await runDoctorCli(["demo", "--json"]);
    cap.restore();
    expect(code).toBe(1);
  });

  it("FAIL 0건이면 exit 0(텍스트 모드와 동일한 판정 기준)", async () => {
    runDoctor.mockResolvedValue(PASS_ONLY);
    const cap = captureStdout();
    const code = await runDoctorCli(["demo", "--json"]);
    cap.restore();
    expect(code).toBe(0);
  });
});

describe("doctor 비-json 경로 불변 (SC-024)", () => {
  it("--json 없이 호출하면 기존 텍스트 출력(심볼·요약)과 종료 코드가 불변이다", async () => {
    runDoctor.mockResolvedValue(WITH_FAIL);
    const cap = captureStdout();
    const code = await runDoctorCli(["demo"]);
    cap.restore();
    expect(cap.out()).toMatch(/FAIL/);
    expect(cap.out()).toMatch(/[✔▲✘]/); // 심볼 루프 유지(텍스트 모드 회귀 방지)
    expect(code).toBe(1);
  });

  it("--json 없이 FAIL 0건이면 기존처럼 exit 0", async () => {
    runDoctor.mockResolvedValue(PASS_ONLY);
    const cap = captureStdout();
    const code = await runDoctorCli(["demo"]);
    cap.restore();
    expect(code).toBe(0);
  });
});
