import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { lanePaths } from "../../src/shared/paths.js";
import { waitFor } from "../helpers/wait.js";

// NFR-105 — C-1(즉시 종료)·H-1(회전 경합 크래시)·N-3(abort 후 잔여 tick) 를 vitest 워커 내 함수
// 직접 호출이 아니라, 빌드 산출물(dist)을 실제 별도 OS 프로세스로 spawn 해 생존·스트리밍·시그널
// 종료를 관통하여 방어한다(SC-101·SC-102b·SC-105b·SC-106b·SC-111·SC-116). 선행 `pnpm build` 필요 —
// dist 산출물이 없으면(개발 중 미빌드) 이 파일 전체를 스킵한다(5b EXECUTION 이 빌드 후 재실행 확정,
// PROC-R15). 격리 tmp ADDE_HOME 사용 — 실 launchd·실 봇/엔진 미접촉.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const distEntry = path.join(repoRoot, "dist", "cli", "adde.js");
const distAvailable = fs.existsSync(distEntry);

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-logs-follow-spawn-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

type LogsFollowChild = ChildProcessByStdio<null, Readable, Readable>;

function spawnLogsFollow(proj: string, lane: string): LogsFollowChild {
  return spawn(process.execPath, [distEntry, "logs", proj, lane, "-f"], {
    env: { ...process.env, ADDE_HOME: tmpBase },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** child 의 stdout 누적 버퍼 + exit 여부를 함께 추적하는 헬퍼(생존/종료 판정은 exit 이벤트로). */
function trackChild(child: LogsFollowChild): {
  out: () => string;
  exited: () => boolean;
  exitCode: () => number | null;
} {
  let out = "";
  let exited = false;
  let exitCode: number | null = null;
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString("utf8");
  });
  child.once("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  return { out: () => out, exited: () => exited, exitCode: () => exitCode };
}

describe.skipIf(!distAvailable)(
  "실 프로세스 spawn — logs -f 생존·스트리밍·SIGINT 종료 (NFR-105)",
  () => {
    it(
      "스냅샷 출력 후 프로세스가 종료하지 않고 append 된 신규 라인을 stdout 으로 실시간 방출한다 (SC-101)",
      async () => {
        const proj = "p101";
        const lane = "l101";
        const paths = lanePaths(tmpBase, proj, lane);
        fs.mkdirSync(paths.stateDir, { recursive: true });
        fs.writeFileSync(paths.transcriptLog, "line1\n");

        const child = spawnLogsFollow(proj, lane);
        const t = trackChild(child);

        await waitFor(() => t.out().includes("line1"), { timeoutMs: 5000 });
        // 스냅샷 출력 직후에도 살아있어야 한다(C-1 회귀 방어).
        await new Promise((r) => setTimeout(r, 300));
        expect(t.exited()).toBe(false);

        fs.appendFileSync(paths.transcriptLog, "line2\n");
        await waitFor(() => t.out().includes("line2"), { timeoutMs: 5000 });

        child.kill("SIGINT");
        await waitFor(() => t.exited(), { timeoutMs: 5000 });
        expect(t.out()).toContain("line1");
        expect(t.out()).toContain("line2");
      },
      15000,
    );

    it(
      "파일 삭제 후 재생성(회전) read 경합에도 생존하며 신 활성 파일 라인을 방출한다 (SC-102b)",
      async () => {
        const proj = "p102b";
        const lane = "l102b";
        const paths = lanePaths(tmpBase, proj, lane);
        fs.mkdirSync(paths.stateDir, { recursive: true });
        fs.writeFileSync(paths.transcriptLog, "line1\n");

        const child = spawnLogsFollow(proj, lane);
        const t = trackChild(child);

        await waitFor(() => t.out().includes("line1"), { timeoutMs: 5000 });

        // 회전 경합 모사 — rename(원본→.1) 후 신 파일 생성(신규 inode).
        fs.renameSync(paths.transcriptLog, `${paths.transcriptLog}.1`);
        fs.writeFileSync(paths.transcriptLog, "gen2\n");

        await waitFor(() => t.out().includes("gen2"), { timeoutMs: 5000 });
        expect(t.exited()).toBe(false); // 회전 경합 중 크래시 없음(H-1)

        child.kill("SIGINT");
        await waitFor(() => t.exited(), { timeoutMs: 5000 });
      },
      15000,
    );

    it(
      "SIGINT 수신 시 hang·좀비 없이 정상 종료한다 (SC-105b)",
      async () => {
        const proj = "p105b";
        const lane = "l105b";
        const paths = lanePaths(tmpBase, proj, lane);
        fs.mkdirSync(paths.stateDir, { recursive: true });
        fs.writeFileSync(paths.transcriptLog, "line1\n");

        const child = spawnLogsFollow(proj, lane);
        const t = trackChild(child);

        await waitFor(() => t.out().includes("line1"), { timeoutMs: 5000 });
        child.kill("SIGINT");

        await Promise.race([
          waitFor(() => t.exited(), { timeoutMs: 5000 }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("SIGINT 후 5s 내 종료하지 않음(hang)")), 5000),
          ),
        ]);
        expect(t.exitCode()).toBe(0); // graceful exit(내부 abort→followFile resolve→return 0)
      },
      15000,
    );

    it(
      "copytruncate(동일 inode truncate→재성장) 모사에도 유실·중복 없이 추적한다 (SC-106b)",
      async () => {
        const proj = "p106b";
        const lane = "l106b";
        const paths = lanePaths(tmpBase, proj, lane);
        fs.mkdirSync(paths.stateDir, { recursive: true });
        fs.writeFileSync(paths.transcriptLog, "line1\n");

        const child = spawnLogsFollow(proj, lane);
        const t = trackChild(child);

        await waitFor(() => t.out().includes("line1"), { timeoutMs: 5000 });

        // 실 copytruncate 는 truncate·재기록이 별개 syscall 로 시간차를 두고 일어난다(research.md
        // 실측 — 120ms 분리 시 별도 이벤트로 관측됨). truncate·regrow 가 단일 코얼레싱 윈도우(sub-ms)에
        // 몰리면 중간 상태(size<offset)를 못 보는 잔여 창은 008 GAP-002 승계로 인정된 한계이지 본
        // SC 의 보장 대상이 아니므로, 실제 timing 을 반영해 둘 사이 간격을 둔다.
        fs.truncateSync(paths.transcriptLog, 0);
        await new Promise((r) => setTimeout(r, 150));
        fs.appendFileSync(paths.transcriptLog, "after-trunc\n");

        await waitFor(() => t.out().includes("after-trunc"), { timeoutMs: 5000 });
        expect(t.exited()).toBe(false);
        const occurrences = t.out().split("after-trunc").length - 1;
        expect(occurrences).toBe(1); // 중복 없음

        child.kill("SIGINT");
        await waitFor(() => t.exited(), { timeoutMs: 5000 });
      },
      15000,
    );

    it(
      "세대 회전(rename, inode 변경) 후 유실·중복 없이 새 활성 파일 라인을 방출한다 (SC-111, 008 계약 무회귀)",
      async () => {
        const proj = "p111";
        const lane = "l111";
        const paths = lanePaths(tmpBase, proj, lane);
        fs.mkdirSync(paths.stateDir, { recursive: true });
        fs.writeFileSync(paths.transcriptLog, "line1\n");

        const child = spawnLogsFollow(proj, lane);
        const t = trackChild(child);

        await waitFor(() => t.out().includes("line1"), { timeoutMs: 5000 });

        fs.renameSync(paths.transcriptLog, `${paths.transcriptLog}.1`);
        fs.writeFileSync(paths.transcriptLog, "gen2-a\n");
        await waitFor(() => t.out().includes("gen2-a"), { timeoutMs: 5000 });

        fs.appendFileSync(paths.transcriptLog, "gen2-b\n");
        await waitFor(() => t.out().includes("gen2-b"), { timeoutMs: 5000 });

        child.kill("SIGINT");
        await waitFor(() => t.exited(), { timeoutMs: 5000 });

        expect(t.out().split("gen2-a").length - 1).toBe(1);
        expect(t.out().split("gen2-b").length - 1).toBe(1);
      },
      15000,
    );
  },
);
