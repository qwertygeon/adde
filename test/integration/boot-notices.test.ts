import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// 자동 허용 티어로 기동했다는 사실과 어떤 거부 목록 위에서 도는지를 알리는 배너는 v0.2 가 채널로
// 보냈으나 v2 에서 발신 경로 자체가 사라졌다(포매터 호출처 0). 상태 존은 "미해소 실패" 뷰라 해소
// 대상이 아닌 상태 공지를 상주시키지 않으므로, 부팅 리포트의 안내 항목으로 싣는다 —
// 리포트는 up/restart 가 읽어 사용자에게 표시한다.

let home: string;
let vault: string;
const origHome = process.env["ADDE_HOME"];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "adde-notice-"));
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "adde-notice-vault-"));
  process.env["ADDE_HOME"] = home;
});

afterEach(() => {
  if (origHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = origHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(vault, { recursive: true, force: true });
});

async function addProject(proj: string, extraArgs: string[]): Promise<void> {
  const projectCli = await import("../../src/cli/project.js");
  const code = await projectCli.runProject(["add", proj, "--vault", vault, ...extraArgs]);
  expect(code).toBe(0);
}

describe("자동 허용 티어 기동 배너", () => {
  it("Happy: autopass 프로젝트 기동 시 안내가 부팅 리포트에 실린다", async () => {
    await addProject("pa", ["--perm-tier", "autopass"]);
    const supervisor = await import("../../src/core/supervisor.js");
    const bootReport = await import("../../src/core/boot-report.js");

    const result = await supervisor.supervisorUp("pa");
    try {
      expect(result.notices.length).toBe(1);
      // "상황 + 조치" 2요소 형식이어야 한다 — 차이만 알리고 조치가 없으면 대응할 수 없다.
      expect(result.notices[0]).toContain("자동 허용 모드");
      expect(result.notices[0]).toContain("조치");

      await bootReport.writeBootReport(home, "pa", result.sessions, undefined, result.notices);
      const persisted = await bootReport.readBootReport(home, "pa");
      expect(persisted?.notices?.[0]).toContain("자동 허용 모드");
    } finally {
      await supervisor.supervisorDown("pa");
    }
  }, 30_000);

  it("Edge: 기본 티어(acp) 프로젝트에는 배너가 없다", async () => {
    await addProject("pb", []);
    const supervisor = await import("../../src/core/supervisor.js");
    const result = await supervisor.supervisorUp("pb");
    try {
      expect(result.notices).toEqual([]);
    } finally {
      await supervisor.supervisorDown("pb");
    }
  }, 30_000);

  it("Happy: 거부 목록이 비면 모든 요청이 확인 없이 통과한다는 사실을 명시한다", async () => {
    await addProject("pc", ["--perm-tier", "autopass", "--denylist", ""]);
    const supervisor = await import("../../src/core/supervisor.js");
    const result = await supervisor.supervisorUp("pc");
    try {
      expect(result.notices[0]).toContain("확인 없이");
    } finally {
      await supervisor.supervisorDown("pc");
    }
  }, 30_000);
});
