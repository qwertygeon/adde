import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { waitFor } from "../helpers/wait.js";

// logs --follow/-f 단위 검증(주입 deps·CLI 표면) — SC-008·SC-009(주입 결정적 변형)·
// SC-011(daemon 은 스냅샷만)·SC-012(대상 부재)·SC-013(비숫자·비양수 줄수 경고).

let tmpBase: string;
let prevHome: string | undefined;
let daemonErrLog: string;

const { daemonLogPaths } = vi.hoisted(() => ({ daemonLogPaths: vi.fn() }));
vi.mock("../../src/core/launchd.js", () => ({ daemonLogPaths }));

import { runLogs } from "../../src/cli/ops.js";
import { lanePaths } from "../../src/shared/paths.js";

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

describe("followFile 주입 deps — 회전/truncate 결정적 단위 검증 (SC-008·SC-009)", () => {
  it("inode 교체를 감지하면 신 파일을 offset 0 부터 읽는다 (SC-008 단위)", async () => {
    const { followFile } = await import("../../src/core/log-follow.js");
    const chunks: string[] = [];
    const ac = new AbortController();
    const stat = vi
      .fn()
      .mockResolvedValueOnce({ ino: 2, size: 6 }) // tick1: 회전 감지(주입 시작 ino=1 대비)
      .mockResolvedValue({ ino: 2, size: 6 }); // 이후 무변화
    const read = vi.fn(async (_p: string, _offset: number, _length: number) => "rotate\n");

    const done = followFile("dummy-target", {
      onData: (c) => chunks.push(c),
      signal: ac.signal,
      pollMs: 5,
      deps: { stat, read },
      startOffset: 999, // 회전 전 파일 기준 오프셋(무의미해져야 함)
      startIno: 1,
    });

    await waitFor(() => read.mock.calls.length >= 1, { timeoutMs: 1000 });
    ac.abort();
    await done;

    expect(read.mock.calls[0]?.[1]).toBe(0); // 회전 감지 시 신 파일은 offset 0 부터
    expect(chunks.join("")).toContain("rotate");
  });

  it("size<offset(truncate) 를 감지하면 offset 0 으로 재조정 후 재읽는다 (SC-009 단위)", async () => {
    const { followFile } = await import("../../src/core/log-follow.js");
    const chunks: string[] = [];
    const ac = new AbortController();
    const stat = vi
      .fn()
      .mockResolvedValueOnce({ ino: 1, size: 3 }) // size(3) < startOffset(100) → truncate
      .mockResolvedValue({ ino: 1, size: 3 });
    const read = vi.fn(async (_p: string, _offset: number, _length: number) => "trunc\n");

    const done = followFile("dummy-target", {
      onData: (c) => chunks.push(c),
      signal: ac.signal,
      pollMs: 5,
      deps: { stat, read },
      startOffset: 100,
      startIno: 1,
    });

    await waitFor(() => read.mock.calls.length >= 1, { timeoutMs: 1000 });
    ac.abort();
    await done;

    expect(read.mock.calls[0]?.[1]).toBe(0); // truncate 재조정 — 0 부터 재읽기
    expect(chunks.join("")).toContain("trunc");
  });
});

describe("logs --daemon --follow → follow 미적용, 스냅샷만 (SC-011)", () => {
  it("daemon 로그는 follow 하지 않고 최근 N줄 스냅샷 후 즉시 종료한다(상주 안 함)", async () => {
    fs.writeFileSync(daemonErrLog, "d1\nd2\n");
    const cap = captureStdout();
    const code = await Promise.race([
      runLogs(["p", "--daemon", "-f"]),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("daemon -f 가 상주함(SC-011 위반)")), 1500),
      ),
    ]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out()).toContain("d1");
    expect(cap.out()).toContain("d2");
  });
});

describe("logs -f 대상 부재 (SC-012)", () => {
  it("시작 시 대상 파일이 없으면 부재 안내 후 종료한다(생성 대기 상주 안 함)", async () => {
    const cap = captureStdout();
    const code = await Promise.race([
      runLogs(["p", "l", "-f"]),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("대상 부재인데 follow 가 상주함(SC-012 위반)")), 1500),
      ),
    ]);
    cap.restore();
    expect(code).toBe(0);
    expect(cap.out().length).toBeGreaterThan(0); // 부재 안내 출력 존재
  });
});

describe("logs 비숫자·비양수 줄수 경고 (SC-013)", () => {
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
