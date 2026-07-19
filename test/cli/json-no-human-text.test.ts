import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --json 지정 시 사람용 텍스트(표·심볼·요약·업데이트 알림) 미혼입 (SC-004, FR-003). stdout 전체가
// 단일 JSON.parse 로 파싱되어야 한다 — 앞뒤에 사람용 문구가 섞이면 파싱이 실패하거나 트림 후에도
// 잔여 문자가 남는다. up/restart --json 의 순도는 up-restart-json.test.ts 가 별도로 검증한다.

const { runDoctor } = vi.hoisted(() => ({ runDoctor: vi.fn() }));
// runDoctor 만 대체 — collectStatus 등 나머지 export 는 실 구현 유지(status --json 회귀 테스트가
// 같은 파일에서 실 diagnostics 를 필요로 함).
vi.mock("../../src/core/diagnostics.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/diagnostics.js")>();
  return { ...actual, runDoctor };
});

import { runDoctorCli } from "../../src/cli/ops.js";
import type { DoctorCheck } from "../../src/core/diagnostics.js";

const CONF = `source=telegram\nbackend=acp\nengine=claude-agent-acp\nchannel=telegram\nperm_tier=acp\nacp_version=v1\n`;

let tmpBase: string;
let prevHome: string | undefined;

function writeConf(proj: string, lane: string): void {
  const dir = path.join(tmpBase, proj, "lanes.d");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${lane}.conf`), CONF);
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-json-pure-"));
  prevHome = process.env["ADDE_HOME"];
  process.env["ADDE_HOME"] = tmpBase;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevHome;
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.clearAllMocks();
});

function captureStdout(): { out: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  return { out: () => chunks.join(""), restore: () => spy.mockRestore() };
}

const WITH_FAIL: DoctorCheck[] = [
  { name: "Node 버전", level: "PASS", detail: "v22.0.0 (≥22)" },
  { name: "어댑터 바이너리", level: "FAIL", detail: "부재", hint: "설치 필요" },
];

describe("doctor --json — 심볼·요약·업데이트 알림 미혼입 (SC-004 Happy)", () => {
  it("stdout 전체가 단일 JSON.parse 로 파싱되고 사람용 심볼이 없다", async () => {
    runDoctor.mockResolvedValue(WITH_FAIL);
    const cap = captureStdout();
    await runDoctorCli(["demo", "--json"]);
    cap.restore();
    const out = cap.out();
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).not.toMatch(/[✔▲✘]/);
  });
});

describe("doctor --json — 요약 줄 부재 (SC-004 Edge)", () => {
  it("요약 문구(pass/warn/fail 카운트 안내 문장)가 JSON 바깥에 섞이지 않는다", async () => {
    runDoctor.mockResolvedValue(WITH_FAIL);
    const cap = captureStdout();
    await runDoctorCli(["demo", "--json"]);
    cap.restore();
    const out = cap.out().trim();
    // 순수 JSON 이면 트림된 전체 문자열이 그대로 파싱되고, 파싱 후 재직렬화 길이가 원본과 근접
    // (배열 JSON 앞뒤에 추가 텍스트 줄이 없다는 뜻 — 요약 문구가 섞이면 배열 뒤에 개행+문장이
    // 남아 trailing 파싱 실패 또는 별도 라인이 생긴다).
    const parsed = JSON.parse(out) as { v: number; checks: unknown[] };
    expect(parsed.v).toBe(1);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(out.split("\n").filter((l) => /pass|warn|fail/i.test(l) && !l.trim().startsWith('"')).length).toBe(0);
  });
});

describe("lane ls --json — 표·심볼 없이 순수 배열 (SC-004 Happy)", () => {
  it("stdout 전체가 단일 JSON.parse 배열로 파싱된다", async () => {
    writeConf("p", "a");
    const { runLane } = await import("../../src/cli/lane.js");
    const cap = captureStdout();
    await runLane(["ls", "p", "--json"]);
    cap.restore();
    const out = cap.out();
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).not.toMatch(/LANE|STATUS|PID/); // 표 헤더 부재
  });
});

describe("status --json — 표·경고 텍스트 미혼입 (SC-004 Happy, 회귀)", () => {
  it("stdout 전체가 단일 JSON.parse 객체로 파싱된다", async () => {
    const { runStatus } = await import("../../src/cli/ops.js");
    const cap = captureStdout();
    await runStatus(["p", "--json"]);
    cap.restore();
    const out = cap.out();
    const parsed = JSON.parse(out) as { lanes: unknown[]; halt: unknown };
    expect(Array.isArray(parsed.lanes)).toBe(true);
    expect(out).not.toMatch(/LANE|STATUS|PID/);
  });
});
