import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  writeRuntime,
  readRuntime,
  removeRuntime,
  touchRuntime,
  isPidAlive,
  livenessOf,
  HEARTBEAT_STALE_MS,
} from "../../src/core/runtime-state.js";
import type { RuntimeInfo } from "../../src/core/runtime-state.js";
import { lanePaths } from "../../src/shared/paths.js";

// SC1: runtime.json 기록/제거. SC2: pid 생존 기반 running/dead/stopped 판정.

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-rt-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function info(pid: number): RuntimeInfo {
  return {
    v: 1,
    pid,
    lane: "telegram-claude",
    sessionId: "sess-1",
    startedAt: new Date().toISOString(),
    source: "telegram",
    backend: "acp",
    engine: "claude-agent-acp",
  };
}

/** 종료가 보장된 pid 를 얻는다 — 자식을 띄우고 exit 를 기다린 뒤 그 pid 반환. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const pid = child.pid!;
  // exit 리스너를 트리거 이전에 선등록(once 'exit' 누락 방지) — spawn 직후이므로 await.
  await once(child, "exit");
  return pid;
}

describe("runtime-state 입출력 (SC1)", () => {
  it("writeRuntime → readRuntime 라운드트립", async () => {
    const paths = lanePaths(tmpBase, "proj", "telegram-claude");
    await writeRuntime(paths, info(process.pid));
    expect(fs.existsSync(paths.runtimeJson)).toBe(true);
    const back = await readRuntime(paths);
    expect(back?.pid).toBe(process.pid);
    expect(back?.sessionId).toBe("sess-1");
    expect(back?.source).toBe("telegram");
  });

  it("removeRuntime 는 파일을 제거하고 부재 시 멱등", async () => {
    const paths = lanePaths(tmpBase, "proj", "telegram-claude");
    await writeRuntime(paths, info(process.pid));
    await removeRuntime(paths);
    expect(fs.existsSync(paths.runtimeJson)).toBe(false);
    await expect(removeRuntime(paths)).resolves.toBeUndefined();
  });

  it("readRuntime 는 부재·손상 파일에 null 을 반환한다", async () => {
    const paths = lanePaths(tmpBase, "proj", "telegram-claude");
    expect(await readRuntime(paths)).toBeNull();
    fs.mkdirSync(path.dirname(paths.runtimeJson), { recursive: true });
    fs.writeFileSync(paths.runtimeJson, "{ not json");
    expect(await readRuntime(paths)).toBeNull();
  });
});

describe("라이브니스 판정 (SC2)", () => {
  it("isPidAlive 는 자기 프로세스에 true", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("isPidAlive 는 종료된 pid 에 false", async () => {
    expect(isPidAlive(await deadPid())).toBe(false);
  });

  it("livenessOf: 파일 없음=stopped, 생존=running, 종료=dead", async () => {
    expect(livenessOf(null)).toBe("stopped");
    expect(livenessOf(info(process.pid))).toBe("running");
    expect(livenessOf(info(await deadPid()))).toBe("dead");
  });

  // SC-S2: 하트비트(mtime) 신선도 기반 stale 판정.
  it("livenessOf: pid 생존 + mtime 신선=running, 임계 초과=stale", () => {
    const now = 1_000_000_000_000;
    const fresh = now - 1000;
    const old = now - (HEARTBEAT_STALE_MS + 1000);
    expect(livenessOf(info(process.pid), { mtimeMs: fresh, now })).toBe("running");
    expect(livenessOf(info(process.pid), { mtimeMs: old, now })).toBe("stale");
  });

  it("livenessOf: mtime 미주입이면 stale 판정 안 함(pid-only running)", () => {
    expect(livenessOf(info(process.pid), {})).toBe("running");
  });

  it("livenessOf: pid 종료면 mtime 무관하게 dead", async () => {
    const now = 1_000_000_000_000;
    expect(livenessOf(info(await deadPid()), { mtimeMs: now, now })).toBe("dead");
  });
});

describe("touchRuntime 하트비트 (SC-S1)", () => {
  it("runtime.json mtime 을 전진시킨다(내용 불변)", async () => {
    const paths = lanePaths(tmpBase, "proj", "telegram-claude");
    await writeRuntime(paths, info(process.pid));
    const before = fs.statSync(paths.runtimeJson).mtimeMs;
    const contentBefore = fs.readFileSync(paths.runtimeJson, "utf8");
    // mtime 은 과거로 강제(touch 전진 검증 — 실시간 간격 의존 제거).
    const past = new Date(before - 10_000);
    fs.utimesSync(paths.runtimeJson, past, past);
    await touchRuntime(paths);
    const after = fs.statSync(paths.runtimeJson).mtimeMs;
    expect(after).toBeGreaterThan(past.getTime());
    expect(fs.readFileSync(paths.runtimeJson, "utf8")).toBe(contentBefore);
  });

  it("파일 부재 시 멱등(throw 없음)", async () => {
    const paths = lanePaths(tmpBase, "proj", "ghost");
    await expect(touchRuntime(paths)).resolves.toBeUndefined();
  });
});
