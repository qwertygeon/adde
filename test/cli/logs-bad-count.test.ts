import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// SC-016(FR-016) — 로그 명령의 줄 수 인자에 양의 정수가 아닌 값을 주면 조용히 기본값(50)으로
// 치환하지 않고 경고 1건을 stderr 로 출력한 뒤 기본값을 적용한다. `parseLineCount` 는 이미
// warn 플래그를 반환하지만(현행), 두 호출 지점(세션 분기의 nRaw · --daemon 분기의
// positional[1])이 그 플래그를 실제로 소비해 경고를 발신하는지가 이번 차수의 신규 계약이다
// (T009 — 현재는 무음 치환이라 CLI 레벨 단언은 미착지 시 RED 가 예상 상태, PROC-R15).

let tmpHome: string;
const origHome = process.env["ADDE_HOME"];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "adde-logs-bad-count-"));
  process.env["ADDE_HOME"] = path.join(tmpHome, "adde");
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (origHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = origHome;
  vi.restoreAllMocks();
});

function base(): string {
  return process.env["ADDE_HOME"]!;
}

function writeProject(proj: string): void {
  const vaultDir = path.join(tmpHome, `vault-${proj}`);
  fs.mkdirSync(vaultDir, { recursive: true });
  const projDir = path.join(base(), "projects", proj);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "project.conf"), `v=1\nvault=${vaultDir}\n`);
}

async function captureLogs(args: string[]): Promise<{ out: string; err: string; code: number }> {
  const ops = await import("../../src/cli/ops.js");
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  const code = await ops.runLogs(args);
  return { out, err, code };
}

describe("SC-016 (단위): parseLineCount 계약 — 유효하지 않은 값은 기본값 + warn:true", () => {
  it("Happy: abc 는 경고 플래그와 함께 기본값(DEFAULT_LOG_LINES)을 반환한다", async () => {
    const { parseLineCount, DEFAULT_LOG_LINES } = await import("../../src/cli/ops.js");
    const result = parseLineCount("abc");
    expect(result.warn).toBe(true);
    expect(result.n).toBe(DEFAULT_LOG_LINES);
  });

  it("Edge: 0·-1 도 동일하게 경고 + 기본값이다", async () => {
    const { parseLineCount, DEFAULT_LOG_LINES } = await import("../../src/cli/ops.js");
    for (const raw of ["0", "-1"]) {
      const result = parseLineCount(raw);
      expect(result.warn).toBe(true);
      expect(result.n).toBe(DEFAULT_LOG_LINES);
    }
  });

  it("Error: 유효한 양의 정수는 경고 없이 그 값을 그대로 반환한다(대조군)", async () => {
    const { parseLineCount } = await import("../../src/cli/ops.js");
    const result = parseLineCount("7");
    expect(result.warn).toBe(false);
    expect(result.n).toBe(7);
  });
});

describe("SC-016 (CLI): 로그 명령 실행 시 무음 치환 없이 경고가 출력된다", () => {
  it("Happy: abc 입력 시 경고 1건이 출력되고 기본값이 적용된다(--engine 분기)", async () => {
    writeProject("p1");
    const { err } = await captureLogs(["p1", "sid1", "abc", "--engine"]);
    expect(err).toMatch(/abc/);
  });

  it("Edge: 0·-1 입력도 경고와 함께 처리된다(--engine 분기)", async () => {
    writeProject("p1");
    for (const raw of ["0", "-1"]) {
      const { err } = await captureLogs(["p1", "sid1", raw, "--engine"]);
      expect(err).toContain(raw);
    }
  });

  it("Error: --daemon 분기에서도 무음 치환이 없다(경고 1건 발신)", async () => {
    writeProject("p1");
    const { err } = await captureLogs(["p1", "--daemon", "abc"]);
    expect(err).toMatch(/abc/);
  });
});
