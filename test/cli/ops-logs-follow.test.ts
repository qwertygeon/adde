import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// logs --follow/-f 단위 검증(주입 deps·CLI 표면) — SC-112(daemon 은 스냅샷만·대상 부재)·
// SC-109(비숫자·비양수 줄수 경고, daemon/비daemon 공통)·SC-104(스냅샷→follow 이어읽기, CLI 배선).
// followFile 코어의 회전/truncate 결정적 단위 검증(구 SC-008/SC-009)은 신 계약(read: Buffer,
// watch 주입점)으로 test/core/log-follow.test.ts 의 SC-102·SC-106 이 대체한다(GAP-003 마이그레이션
// — 중복 제거 우선, 코어 로직은 그쪽에서 이미 검증되므로 여기서는 CLI 표면·daemon 분기만 다룬다).

let tmpBase: string;
let prevHome: string | undefined;
let daemonErrLog: string;

const { daemonLogPaths } = vi.hoisted(() => ({ daemonLogPaths: vi.fn() }));
vi.mock("../../src/core/launchd.js", () => ({ daemonLogPaths }));

import { runLogs } from "../../src/cli/ops.js";
import { lanePaths } from "../../src/shared/paths.js";
import { waitFor } from "../helpers/wait.js";

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-ops-logs-follow-"));
  prevHome = process.env["ADDE_HOME"];
  process.env["ADDE_HOME"] = tmpBase;
  daemonErrLog = path.join(tmpBase, "daemon.err.log");
  daemonLogPaths.mockReturnValue({ out: path.join(tmpBase, "daemon.out.log"), err: daemonErrLog });
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

function writeTranscriptLines(proj: string, lane: string, n: number): void {
  const paths = lanePaths(tmpBase, proj, lane);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const lines = Array.from({ length: n }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
  fs.writeFileSync(paths.transcriptLog, lines);
}

describe("logs --daemon --follow → follow 미적용, 스냅샷만 (SC-112)", () => {
  it("daemon 로그는 follow 하지 않고 최근 N줄 스냅샷 후 즉시 종료한다(상주 안 함)", async () => {
    fs.writeFileSync(daemonErrLog, "d1\nd2\n");
    const cap = captureStdout();
    const code = await Promise.race([
      runLogs(["p", "--daemon", "-f"]),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("daemon -f 가 상주함(SC-112 위반)")), 1500),
      ),
    ]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out()).toContain("d1");
    expect(cap.out()).toContain("d2");
  });
});

describe("logs -f 대상 부재 (SC-112)", () => {
  it("시작 시 대상 파일이 없으면 부재 안내 후 종료한다(생성 대기 상주 안 함)", async () => {
    const cap = captureStdout();
    const code = await Promise.race([
      runLogs(["p", "l", "-f"]),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("대상 부재인데 follow 가 상주함(SC-112 위반)")), 1500),
      ),
    ]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out().length).toBeGreaterThan(0); // 부재 안내 출력 존재
  });
});

describe("logs 비숫자·비양수 줄수 경고 — 비daemon 경로 (SC-109)", () => {
  for (const bad of ["abc", "0", "-5"]) {
    it(`N="${bad}" 이면 stderr 경고 후 기본 50줄로 폴백한다`, async () => {
      writeTranscriptLines("p", "l", 60);
      const errs: string[] = [];
      const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
        errs.push(String(s));
        return true;
      });
      const cap = captureStdout();
      const code = await runLogs(["p", "l", bad]);
      cap.restore();
      spyErr.mockRestore();
      expect(code).toBe(0);
      expect(errs.join("")).toContain(bad);
      const printedLines = cap
        .out()
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      expect(printedLines).toHaveLength(50);
      expect(printedLines[0]).toBe("line-11"); // 최근 50줄 = line-11..line-60
      expect(printedLines[printedLines.length - 1]).toBe("line-60");
    });
  }

  // FR-004(-f 단축형)·FR-007(줄수 파싱) 상호작용 회귀 — positional 필터가 "--xxx"(더블대시)만
  // 걸러내고 단축 플래그 "-f" 는 위치인자에 남아 [proj,lane,nRaw] 3번째 자리로 오인될 수 있다.
  // `logs <proj> <lane> -f`(N 미지정, 단축 follow)에서 가짜 비숫자 경고가 뜨면 안 된다(GAP-003).
  it('follow 단축형("-f", N 미지정)은 "-f" 자체를 줄수로 오인해 경고를 내지 않는다', async () => {
    writeTranscriptLines("p", "l", 60);
    const errs: string[] = [];
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errs.push(String(s));
      return true;
    });
    const cap = captureStdout();
    const donePromise = runLogs(["p", "l", "-f"]);
    // parseLineCount 판정은 follow 진입 이전에 동기적으로 끝난다 — 짧게 대기 후 실 SIGINT 로
    // follow 루프를 정지시켜(runLogs 내부 process.once("SIGINT",...) 배선) 상주를 종료한다.
    await new Promise((r) => setTimeout(r, 50));
    process.emit("SIGINT");
    const code = await donePromise;
    cap.restore();
    spyErr.mockRestore();
    expect(code).toBe(0);
    expect(errs.join("")).not.toContain('"-f"');
  });
});

describe("logs 비숫자·비양수 줄수 경고 — daemon 경로 통일 (SC-109, N-2 회귀 방지)", () => {
  for (const bad of ["abc", "0", "-5"]) {
    it(`daemon 경로 N="${bad}" 이면 비daemon 과 동일하게 stderr 경고 + 기본 50줄 폴백`, async () => {
      const lines = Array.from({ length: 60 }, (_, i) => `d-${i + 1}`).join("\n") + "\n";
      fs.writeFileSync(daemonErrLog, lines);
      const errs: string[] = [];
      const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
        errs.push(String(s));
        return true;
      });
      const cap = captureStdout();
      const code = await runLogs(["p", "--daemon", bad]);
      cap.restore();
      spyErr.mockRestore();
      expect(code).toBe(0);
      expect(errs.join("")).toContain(bad); // 무경고 흡수(N-2 구 결함) 회귀 방지
      const printed = cap
        .out()
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      expect(printed).toHaveLength(50);
    });
  }

  it("daemon 경로 유효 정수 N 은 경고 없이 그 값을 사용한다(기존 동작 불변)", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `d-${i + 1}`).join("\n") + "\n";
    fs.writeFileSync(daemonErrLog, lines);
    const errs: string[] = [];
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errs.push(String(s));
      return true;
    });
    const cap = captureStdout();
    const code = await runLogs(["p", "--daemon", "10"]);
    cap.restore();
    spyErr.mockRestore();
    expect(code).toBe(0);
    expect(errs.join("")).toBe("");
    const printed = cap
      .out()
      .trim()
      .split("\n")
      .filter((l) => l.length > 0);
    expect(printed).toHaveLength(10);
  });
});

describe("logs follow — 스냅샷 직후·follow 시작 전 append 가 유실·중복 없이 1회 방출 (SC-104)", () => {
  it("스냅샷 출력 시점(별도 stat 재조회 없이 readLogs 오프셋 이어받기)에 append 된 라인이 정확히 1회 방출된다", async () => {
    writeTranscriptLines("p", "l", 1); // "line-1\n"
    const paths = lanePaths(tmpBase, "p", "l");
    const chunks: string[] = [];
    let appended = false;
    const spyOut = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
      const str = String(s);
      chunks.push(str);
      // 스냅샷 출력 직후(= readLogs 완료 후, followFile 시작 전) 경합 라인을 주입한다.
      if (!appended && str.includes("line-1")) {
        appended = true;
        fs.appendFileSync(paths.transcriptLog, "race-line\n");
      }
      return true;
    });

    const donePromise = runLogs(["p", "l", "-f"]);
    await waitFor(() => chunks.join("").includes("race-line"), { timeoutMs: 4000 });
    process.emit("SIGINT");
    const code = await donePromise;
    spyOut.mockRestore();

    expect(code).toBe(0);
    const out = chunks.join("");
    expect(out.split("race-line").length - 1).toBe(1); // 정확히 1회(유실·중복 없음)
  });
});
