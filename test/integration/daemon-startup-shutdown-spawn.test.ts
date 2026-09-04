import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeMinimalProjectConf } from "../helpers/v2-fixtures.js";

type SpawnedChild = ReturnType<typeof spawn>;

// PROC-R18 — SC-013(FR-013 기동 창 종료 요청): 부팅 리포트 기록을 기다리지 않고 spawn 직후
// 종료 시그널을 보내도 정상 종료 경로(exit code 0, signal null)로 처리되어야 한다(§핵심 설계 1
// ①~⑤ — 시그널 핸들러가 조립보다 먼저 설치됨). dist 미존재 시 스킵.
//
// spawn 과 시그널 사이 "0ms" 지연 구성은 판정 대상에서 제외한다 — 프로세스 시작(OS 의 기본
// 시그널 처리 등록)보다 먼저는 어떤 사용자 코드도 실행될 수 없어 이 스택에서 완전 커버가
// 불가능하다(사용자 결정 — scope.md CUT-004, 실측: 신호 +1ms·종료 +2ms로 데몬 코드 진입 이전
// 구간에서 종료). SC-013 은 실측 가능한 지연 구성(50ms)으로 판정한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const distEntry = path.join(repoRoot, "dist", "cli", "adde.js");
const distAvailable = fs.existsSync(distEntry);

if (!distAvailable) {
  process.stderr.write(
    "[daemon-startup-shutdown-spawn] dist 미존재 — 실 프로세스 spawn 회귀를 스킵합니다. `pnpm build` 후 재실행하세요.\n",
  );
}

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-startup-shutdown-spawn-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function runtimeJsonPath(proj: string): string {
  return path.join(tmpBase, "projects", proj, "runtime", "runtime.json");
}

function spawnDaemon(proj: string): SpawnedChild {
  return spawn(process.execPath, [distEntry, "__daemon", proj], {
    env: { ...process.env, ADDE_HOME: tmpBase },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitExit(
  child: SpawnedChild,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const EDGE_RETRY_ATTEMPTS = 3; // liveness.test.ts SC-002 Error(touch 3회) 관행 승계

type ShutdownObservation = {
  code: number | null;
  signal: NodeJS.Signals | null;
  runtimeExists: boolean;
};

// 고정 sleep(50) 한 번으로 신호 발신 시점을 판정하면 부하로 스케줄링이 밀릴 때 데몬의
// 핸들러 설치 진행도가 벌어져 간헐 RED 가 난다(spec.md 배경 절 "8회 중 2회" 계열의 타이밍
// 경합) — 상한 있는 재시도(조건 폴링)로 흡수하고, 상한 소진까지 전부 실패해야만 결함으로
// 판정한다.
async function observeDelayedShutdown(
  projBase: string,
  delayMs: number,
): Promise<ShutdownObservation> {
  let last: ShutdownObservation | undefined;
  for (let attempt = 0; attempt < EDGE_RETRY_ATTEMPTS; attempt += 1) {
    const proj = `${projBase}-${attempt}`;
    writeMinimalProjectConf(tmpBase, proj, { vault: path.join(tmpBase, `vault-${proj}`) });
    const child = spawnDaemon(proj);
    await sleep(delayMs);
    child.kill("SIGTERM");
    const { code, signal } = await waitExit(child);
    last = { code, signal, runtimeExists: fs.existsSync(runtimeJsonPath(proj)) };
    if (last.code === 0 && last.signal === null && !last.runtimeExists) {
      return last;
    }
  }
  return last as ShutdownObservation;
}

function seedStaleRuntimeRecord(proj: string): void {
  const p = runtimeJsonPath(proj);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify({
      v: 1,
      pid: 999_999_999,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    }),
  );
}

// GAP-008 — 이전 부팅의 잔존 라이브니스 기록이 있는 채로 기동 창에서 종료 요청을 받으면, 정리가
// 끝나기 전에 process.exit 로 빠지는 회귀가 있으면 그 잔존 기록을 지우는 분기가 실행되지 않아
// 종료 후에도 기록이 남는다. 기존 케이스는 그 창에서 애초에 기록을 쓰지 않으므로(=매 시도 신규
// 프로젝트) 제거 실행 여부와 무관하게 통과해 판별력이 없었다 — 잔존 기록을 사전 시드해 판별력을
// 확보한다.
async function observeDelayedShutdownWithStaleSeed(
  projBase: string,
  delayMs: number,
): Promise<ShutdownObservation> {
  let last: ShutdownObservation | undefined;
  for (let attempt = 0; attempt < EDGE_RETRY_ATTEMPTS; attempt += 1) {
    const proj = `${projBase}-${attempt}`;
    writeMinimalProjectConf(tmpBase, proj, { vault: path.join(tmpBase, `vault-${proj}`) });
    seedStaleRuntimeRecord(proj);
    const child = spawnDaemon(proj);
    await sleep(delayMs);
    child.kill("SIGTERM");
    const { code, signal } = await waitExit(child);
    last = { code, signal, runtimeExists: fs.existsSync(runtimeJsonPath(proj)) };
    if (last.code === 0 && last.signal === null && !last.runtimeExists) {
      return last;
    }
  }
  return last as ShutdownObservation;
}

describe.skipIf(!distAvailable)("실 프로세스 spawn — SC-013: 기동 창 종료 요청도 정상 종료", () => {
  it("Happy: 부팅 리포트 대기 없이 보낸 종료 시그널도 exit 0 으로 끝난다", async () => {
    // 지연 없는 즉시 kill 은 CUT-004 가 판정 제외한 "0ms" 구성과 동형(실측: 이 스택에서
    // core/daemon.ts 진입·핸들러 설치까지 필요한 시간이 30~50ms대라 그 미만은 결정적으로
    // signal 종료로 관측됨)이므로 실측 가능한 지연(60ms, 상한 3회 재시도)으로 판정한다 —
    // 부팅 리포트가 아직 쓰이기 전이라는 시나리오 취지는 그대로 유지된다.
    const result = await observeDelayedShutdown("sc013-happy", 60);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.runtimeExists).toBe(false);
  }, 45000);

  it("Edge: spawn 과 시그널 사이 지연 50ms 도 정상 종료(exit 0 + 기록 부재, 상한 3회 재시도)", async () => {
    const result = await observeDelayedShutdown("sc013-edge-50", 50);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.runtimeExists).toBe(false);
  }, 45000);

  it("Error: 시그널 종료로 끝나지 않는다 — exit 이벤트의 signal 값이 null(코드 종료)이다", async () => {
    const proj = "sc013-error";
    writeMinimalProjectConf(tmpBase, proj, { vault: path.join(tmpBase, `vault-${proj}`) });
    const child = spawnDaemon(proj);
    await sleep(50);
    child.kill("SIGTERM");
    const { code, signal } = await waitExit(child);
    // 데몬이 SIGTERM 을 자체 처리(graceful shutdown → process.exit(0))하므로 OS 가 프로세스를
    // 강제 종료한 것이 아니다 — signal 이 null 이고 code 가 0 이어야 판별력이 성립한다.
    expect(signal).toBeNull();
    expect(code).toBe(0);
  }, 45000);

  it("GAP-008: 이전 부팅의 잔존 라이브니스 기록이 있어도 기동 창 종료 후 기록이 제거된다", async () => {
    const result = await observeDelayedShutdownWithStaleSeed("sc013-gap008-seed", 60);
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.runtimeExists).toBe(false);
  }, 45000);
});
