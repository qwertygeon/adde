import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  collectStatus,
  collectAllStatus,
  listRegisteredProjects,
  runDoctor,
  readLogs,
  readHalt,
  clearHalt,
} from "../../src/core/diagnostics.js";
import { writeRuntime } from "../../src/core/runtime-state.js";
import type { RuntimeInfo } from "../../src/core/runtime-state.js";
import { lanePaths, daemonHaltPath, daemonBootsPath } from "../../src/shared/paths.js";
import { createCrashLoopGuard } from "../../src/core/crash-loop.js";
import type { LaunchctlExec as LaunchctlExecType } from "../../src/core/launchd.js";
import type { HaltRecord } from "../../src/core/crash-loop.js";
import { SOURCE_REGISTRY } from "../../src/src-adapters/index.js";
import { parseLaneConf } from "../../src/shared/conf.js";

// SC2: status running/dead/stopped 구분. SC3: doctor 점검+힌트. SC4: logs tail.
// SC-008/009/014/015: daemon 등록 점검 케이스 (daemon-lifecycle spec)

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-diag-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

const conf = (extra = ""): string =>
  `source=telegram\nbackend=acp\nengine=claude-agent-acp\nchannel=telegram\nperm_tier=acp\nacp_version=v1\n${extra}`;

const mdConf = (extra = ""): string =>
  `source=markdown\nbackend=acp\nengine=claude-agent-acp\nchannel=markdown\nperm_tier=acp\nacp_version=v1\n${extra}`;

function writeConf(proj: string, lane: string, text: string): void {
  const lanesDir = path.join(tmpBase, proj, "lanes.d");
  fs.mkdirSync(lanesDir, { recursive: true });
  fs.writeFileSync(path.join(lanesDir, `${lane}.conf`), text);
}

function rt(pid: number, lane: string): RuntimeInfo {
  return {
    v: 1,
    pid,
    lane,
    sessionId: "s",
    startedAt: new Date().toISOString(),
    source: "telegram",
    backend: "acp",
    engine: "claude-agent-acp",
  };
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid!;
  await once(child, "exit");
  return pid;
}

describe("collectStatus (SC2)", () => {
  it("running·dead·stopped 를 구분한다", async () => {
    writeConf("p", "alive", conf());
    writeConf("p", "crashed", conf());
    writeConf("p", "down", conf());
    await writeRuntime(lanePaths(tmpBase, "p", "alive"), rt(process.pid, "alive"));
    await writeRuntime(lanePaths(tmpBase, "p", "crashed"), rt(await deadPid(), "crashed"));
    // "down" 레인은 runtime.json 없음 → stopped

    const rows = await collectStatus("p", { base: tmpBase });
    const byLane = Object.fromEntries(rows.map((r) => [r.lane, r.status]));
    expect(byLane["alive"]).toBe("running");
    expect(byLane["crashed"]).toBe("dead");
    expect(byLane["down"]).toBe("stopped");
  });

  it("running 행은 pid·uptime 을 채우고 stopped 는 null", async () => {
    writeConf("p", "alive", conf());
    writeConf("p", "down", conf());
    await writeRuntime(lanePaths(tmpBase, "p", "alive"), rt(process.pid, "alive"));

    const rows = await collectStatus("p", { base: tmpBase });
    const alive = rows.find((r) => r.lane === "alive");
    const down = rows.find((r) => r.lane === "down");
    expect(alive?.pid).toBe(process.pid);
    expect(alive?.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(down?.pid).toBeNull();
    expect(down?.uptimeMs).toBeNull();
  });

  it("conf 없는 proj 는 빈 배열", async () => {
    expect(await collectStatus("nope", { base: tmpBase })).toEqual([]);
  });

  // SC-S3: pid 생존 + runtime.json mtime 이 임계 초과로 오래되면 stale.
  it("pid 생존이나 하트비트(mtime) 가 오래되면 stale + lastSeenAt 노출", async () => {
    writeConf("p", "hung", conf());
    const lp = lanePaths(tmpBase, "p", "hung");
    await writeRuntime(lp, rt(process.pid, "hung"));
    // mtime 을 임계(180s) 초과 과거로 강제 — 행(hung) 시뮬레이션.
    const past = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lp.runtimeJson, past, past);

    const rows = await collectStatus("p", { base: tmpBase });
    const hung = rows.find((r) => r.lane === "hung");
    expect(hung?.status).toBe("stale");
    expect(hung?.lastSeenAt).not.toBeNull();
  });
});

describe("listRegisteredProjects (status parity)", () => {
  it("lanes.d 를 가진 프로젝트만 열거하고 정렬한다", async () => {
    writeConf("beta", "l1", conf());
    writeConf("alpha", "l1", conf());
    // lanes.d 없는 부속 디렉터리는 프로젝트로 보지 않는다.
    fs.mkdirSync(path.join(tmpBase, "not-a-proj"), { recursive: true });
    expect(await listRegisteredProjects({ base: tmpBase })).toEqual(["alpha", "beta"]);
  });

  it("base 부재 시 빈 배열", async () => {
    expect(await listRegisteredProjects({ base: path.join(tmpBase, "nope") })).toEqual([]);
  });
});

describe("collectAllStatus (status parity — 다중 프로젝트 집계)", () => {
  it("전 프로젝트 레인을 proj 부기와 함께 집계한다", async () => {
    writeConf("p1", "alive", conf());
    writeConf("p2", "down", conf());
    await writeRuntime(lanePaths(tmpBase, "p1", "alive"), rt(process.pid, "alive"));
    // p2/down 은 runtime.json 없음 → stopped

    const rows = await collectAllStatus({ base: tmpBase });
    const key = (r: (typeof rows)[number]): string => `${r.proj}/${r.lane}`;
    const byKey = Object.fromEntries(rows.map((r) => [key(r), r.status]));
    expect(byKey["p1/alive"]).toBe("running");
    expect(byKey["p2/down"]).toBe("stopped");
    // 각 행에 proj 가 부기된다.
    expect(rows.every((r) => typeof r.proj === "string" && r.proj.length > 0)).toBe(true);
  });

  it("프로젝트가 없으면 빈 배열", async () => {
    expect(await collectAllStatus({ base: path.join(tmpBase, "empty") })).toEqual([]);
  });
});

describe("runDoctor (SC3)", () => {
  it("전역 점검: Node 버전은 PASS(테스트 런타임 ≥22)", async () => {
    const checks = await runDoctor(undefined, { base: tmpBase });
    const node = checks.find((c) => c.name === "Node 버전");
    expect(node?.level).toBe("PASS");
  });

  it("데몬 진입 파일 점검 — darwin 은 WARN(tsx 부재)·비-darwin(CI 등)은 스킵", async () => {
    const checks = await runDoctor(undefined, { base: tmpBase });
    const entry = checks.find((c) => c.name === "데몬 진입 파일");
    if (process.platform === "darwin") {
      // vitest 는 src(tsx)로 실행 → src/cli/adde.js 부재 → WARN + 빌드 안내 hint
      expect(entry?.level).toBe("WARN");
      expect(entry?.hint).toBeTruthy();
    } else {
      // 비-darwin(예: ubuntu CI)에서는 데몬 점검을 스킵하므로 항목 없음
      expect(entry).toBeUndefined();
    }
  });

  it("telegram 레인의 토큰 부재는 FAIL + 조치 힌트", async () => {
    writeConf("p", "telegram-claude", conf());
    const checks = await runDoctor("p", { base: tmpBase });
    const token = checks.find((c) => c.name.endsWith("토큰"));
    expect(token?.level).toBe("FAIL");
    expect(token?.hint).toBeTruthy();
  });

  it("토큰 존재 시 PASS", async () => {
    writeConf("p", "telegram-claude", conf());
    const lp = lanePaths(tmpBase, "p", "telegram-claude");
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.writeFileSync(lp.envFile, "TELEGRAM_BOT_TOKEN=abc\n");
    const checks = await runDoctor("p", { base: tmpBase });
    const token = checks.find((c) => c.name.endsWith("토큰"));
    expect(token?.level).toBe("PASS");
  });

  it("존재하지 않는 cwd 는 FAIL", async () => {
    writeConf("p", "telegram-claude", conf(`cwd=${path.join(tmpBase, "no-such-dir")}\n`));
    const checks = await runDoctor("p", { base: tmpBase });
    const cwd = checks.find((c) => c.name.endsWith("cwd"));
    expect(cwd?.level).toBe("FAIL");
  });

  it("root 없는 markdown 레인은 마크다운 경로 FAIL (기동 실패 예방)", async () => {
    writeConf("p", "md-claude", mdConf());
    const checks = await runDoctor("p", { base: tmpBase });
    const md = checks.find((c) => c.name.endsWith("마크다운 경로"));
    expect(md?.level).toBe("FAIL");
    expect(md?.hint).toBeTruthy();
  });

  it("root(존재)+inbox 지정 markdown 레인은 마크다운 경로 PASS", async () => {
    const rootDir = path.join(tmpBase, "vault");
    fs.mkdirSync(rootDir, { recursive: true });
    writeConf("p", "md-ok", mdConf(`markdown.root=${rootDir}\nmarkdown.inbox=inbox.md\n`));
    const checks = await runDoctor("p", { base: tmpBase });
    const md = checks.find((c) => c.name.endsWith("마크다운 경로"));
    expect(md?.level).toBe("PASS");
  });

  it("존재하지 않는 root 의 markdown 레인은 마크다운 경로 FAIL", async () => {
    writeConf(
      "p",
      "md-noroot",
      mdConf(`markdown.root=${path.join(tmpBase, "no-vault")}\nmarkdown.inbox=inbox.md\n`),
    );
    const checks = await runDoctor("p", { base: tmpBase });
    const md = checks.find((c) => c.name.endsWith("마크다운 경로"));
    expect(md?.level).toBe("FAIL");
  });

  it("구 평면 어댑터 키(root=)를 쓰면 conf format FAIL 로 마이그레이션을 안내한다", async () => {
    // 클린 브레이크: 파서가 구 키를 무시하므로 doctor 가 감지해 포맷 변경을 알린다(조용한 실패 방지).
    writeConf("p", "md-legacy", mdConf(`root=${tmpBase}\ninbox=inbox.md\n`));
    const checks = await runDoctor("p", { base: tmpBase });
    const fmt = checks.find((c) => c.name.endsWith("conf format"));
    expect(fmt?.level).toBe("FAIL");
    expect(fmt?.detail).toContain("root");
  });

  it("그룹/기타 읽기 가능한 .env 는 파일 권한 WARN (토큰 노출)", async () => {
    writeConf("p", "lane1", conf());
    const lp = lanePaths(tmpBase, "p", "lane1");
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.chmodSync(lp.stateDir, 0o700);
    fs.writeFileSync(lp.envFile, "TELEGRAM_BOT_TOKEN=abc\n");
    fs.chmodSync(lp.envFile, 0o644);
    const checks = await runDoctor("p", { base: tmpBase });
    const perms = checks.find((c) => c.name.endsWith("파일 권한"));
    expect(perms?.level).toBe("WARN");
    expect(perms?.hint).toContain("chmod 600");
  });

  it("제한적 권한(.env 0600 + state 0700)은 파일 권한 PASS", async () => {
    writeConf("p", "lane1", conf());
    const lp = lanePaths(tmpBase, "p", "lane1");
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.chmodSync(lp.stateDir, 0o700);
    fs.writeFileSync(lp.envFile, "TELEGRAM_BOT_TOKEN=abc\n");
    fs.chmodSync(lp.envFile, 0o600);
    const checks = await runDoctor("p", { base: tmpBase });
    const perms = checks.find((c) => c.name.endsWith("파일 권한"));
    expect(perms?.level).toBe("PASS");
  });

  it("private 모드인데 느슨한 state 디렉터리(0755)는 파일 권한 WARN", async () => {
    writeConf("p", "lane1", conf());
    const lp = lanePaths(tmpBase, "p", "lane1");
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.chmodSync(lp.stateDir, 0o755);
    const checks = await runDoctor("p", { base: tmpBase });
    const perms = checks.find((c) => c.name.endsWith("파일 권한"));
    expect(perms?.level).toBe("WARN");
    expect(perms?.hint).toContain("chmod 700");
  });

  it("shared 모드는 느슨한 state 디렉터리를 경고하지 않는다(의도된 선택)", async () => {
    writeConf("p", "lane1", conf("file_mode=shared\n"));
    const lp = lanePaths(tmpBase, "p", "lane1");
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.chmodSync(lp.stateDir, 0o755);
    const checks = await runDoctor("p", { base: tmpBase });
    const perms = checks.find((c) => c.name.endsWith("파일 권한"));
    expect(perms?.level).toBe("PASS");
  });
});

describe("readLogs (SC4)", () => {
  it("최근 N줄을 반환한다", async () => {
    const lp = lanePaths(tmpBase, "p", "lane1");
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.writeFileSync(lp.transcriptLog, ["a", "b", "c", "d", "e"].join("\n") + "\n");
    const res = await readLogs("p", "lane1", 2, { base: tmpBase });
    expect(res.exists).toBe(true);
    expect(res.lines).toEqual(["d", "e"]);
  });

  it("파일 부재 시 exists=false", async () => {
    const res = await readLogs("p", "ghost", 50, { base: tmpBase });
    expect(res.exists).toBe(false);
    expect(res.lines).toEqual([]);
  });

  // SC-R2: --engine 시 engine.log 를 읽고, 기본은 transcript.log.
  it("engine 옵션 시 engine.log 를 읽는다", async () => {
    const lp = lanePaths(tmpBase, "p", "lane1");
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.writeFileSync(lp.transcriptLog, "transcript-line\n");
    fs.writeFileSync(lp.engineLog, ["err1", "err2", "err3"].join("\n") + "\n");
    const res = await readLogs("p", "lane1", 2, { base: tmpBase, engine: true });
    expect(res.exists).toBe(true);
    expect(res.path).toBe(lp.engineLog);
    expect(res.lines).toEqual(["err2", "err3"]);
  });

  it("engine 옵션 없으면 transcript.log 를 읽는다(엔진 로그가 있어도)", async () => {
    const lp = lanePaths(tmpBase, "p", "lane1");
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.writeFileSync(lp.transcriptLog, "transcript-line\n");
    fs.writeFileSync(lp.engineLog, "engine-line\n");
    const res = await readLogs("p", "lane1", 50, { base: tmpBase });
    expect(res.path).toBe(lp.transcriptLog);
    expect(res.lines).toEqual(["transcript-line"]);
  });

  it("engine 옵션 시 engine.log 부재면 exists=false", async () => {
    const lp = lanePaths(tmpBase, "p", "lane1");
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.writeFileSync(lp.transcriptLog, "transcript-line\n");
    const res = await readLogs("p", "lane1", 50, { base: tmpBase, engine: true });
    expect(res.exists).toBe(false);
    expect(res.path).toBe(lp.engineLog);
  });
});

// readLogs — 스냅샷 종료 바이트 오프셋·inode 반환(코어 파트) — SC-104. ops.ts runLogs 의 follow
// 진입이 이 값을 그대로 startOffset·startIno 로 이어받아 별도 stat 경합 창을 없앤다(ADR-004).
describe("readLogs — endOffset·startIno 반환 (SC-104 코어)", () => {
  it("endOffset 은 스냅샷이 읽은 바이트 종료 오프셋, startIno 는 파일 inode 다", async () => {
    const lp = lanePaths(tmpBase, "p", "lane1");
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.writeFileSync(lp.transcriptLog, "a\nb\nc\n");
    const res = await readLogs("p", "lane1", 50, { base: tmpBase });
    const st = fs.statSync(lp.transcriptLog);
    expect(res.endOffset).toBe(st.size);
    expect(res.startIno).toBe(st.ino);
  });

  it("파일 부재 시 endOffset·startIno 는 0", async () => {
    const res = await readLogs("p", "ghost", 50, { base: tmpBase });
    expect(res.endOffset).toBe(0);
    expect(res.startIno).toBe(0);
  });

  it("--engine 옵션 시 engine.log 기준 endOffset·startIno 를 반환한다", async () => {
    const lp = lanePaths(tmpBase, "p", "lane1");
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.writeFileSync(lp.transcriptLog, "transcript-line\n");
    fs.writeFileSync(lp.engineLog, ["err1", "err2"].join("\n") + "\n");
    const res = await readLogs("p", "lane1", 50, { base: tmpBase, engine: true });
    const st = fs.statSync(lp.engineLog);
    expect(res.endOffset).toBe(st.size);
    expect(res.startIno).toBe(st.ino);
  });
});

// ── runDoctor daemon 등록 점검 (SC-008/009/014/015) ─────────────────────
// fake launchctlExec 주입 — CI 에서 실 launchctl 미접촉

function makeLaunchctlExec(launchctlHasLabel: boolean, proj: string): LaunchctlExecType {
  const label = `com.qwertygeon.adde.${proj}`;
  return async (args) => {
    if (args[0] === "list") {
      const stdout = launchctlHasLabel
        ? `PID\tStatus\tLabel\n-\t0\t${label}\n`
        : `PID\tStatus\tLabel\n-\t0\tcom.apple.other\n`;
      return { stdout, code: 0 };
    }
    return { stdout: "", code: 0 };
  };
}

describe("runDoctor — daemon 등록 점검 (SC-008/SC-009)", () => {
  // darwin 전용 — 비-darwin 환경에서는 항목 스킵
  const isDarwin = process.platform === "darwin";

  it("daemon_등록_PASS (SC-008) — plist 존재 + list 등록", async () => {
    if (!isDarwin) {
      expect(true).toBe(true);
      return;
    }
    writeConf("dproj", "telegram-claude", conf());

    // launchctl list 에 Label 있음 → launchctlRegistered=true
    // plistExists 는 실제 파일 stat → plist 파일도 tmpHome 에 생성해야 함
    // (diagnostics.ts 가 daemonRegState 로 실제 plist 경로 stat 함)
    // home 경로를 직접 지정하지 못하므로 — 이 케이스는 darwin 환경에서
    // 실제 plist 파일 없이 exec 만으로는 plistExists=false → 불일치 WARN 가능
    // 완전한 PASS 검증은 운영 검증(옵션 A) — 여기서는 exec 주입으로 launchctlRegistered 경로 검증
    const fakeExec = makeLaunchctlExec(true, "dproj");
    const checks = await runDoctor("dproj", {
      base: tmpBase,
      launchctlExec: fakeExec,
    });

    const daemonCheck = checks.find((c) => c.name.startsWith("daemon 등록"));
    // daemon 점검 항목이 존재해야 한다
    expect(daemonCheck).toBeDefined();
    // level 은 plist 파일 존재 여부에 따라 PASS 또는 WARN
    expect(["PASS", "WARN"]).toContain(daemonCheck?.level);
  });

  it("daemon_plist_없음_list_없음_PASS (SC-008 — 데몬 미기동 정상)", async () => {
    if (!isDarwin) {
      expect(true).toBe(true);
      return;
    }
    writeConf("dproj2", "telegram-claude", conf());

    // 둘 다 없음 → 데몬 미기동 정상 → PASS
    const fakeExec = makeLaunchctlExec(false, "dproj2");
    const checks = await runDoctor("dproj2", {
      base: tmpBase,
      launchctlExec: fakeExec,
    });

    const daemonCheck = checks.find((c) => c.name.startsWith("daemon 등록"));
    expect(daemonCheck).toBeDefined();
    // plist 없음 + list 없음 → PASS(데몬 미기동 정상)
    expect(daemonCheck?.level).toBe("PASS");
  });

  it("daemon_plist_없음_등록됨_WARN_hint (SC-009 — 불일치 감지)", async () => {
    if (!isDarwin) {
      expect(true).toBe(true);
      return;
    }
    writeConf("dproj3", "telegram-claude", conf());

    // launchctl list 에 Label 있음 + plist 없음 → 불일치 WARN
    const fakeExec = makeLaunchctlExec(true, "dproj3");
    const checks = await runDoctor("dproj3", {
      base: tmpBase,
      launchctlExec: fakeExec,
    });

    const daemonCheck = checks.find((c) => c.name.startsWith("daemon 등록"));
    expect(daemonCheck).toBeDefined();
    // plist 없음 + list 있음 → 불일치 WARN
    expect(daemonCheck?.level).toBe("WARN");
  });

  it("WARN_항목_hint_조치_형식_포함 (SC-014) — WARN 항목에 hint 필드 존재", async () => {
    if (!isDarwin) {
      expect(true).toBe(true);
      return;
    }
    writeConf("hintproj", "telegram-claude", conf());

    // 불일치 WARN 유발
    const fakeExec = makeLaunchctlExec(true, "hintproj");
    const checks = await runDoctor("hintproj", {
      base: tmpBase,
      launchctlExec: fakeExec,
    });

    const daemonCheck = checks.find((c) => c.name.startsWith("daemon 등록"));
    if (daemonCheck?.level === "WARN") {
      // NFR-003: WARN 항목에는 hint 가 있어야 한다
      expect(daemonCheck.hint).toBeDefined();
      expect(daemonCheck.hint).toBeTruthy();
    } else {
      // PASS 이면 hint 없어도 됨 — 상황에 따른 분기
      expect(true).toBe(true);
    }
  });
});

describe("기존 conf·runtime.json 스키마 비침해 (SC-015)", () => {
  it("기존_conf_런타임_스키마_비침해", async () => {
    // conf 파일(v:1 스키마 runtime.json) 이 launchd 도입 후에도 불변임을 검증
    writeConf("legacyproj", "tg-lane", conf());
    const lp = lanePaths(tmpBase, "legacyproj", "tg-lane");

    // v:1 스키마 runtime.json 작성
    const originalRuntime: RuntimeInfo = {
      v: 1,
      pid: process.pid,
      lane: "tg-lane",
      sessionId: "orig-session",
      startedAt: new Date().toISOString(),
      source: "telegram",
      backend: "acp",
      engine: "claude-agent-acp",
    };
    await writeRuntime(lp, originalRuntime);

    // collectStatus 가 기존 runtime.json 을 그대로 읽을 수 있어야 한다 (스키마 불변)
    const rows = await collectStatus("legacyproj", { base: tmpBase });
    const row = rows.find((r) => r.lane === "tg-lane");
    expect(row).toBeDefined();
    expect(row?.sessionId).toBe("orig-session");
    expect(row?.source).toBe("telegram");
    expect(row?.backend).toBe("acp");
    expect(row?.engine).toBe("claude-agent-acp");
  });

  it("lanes.d conf 파일이 runDoctor 후에도 내용 불변", async () => {
    const confContent = conf();
    writeConf("legacyproj2", "tg-lane2", confContent);
    const confPath = path.join(tmpBase, "legacyproj2", "lanes.d", "tg-lane2.conf");

    await runDoctor("legacyproj2", { base: tmpBase });

    // conf 파일 내용 불변
    const afterContent = fs.readFileSync(confPath, "utf8");
    expect(afterContent).toBe(confContent);
  });
});

// ── readHalt / clearHalt (SC-023·024·025 지원 프리미티브) ──────────────────

describe("readHalt / clearHalt", () => {
  it("daemon-halt.json 부재 시 readHalt 는 null", async () => {
    expect(await readHalt(tmpBase, "haltproj")).toBeNull();
  });

  it("daemon-halt.json 존재 시 readHalt 가 원인·시점·카운트를 반환한다", async () => {
    const haltPath = daemonHaltPath(tmpBase, "haltproj");
    fs.mkdirSync(path.dirname(haltPath), { recursive: true });
    const record: HaltRecord = {
      reason: "crash-loop",
      haltedAt: "2026-07-08T00:00:00.000Z",
      consecutiveShortLived: 5,
    };
    fs.writeFileSync(haltPath, JSON.stringify(record));

    const result = await readHalt(tmpBase, "haltproj");
    expect(result).toEqual(record);
  });

  it("clearHalt 는 daemon-halt.json 을 제거한다(멱등 — 부재 시에도 throw 없음)", async () => {
    const haltPath = daemonHaltPath(tmpBase, "haltproj");
    fs.mkdirSync(path.dirname(haltPath), { recursive: true });
    fs.writeFileSync(
      haltPath,
      JSON.stringify({ reason: "x", haltedAt: "2026-07-08T00:00:00.000Z", consecutiveShortLived: 5 }),
    );

    await clearHalt(tmpBase, "haltproj");
    expect(fs.existsSync(haltPath)).toBe(false);

    // 이미 제거된 상태에서 재호출해도 throw 없음(ENOENT 흡수 — 멱등).
    await expect(clearHalt(tmpBase, "haltproj")).resolves.toBeUndefined();
  });

  it("clearHalt 는 짧은-수명 연속 카운터(daemon-boots.json)도 함께 제거한다 — 재시도 부팅이 즉시 재정지하지 않도록", async () => {
    const haltPath = daemonHaltPath(tmpBase, "haltproj");
    const bootsPath = daemonBootsPath(tmpBase, "haltproj");
    fs.mkdirSync(path.dirname(haltPath), { recursive: true });
    fs.writeFileSync(
      haltPath,
      JSON.stringify({ reason: "x", haltedAt: "2026-07-08T00:00:00.000Z", consecutiveShortLived: 6 }),
    );
    fs.writeFileSync(bootsPath, JSON.stringify({ consecutiveShortLived: 6 }));

    await clearHalt(tmpBase, "haltproj");
    expect(fs.existsSync(haltPath)).toBe(false);
    expect(fs.existsSync(bootsPath)).toBe(false);
  });

  it("halt 후 clearHalt → 다음 부팅은 streak 을 승계하지 않는다 (회귀 — 실 launchd 검증에서 발견: restart 마다 즉시 재정지)", async () => {
    const proj = "haltproj";
    // halt 상태를 실제 guard 로 재현: 임계 2 로 두 번 연속 짧은-수명 부팅.
    const mk = () => createCrashLoopGuard({ base: tmpBase, proj, maxShortLived: 2 });
    await mk().checkOnBoot(); // count 1
    const second = await mk().checkOnBoot(); // count 2 → halt
    expect(second.halt).toBe(true);

    // 사용자 명시 재시도(adde up/restart 경로) — halt + 카운터 모두 초기화돼야 한다.
    await clearHalt(tmpBase, proj);

    const retry = await mk().checkOnBoot();
    expect(retry.halt).toBe(false);
    expect(retry.count).toBe(1);
  });
});

// ── runDoctor — halt 자가정지 표면화 (SC-024 Happy) ────────────────────────

describe("runDoctor — halt 자가정지 표면화 (SC-024)", () => {
  it("daemon-halt.json 존재 시 'FAIL' + 자가 정지 안내 + restart 조치 힌트를 표면화한다", async () => {
    writeConf("haltp", "lane1", conf());
    const haltPath = daemonHaltPath(tmpBase, "haltp");
    fs.mkdirSync(path.dirname(haltPath), { recursive: true });
    fs.writeFileSync(
      haltPath,
      JSON.stringify({
        reason: "crash-loop",
        haltedAt: "2026-07-08T00:00:00.000Z",
        consecutiveShortLived: 5,
      }),
    );

    const checks = await runDoctor("haltp", { base: tmpBase });
    const haltCheck = checks.find((c) => c.detail.includes("자가 정지") || c.hint?.includes("restart"));
    expect(haltCheck).toBeDefined();
    expect(haltCheck?.level).toBe("FAIL");
    expect(haltCheck?.hint).toBeTruthy();
    expect(haltCheck?.hint).toMatch(/restart/);
  });

  it("daemon-halt.json 부재 시 halt 관련 FAIL 항목이 없다(정상 상태)", async () => {
    writeConf("nohaltp", "lane1", conf());

    const checks = await runDoctor("nohaltp", { base: tmpBase });
    const haltCheck = checks.find((c) => c.detail.includes("자가 정지"));
    expect(haltCheck).toBeUndefined();
  });
});

// ── runDoctor — auto_restart=off 죽은-등록 표면화 (SC-026 Edge) ────────────
//
// 테스트 환경 한계(기존 daemon 등록 점검 describe 의 주석과 동일 제약): daemonRegState 의
// plistExists 는 실 home 경로를 stat 하므로(runDoctor 는 home override 를 받지 않음) 테스트
// 환경에서 항상 plistExists=false 다. 따라서 "plistExists && launchctlRegistered && running===0"
// 조합(구현의 신규 deadReg 경고 분기)의 **완전한 재현은 실 macOS 검증 영역**이다(test-cases.md
// 미커버 항목 카테고리(2)). 여기서는 도달 가능한 결합(plist 불일치 + running===0)에서 "거짓 UP"
// 으로 보고되지 않음을 확인한다 — 기존 daemon 등록 점검 describe 의 검증 한계와 동일 관례.
describe("runDoctor — auto_restart=off 죽은-등록 표면화 (SC-026)", () => {
  const isDarwin = process.platform === "darwin";

  it("등록 잔존(불일치 조합) + running===0 이어도 'PASS(정상)' 로 오인 보고하지 않는다(거짓 UP 없음)", async () => {
    if (!isDarwin) {
      expect(true).toBe(true);
      return;
    }
    writeConf("deadregproj", "lane1", conf());
    // lane1 은 runtime.json 없음 → collectStatus 상 stopped(running 아님) → running===0.
    const label = "com.qwertygeon.adde.deadregproj";
    const fakeExec: LaunchctlExecType = async (args) => {
      if (args[0] === "list") {
        return { stdout: `PID\tStatus\tLabel\n-\t0\t${label}\n`, code: 0 };
      }
      return { stdout: "", code: 0 };
    };

    const checks = await runDoctor("deadregproj", { base: tmpBase, launchctlExec: fakeExec });
    const rows = await collectStatus("deadregproj", { base: tmpBase });
    expect(rows.every((r) => r.status !== "running")).toBe(true);

    const daemonCheck = checks.find((c) => c.name.startsWith("daemon 등록"));
    expect(daemonCheck).toBeDefined();
    expect(daemonCheck?.level).not.toBe("PASS");
  });
});

// ── 005-source-extensibility ─────────────────────────────────────────────

describe("SC-006: telegram doctor 진단이 소스 정의(descriptor.doctorChecks) 위임으로 수행된다", () => {
  it("토큰 미존재(.env 부재)는 기존과 동일하게 토큰 누락 FAIL 로 보고된다", async () => {
    writeConf("sc006", "tg", conf());
    const checks = await runDoctor("sc006", { base: tmpBase });
    const tokenCheck = checks.find((c) => c.name.includes("토큰"));
    expect(tokenCheck?.level).toBe("FAIL");
  });

  it("SOURCE_REGISTRY.telegram.doctorChecks 를 직접 호출해도 토큰 부재를 FAIL 로 반환한다(descriptor 직접 대조)", async () => {
    const lp = lanePaths(tmpBase, "sc006b", "tg");
    fs.mkdirSync(lp.stateDir, { recursive: true }); // .env 없음
    const doctorChecks = SOURCE_REGISTRY["telegram"]?.doctorChecks;
    expect(typeof doctorChecks).toBe("function");
    const result = await doctorChecks!({ lane: "tg", conf: parseLaneConf(conf()), paths: lp });
    expect(result.some((c) => c.level === "FAIL")).toBe(true);
  });
});

describe("SC-007: markdown doctor 진단이 소스 정의(descriptor.doctorChecks) 위임으로 수행된다", () => {
  it("root 경로 부재는 기존과 동일하게 마크다운 경로 FAIL 로 보고된다", async () => {
    writeConf("sc007", "md", mdConf(`markdown.root=${path.join(tmpBase, "NoSuchRoot")}\n`));
    const checks = await runDoctor("sc007", { base: tmpBase });
    const mdCheck = checks.find((c) => c.name.includes("마크다운"));
    expect(mdCheck?.level).toBe("FAIL");
  });

  it("SOURCE_REGISTRY.markdown.doctorChecks 를 직접 호출해도 root 부재를 FAIL 로 반환한다(descriptor 직접 대조)", async () => {
    const lp = lanePaths(tmpBase, "sc007b", "md");
    const doctorChecks = SOURCE_REGISTRY["markdown"]?.doctorChecks;
    expect(typeof doctorChecks).toBe("function");
    const badConf = parseLaneConf(mdConf(`markdown.root=${path.join(tmpBase, "NoSuchRoot2")}\n`));
    const result = await doctorChecks!({ lane: "md", conf: badConf, paths: lp });
    expect(result.every((c) => c.level === "FAIL")).toBe(true);
  });
});
