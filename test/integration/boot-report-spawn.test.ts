import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { daemonBootReportPath, daemonBootsPath } from "../../src/shared/paths.js";
import { CRASH_LOOP_MAX_SHORT_LIVED } from "../../src/core/crash-loop.js";

// SC-013·SC-004(데몬측) — PROC-R18: 포그라운드 상주 데몬 워커(runDaemonForeground)의 부팅 리포트
// 기록/미기록을 vitest 워커 내 함수 직접 호출이 아니라 빌드 산출물(dist)의 실 OS 프로세스로 spawn 해
// 관통 검증한다(process-liveness·기록 시점 결함은 in-worker 호출로 재현 불가). 선행 `pnpm build` 필요 —
// dist 미존재 시(개발 중 미빌드) 전체 스킵(5b EXECUTION 이 빌드 후 재실행 확정, PROC-R15). 격리 tmp
// ADDE_HOME 사용 — 실 launchd·실 엔진 미접촉(logs-follow-spawn.test.ts 선례 패턴).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const distEntry = path.join(repoRoot, "dist", "cli", "adde.js");
const distAvailable = fs.existsSync(distEntry);

if (!distAvailable) {
  process.stderr.write(
    "[boot-report-spawn] dist 미존재 — 실 프로세스 spawn 회귀 2건을 스킵합니다. `pnpm build` 후 재실행하세요.\n",
  );
}

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-boot-report-spawn-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function spawnDaemon(proj: string): ReturnType<typeof spawn> {
  return spawn(process.execPath, [distEntry, "__daemon", proj], {
    env: { ...process.env, ADDE_HOME: tmpBase },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
}

describe.skipIf(!distAvailable)(
  "실 프로세스 spawn — 데몬 부팅 리포트 기록/미기록 (PROC-R18)",
  () => {
    it(
      "부팅 트리거 무관(CLI 개입 없는 직접 spawn)하게 supervisorUp 완료 시 리포트를 기록한다 (SC-013 Happy)",
      async () => {
        const proj = "spawnproj1";
        // 미지 source — supervisor 가 해당 레인을 조기에 error 로 격리(엔진 backend.launch 미도달,
        // 엔진 미spawn)하고 running=0 이라 결정적 부팅 실패(exit 0) 경로를 탄다. writeBootReport 는
        // 이 조기 return 앞에서 실행되므로 리포트는 트리거와 무관하게 남는다.
        const lanesDir = path.join(tmpBase, proj, "lanes.d");
        fs.mkdirSync(lanesDir, { recursive: true });
        fs.writeFileSync(path.join(lanesDir, "bad.conf"), "source=doesnotexist\n");

        const child = spawnDaemon(proj);
        const exitCode = await waitExit(child);

        expect(exitCode).toBe(0); // running=0(기동된 레인 없음) — 결정적 부팅 실패, 재시도 무익
        const reportPath = daemonBootReportPath(tmpBase, proj);
        expect(fs.existsSync(reportPath)).toBe(true);
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
          bootId: number;
          lanes: { lane: string; status: string; error?: string }[];
        };
        expect(report.bootId).toBeGreaterThanOrEqual(1);
        const badLane = report.lanes.find((l) => l.lane === "bad");
        expect(badLane?.status).toBe("error");
      },
      15000,
    );

    it(
      "halt 마커 사전 기록(크래시루프 임계 도달) 후 spawn 하면 supervisorUp 전에 종료되어 리포트가 기록되지 않는다 (SC-004 데몬측 Error)",
      async () => {
        const proj = "spawnproj2";
        // 직전까지 짧은-수명 연속 사망이 임계-1 회 누적된 상태를 미리 기록 — 이번 부팅의
        // checkOnBoot() 증가분(+1)이 임계(CRASH_LOOP_MAX_SHORT_LIVED)에 도달해 supervisorUp
        // 이전에 halt·확정 종료(exit 0)한다. 레인 conf 는 준비하지 않는다(halt 분기가 supervisorUp
        // 자체를 호출하지 않으므로 무관).
        const bootsPath = daemonBootsPath(tmpBase, proj);
        fs.mkdirSync(path.dirname(bootsPath), { recursive: true });
        fs.writeFileSync(
          bootsPath,
          JSON.stringify({ consecutiveShortLived: CRASH_LOOP_MAX_SHORT_LIVED - 1 }),
        );

        const child = spawnDaemon(proj);
        const exitCode = await waitExit(child);

        expect(exitCode).toBe(0); // halt 확정 종료(크래시루프 자가 정지, 재시도 무익)
        const reportPath = daemonBootReportPath(tmpBase, proj);
        expect(fs.existsSync(reportPath)).toBe(false); // supervisorUp 미도달 — 리포트 기록 없음
      },
      15000,
    );
  },
);
