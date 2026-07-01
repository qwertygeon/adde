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
    // plistLabel(proj) → "com.rtm.adde.<proj>"
    expect(plistLabel("myproj")).toBe("com.rtm.adde.myproj");
    expect(plistLabel("alpha")).toBe("com.rtm.adde.alpha");
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
    // plistPath(proj) → <home>/Library/LaunchAgents/com.rtm.adde.<proj>.plist
    const result = plistPath("myproj", { home: tmpHome });
    expect(result).toBe(
      path.join(tmpHome, "Library", "LaunchAgents", "com.rtm.adde.myproj.plist"),
    );
  });

  it("home 미주입 시 os.homedir() 사용", () => {
    const result = plistPath("myproj");
    expect(result).toContain("Library");
    expect(result).toContain("LaunchAgents");
    expect(result).toContain("com.rtm.adde.myproj.plist");
    expect(result).toContain(os.homedir());
  });
});

// ── renderPlist (SC-007, SC-013) ──────────────────────────────────────────

describe("renderPlist (SC-007 / SC-013)", () => {
  const opts = {
    nodeBin: "/usr/local/bin/node",
    addeBin: "/usr/local/bin/adde",
    logPath: "/tmp/adde-daemon.log",
  };

  it("renderPlist_KeepAlive_RunAtLoad_true_포함 (SC-007)", () => {
    const xml = renderPlist("testproj", opts);
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<true/>");
    expect(xml).toContain("<key>RunAtLoad</key>");
  });

  it("KeepAlive=true 와 RunAtLoad=true 가 한 출력에 모두 존재", () => {
    const xml = renderPlist("testproj", opts);
    // 순서 무관 — 둘 다 존재해야 한다
    const keepAliveIdx = xml.indexOf("<key>KeepAlive</key>");
    const runAtLoadIdx = xml.indexOf("<key>RunAtLoad</key>");
    expect(keepAliveIdx).toBeGreaterThan(-1);
    expect(runAtLoadIdx).toBeGreaterThan(-1);
    // 각 키 직후에 <true/> 가 따른다
    const afterKeepAlive = xml.slice(keepAliveIdx).replace(/\s+/g, "");
    expect(afterKeepAlive).toMatch(/^<key>KeepAlive<\/key><true\/>/);
    const afterRunAtLoad = xml.slice(runAtLoadIdx).replace(/\s+/g, "");
    expect(afterRunAtLoad).toMatch(/^<key>RunAtLoad<\/key><true\/>/);
  });

  it("renderPlist_토큰_정규식_미검출 (SC-013)", () => {
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
    expect(xml).toContain("com.rtm.adde.myproj");
  });

  it("EnvironmentVariables 키 미포함 (시크릿 주입 0)", () => {
    const xml = renderPlist("myproj", opts);
    expect(xml).not.toContain("EnvironmentVariables");
    expect(xml).not.toContain("TELEGRAM_BOT_TOKEN");
  });
});

// ── loadDaemon ────────────────────────────────────────────────────────────

describe("loadDaemon", () => {
  it("loadDaemon_fake_exec_load_argv_검증", async () => {
    const { exec, calls } = makeFakeExec("ok");
    const deps: LaunchdDeps = { exec, home: tmpHome };

    await loadDaemon("myproj", deps);

    // launchctl load <plist경로> 가 호출되어야 한다
    const loadCall = calls.find((c) => c[0] === "load");
    expect(loadCall).toBeDefined();
    expect(loadCall?.[0]).toBe("load");
    expect(loadCall?.[1]).toContain("com.rtm.adde.myproj.plist");
  });

  it("loadDaemon_exit_nonzero_throw_actionable", async () => {
    const { exec } = makeFakeExec("fail");
    const deps: LaunchdDeps = { exec, home: tmpHome };

    // exit code 비정상 시 actionable 메시지와 함께 throw — NFR-003
    await expect(loadDaemon("myproj", deps)).rejects.toThrow();
  });

  it("loadDaemon 성공 시 plist 파일이 LaunchAgents 에 생성된다", async () => {
    const { exec } = makeFakeExec("ok");
    const deps: LaunchdDeps = { exec, home: tmpHome };

    await loadDaemon("myproj", deps);

    const expectedPlist = path.join(
      tmpHome,
      "Library",
      "LaunchAgents",
      "com.rtm.adde.myproj.plist",
    );
    expect(fs.existsSync(expectedPlist)).toBe(true);
  });
});

// ── unloadDaemon ──────────────────────────────────────────────────────────

describe("unloadDaemon", () => {
  it("unloadDaemon_fake_exec_unload_argv_검증", async () => {
    const { exec, calls } = makeFakeExec("ok");
    const deps: LaunchdDeps = { exec, home: tmpHome };
    // plist 미리 생성 — unload 후 삭제 테스트
    const plistDir = path.join(tmpHome, "Library", "LaunchAgents");
    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(path.join(plistDir, "com.rtm.adde.myproj.plist"), "<plist/>");

    await unloadDaemon("myproj", deps);

    const unloadCall = calls.find((c) => c[0] === "unload");
    expect(unloadCall).toBeDefined();
    expect(unloadCall?.[0]).toBe("unload");
    expect(unloadCall?.[1]).toContain("com.rtm.adde.myproj.plist");
  });

  it("unloadDaemon_plist_없어도_멱등", async () => {
    // plist 미존재 시에도 throw 없이 완료(멱등성)
    const { exec } = makeFakeExec("ok");
    const deps: LaunchdDeps = { exec, home: tmpHome };

    await expect(unloadDaemon("myproj", deps)).resolves.toBeUndefined();
  });

  it("unload 후 plist 파일이 제거된다", async () => {
    const { exec } = makeFakeExec("ok");
    const deps: LaunchdDeps = { exec, home: tmpHome };
    const plistDir = path.join(tmpHome, "Library", "LaunchAgents");
    const plistFile = path.join(plistDir, "com.rtm.adde.myproj.plist");
    fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(plistFile, "<plist/>");

    await unloadDaemon("myproj", deps);

    expect(fs.existsSync(plistFile)).toBe(false);
  });

  it("unload 실패(launchctl 비정상 exit)는 흡수하고 멱등 완료", async () => {
    // unloadDaemon 은 unload 실패를 흡수(멱등) — ADR-006 명세
    const { exec } = makeFakeExec("fail");
    const deps: LaunchdDeps = { exec, home: tmpHome };

    await expect(unloadDaemon("myproj", deps)).resolves.toBeUndefined();
  });
});

// ── daemonRegState ────────────────────────────────────────────────────────

describe("daemonRegState", () => {
  function makePlist(home: string, proj: string): string {
    const dir = path.join(home, "Library", "LaunchAgents");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `com.rtm.adde.${proj}.plist`);
    fs.writeFileSync(file, "<plist/>");
    return file;
  }

  it("daemonRegState_plist_존재_list_포함_등록됨", async () => {
    makePlist(tmpHome, "myproj");
    const label = plistLabel("myproj");
    const { exec } = makeFakeExec("list-match", label);
    const deps: LaunchdDeps = { exec, home: tmpHome };

    const state = await daemonRegState("myproj", deps);

    expect(state.plistExists).toBe(true);
    expect(state.launchctlRegistered).toBe(true);
  });

  it("daemonRegState_plist_없음_미등록", async () => {
    // plist 미생성, list 에도 없음
    const { exec } = makeFakeExec("list-no-match");
    const deps: LaunchdDeps = { exec, home: tmpHome };

    const state = await daemonRegState("myproj", deps);

    expect(state.plistExists).toBe(false);
    expect(state.launchctlRegistered).toBe(false);
  });

  it("daemonRegState_plist_없음_list_포함_불일치", async () => {
    // plist 미존재 + launchctl list 에 있음 (비정상 상태)
    const label = plistLabel("myproj");
    const { exec } = makeFakeExec("list-match", label);
    const deps: LaunchdDeps = { exec, home: tmpHome };

    const state = await daemonRegState("myproj", deps);

    expect(state.plistExists).toBe(false);
    expect(state.launchctlRegistered).toBe(true);
  });

  it("plist 존재 + list 없음 불일치", async () => {
    // plist 존재 + launchctl list 에 없음 (비정상 상태)
    makePlist(tmpHome, "myproj");
    const { exec } = makeFakeExec("list-no-match");
    const deps: LaunchdDeps = { exec, home: tmpHome };

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
    const deps: LaunchdDeps = { exec, home: tmpHome };

    const state = await daemonRegState("myproj", deps);
    expect(state.launchctlRegistered).toBe(true);
  });
});
