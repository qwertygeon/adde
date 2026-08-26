import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { writeMinimalProjectConf } from "../helpers/v2-fixtures.js";
import { waitFor } from "../helpers/wait.js";

// GAP-032 — v0.2.x `test/integration/logs-follow-spawn.test.ts`(실 child_process spawn + SIGINT
// 처리 회귀, backlog C-1·H-1·N-3 방어)가 T-D11(v0.2.x 81건 처분) 당시 v2 로 이관되지 않고 소실됐다.
// v0.2.x 는 `transcript.log` 를 바이트 tail 하고 rename 세대 회전을 추적했지만(core/log-follow.ts),
// v2 `logs <proj> <sid> -f` 는 이벤트 세대 파일(events-NNNN.jsonl)을 매 폴링마다 재렌더-증분 방식으로
// 읽는다(record/render.ts followSessionLog) — 세대 회전은 파일 rename 이 아니라 새 세대 파일 추가로
// 표현되며, 별도 분기 없이 흡수된다(같은 파일 주석 참조). 본 파일은 이 흡수가 실 프로세스 경계
// (dist/cli/adde.js spawn)에서도 깨지지 않는지 관통 검증한다. PROC-R18 계열 — dist 미존재 시 스킵.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const distEntry = path.join(repoRoot, "dist", "cli", "adde.js");
const distAvailable = fs.existsSync(distEntry);

if (!distAvailable) {
  process.stderr.write(
    "[logs-follow-spawn] dist 미존재 — 실 프로세스 spawn 회귀(C-1·H-1·N-3)를 스킵합니다. `pnpm build` 후 재실행하세요.\n",
  );
}

let tmpBase: string;
let vaultRoot: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-logs-follow-spawn-"));
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adde-logs-follow-spawn-vault-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.rmSync(vaultRoot, { recursive: true, force: true });
});

type LogsFollowChild = ChildProcessByStdio<null, Readable, Readable>;

function spawnLogsFollow(proj: string, sid: string): LogsFollowChild {
  return spawn(process.execPath, [distEntry, "logs", proj, sid, "-f"], {
    env: { ...process.env, ADDE_HOME: tmpBase },
    stdio: ["ignore", "pipe", "pipe"],
  }) as LogsFollowChild;
}

/** child 의 stdout 누적 버퍼 + exit 여부·코드·시그널을 함께 추적하는 헬퍼. */
function trackChild(child: LogsFollowChild): {
  out: () => string;
  exited: () => boolean;
  exitCode: () => number | null;
  signalCode: () => NodeJS.Signals | null;
} {
  let out = "";
  let exited = false;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString("utf8");
  });
  child.once("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    signalCode = signal;
  });
  return {
    out: () => out,
    exited: () => exited,
    exitCode: () => exitCode,
    signalCode: () => signalCode,
  };
}

function eventsDirFor(proj: string, sid: string): string {
  return path.join(vaultRoot, "adde", "projects", proj, ".adde", "sessions", sid);
}

/** 최소 유효 이벤트 라인(note 타입) — renderEventLine 이 message 를 그대로 방출한다. */
function noteEvent(sid: string, seq: number, message: string): unknown {
  return {
    v: 1,
    sid,
    turn: 1,
    seq,
    ts: new Date(Date.now() + seq).toISOString(),
    t: "note",
    kind: "info",
    message,
  };
}

/** 세대 파일(events-NNNN.jsonl)에 이벤트를 append(파일 없으면 생성) — v2 세대 회전은 rename 이
 * 아니라 신규 세대 파일 추가로 표현된다(record/events.ts). */
function appendGen(proj: string, sid: string, gen: number, events: unknown[]): void {
  const dir = eventsDirFor(proj, sid);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `events-${String(gen).padStart(4, "0")}.jsonl`);
  const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.appendFileSync(file, content);
}

describe.skipIf(!distAvailable)(
  "실 프로세스 spawn — logs -f 생존·세대 회전·SIGINT 종료 (GAP-032, backlog C-1·H-1·N-3 승계)",
  () => {
    it("스냅샷 출력 후 프로세스가 종료하지 않고 신규 이벤트를 stdout 으로 실시간 방출한다 (C-1)", async () => {
      const proj = "p-c1";
      const sid = "sess-c1";
      writeMinimalProjectConf(tmpBase, proj, { vault: vaultRoot });
      appendGen(proj, sid, 1, [noteEvent(sid, 1, "line1")]);

      const child = spawnLogsFollow(proj, sid);
      const t = trackChild(child);

      await waitFor(() => t.out().includes("line1"), { timeoutMs: 5000 });
      // 스냅샷 출력 직후에도 살아있어야 한다(C-1 회귀 방어 — 즉시 종료 금지).
      await new Promise((r) => setTimeout(r, 300));
      expect(t.exited()).toBe(false);

      appendGen(proj, sid, 1, [noteEvent(sid, 2, "line2")]);
      await waitFor(() => t.out().includes("line2"), { timeoutMs: 5000 });

      child.kill("SIGINT");
      await waitFor(() => t.exited(), { timeoutMs: 5000 });
      expect(t.out()).toContain("line1");
      expect(t.out()).toContain("line2");
    }, 15000);

    it("세대 회전(신규 events-NNNN.jsonl 파일 추가) 경합에도 크래시 없이 신 세대 라인을 방출한다 (H-1)", async () => {
      const proj = "p-h1";
      const sid = "sess-h1";
      writeMinimalProjectConf(tmpBase, proj, { vault: vaultRoot });
      appendGen(proj, sid, 1, [noteEvent(sid, 1, "gen1-line")]);

      const child = spawnLogsFollow(proj, sid);
      const t = trackChild(child);

      await waitFor(() => t.out().includes("gen1-line"), { timeoutMs: 5000 });

      // 세대 회전 모사 — v2 는 rename 이 아니라 새 세대 파일 추가로 표현(EVENTS_GENERATION_MAX_BYTES
      // 초과 시 record/events.ts appendEvent() 가 gen+1 로 전환하는 것과 동형).
      appendGen(proj, sid, 2, [noteEvent(sid, 2, "gen2-line")]);
      await waitFor(() => t.out().includes("gen2-line"), { timeoutMs: 5000 });
      expect(t.exited()).toBe(false); // 회전 경합 중 크래시 없음(H-1)

      // 회전 후 이어서 append 되는 라인도 유실·중복 없이 계속 방출되는지 확인.
      appendGen(proj, sid, 2, [noteEvent(sid, 3, "gen2-line-b")]);
      await waitFor(() => t.out().includes("gen2-line-b"), { timeoutMs: 5000 });

      child.kill("SIGINT");
      await waitFor(() => t.exited(), { timeoutMs: 5000 });

      const joined = t.out();
      expect(joined.split("gen1-line").length - 1).toBe(1); // 중복 emit 없음
      expect(joined.split("gen2-line-b").length - 1).toBe(1);
    }, 15000);

    it("SIGINT 수신 시 hang 없이 유계 시간 내 종료한다 (N-3)", async () => {
      const proj = "p-n3";
      const sid = "sess-n3";
      writeMinimalProjectConf(tmpBase, proj, { vault: vaultRoot });
      appendGen(proj, sid, 1, [noteEvent(sid, 1, "line1")]);

      const child = spawnLogsFollow(proj, sid);
      const t = trackChild(child);

      await waitFor(() => t.out().includes("line1"), { timeoutMs: 5000 });
      child.kill("SIGINT");

      await Promise.race([
        waitFor(() => t.exited(), { timeoutMs: 5000 }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("SIGINT 후 5s 내 종료하지 않음(hang)")), 5000),
        ),
      ]);
      // ops.ts runLogs() 의 --follow 경로는 --engine 경로와 동일하게 SIGINT 핸들러를 별도 등록하지
      // 않고 Node 기본 동작에 위임한다(record/render.ts followSessionLog 주석) — 핸들러 미등록 상태의
      // 기본 SIGINT 는 시그널로 종료되므로 exitCode 는 null, signalCode 는 "SIGINT" 로 관측된다.
      expect(t.exitCode()).toBeNull();
      expect(t.signalCode()).toBe("SIGINT");
    }, 15000);
  },
);
