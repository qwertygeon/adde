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
  isPidAlive,
  livenessOf,
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
    engine: "claude-code-acp",
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
});
