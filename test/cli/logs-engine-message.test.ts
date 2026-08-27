import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// `logs --engine` 은 진단 명령이므로 "엔진이 아직 기동한 적 없음"(경로 미생성)과 "엔진이 기동했고
// 진단 출력을 남기지 않음"(빈 파일)을 구분해야 한다. 둘을 같은 문구로 덮으면 정상 상태가 배선
// 실패처럼 보인다(실제로 그렇게 오진단됐다).

let tmpHome: string;
const origHome = process.env["ADDE_HOME"];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "adde-logs-msg-"));
  process.env["ADDE_HOME"] = path.join(tmpHome, "adde");
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (origHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = origHome;
  vi.restoreAllMocks();
});

/** runLogs 의 stdout 출력을 모아 반환한다. */
async function captureLogs(args: string[]): Promise<string> {
  const ops = await import("../../src/cli/ops.js");
  let out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  await ops.runLogs(args);
  return out;
}

function engineLogFile(proj: string, sid: string): string {
  return path.join(
    process.env["ADDE_HOME"]!,
    "projects",
    proj,
    "runtime",
    "sessions",
    sid,
    "engine.log",
  );
}

describe("logs --engine 의 부재/빈내용 구분", () => {
  it("Happy: 파일이 없으면 엔진이 기동하지 않았다는 뜻의 안내를 출력한다", async () => {
    const out = await captureLogs(["p1", "sid-a", "--engine"]);
    expect(out).toContain("기동");
    expect(out).toContain(engineLogFile("p1", "sid-a")); // 경로는 양쪽 모두 병기
  });

  it("Happy: 파일이 있고 비어 있으면 진단 출력이 없다는 뜻의 다른 안내를 출력한다", async () => {
    const file = engineLogFile("p1", "sid-b");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");

    const empty = await captureLogs(["p1", "sid-b", "--engine"]);
    expect(empty).toContain("비어");
    expect(empty).toContain(file);
    // 부재 케이스의 문구("기동")로 덮이지 않았음을 함께 고정한다 — 경로 차이로 우연히 달라지는
    // 문자열 비교가 아니라, 각 상태 고유 어휘의 존재/부재로 판정한다.
    expect(empty).not.toContain("기동");
  });

  it("Happy: 내용이 있으면 그 내용을 출력한다(안내 문구로 대체하지 않음)", async () => {
    const file = engineLogFile("p1", "sid-c");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "adapter said something\n");

    const out = await captureLogs(["p1", "sid-c", "--engine"]);
    expect(out).toContain("adapter said something");
  });

  it("Happy: --json 은 부재/빈내용을 exists 로 구분한다(기존 계약 유지)", async () => {
    const file = engineLogFile("p1", "sid-d");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");

    const emptyJson = JSON.parse(await captureLogs(["p1", "sid-d", "--engine", "--json"])) as {
      exists: boolean;
      lines: string[];
    };
    vi.restoreAllMocks();
    const missingJson = JSON.parse(await captureLogs(["p1", "sid-x", "--engine", "--json"])) as {
      exists: boolean;
    };

    expect(emptyJson.exists).toBe(true);
    expect(emptyJson.lines).toEqual([]);
    expect(missingJson.exists).toBe(false);
  });
});
