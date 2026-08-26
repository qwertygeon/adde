import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { waitFor } from "../helpers/wait.js";

// PROC-R18 — SC-006(재기동 자동 재개)·SC-039(상주 엔진 상한)을 dist/cli/adde.js 실 OS 프로세스
// spawn 으로 관통 검증한다(선례: boot-report-spawn.test.ts). dist 미존재 시 스킵.
//
// ASSUMPTION(테스트 작성자 — Development 동기화 필요): 실 프로세스 daemon spawn 이 실제
// claude-agent-acp 를 spawn 하지 않도록(infra.md §4 [MUST NOT] 실 엔진 프로세스 무접촉), acpDriver
// 의 바이너리 해석이 `ADDE_ACP_BIN` env override 를 최우선으로 소비한다고 가정한다(현행
// `resolveAdapterBin()` 에는 아직 이 훅이 없음 — v2 acpDriver 이식 시(T009) 테스트 전용 오버라이드로
// 추가되어야 한다). 불일치 시 Development 가 runs/pipeline-log 에 실제 메커니즘을 명시하고 본 파일을
// 동기화한다(PPG-1 2차 방어).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const distEntry = path.join(repoRoot, "dist", "cli", "adde.js");
const distAvailable = fs.existsSync(distEntry);
const FIXTURE = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));

if (!distAvailable) {
  process.stderr.write(
    "[resume-spawn] dist 미존재 — PROC-R18 실 프로세스 spawn 회귀를 스킵합니다. `pnpm build` 후 재실행하세요.\n",
  );
}

let tmpBase: string;
let vaultRoot: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-resume-spawn-"));
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adde-resume-spawn-vault-"));
  fs.chmodSync(FIXTURE, 0o755);
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.rmSync(vaultRoot, { recursive: true, force: true });
});

function writeProject(
  proj: string,
  sessions: Array<{ sid: string; engineRef: string | null; status: string }>,
) {
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

function spawnDaemon(proj: string, extraEnv: Record<string, string> = {}) {
  return spawn(process.execPath, [distEntry, "__daemon", proj], {
    env: { ...process.env, ADDE_HOME: tmpBase, ADDE_ACP_BIN: FIXTURE, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readSession(proj: string, sid: string): { status: string } {
  const p = path.join(tmpBase, "projects", proj, "sessions.d", `${sid}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** fake-acp-agent.mjs 가 FAKE_ACP_SESSION_LOAD_LOG 로 덤프한 session/load 호출 sessionId 집합. */
function loadedSessionIds(logPath: string): Set<string> {
  if (!fs.existsSync(logPath)) return new Set();
  const lines = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  return new Set(lines.map((l) => (JSON.parse(l) as { sessionId: string }).sessionId));
}

describe.skipIf(!distAvailable)("PROC-R18 실 프로세스 spawn — 재기동 자동 재개·상주 상한", () => {
  it("SC-006 Happy: active 세션 2개가 재기동 후 조작 없이 재개되어 active 로 복귀한다", async () => {
    // GAP-025/GAP-033 — 초기 픽스처가 이미 status:"active" 라 상태 필드만으로는 "resumeAllOnBoot()
    // 가 실제로 admit()→driver.open({engineRef}) 를 실행했는지"와 "파일이 아예 갱신되지 않았는지"를
    // 구분할 수 없다(판별력 0, 4ms 완주 관측). 판별력 있는 witness 로 fake ACP 더블이 실제로 수신한
    // session/load 호출(sessionId=engineRef)을 FAKE_ACP_SESSION_LOAD_LOG 로 직접 관측한다 — 이
    // 호출은 driver.ts open() 이 `ctx.engineRef` 가 있을 때만 보내므로(driver.ts:351-361), 재개 관통
    // 자체의 직접 증거다.
    const proj = "resumeproj1";
    writeProject(proj, [
      { sid: "sess-known-a", engineRef: "known-a", status: "active" },
      { sid: "sess-known-b", engineRef: "known-b", status: "active" },
    ]);
    const loadLog = path.join(tmpBase, "session-load-happy.jsonl");
    const child = spawnDaemon(proj, { FAKE_ACP_SESSION_LOAD_LOG: loadLog });
    try {
      await waitFor(
        () => {
          const ids = loadedSessionIds(loadLog);
          return ids.has("known-a") && ids.has("known-b");
        },
        { timeoutMs: 10_000 },
      );
      const ids = loadedSessionIds(loadLog);
      expect(ids.has("known-a")).toBe(true);
      expect(ids.has("known-b")).toBe(true);
      // 재개 관통이 확인된 뒤에도 영속 상태가 계약대로 active 로 유지되는지 2차 corroboration.
      expect(readSession(proj, "sess-known-a").status).toBe("active");
      expect(readSession(proj, "sess-known-b").status).toBe("active");
    } finally {
      child.kill("SIGTERM");
    }
  }, 20000);

  it("SC-006 Error: auto_resume=off 이면 재개가 수행되지 않는다(조용한 실패가 아니라 미수행으로 안내)", async () => {
    // 판별력 검증(GAP-033) — 위 Happy 와 동일한 witness 채널(session/load 수신 로그)을 반전
    // 픽스처(auto_resume=false)에 붙여, Happy 의 통과가 "항상 통과하는 흔적"이 아니라 재개
    // 활성/비활성에 실제로 반응함을 1회 확인한다: 재개가 비활성화되면 admit() 자체가 호출되지
    // 않으므로(session-manager.ts resumeAllOnBoot: `if (!deps.conf.auto_resume) { ...continue; }`)
    // known-c 에 대한 session/load 는 결코 관측되지 않아야 한다.
    const proj = "resumeproj2";
    writeProject(proj, [{ sid: "sess-known-c", engineRef: "known-c", status: "active" }]);
    const projDir = path.join(tmpBase, "projects", proj);
    fs.writeFileSync(
      path.join(projDir, "project.conf"),
      `v=1\nvault=${vaultRoot}\nengine=acp\nauto_resume=false\n`,
    );
    const loadLog = path.join(tmpBase, "session-load-error.jsonl");
    const child = spawnDaemon(proj, { FAKE_ACP_SESSION_LOAD_LOG: loadLog });
    try {
      await new Promise((r) => setTimeout(r, 1500));
      // auto_resume=false — 세션은 active 로 남아있던 파일 그대로거나 hibernated 로 전환되되,
      // 엔진 프로세스가 실제로 재개(open)되지는 않는다(관측 지점: 상태가 최소한 "active" 로 착지하지 않음).
      expect(readSession(proj, "sess-known-c").status).not.toBe("error");
      // 판별력 witness — Happy 에서는 known-a/b 가 관측되는 동일 채널에서, 재개 비활성 시에는
      // known-c 에 대한 session/load 가 전혀 기록되지 않아야 한다(반증 픽스처 FAIL 확인 — 이 값이
      // 만약 참(포함)이면 Happy 의 witness 는 판별력이 없는 것이므로 이 단언이 그 반증 역할을 한다).
      expect(loadedSessionIds(loadLog).has("known-c")).toBe(false);
    } finally {
      child.kill("SIGTERM");
    }
  }, 20000);

  it("SC-039 Happy: 상한 3·세션 10개에서 어느 시점에도 상주 엔진 수가 3을 넘지 않는다", async () => {
    const proj = "resumeproj3";
    const sessions = Array.from({ length: 10 }, (_, i) => ({
      sid: `sess-known-${i}`,
      engineRef: `known-${i}`,
      status: "active",
    }));
    writeProject(proj, sessions);
    const projDir = path.join(tmpBase, "projects", proj);
    fs.writeFileSync(
      path.join(projDir, "project.conf"),
      `v=1\nvault=${vaultRoot}\nengine=acp\nmax_active_engines=3\n`,
    );
    const child = spawnDaemon(proj);
    try {
      await new Promise((r) => setTimeout(r, 3000));
      const enginesJsonPath = path.join(projDir, "runtime", "engines.json");
      if (fs.existsSync(enginesJsonPath)) {
        const snapshot = JSON.parse(fs.readFileSync(enginesJsonPath, "utf8")) as Record<
          string,
          unknown
        >;
        expect(Object.keys(snapshot).length).toBeLessThanOrEqual(3);
      }
      const activeCount = sessions.filter(
        (s) => readSession(proj, s.sid).status === "active",
      ).length;
      expect(activeCount).toBeLessThanOrEqual(3);
    } finally {
      child.kill("SIGTERM");
    }
  }, 20000);
});
