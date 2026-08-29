import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { waitFor } from "../helpers/wait.js";

// PROC-R18 — SC-013(중지 예약의 재기동 승계)를 dist/cli/adde.js 실 OS 프로세스 spawn 으로
// 관통 검증한다(선례: resume-spawn.test.ts). dist 미존재 시 스킵.
//
// ASSUMPTION(테스트 작성자 — Development 동기화 필요, PPG-1 2차 방어): design.md §3 이 서술하는
// "stopPending 승계 → resumeAllOnBoot 는 admit 하지 않고 런너만 arm" 경로는 큐에 남은 봉투를
// 소진(claim→처리)해야 중지가 완결된다. fake-acp-agent.mjs 는 임의 텍스트 프롬프트에 echo 응답한다고
// 가정한다(resume-spawn.test.ts 의 FAKE_ACP_SESSION_LOAD_LOG 선례와 동일 신뢰 수준).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const distEntry = path.join(repoRoot, "dist", "cli", "adde.js");
const distAvailable = fs.existsSync(distEntry);
const FIXTURE = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));

if (!distAvailable) {
  process.stderr.write(
    "[stop-reservation-spawn] dist 미존재 — PROC-R18 실 프로세스 spawn 회귀를 스킵합니다. `pnpm build` 후 재실행하세요.\n",
  );
}

let tmpBase: string;
let vaultRoot: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-stopres-spawn-"));
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adde-stopres-spawn-vault-"));
  fs.chmodSync(FIXTURE, 0o755);
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.rmSync(vaultRoot, { recursive: true, force: true });
});

function writeProject(
  proj: string,
  sessions: Array<{
    sid: string;
    engineRef: string | null;
    status: string;
    stopPending?: Record<string, unknown> | null;
    corrupt?: boolean;
  }>,
) {
  const projDir = path.join(tmpBase, "projects", proj);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "project.conf"), `v=1\nvault=${vaultRoot}\nengine=acp\n`);
  const sessionsDir = path.join(projDir, "sessions.d");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const now = new Date().toISOString();
  for (const s of sessions) {
    const filePath = path.join(sessionsDir, `${s.sid}.json`);
    if (s.corrupt) {
      fs.writeFileSync(filePath, "{not valid json");
      continue;
    }
    fs.writeFileSync(
      filePath,
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
        rev: 0,
        stopReason: null,
        stoppedAt: null,
        stopPending: s.stopPending ?? null,
        stopNotePending: false,
        notices: [],
      }),
    );
  }
}

function spawnDaemon(proj: string, extraEnv: Record<string, string> = {}) {
  return spawn(process.execPath, [distEntry, "__daemon", proj], {
    env: { ...process.env, ADDE_HOME: tmpBase, ADDE_ACP_BIN: FIXTURE, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readSession(proj: string, sid: string): { status: string; notices?: unknown[] } {
  const p = path.join(tmpBase, "projects", proj, "sessions.d", `${sid}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

describe.skipIf(!distAvailable)(
  "PROC-R18 실 프로세스 spawn — 중지 예약의 재기동 승계(SC-013)",
  () => {
    it("Happy: 잔여 큐가 없는 예약 세션은 재기동 직후 곧바로 중지된다", async () => {
      const proj = "stopresproj1";
      writeProject(proj, [
        {
          sid: "sess-pending-a",
          engineRef: "known-a",
          status: "active",
          stopPending: { requestedAt: new Date().toISOString(), reason: "user", source: "cli" },
        },
      ]);
      const child = spawnDaemon(proj);
      try {
        await waitFor(() => readSession(proj, "sess-pending-a").status === "stopped", {
          timeoutMs: 10_000,
        });
        expect(readSession(proj, "sess-pending-a").status).toBe("stopped");
      } finally {
        child.kill("SIGTERM");
      }
    }, 20000);

    it("Edge: 잔여 큐가 있는 예약 세션은 소진 후 중지된다(재기동 시 admit 없이 arm)", async () => {
      const proj = "stopresproj2";
      writeProject(proj, [
        {
          sid: "sess-pending-b",
          engineRef: "known-b",
          status: "active",
          stopPending: { requestedAt: new Date().toISOString(), reason: "user", source: "cli" },
        },
      ]);
      const queueDir = path.join(
        tmpBase,
        "projects",
        proj,
        "runtime",
        "sessions",
        "sess-pending-b",
        "queue",
      );
      fs.mkdirSync(queueDir, { recursive: true });
      fs.writeFileSync(
        path.join(queueDir, `${Date.now()}-env-carried.msg`),
        JSON.stringify({
          v: 1,
          id: "env-carried",
          lane: "sess-pending-b",
          source: "markdown",
          backend: "acp",
          engine: "acp",
          project: proj,
          ts: new Date().toISOString(),
          text: "잔여 지시",
        }),
      );
      const child = spawnDaemon(proj);
      try {
        await waitFor(() => readSession(proj, "sess-pending-b").status === "stopped", {
          timeoutMs: 15_000,
        });
        expect(readSession(proj, "sess-pending-b").status).toBe("stopped");
      } finally {
        child.kill("SIGTERM");
      }
    }, 25000);

    it("Error: 레코드 파싱 실패로 예약이 소실돼도 데몬은 살아남고 다른 세션은 정상 처리된다", async () => {
      const proj = "stopresproj3";
      writeProject(proj, [
        { sid: "sess-corrupt", engineRef: null, status: "active", corrupt: true },
        { sid: "sess-normal", engineRef: "known-normal", status: "active" },
      ]);
      const loadLog = path.join(tmpBase, "session-load-error-stopres.jsonl");
      const child = spawnDaemon(proj, { FAKE_ACP_SESSION_LOAD_LOG: loadLog });
      try {
        await new Promise((r) => setTimeout(r, 2000));
        // 손상 레코드는 격리(A-P002 비침해) — 파일 자체가 계속 파싱 불가 상태로 남아도 데몬은
        // 살아있고 정상 세션은 영향받지 않는다(무표시 활성 잔존 금지는 정상 레코드 소유 세션 한정).
        expect(() => readSession(proj, "sess-corrupt")).toThrow();
        expect(readSession(proj, "sess-normal").status).not.toBe("error");
      } finally {
        child.kill("SIGTERM");
      }
    }, 20000);

    // "stop-reservation-lost" 안내(design.md §3 — "레코드 파싱 실패로 예약이 소실된 경우에만
    // stop-reservation-lost 안내를 남긴다")는 코드 검토 결과 **관측 불가능**으로 판정해 미검증으로
    // 명시한다(PPG-1 재정합 요청 3 대응). 근거: validateSessionRecord(src/core/session-store.ts)
    // 는 stopPending 이 object 가 아니면 예외 없이 조용히 null 로 대체한다 — "말짱한 레코드에
    // stopPending 이 원래 없음" 과 "말짱하지 않은 stopPending 이 소실됨" 이 로드 후 완전히 동일한
    // 상태(stopPending:null)로 수렴해 사후에 구분할 근거가 남지 않는다. 레코드 파일 자체가 파싱
    // 불가(JSON 깨짐)한 경우는 위 "Error" 케이스처럼 해당 세션 자체가 격리·소멸돼 그 세션에 안내를
    // 실을 매체(레코드)가 없다. 따라서 이 두 경로 어느 쪽으로도 "안내가 실제로 렌더됐는가" 를
    // 판별력 있게 단언할 수 없다 — src 변경 없이는 해소 불가(coverage-gap.md 카테고리 (2)).
    it.skip("[미검증] Error: stopPending 소실 시 stop-reservation-lost 안내가 남는다 — 관측 불가로 스킵", () => {
      // 의도적 미구현 — 위 주석 참조. 재현 시도 자체가 무의미함을 스킵 사유에 남긴다.
    });
  },
);
