import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { collectStatus, runDoctor, readLogs } from "../../src/core/diagnostics.js";
import { writeRuntime } from "../../src/core/runtime-state.js";
import type { RuntimeInfo } from "../../src/core/runtime-state.js";
import { lanePaths } from "../../src/shared/paths.js";

// SC2: status running/dead/stopped 구분. SC3: doctor 점검+힌트. SC4: logs tail.

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-diag-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

const conf = (extra = ""): string =>
  `source=telegram\nbackend=acp\nengine=claude-code-acp\nchannel=telegram\nperm_tier=acp\nacp_version=v1\n${extra}`;

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
    engine: "claude-code-acp",
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

describe("runDoctor (SC3)", () => {
  it("전역 점검: Node 버전은 PASS(테스트 런타임 ≥22)", async () => {
    const checks = await runDoctor(undefined, { base: tmpBase });
    const node = checks.find((c) => c.name === "Node 버전");
    expect(node?.level).toBe("PASS");
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
