import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { waitFor } from "../helpers/wait.js";

type SpawnedChild = ReturnType<typeof spawn>;

// PROC-R18 — SC-008(FR-008 엔진 상주 표시의 신호화): 데몬 라이브니스가 상주 중일 때만 active
// 세션의 enginePresent 가 true 다(상수가 아니다 — 정상 종료 후 false 로 바뀐다). fake ACP
// (`ADDE_ACP_BIN`)로 실 엔진 프로세스 접촉 없이 resumeAllOnBoot() 가 실제로 active 세션을
// 재개시킨다(선례 resume-spawn.test.ts). dist 미존재 시 스킵.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const distEntry = path.join(repoRoot, "dist", "cli", "adde.js");
const distAvailable = fs.existsSync(distEntry);
const FIXTURE = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));

if (!distAvailable) {
  process.stderr.write(
    "[engine-present-signal-spawn] dist 미존재 — 실 프로세스 spawn 회귀를 스킵합니다. `pnpm build` 후 재실행하세요.\n",
  );
}

let tmpBase: string;
let vaultRoot: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-engine-present-spawn-"));
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adde-engine-present-spawn-vault-"));
  fs.chmodSync(FIXTURE, 0o755);
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.rmSync(vaultRoot, { recursive: true, force: true });
});

function writeProject(
  proj: string,
  sessions: Array<{ sid: string; engineRef: string | null; status: string }>,
): void {
  const projDir = path.join(tmpBase, "projects", proj);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "project.conf"), `v=1\nvault=${vaultRoot}\nengine=acp\n`);
  const sessionsDir = path.join(projDir, "sessions.d");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const now = new Date().toISOString();
  for (const s of sessions) {
    fs.writeFileSync(
      path.join(sessionsDir, `${s.sid}.json`),
      JSON.stringify({
        v: 1,
        sid: s.sid,
        engine: "acp",
        engineRef: s.engineRef,
        status: s.status,
        title: null,
        createdAt: now,
        lastActivityAt: now,
        successorOf: null,
        engineArgs: [],
        warnings: [],
        bindings: [],
      }),
    );
  }
}

function runtimeJsonPath(proj: string): string {
  return path.join(tmpBase, "projects", proj, "runtime", "runtime.json");
}

function spawnDaemon(proj: string, extraEnv: Record<string, string> = {}): SpawnedChild {
  return spawn(process.execPath, [distEntry, "__daemon", proj], {
    env: { ...process.env, ADDE_HOME: tmpBase, ADDE_ACP_BIN: FIXTURE, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

interface StatusJson {
  sessions: Array<{ sid: string; enginePresent: boolean; status: string }>;
}

async function queryStatusJson(proj: string): Promise<StatusJson> {
  const child = spawn(process.execPath, [distEntry, "status", proj, "--json"], {
    env: { ...process.env, ADDE_HOME: tmpBase },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
  await new Promise((resolve) => child.once("exit", resolve));
  return JSON.parse(stdout) as StatusJson;
}

async function waitExit(child: SpawnedChild): Promise<void> {
  await new Promise((resolve) => child.once("exit", resolve));
}

describe.skipIf(!distAvailable)("실 프로세스 spawn — SC-008: 엔진 상주 표시의 신호화", () => {
  it("Happy: 데몬 상주 중 활성 세션의 엔진 상주 표시가 있음(true)이다", async () => {
    const proj = "sc008-happy";
    writeProject(proj, [{ sid: "sess-active", engineRef: "known-active", status: "active" }]);
    const child = spawnDaemon(proj);
    try {
      await waitFor(() => fs.existsSync(runtimeJsonPath(proj)), { timeoutMs: 15_000 });
      await waitFor(
        async () => {
          const status = await queryStatusJson(proj);
          const row = status.sessions.find((s) => s.sid === "sess-active");
          return row?.enginePresent === true;
        },
        { timeoutMs: 15_000 },
      );
      const status = await queryStatusJson(proj);
      const row = status.sessions.find((s) => s.sid === "sess-active");
      expect(row?.enginePresent).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await waitExit(child);
    }
  }, 45000);

  it("Edge: 정상 종료 후 같은 세션의 표시가 없음(false)으로 바뀐다(상수 아님)", async () => {
    const proj = "sc008-edge";
    writeProject(proj, [{ sid: "sess-active", engineRef: "known-active", status: "active" }]);
    const child = spawnDaemon(proj);
    await waitFor(() => fs.existsSync(runtimeJsonPath(proj)), { timeoutMs: 15_000 });
    await waitFor(
      async () => {
        const status = await queryStatusJson(proj);
        return status.sessions.find((s) => s.sid === "sess-active")?.enginePresent === true;
      },
      { timeoutMs: 15_000 },
    );
    child.kill("SIGTERM");
    await waitExit(child);
    const afterStatus = await queryStatusJson(proj);
    const row = afterStatus.sessions.find((s) => s.sid === "sess-active");
    expect(row?.enginePresent).toBe(false);
  }, 45000);

  it("Error: 상주 중이어도 비활성(hibernated) 세션은 없음(false)이다", async () => {
    const proj = "sc008-error";
    writeProject(proj, [
      { sid: "sess-active", engineRef: "known-active", status: "active" },
      { sid: "sess-hibernated", engineRef: "known-hib", status: "hibernated" },
    ]);
    const child = spawnDaemon(proj);
    try {
      await waitFor(() => fs.existsSync(runtimeJsonPath(proj)), { timeoutMs: 15_000 });
      await waitFor(
        async () => {
          const status = await queryStatusJson(proj);
          return status.sessions.find((s) => s.sid === "sess-active")?.enginePresent === true;
        },
        { timeoutMs: 15_000 },
      );
      const status = await queryStatusJson(proj);
      const hib = status.sessions.find((s) => s.sid === "sess-hibernated");
      expect(hib?.enginePresent).toBe(false);
    } finally {
      child.kill("SIGTERM");
      await waitExit(child);
    }
  }, 45000);
});
