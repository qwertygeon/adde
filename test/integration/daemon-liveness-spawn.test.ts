import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeMinimalProjectConf } from "../helpers/v2-fixtures.js";
import { waitFor } from "../helpers/wait.js";

type SpawnedChild = ReturnType<typeof spawn>;

// PROC-R18 — SC-001·SC-002(Happy/Edge)·SC-003·SC-004 를 dist/cli/adde.js 실 OS 프로세스 spawn
// 으로 관통 검증한다(함수 직접 호출·타이머 모킹으로 갈음하지 않는다 — NFR-005). SC-002 의 Error
// 시나리오(갱신 실패 반복)는 실 프로세스 관통이 필요 없어 test/core/liveness.test.ts 단위 경로가
// 담당한다(tasks.md T010/T011 분담). dist 미존재 시 스킵(선례 boot-report-spawn.test.ts).
//
// core/liveness.ts·runtime-state.ts 의 판독 계약 변경은 PPG-1 병렬 중 아직 착지 전일 수 있으나,
// 본 파일은 소스 모듈을 직접 import 하지 않고 빌드된 dist 를 자식 프로세스로 관찰하므로 미착지로
// 인한 파일 전체 수집 붕괴가 없다(PROC-R15).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const distEntry = path.join(repoRoot, "dist", "cli", "adde.js");
const distAvailable = fs.existsSync(distEntry);

if (!distAvailable) {
  process.stderr.write(
    "[daemon-liveness-spawn] dist 미존재 — 실 프로세스 spawn 회귀를 스킵합니다. `pnpm build` 후 재실행하세요.\n",
  );
}

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-liveness-spawn-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function runtimeJsonPath(proj: string): string {
  return path.join(tmpBase, "projects", proj, "runtime", "runtime.json");
}

function daemonBootsJsonPath(proj: string): string {
  return path.join(tmpBase, "projects", proj, "daemon-boots.json");
}

function setupProject(proj: string): void {
  const vaultDir = path.join(tmpBase, `vault-${proj}`);
  writeMinimalProjectConf(tmpBase, proj, { vault: vaultDir });
}

function spawnCli(args: string[], extraEnv: Record<string, string> = {}): SpawnedChild {
  return spawn(process.execPath, [distEntry, ...args], {
    env: { ...process.env, ADDE_HOME: tmpBase, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function spawnDaemon(proj: string, extraEnv: Record<string, string> = {}): SpawnedChild {
  return spawnCli(["__daemon", proj], extraEnv);
}

interface Collected {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function waitExitFull(child: SpawnedChild): Promise<Collected> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function runStatusText(proj: string): Promise<Collected> {
  const child = spawnCli(["status", proj]);
  return waitExitFull(child);
}

describe.skipIf(!distAvailable)("실 프로세스 spawn — SC-001: 기동 후 라이브니스 기록", () => {
  it("Happy: 기동 후 라이브니스 기록이 생성되고 pid·기동시각·스키마버전을 담는다", async () => {
    const proj = "sc001-happy";
    setupProject(proj);
    const child = spawnDaemon(proj);
    const rtPath = runtimeJsonPath(proj);
    try {
      await waitFor(() => fs.existsSync(rtPath), { timeoutMs: 15_000 });
      const info = JSON.parse(fs.readFileSync(rtPath, "utf8")) as {
        v: number;
        pid: number;
        startedAt: string;
      };
      expect(info.v).toBe(1);
      expect(info.pid).toBe(child.pid);
      expect(info.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      child.kill("SIGTERM");
      await waitExitFull(child);
    }
  }, 45000);

  it("Edge: 잔존 기록이 있어도 새 기동 pid 로 원자 교체된다", async () => {
    const proj = "sc001-edge";
    setupProject(proj);
    const rtPath = runtimeJsonPath(proj);
    fs.mkdirSync(path.dirname(rtPath), { recursive: true });
    fs.writeFileSync(
      rtPath,
      JSON.stringify({ v: 1, pid: 999999, startedAt: new Date(0).toISOString() }),
    );
    const child = spawnDaemon(proj);
    try {
      await waitFor(
        () => {
          if (!fs.existsSync(rtPath)) return false;
          const info = JSON.parse(fs.readFileSync(rtPath, "utf8")) as { pid: number };
          return info.pid === child.pid;
        },
        { timeoutMs: 15_000 },
      );
      const info = JSON.parse(fs.readFileSync(rtPath, "utf8")) as { pid: number };
      expect(info.pid).not.toBe(999999);
      expect(info.pid).toBe(child.pid);
    } finally {
      child.kill("SIGTERM");
      await waitExitFull(child);
    }
  }, 45000);

  it("Error: 크래시루프 halt 임계 도달 부팅은 기록을 생성하지 않는다", async () => {
    const proj = "sc001-error-halt";
    // CRASH_LOOP_MAX_SHORT_LIVED - 1 을 선기록해 이번 부팅의 checkOnBoot() 증가분(+1)이 임계에
    // 도달, supervisorUp 이전에 halt·확정 종료(exit 0)한다(선례 boot-report-spawn.test.ts).
    const { CRASH_LOOP_MAX_SHORT_LIVED } = await import("../../src/core/crash-loop.js");
    const bootsPath = daemonBootsJsonPath(proj);
    fs.mkdirSync(path.dirname(bootsPath), { recursive: true });
    fs.writeFileSync(
      bootsPath,
      JSON.stringify({ consecutiveShortLived: CRASH_LOOP_MAX_SHORT_LIVED - 1 }),
    );
    const child = spawnDaemon(proj);
    const { code } = await waitExitFull(child);
    expect(code).toBe(0);
    expect(fs.existsSync(runtimeJsonPath(proj))).toBe(false);
  }, 45000);
});

describe.skipIf(!distAvailable)(
  "실 프로세스 spawn — SC-002: 주기 갱신으로 응답 없음 미전이(Happy/Edge)",
  () => {
    it("Happy: 갱신 주기 경과 후 갱신 시각이 전진하고 상주 중이 유지된다", async () => {
      const proj = "sc002-happy";
      setupProject(proj);
      const rtPath = runtimeJsonPath(proj);
      const child = spawnDaemon(proj, { ADDE_HEARTBEAT_INTERVAL_MS: "200" });
      try {
        await waitFor(() => fs.existsSync(rtPath), { timeoutMs: 15_000 });
        const t0 = fs.statSync(rtPath).mtimeMs;
        await waitFor(() => fs.existsSync(rtPath) && fs.statSync(rtPath).mtimeMs > t0, {
          timeoutMs: 10_000,
        });
        const statusResult = await runStatusText(proj);
        expect(statusResult.stdout).toMatch(/상주 중|running/);
      } finally {
        child.kill("SIGTERM");
        await waitExitFull(child);
      }
    }, 45000);

    it("Edge: 갱신 대상 기록이 외부에서 삭제돼도 상주가 중단되지 않는다", async () => {
      const proj = "sc002-edge";
      setupProject(proj);
      const rtPath = runtimeJsonPath(proj);
      const child = spawnDaemon(proj, { ADDE_HEARTBEAT_INTERVAL_MS: "200" });
      try {
        await waitFor(() => fs.existsSync(rtPath), { timeoutMs: 15_000 });
        fs.rmSync(rtPath, { force: true });
        // 주기(200ms) 2회 경과 대기 — 프로세스가 죽지 않았는지만 단언한다(design.md 결정 —
        // ENOENT 는 touchRuntime 이 흡수 대상이라 경고 유무는 판정하지 않는다).
        await new Promise((r) => setTimeout(r, 500));
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill("SIGTERM");
        await waitExitFull(child);
      }
    }, 45000);
  },
);

describe.skipIf(!distAvailable)("실 프로세스 spawn — SC-003: 정상 종료 시 기록 제거", () => {
  it("Happy: SIGTERM 수신 시 exit 0 이고 기록이 제거되며 미기동으로 보고된다", async () => {
    const proj = "sc003-happy";
    setupProject(proj);
    const rtPath = runtimeJsonPath(proj);
    const child = spawnDaemon(proj);
    await waitFor(() => fs.existsSync(rtPath), { timeoutMs: 15_000 });
    child.kill("SIGTERM");
    const { code } = await waitExitFull(child);
    expect(code).toBe(0);
    expect(fs.existsSync(rtPath)).toBe(false);
    const statusResult = await runStatusText(proj);
    expect(statusResult.stdout).toMatch(/미기동|not started/);
  }, 45000);

  it("Edge: SIGINT 도 동일한 정상 종료 경로를 탄다", async () => {
    const proj = "sc003-edge";
    setupProject(proj);
    const rtPath = runtimeJsonPath(proj);
    const child = spawnDaemon(proj);
    await waitFor(() => fs.existsSync(rtPath), { timeoutMs: 15_000 });
    child.kill("SIGINT");
    const { code } = await waitExitFull(child);
    expect(code).toBe(0);
    expect(fs.existsSync(rtPath)).toBe(false);
  }, 45000);

  it("Error: 종료 시그널 2회 연속에도 중복 종결 없이 exit 0 이다", async () => {
    const proj = "sc003-error";
    setupProject(proj);
    const rtPath = runtimeJsonPath(proj);
    const child = spawnDaemon(proj);
    await waitFor(() => fs.existsSync(rtPath), { timeoutMs: 15_000 });
    child.kill("SIGTERM");
    child.kill("SIGTERM");
    const { code, signal } = await waitExitFull(child);
    expect(code).toBe(0);
    expect(signal).toBeNull();
  }, 45000);
});

describe.skipIf(!distAvailable)("실 프로세스 spawn — SC-004: 비정상 사망 후 상태 표면화", () => {
  it("Happy: SIGKILL 후 상태 조회가 비정상 종료를 보고하고 종료코드가 실패다", async () => {
    const proj = "sc004-happy";
    setupProject(proj);
    const rtPath = runtimeJsonPath(proj);
    const child = spawnDaemon(proj);
    await waitFor(() => fs.existsSync(rtPath), { timeoutMs: 15_000 });
    child.kill("SIGKILL");
    await waitExitFull(child);
    expect(fs.existsSync(rtPath)).toBe(true); // 기록 잔존(정상 종료 경로를 타지 않음)
    const statusResult = await runStatusText(proj);
    expect(statusResult.stdout).toMatch(/비정상 종료|terminated abnormally/);
    expect(statusResult.code).toBe(1);
  }, 45000);

  it("Edge: 비정상 종료에는 조치 안내가 동반된다", async () => {
    const proj = "sc004-edge";
    setupProject(proj);
    const rtPath = runtimeJsonPath(proj);
    const child = spawnDaemon(proj);
    await waitFor(() => fs.existsSync(rtPath), { timeoutMs: 15_000 });
    child.kill("SIGKILL");
    await waitExitFull(child);
    const statusResult = await runStatusText(proj);
    expect(statusResult.stderr).toMatch(/adde down/);
    expect(statusResult.stderr).toMatch(/adde up/);
  }, 45000);

  it("Error: 미기동으로 접히지 않는다 — 정상 종료 관측과 표기가 다르다(판별력)", async () => {
    const deadProj = "sc004-error-dead";
    const stoppedProj = "sc004-error-stopped";
    setupProject(deadProj);
    setupProject(stoppedProj);

    const deadChild = spawnDaemon(deadProj);
    await waitFor(() => fs.existsSync(runtimeJsonPath(deadProj)), { timeoutMs: 15_000 });
    deadChild.kill("SIGKILL");
    await waitExitFull(deadChild);

    const stoppedChild = spawnDaemon(stoppedProj);
    await waitFor(() => fs.existsSync(runtimeJsonPath(stoppedProj)), { timeoutMs: 15_000 });
    stoppedChild.kill("SIGTERM");
    await waitExitFull(stoppedChild);

    const deadStatus = await runStatusText(deadProj);
    const stoppedStatus = await runStatusText(stoppedProj);
    expect(deadStatus.stdout).not.toEqual(stoppedStatus.stdout);
    expect(deadStatus.stdout).toMatch(/비정상 종료|terminated abnormally/);
    expect(stoppedStatus.stdout).toMatch(/미기동|not started/);
  }, 45000);
});
