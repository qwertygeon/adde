import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// `--safe-defaults` 는 파서를 통과하고 usage 가 "sudo·rm -rf·git 강제·자격증명 읽기를 하드 차단에
// 시드한다" 고 안내했으나 핸들러가 그 플래그를 읽지 않아 하드 차단 목록이 빈 배열로 생성됐다 —
// 보안 경계에 대한 오인이다. 플래그 선언 단언이 아니라 **실제 생성된 conf 파일**을 읽어 확인한다.

let home: string;
let vault: string;
const origHome = process.env["ADDE_HOME"];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "adde-safedef-"));
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "adde-safedef-vault-"));
  process.env["ADDE_HOME"] = home;
});

afterEach(() => {
  if (origHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = origHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(vault, { recursive: true, force: true });
});

async function addProject(proj: string, extraArgs: string[]): Promise<number> {
  const projectCli = await import("../../src/cli/project.js");
  return projectCli.runProject(["add", proj, "--vault", vault, ...extraArgs]);
}

async function hardDenyOf(proj: string): Promise<string[]> {
  const [conf, pathsMod] = await Promise.all([
    import("../../src/shared/conf.js"),
    import("../../src/shared/paths.js"),
  ]);
  const confPath = pathsMod.projectPaths(home, proj).projectConf;
  return (conf.parseProjectConf(fs.readFileSync(confPath, "utf8")) as { hard_deny: string[] })
    .hard_deny;
}

describe("위험 명령 하드 차단 시드(--safe-defaults)", () => {
  it("Happy: 플래그를 주면 내장 위험 목록이 하드 차단으로 기록된다", async () => {
    expect(await addProject("p1", ["--safe-defaults"])).toBe(0);
    const denyMatch = await import("../../src/shared/deny-match.js");
    const hardDeny = await hardDenyOf("p1");
    expect(hardDeny.length).toBe(denyMatch.DEFAULT_AUTOPASS_DENYLIST.length);
    for (const entry of denyMatch.DEFAULT_AUTOPASS_DENYLIST) {
      expect(hardDeny).toContain(entry);
    }
  });

  it("Happy: 명시 지정분과 합집합이며 중복이 생기지 않는다(방어 심화)", async () => {
    const denyMatch = await import("../../src/shared/deny-match.js");
    const dup = denyMatch.DEFAULT_AUTOPASS_DENYLIST[0]!;
    expect(await addProject("p2", ["--safe-defaults", "--hard-deny", `MyTool,${dup}`])).toBe(0);
    const hardDeny = await hardDenyOf("p2");
    expect(hardDeny).toContain("MyTool");
    expect(hardDeny.filter((e) => e === dup).length).toBe(1);
  });

  it("Edge: 플래그가 없으면 명시 지정분만 기록된다(기존 동작 불변)", async () => {
    expect(await addProject("p3", ["--hard-deny", "OnlyThis"])).toBe(0);
    expect(await hardDenyOf("p3")).toEqual(["OnlyThis"]);
  });
});
