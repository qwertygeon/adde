import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  plistLabel,
  plistPath,
  renderPlist,
  loadDaemon,
  unloadDaemon,
  daemonRegState,
  trimTail,
} from "../../src/core/launchd.js";
import type { LaunchctlExec, LaunchdDeps } from "../../src/core/launchd.js";

// D-001: launchd.ts — plist 렌더·경로·load/unload·regState (A-001~A-005)
// SC-007(KeepAlive/RunAtLoad), SC-013(시크릿 비포함), plistLabel/Path, loadDaemon/unloadDaemon, daemonRegState

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "adde-launchd-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// fake LaunchctlExec — 실 launchctl 미접촉. 호출된 argv 를 기록한다.
function makeFakeExec(
  behavior: "ok" | "fail" | "list-match" | "list-no-match" = "ok",
  label?: string,
): { exec: LaunchctlExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: LaunchctlExec = async (args) => {
    calls.push(args);
    if (behavior === "fail") {
      return { stdout: "launchctl: Error 125: Domain does not exist", code: 125 };
    }
    if (behavior === "list-match" && label) {
      return { stdout: `PID\tStatus\tLabel\n-\t0\t${label}\n`, code: 0 };
    }
    if (behavior === "list-no-match") {
      return { stdout: "PID\tStatus\tLabel\n-\t0\tcom.apple.something\n", code: 0 };
    }
    return { stdout: "", code: 0 };
  };
  return { exec, calls };
}

// ── plistLabel / plistPath ────────────────────────────────────────────────

describe("plistLabel", () => {
  it("plistLabel_proj_고유_Label_반환", () => {
    // plistLabel(proj) → "com.qwertygeon.adde.<proj>"
    expect(plistLabel("myproj")).toBe("com.qwertygeon.adde.myproj");
    expect(plistLabel("alpha")).toBe("com.qwertygeon.adde.alpha");
  });

  it("서로 다른 proj 는 서로 다른 Label", () => {
    expect(plistLabel("proj-a")).not.toBe(plistLabel("proj-b"));
  });

  it("unsafe_proj_assertSafeSegment_throw", () => {
    // assertSafeSegment 가 경로탈출 차단 — plistLabel 도 throw 해야 한다
    expect(() => plistLabel("../evil")).toThrow();
    expect(() => plistLabel("a/b")).toThrow();
  });
});

describe("plistPath", () => {
  it("plistPath_LaunchAgents_경로_반환", () => {
    // plistPath(proj) → <home>/Library/LaunchAgents/com.qwertygeon.adde.<proj>.plist
    const result = plistPath("myproj", { home: tmpHome });
    expect(result).toBe(
      path.join(tmpHome, "Library", "LaunchAgents", "com.qwertygeon.adde.myproj.plist"),
    );
  });

  it("home 미주입 시 os.homedir() 사용", () => {
    const result = plistPath("myproj");
    expect(result).toContain("Library");
    expect(result).toContain("LaunchAgents");
    expect(result).toContain("com.qwertygeon.adde.myproj.plist");
    expect(result).toContain(os.homedir());
  });
});

// ── renderPlist (SC-012 / SC-013 / SC-018) ────────────────────────────────
// autoRestart 필드 필수 추가(research.md production 시그니처 변경 §1) — 기존 KeepAlive
// boolean(<true/>) 단언은 신 시맨틱(on=dict/off=미포함)으로 대체된다.

describe("renderPlist (SC-012 / SC-013 / SC-018)", () => {
  const opts = {
    nodeBin: "/usr/local/bin/node",
    addeBin: "/usr/local/bin/adde",
    logPath: "/tmp/adde-daemon.log",
    autoRestart: true,
  };

  it("autoRestart=true → KeepAlive dict(SuccessfulExit=false·Crashed=true) + RunAtLoad 유지 (SC-012 Happy)", () => {
    const xml = renderPlist("testproj", opts);
    expect(xml).toContain("<key>KeepAlive</key>");
    const keepAliveIdx = xml.indexOf("<key>KeepAlive</key>");
    const afterKeepAlive = xml.slice(keepAliveIdx).replace(/\s+/g, "");
    expect(afterKeepAlive).toMatch(
      /^<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><key>Crashed<\/key><true\/><\/dict>/,
    );
    expect(xml).toContain("<key>RunAtLoad</key>");
    const runAtLoadIdx = xml.indexOf("<key>RunAtLoad</key>");
    const afterRunAtLoad = xml.slice(runAtLoadIdx).replace(/\s+/g, "");
    expect(afterRunAtLoad).toMatch(/^<key>RunAtLoad<\/key><true\/>/);
  });

  it("autoRestart=true → ThrottleInterval=60 (SC-013 Happy)", () => {
    const xml = renderPlist("testproj", opts);
    expect(xml).toContain("<key>ThrottleInterval</key>");
    const idx = xml.indexOf("<key>ThrottleInterval</key>");
    const after = xml.slice(idx).replace(/\s+/g, "");
    expect(after).toMatch(/^<key>ThrottleInterval<\/key><integer>60<\/integer>/);
  });

  it("autoRestart=false → KeepAlive 키 미포함(ThrottleInterval 도 미포함)·RunAtLoad 유지 (SC-018 Happy)", () => {
    const xml = renderPlist("testproj", { ...opts, autoRestart: false });
    expect(xml).not.toContain("<key>KeepAlive</key>");
    expect(xml).not.toContain("<key>ThrottleInterval</key>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    const runAtLoadIdx = xml.indexOf("<key>RunAtLoad</key>");
    const afterRunAtLoad = xml.slice(runAtLoadIdx).replace(/\s+/g, "");
    expect(afterRunAtLoad).toMatch(/^<key>RunAtLoad<\/key><true\/>/);
  });

  it("renderPlist_토큰_정규식_미검출", () => {
    const xml = renderPlist("testproj", opts);
    // 실제 봇 토큰 패턴: [0-9]+:[A-Za-z0-9_-]{35,}
    const tokenPattern = /[0-9]+:[A-Za-z0-9_-]{35,}/;
    expect(xml).not.toMatch(tokenPattern);
  });

  it("ProgramArguments 에 __daemon 과 proj 포함", () => {
    const xml = renderPlist("myproj", opts);
    expect(xml).toContain("__daemon");
    expect(xml).toContain("myproj");
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/usr/local/bin/adde</string>");
  });

  it("Label 에 proj Label 포함", () => {
    const xml = renderPlist("myproj", opts);
    expect(xml).toContain("com.qwertygeon.adde.myproj");
  });

  it("pathEnv 미지정 시 EnvironmentVariables 키 미포함(구 동작)", () => {
    const xml = renderPlist("myproj", opts);
    expect(xml).not.toContain("EnvironmentVariables");
  });

  it("pathEnv 지정 시 EnvironmentVariables.PATH 만 주입(토큰 등 시크릿 없음)", () => {
    const xml = renderPlist("myproj", { ...opts, pathEnv: "/opt/homebrew/bin:/usr/bin" });
    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>PATH</key>");
    expect(xml).toContain("<string>/opt/homebrew/bin:/usr/bin</string>");
    expect(xml).not.toContain("TELEGRAM_BOT_TOKEN");
    // 시크릿(봇 토큰) 패턴은 여전히 미검출
    expect(xml).not.toMatch(/[0-9]+:[A-Za-z0-9_-]{35,}/);
  });

  it("pathEnv 의 XML 특수문자를 이스케이프한다", () => {
    const xml = renderPlist("myproj", { ...opts, pathEnv: "/a&b/bin:/c<d" });
    expect(xml).toContain("/a&amp;b/bin:/c&lt;d");
    expect(xml).not.toContain("/a&b/bin");
  });
});

// ── trimTail (SC-011) ──────────────────────────────────────────────────────

describe("trimTail (SC-011 Edge — launchd 로그 keep-tail 트림)", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(tmpHome, "big.err.log");
  });

  it("파일이 keepBytes 를 초과하면 끝 N바이트만 남긴다", async () => {
    const content = "0123456789".repeat(1000); // 10000 bytes
    fs.writeFileSync(tmpFile, content);
    const keepBytes = 100;

    await trimTail(tmpFile, keepBytes);

    const result = fs.readFileSync(tmpFile, "utf8");
    expect(result.length).toBe(keepBytes);
    expect(result).toBe(content.slice(-keepBytes));
  });

  it("파일 크기가 keepBytes 이하이면 no-op(내용 불변)", async () => {
    const content = "small content";
    fs.writeFileSync(tmpFile, content);

    await trimTail(tmpFile, 1024);

    expect(fs.readFileSync(tmpFile, "utf8")).toBe(content);
  });

  it("파일 부재 시 throw 하지 않는다(no-op)", async () => {
    const missing = path.join(tmpHome, "does-not-exist.err.log");
    await expect(trimTail(missing, 1024)).resolves.toBeUndefined();
  });

  it("대용량 파일도 끝 N바이트만 유지하며 전체를 메모리로 적재하지 않는다", async () => {
    // 5MB 파일 — 트림 자체가 완료되고(타임아웃 없이) 결과가 keepBytes 로 정확히 축소됨을 확인.
    // (구현이 open→fstat→끝 keepBytes read→임시파일 write→rename 을 쓰는지는 API 계약으로
    //  간접 검증 — 전체 적재 여부의 직접 계측은 E2E/프로파일링 영역, 여기선 결과 크기로 검증.)
    const size = 5 * 1024 * 1024;
    const buf = Buffer.alloc(size, "x");
    buf.write("TAIL-MARKER", size - 20);
    fs.writeFileSync(tmpFile, buf);
    const keepBytes = 1024;

    await trimTail(tmpFile, keepBytes);

    const result = fs.readFileSync(tmpFile);
    expect(result.length).toBe(keepBytes);
    expect(result.toString("utf8")).toContain("TAIL-MARKER");
  });
});

// ── loadDaemon ────────────────────────────────────────────────────────────

describe("loadDaemon", () => {
  // 존재하는 데몬 실행 파일(가드 통과용) — tmpHome 에 더미 생성.
  function makeAddeBin(): string {
    const bin = path.join(tmpHome, "adde.js");
    fs.writeFileSync(bin, "// dummy");
    return bin;
  }

  it("loadDaemon_fake_exec_load_argv_검증", async () => {
    const { exec, calls } = makeFakeExec("ok");
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin", addeBin: makeAddeBin() };

    await loadDaemon("myproj", deps);

    // launchctl load <plist경로> 가 호출되어야 한다
    const loadCall = calls.find((c) => c[0] === "load");
    expect(loadCall).toBeDefined();
    expect(loadCall?.[0]).toBe("load");
    expect(loadCall?.[1]).toContain("com.qwertygeon.adde.myproj.plist");
  });

  it("loadDaemon_exit_nonzero_throw_actionable", async () => {
    const { exec } = makeFakeExec("fail");
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin", addeBin: makeAddeBin() };

    // exit code 비정상 시 actionable 메시지와 함께 throw — NFR-003
    await expect(loadDaemon("myproj", deps)).rejects.toThrow();
  });

  it("loadDaemon 성공 시 plist 파일이 LaunchAgents 에 생성된다", async () => {
    const { exec } = makeFakeExec("ok");
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin", addeBin: makeAddeBin() };

    await loadDaemon("myproj", deps);

    const expectedPlist = path.join(
      tmpHome,
      "Library",
      "LaunchAgents",
      "com.qwertygeon.adde.myproj.plist",
    );
    expect(fs.existsSync(expectedPlist)).toBe(true);
  });

  it("데몬 실행 파일이 없으면 actionable throw(dev/tsx 데몬 방어)", async () => {
    const { exec, calls } = makeFakeExec("ok");
    const missingBin = path.join(tmpHome, "does-not-exist", "adde.js");
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin", addeBin: missingBin };

    // 실행 파일 부재 → load 시도 전에 throw, plist·launchctl 미접촉
    await expect(loadDaemon("myproj", deps)).rejects.toThrow();
    expect(calls.find((c) => c[0] === "load")).toBeUndefined();
    const plist = path.join(tmpHome, "Library", "LaunchAgents", "com.qwertygeon.adde.myproj.plist");
    expect(fs.existsSync(plist)).toBe(false);
  });

  it("생성된 plist 에 데몬 PATH(EnvironmentVariables) 가 주입된다", async () => {
    const { exec } = makeFakeExec("ok");
    const deps: LaunchdDeps = {
      exec,
      home: tmpHome,
      platform: "darwin",
      addeBin: makeAddeBin(),
      pathEnv: "/opt/homebrew/bin:/usr/bin",
    };

    await loadDaemon("myproj", deps);

    const plist = fs.readFileSync(
      path.join(tmpHome, "Library", "LaunchAgents", "com.qwertygeon.adde.myproj.plist"),
      "utf8",
    );
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain("<string>/opt/homebrew/bin:/usr/bin</string>");
  });

  it("pathEnv 미주입 시 node 디렉터리가 PATH 앞에 온다", async () => {
    const { exec } = makeFakeExec("ok");
    const deps: LaunchdDeps = {
      exec,
      home: tmpHome,
      platform: "darwin",
      addeBin: makeAddeBin(),
      nodeBin: "/custom/node/bin/node",
      // pathEnv 미지정 → process.env.PATH + dirname(nodeBin)
    };

    await loadDaemon("myproj", deps);

    const plist = fs.readFileSync(
      path.join(tmpHome, "Library", "LaunchAgents", "com.qwertygeon.adde.myproj.plist"),
      "utf8",
    );
    const m = plist.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/);
    expect(m).not.toBeNull();
    expect(m![1]!.split(":")[0]).toBe("/custom/node/bin");
  });
});

// ── unloadDaemon ──────────────────────────────────────────────────────────

describe("unloadDaemon", () => {
  it("unloadDaemon_fake_exec_unload_argv_검증", async () => {
    const { exec, calls } = makeFakeExec("ok");
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin" };
    // plist 미리 생성 — unload 후 삭제 테스트
    const plistDir = path.join(tmpHome, "Library", "LaunchAgents");
    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(path.join(plistDir, "com.qwertygeon.adde.myproj.plist"), "<plist/>");

    await unloadDaemon("myproj", deps);

    const unloadCall = calls.find((c) => c[0] === "unload");
    expect(unloadCall).toBeDefined();
    expect(unloadCall?.[0]).toBe("unload");
    expect(unloadCall?.[1]).toContain("com.qwertygeon.adde.myproj.plist");
  });

  it("unloadDaemon_plist_없어도_멱등", async () => {
    // plist 미존재 시에도 throw 없이 완료(멱등성)
    const { exec } = makeFakeExec("ok");
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin" };

    await expect(unloadDaemon("myproj", deps)).resolves.toBeUndefined();
  });

  it("unload 후 plist 파일이 제거된다", async () => {
    const { exec } = makeFakeExec("ok");
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin" };
    const plistDir = path.join(tmpHome, "Library", "LaunchAgents");
    const plistFile = path.join(plistDir, "com.qwertygeon.adde.myproj.plist");
    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(plistFile, "<plist/>");

    await unloadDaemon("myproj", deps);

    expect(fs.existsSync(plistFile)).toBe(false);
  });

  it("unload 실패(launchctl 비정상 exit)는 흡수하고 멱등 완료", async () => {
    // unloadDaemon 은 unload 실패를 흡수(멱등) — ADR-006 명세
    const { exec } = makeFakeExec("fail");
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin" };

    await expect(unloadDaemon("myproj", deps)).resolves.toBeUndefined();
  });
});

// ── daemonRegState ────────────────────────────────────────────────────────

describe("daemonRegState", () => {
  function makePlist(home: string, proj: string): string {
    const dir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `com.qwertygeon.adde.${proj}.plist`);
    fs.writeFileSync(file, "<plist/>");
    return file;
  }

  it("daemonRegState_plist_존재_list_포함_등록됨", async () => {
    makePlist(tmpHome, "myproj");
    const label = plistLabel("myproj");
    const { exec } = makeFakeExec("list-match", label);
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin" };

    const state = await daemonRegState("myproj", deps);

    expect(state.plistExists).toBe(true);
    expect(state.launchctlRegistered).toBe(true);
  });

  it("daemonRegState_plist_없음_미등록", async () => {
    // plist 미생성, list 에도 없음
    const { exec } = makeFakeExec("list-no-match");
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin" };

    const state = await daemonRegState("myproj", deps);

    expect(state.plistExists).toBe(false);
    expect(state.launchctlRegistered).toBe(false);
  });

  it("daemonRegState_plist_없음_list_포함_불일치", async () => {
    // plist 미존재 + launchctl list 에 있음 (비정상 상태)
    const label = plistLabel("myproj");
    const { exec } = makeFakeExec("list-match", label);
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin" };

    const state = await daemonRegState("myproj", deps);

    expect(state.plistExists).toBe(false);
    expect(state.launchctlRegistered).toBe(true);
  });

  it("plist 존재 + list 없음 불일치", async () => {
    // plist 존재 + launchctl list 에 없음 (비정상 상태)
    makePlist(tmpHome, "myproj");
    const { exec } = makeFakeExec("list-no-match");
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin" };

    const state = await daemonRegState("myproj", deps);

    expect(state.plistExists).toBe(true);
    expect(state.launchctlRegistered).toBe(false);
  });

  it("list stdout 에 부분문자열(Label)이 포함되면 등록됨으로 판정", async () => {
    // launchctl list 출력에 proj Label 이 substring 으로 있으면 등록됨
    const label = plistLabel("myproj");
    makePlist(tmpHome, "myproj");
    const exec: LaunchctlExec = async (args) => {
      if (args[0] === "list") {
        // Label 이 다른 텍스트 사이에 있는 경우도 매칭
        return { stdout: `12345\t0\t${label}\nsome.other.label\t-\t0\n`, code: 0 };
      }
      return { stdout: "", code: 0 };
    };
    const deps: LaunchdDeps = { exec, home: tmpHome, platform: "darwin" };

    const state = await daemonRegState("myproj", deps);
    expect(state.launchctlRegistered).toBe(true);
  });
});
