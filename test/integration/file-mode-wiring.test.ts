import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// `file_mode` 는 기본값이 `private`(0700) 인 노출된 프로젝트 설정 키이고 사용자 대면 문구가 내부
// state·queue 디렉터리를 지배한다고 서술하지만, v2 에서 적용자 호출처가 0이라 어떤 디렉터리에도
// 적용되지 않았다. 프리미티브 직접 호출 테스트는 이 배선 부재를 그대로 통과시켰으므로(실제로
// 통과했다) 여기서는 **프로덕션 경로**(CLI 프로젝트 생성 · 데몬 기동 조립)를 태워 실제 mode 를 읽는다.

let home: string;
const origHome = process.env["ADDE_HOME"];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "adde-filemode-"));
  process.env["ADDE_HOME"] = home;
});

afterEach(() => {
  if (origHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = origHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

async function runProjectAdd(args: string[]): Promise<number> {
  const projectCli = await import("../../src/cli/project.js");
  return projectCli.runProject(args);
}

describe("file_mode 적용 배선(프로젝트 생성)", () => {
  it("Happy: 기본값(private)으로 생성하면 설정 루트 내부 디렉터리가 0700 이 된다", async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "adde-filemode-vault-"));
    try {
      const code = await runProjectAdd(["add", "p1", "--vault", vault]);
      expect(code).toBe(0);

      const pathsMod = await import("../../src/shared/paths.js");
      const pp = pathsMod.projectPaths(home, "p1");
      expect(mode(pp.root)).toBe(0o700);
      expect(mode(pp.sessionsDir)).toBe(0o700);
      expect(mode(pp.runtimeDir)).toBe(0o700);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  }, 20_000);

  it("Happy: file_mode=shared 로 선언하면 권한을 조이지 않는다(열람 허용 옵트인)", async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "adde-filemode-vault-"));
    try {
      const code = await runProjectAdd(["add", "p2", "--vault", vault]);
      expect(code).toBe(0);

      const pathsMod = await import("../../src/shared/paths.js");
      const pp = pathsMod.projectPaths(home, "p2");
      // 선언을 shared 로 바꾸고 권한을 느슨하게 만든 뒤 적용자를 다시 태운다.
      fs.appendFileSync(pp.projectConf, "file_mode=shared\n");
      fs.chmodSync(pp.runtimeDir, 0o755);

      const fileMode = await import("../../src/shared/file-mode.js");
      await fileMode.applyProjectFileMode(home, "p2", "shared");
      expect(mode(pp.runtimeDir)).toBe(0o755);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("file_mode 적용 배선(데몬 기동)", () => {
  it("Happy: 기동 조립이 느슨해진 내부 디렉터리를 다시 0700 으로 조인다", async () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "adde-filemode-vault-"));
    try {
      expect(await runProjectAdd(["add", "p3", "--vault", vault])).toBe(0);
      const pathsMod = await import("../../src/shared/paths.js");
      const pp = pathsMod.projectPaths(home, "p3");

      // 다른 머신에서 복제된 설정·이전 버전 잔존 등으로 권한이 느슨한 상태 재현.
      fs.chmodSync(pp.runtimeDir, 0o755);
      fs.chmodSync(pp.sessionsDir, 0o755);

      const supervisor = await import("../../src/core/supervisor.js");
      await supervisor.supervisorUp("p3");
      try {
        expect(mode(pp.runtimeDir)).toBe(0o700);
        expect(mode(pp.sessionsDir)).toBe(0o700);
      } finally {
        await supervisor.supervisorDown("p3");
      }
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  }, 30_000);
});
