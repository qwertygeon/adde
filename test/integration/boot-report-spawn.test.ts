import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { daemonBootReportPath, daemonBootsPath } from "../../src/shared/paths.js";
import { CRASH_LOOP_MAX_SHORT_LIVED } from "../../src/core/crash-loop.js";
import { writeMinimalProjectConf } from "../helpers/v2-fixtures.js";
import { newSid, saveSession } from "../../src/core/session-store.js";
import { waitFor } from "../helpers/wait.js";
import { makeSessionRecordFixture } from "../helpers/session-record-fixture.js";

// 대기 상한 note: 본 파일은 실 node 프로세스를 spawn 해 dist 산출물을 적재하므로, 병렬 스위트의
// CPU·디스크 경합에서 기동이 수 초 이상 밀린다. 상한이 촘촘하면 계약 위반이 아닌 경합으로 실패한다
// (전체 스위트 반복 실행에서 간헐 실패 실측) → spawn 대기·테스트 상한을 넉넉하게 둔다.

// PROC-R18: 포그라운드 상주 데몬 워커(runDaemonForeground)의 부팅 리포트 기록/미기록을 vitest
// 워커 내 함수 직접 호출이 아니라 빌드 산출물(dist)의 실 OS 프로세스로 spawn 해 관통 검증한다
// (process-liveness·기록 시점 결함은 in-worker 호출로 재현 불가). 선행 `pnpm build` 필요 — dist
// 미존재 시(개발 중 미빌드) 전체 스킵(5b EXECUTION 이 빌드 후 재실행 확정, PROC-R15). 격리 tmp
// ADDE_HOME 사용 — 실 launchd·실 엔진 미접촉.
//
// 실측(v2): supervisorUp() 은 project.conf(v0.2.x lanes.d 아님)를 읽고 SessionManager.load() +
// resumeAllOnBoot() 를 구동한다. "미등록 엔진" 세션을 boot report 에서 error 로 관측하려면
// sessions.d 에 미등록 엔진 id 를 가진 status:"active" 레코드를 사전 기록해야 한다(admit() 이
// driverFor() 에서 미등록 엔진 id 로 즉시 throw → resumeAllOnBoot() 가 detached 로 표시).

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
    it("부팅 트리거 무관(CLI 개입 없는 직접 spawn)하게 supervisorUp 완료 시 리포트를 기록한다", async () => {
      const proj = "spawnproj1";
      const vaultDir = path.join(tmpBase, "vault-spawnproj1");
      writeMinimalProjectConf(tmpBase, proj, { vault: vaultDir });
      const badSid = newSid();
      // 미등록 엔진 id — admit() 의 driverFor() 가 즉시 throw 해 resumeAllOnBoot() 가 이 세션을
      // detached 로 표시한다(재개 실패는 새 세션 폴백 없이 detached 확정, ADR-009).
      await saveSession(
        tmpBase,
        proj,
        makeSessionRecordFixture(badSid, { engine: "doesnotexist" }),
      );

      // GAP-034 — 데몬은 세션 활성 여부와 무관하게 상주한다(core/daemon.ts runDaemonForeground,
      // v1 의 "레인 0개면 즉시 종료" 정책 폐기 — design.md §528 "포그라운드 상주·시그널 종료" 계약).
      // supervisorUp() 완료·리포트 기록은 SIGTERM/SIGINT 없이 자연 종료되지 않으므로, 리포트가
      // 쓰였는지를 폴링으로 먼저 확인한 뒤 명시적으로 종료 신호를 보내고 graceful shutdown(exit 0)을
      // 확인한다(GAP-030 수정 이전에는 driverFor() 미보호 크래시로 인한 우발적 조기 종료가 이
      // 폴링·신호 단계 없이도 우연히 테스트를 통과/실패시켰을 뿐 — 상주 계약과 무관한 착시였다).
      const child = spawnDaemon(proj);
      const reportPath = daemonBootReportPath(tmpBase, proj);
      try {
        await waitFor(() => fs.existsSync(reportPath), { timeoutMs: 30_000 });
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
          bootId: number;
          sessions: { sid: string; status: string; error?: string }[];
        };
        expect(report.bootId).toBeGreaterThanOrEqual(1);
        const badSession = report.sessions.find((s) => s.sid === badSid);
        expect(badSession?.status).toBe("detached");
      } finally {
        child.kill("SIGTERM");
      }
      const exitCode = await waitExit(child);
      expect(exitCode).toBe(0); // graceful shutdown(SIGTERM 수신 → supervisorDown → exit 0)
    }, 45000);

    it("halt 마커 사전 기록(크래시루프 임계 도달) 후 spawn 하면 supervisorUp 전에 종료되어 리포트가 기록되지 않는다 (SC-004 데몬측 Error)", async () => {
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
    }, 45000);
  },
);
