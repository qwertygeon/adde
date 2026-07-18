import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --json 확대 산출물의 시크릿 비노출 (SC-015, NFR-002·A-P003). up --json 은 이미 write-time
// maskSecrets 가 적용된 BootReport(boot-report.ts)를 재사용하므로 신규 마스킹 로직이 필요 없다 —
// 실 writeBootReport 를 통해 기록한 뒤 실 readBootReport 로 읽는 전 경로를 관통시켜, up --json 이
// 마스킹을 우회하는 신규 노출 경로를 만들지 않았음을 회귀로 확인한다(더블은 launchd/diagnostics
// 만 대체 — boot-report 는 실 구현 사용).

const { loadDaemon, unloadDaemon, daemonRegState, collectStatus, clearHalt } = vi.hoisted(() => ({
  loadDaemon: vi.fn(),
  unloadDaemon: vi.fn(),
  daemonRegState: vi.fn(),
  collectStatus: vi.fn(),
  clearHalt: vi.fn(),
}));
vi.mock("../../src/core/launchd.js", () => ({ loadDaemon, unloadDaemon, daemonRegState }));
vi.mock("../../src/core/diagnostics.js", () => ({ collectStatus, clearHalt }));

import { run } from "../../src/cli/run.js";
import { writeBootReport } from "../../src/core/boot-report.js";

const RAW_TOKEN = `123456789:${"A".repeat(40)}`; // BOT_TOKEN_PATTERN 매치(ops-secret-mask.test.ts 관행)

let tmpBase: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-up-json-secret-"));
  prevHome = process.env["ADDE_HOME"];
  process.env["ADDE_HOME"] = tmpBase;
  daemonRegState.mockResolvedValue({ launchctlRegistered: false });
  clearHalt.mockResolvedValue(undefined);
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

describe("up --json — 기동 실패 사유의 raw 토큰이 평문 노출되지 않는다 (SC-015 Error)", () => {
  it("실 writeBootReport 의 write-time 마스킹이 --json 출력에 그대로 반영된다(마스킹만 존재)", async () => {
    // loadDaemon(가짜 데몬 적재) 완료 시점에 데몬이 실제로 리포트를 쓰는 것을 흉내낸다 —
    // waitForBootReport 가 폴링을 시작하기 전에 이미 (bootId=1 > baseline=0) 리포트가 존재.
    loadDaemon.mockImplementation(async () => {
      await writeBootReport(tmpBase, "p", [
        { lane: "bad", status: "error", error: `engine spawn failed token=${RAW_TOKEN}` },
      ]);
    });
    const cap = captureStdout();
    const code = await run(["up", "p", "--json"]);
    cap.restore();
    const raw = cap.out();
    expect(raw).not.toContain(RAW_TOKEN);
    const parsed = JSON.parse(raw) as { lanes: Array<{ lane: string; error?: string }> };
    const bad = parsed.lanes.find((l) => l.lane === "bad");
    expect(bad?.error).toBeDefined();
    expect(bad?.error).not.toContain(RAW_TOKEN);
    expect(bad?.error).toContain("***");
    expect(code).toBe(1); // 실패 레인 존재
  });
});
