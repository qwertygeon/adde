import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { findExecutableInPath, setupAliases } from "../../src/cli/alias.js";
import type { AliasDeps } from "../../src/cli/alias.js";

let tmp: string;
let addeTarget: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adde-alias-"));
  addeTarget = path.join(tmp, "adde");
  fs.writeFileSync(addeTarget, "#!/usr/bin/env node\n");
  fs.chmodSync(addeTarget, 0o755);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function deps(commandExists: (n: string) => Promise<boolean>): AliasDeps {
  return { binDir: tmp, addeTarget, commandExists };
}

describe("findExecutableInPath", () => {
  it("PATH 에서 실행 가능한 파일을 찾는다", async () => {
    const found = await findExecutableInPath("adde", { PATH: tmp } as NodeJS.ProcessEnv);
    expect(found).toBe(addeTarget);
  });

  it("실행 비트 없는 파일은 무시", async () => {
    const plain = path.join(tmp, "noexec");
    fs.writeFileSync(plain, "x");
    fs.chmodSync(plain, 0o644);
    expect(await findExecutableInPath("noexec", { PATH: tmp } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("PATH 에 없으면 null", async () => {
    expect(await findExecutableInPath("ghost", { PATH: tmp } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("setupAliases", () => {
  it("빈 이름은 심링크를 생성한다", async () => {
    const res = await setupAliases(
      ["ad"],
      deps(async () => false),
    );
    expect(res.created).toEqual(["ad"]);
    const link = path.join(tmp, "ad");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(addeTarget));
  });

  it("PATH 에 동명 명령이 있으면 exists 로 건너뛴다(사용자 요구)", async () => {
    const res = await setupAliases(
      ["add"],
      deps(async (n) => n === "add"),
    );
    expect(res.created).toEqual([]);
    expect(res.skipped).toEqual([{ name: "add", reason: "exists" }]);
    expect(fs.existsSync(path.join(tmp, "add"))).toBe(false);
  });

  it("이미 adde 를 가리키는 심링크면 alreadyLinked(멱등)", async () => {
    fs.symlinkSync(addeTarget, path.join(tmp, "ad"));
    // 우리 것이라 commandExists 가 true 여도 alreadyLinked 로 판정되어야 한다.
    const res = await setupAliases(
      ["ad"],
      deps(async () => true),
    );
    expect(res.alreadyLinked).toEqual(["ad"]);
    expect(res.skipped).toEqual([]);
  });

  it("우리 것이 아닌 심링크가 자리를 차지하면 occupied", async () => {
    const other = path.join(tmp, "other-target");
    fs.writeFileSync(other, "x");
    fs.symlinkSync(other, path.join(tmp, "ad"));
    const res = await setupAliases(
      ["ad"],
      deps(async () => false),
    );
    expect(res.skipped).toEqual([{ name: "ad", reason: "occupied" }]);
  });

  it("심링크 생성 실패(EEXIST 비심링크 파일)는 크래시하지 않고 error 로 건너뛴다", async () => {
    // 비심링크·비실행 일반 파일이 자리에 있으면 readlinkSafe→null, commandExists→false 라
    // 두 가드를 통과해 symlink 가 EEXIST 로 throw 한다 — 흡수해 error 사유로 보고해야 한다.
    fs.writeFileSync(path.join(tmp, "ad"), "plain");
    fs.chmodSync(path.join(tmp, "ad"), 0o644);
    const res = await setupAliases(
      ["ad"],
      deps(async () => false),
    );
    expect(res.created).toEqual([]);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]?.name).toBe("ad");
    expect(res.skipped[0]?.reason).toBe("error");
    expect(res.skipped[0]?.detail).toBeTruthy();
  });

  it("한 별칭이 실패해도 다른 별칭 생성은 계속된다(부분 성공 보존)", async () => {
    fs.writeFileSync(path.join(tmp, "ad"), "plain"); // ad 는 EEXIST 로 실패
    fs.chmodSync(path.join(tmp, "ad"), 0o644);
    const res = await setupAliases(
      ["ad", "add"],
      deps(async () => false),
    );
    expect(res.created).toEqual(["add"]); // add 는 정상 생성
    expect(res.skipped.map((s) => s.reason)).toEqual(["error"]);
    expect(fs.lstatSync(path.join(tmp, "add")).isSymbolicLink()).toBe(true);
  });
});
