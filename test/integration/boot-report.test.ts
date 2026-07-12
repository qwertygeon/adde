import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { daemonBootReportPath } from "../../src/shared/paths.js";
import { waitFor } from "../helpers/wait.js";

// SC-001 — supervisorUp 완료 시 데몬이 리포트를 실제로 남기는 배선(wiring)을 관통 검증한다.
// 실엔진은 미접촉(supervisorUp mock) — run(["__daemon", proj]) 를 tmp ADDE_HOME 로 격리 실행하고
// 파일시스템에 실제로 기록된 daemon-boot-report.json 내용을 단언한다(run-boot.test.ts 선례 패턴).

const { supervisorUp, supervisorDown } = vi.hoisted(() => ({
  supervisorUp: vi.fn(),
  supervisorDown: vi.fn(),
}));

vi.mock("../../src/core/supervisor.js", () => ({ supervisorUp, supervisorDown }));

import { run } from "../../src/cli/run.js";

const WATCHED_EVENTS = ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGINT"] as const;
const proc = process as unknown as NodeJS.EventEmitter;

let baseline: Record<string, unknown[]>;
let prevAddeHome: string | undefined;
let tmpAddeHome: string;

beforeEach(() => {
  baseline = {};
  for (const ev of WATCHED_EVENTS) baseline[ev] = proc.listeners(ev).slice();
  vi.clearAllMocks();
  // writeBootReport 는 defaultBase()(ADDE_HOME)에 실 fs 로 기록한다 — 실 홈 오염 방지를 위해
  // 격리된 tmp 로 override(run-boot.test.ts 와 동일 관례).
  prevAddeHome = process.env["ADDE_HOME"];
  tmpAddeHome = fs.mkdtempSync(path.join(os.tmpdir(), "adde-boot-report-int-"));
  process.env["ADDE_HOME"] = tmpAddeHome;
});

afterEach(() => {
  for (const ev of WATCHED_EVENTS) {
    const before = new Set(baseline[ev]);
    for (const l of proc.listeners(ev)) {
      if (!before.has(l)) proc.removeListener(ev, l as (...args: unknown[]) => void);
    }
  }
  vi.restoreAllMocks();
  if (prevAddeHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = prevAddeHome;
  fs.rmSync(tmpAddeHome, { recursive: true, force: true });
});

describe("데몬 부팅 리포트 기록 — supervisorUp 완료 시 실제 파일 기록 (SC-001 Happy)", () => {
  it("레인별 최종 상태(A=running·B=error+사유)와 boot id 를 daemon-boot-report.json 에 기록한다", async () => {
    supervisorUp.mockResolvedValue({
      message: "boot",
      lanes: [
        { lane: "A", status: "running" },
        { lane: "B", status: "error", error: "markdown root 누락" },
      ],
    });
    supervisorDown.mockResolvedValue({ message: "down" });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const reportPath = daemonBootReportPath(tmpAddeHome, "demo");
    void run(["__daemon", "demo"]); // A 레인이 running 이라 상주(never-resolve) — fire-and-forget
    await waitFor(() => fs.existsSync(reportPath));

    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
      v: number;
      bootId: number;
      lanes: { lane: string; status: string; error?: string }[];
      running: number;
    };
    expect(report.v).toBe(1);
    expect(report.bootId).toBeGreaterThanOrEqual(1);
    expect(report.lanes.find((l) => l.lane === "A")?.status).toBe("running");
    const laneB = report.lanes.find((l) => l.lane === "B");
    expect(laneB?.status).toBe("error");
    expect(laneB?.error).toContain("markdown root 누락");
    expect(report.running).toBe(1);

    // 정리 — SIGTERM 으로 graceful shutdown 시켜 상주·리스너를 남기지 않는다.
    process.emit("SIGTERM");
    await waitFor(() => exitSpy.mock.calls.length > 0);
    errSpy.mockRestore();
    outSpy.mockRestore();
  });
});
