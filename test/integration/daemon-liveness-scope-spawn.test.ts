import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeMinimalProjectConf } from "../helpers/v2-fixtures.js";
import { makeSessionRecordFixture } from "../helpers/session-record-fixture.js";
import { waitFor } from "../helpers/wait.js";

type SpawnedChild = ReturnType<typeof spawn>;

// PROC-R18 — SC-018(NFR-002 종료 비지연)·SC-019(NFR-003 상태 비침해)를 dist/cli/adde.js 실
// OS 프로세스 spawn 으로 관통 검증한다. dist 미존재 시 스킵(선례 boot-report-spawn.test.ts).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const distEntry = path.join(repoRoot, "dist", "cli", "adde.js");
const distAvailable = fs.existsSync(distEntry);

if (!distAvailable) {
  process.stderr.write(
    "[daemon-liveness-scope-spawn] dist 미존재 — 실 프로세스 spawn 회귀를 스킵합니다. `pnpm build` 후 재실행하세요.\n",
  );
}

let tmpBase: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-liveness-scope-spawn-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

function runtimeJsonPath(proj: string): string {
  return path.join(tmpBase, "projects", proj, "runtime", "runtime.json");
}

function spawnDaemon(proj: string, extraEnv: Record<string, string> = {}): SpawnedChild {
  return spawn(process.execPath, [distEntry, "__daemon", proj], {
    env: { ...process.env, ADDE_HOME: tmpBase, ...extraEnv },
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

async function raceWithTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`raceWithTimeout: ${timeoutMs}ms 초과`)), timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

describe.skipIf(!distAvailable)(
  "실 프로세스 spawn — SC-018: 종료가 주기 갱신을 지연시키지 않는다",
  () => {
    it("Happy: 기본 주기에서도 종료가 통합 테스트 상한(10초) 내에 완료된다", async () => {
      const proj = "sc018-happy";
      writeMinimalProjectConf(tmpBase, proj, { vault: path.join(tmpBase, `vault-${proj}`) });
      const child = spawnDaemon(proj);
      await waitFor(() => fs.existsSync(runtimeJsonPath(proj)), { timeoutMs: 15_000 });
      const start = Date.now();
      child.kill("SIGTERM");
      const { code } = await raceWithTimeout(waitExit(child), 10_000);
      const elapsed = Date.now() - start;
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(60_000);
    }, 45000);

    it("Edge: 축약 주기(200ms)에서도 동일 상한 내에 exit 0", async () => {
      const proj = "sc018-edge";
      writeMinimalProjectConf(tmpBase, proj, { vault: path.join(tmpBase, `vault-${proj}`) });
      const child = spawnDaemon(proj, { ADDE_HEARTBEAT_INTERVAL_MS: "200" });
      await waitFor(() => fs.existsSync(runtimeJsonPath(proj)), { timeoutMs: 15_000 });
      const start = Date.now();
      child.kill("SIGTERM");
      const { code } = await raceWithTimeout(waitExit(child), 10_000);
      const elapsed = Date.now() - start;
      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(10_000);
    }, 45000);

    it("Error: 타이머가 이벤트 루프를 붙잡지 않는다(판별력 — 60초 미만이며 상한 초과 시 실패)", async () => {
      const proj = "sc018-error";
      writeMinimalProjectConf(tmpBase, proj, { vault: path.join(tmpBase, `vault-${proj}`) });
      const child = spawnDaemon(proj);
      await waitFor(() => fs.existsSync(runtimeJsonPath(proj)), { timeoutMs: 15_000 });
      child.kill("SIGTERM");
      // raceWithTimeout 이 10초 초과 시 throw 하므로, 타이머가 종료를 붙잡는 회귀가 생기면 이
      // 테스트 자체가 실패로 보고된다(waitFor 류가 조용히 통과하지 않는 것과 동형).
      await expect(raceWithTimeout(waitExit(child), 10_000)).resolves.toEqual({
        code: 0,
        signal: null,
      });
    }, 45000);
  },
);

describe.skipIf(!distAvailable)(
  "실 프로세스 spawn — SC-019: 라이브니스만 생성·제거(상태 비침해)",
  () => {
    it("Happy: 기동·정상 종료 후 세션 레코드·대화 노트·다른 프로젝트 상태가 변하지 않는다", async () => {
      const proj = "sc019-happy";
      const otherProj = "sc019-other";
      const vaultRoot = path.join(tmpBase, `vault-${proj}`);
      writeMinimalProjectConf(tmpBase, proj, { vault: vaultRoot });
      writeMinimalProjectConf(tmpBase, otherProj, {
        vault: path.join(tmpBase, `vault-${otherProj}`),
      });

      // 세션은 hibernated 1건만(자동 재개가 레코드를 쓰지 않도록 — GAP-003 픽스처 제약).
      const { saveSession, newSid } = await import("../../src/core/session-store.js");
      const sid = newSid();
      const record = makeSessionRecordFixture(sid, { status: "hibernated" });
      await saveSession(tmpBase, proj, record);
      const recordPath = path.join(tmpBase, "projects", proj, "sessions.d", `${sid}.json`);
      const recordBefore = fs.readFileSync(recordPath, "utf8");

      // 사전 시드한 대화 노트 1파일(turns — 부팅 시 surface 가 자동 생성하는 project/inbox 노트는
      // 비교 대상에서 제외한다, GAP-003).
      const { vaultPaths } = await import("../../src/shared/paths.js");
      const vp = vaultPaths(vaultRoot, proj, sid);
      fs.mkdirSync(vp.turnsDir, { recursive: true });
      const seedNotePath = path.join(vp.turnsDir, "0001-seed.md");
      fs.writeFileSync(seedNotePath, "seed content — 무변경 기대\n");
      const seedNoteBefore = fs.readFileSync(seedNotePath, "utf8");

      // 다른 프로젝트의 사전 기록.
      const otherRtPath = runtimeJsonPath(otherProj);
      fs.mkdirSync(path.dirname(otherRtPath), { recursive: true });
      fs.writeFileSync(
        otherRtPath,
        JSON.stringify({ v: 1, pid: 424242, startedAt: new Date(0).toISOString() }),
      );
      const otherRtBefore = fs.readFileSync(otherRtPath, "utf8");
      const otherRtMtimeBefore = fs.statSync(otherRtPath).mtimeMs;

      const child = spawnDaemon(proj);
      await waitFor(() => fs.existsSync(runtimeJsonPath(proj)), { timeoutMs: 15_000 });
      child.kill("SIGTERM");
      await waitExit(child);

      expect(fs.readFileSync(recordPath, "utf8")).toBe(recordBefore);
      expect(fs.readFileSync(seedNotePath, "utf8")).toBe(seedNoteBefore);
      expect(fs.readFileSync(otherRtPath, "utf8")).toBe(otherRtBefore);
      expect(fs.statSync(otherRtPath).mtimeMs).toBe(otherRtMtimeBefore);
    }, 45000);

    it("Edge: 다른 프로젝트 상태 무접촉(내용·mtime 모두 불변)", async () => {
      const proj = "sc019-edge";
      const otherProj = "sc019-edge-other";
      writeMinimalProjectConf(tmpBase, proj, { vault: path.join(tmpBase, `vault-${proj}`) });
      writeMinimalProjectConf(tmpBase, otherProj, {
        vault: path.join(tmpBase, `vault-${otherProj}`),
      });

      const otherRtPath = runtimeJsonPath(otherProj);
      fs.mkdirSync(path.dirname(otherRtPath), { recursive: true });
      fs.writeFileSync(
        otherRtPath,
        JSON.stringify({ v: 1, pid: 424243, startedAt: new Date(0).toISOString() }),
      );
      const before = fs.readFileSync(otherRtPath, "utf8");
      const mtimeBefore = fs.statSync(otherRtPath).mtimeMs;

      const child = spawnDaemon(proj);
      await waitFor(() => fs.existsSync(runtimeJsonPath(proj)), { timeoutMs: 15_000 });
      child.kill("SIGTERM");
      await waitExit(child);

      expect(fs.readFileSync(otherRtPath, "utf8")).toBe(before);
      expect(fs.statSync(otherRtPath).mtimeMs).toBe(mtimeBefore);
    }, 45000);

    it("Error: 제거가 대상 프로젝트 기록에만 한정된다", async () => {
      const proj = "sc019-error";
      const otherProj = "sc019-error-other";
      writeMinimalProjectConf(tmpBase, proj, { vault: path.join(tmpBase, `vault-${proj}`) });
      writeMinimalProjectConf(tmpBase, otherProj, {
        vault: path.join(tmpBase, `vault-${otherProj}`),
      });

      const otherRtPath = runtimeJsonPath(otherProj);
      fs.mkdirSync(path.dirname(otherRtPath), { recursive: true });
      fs.writeFileSync(
        otherRtPath,
        JSON.stringify({ v: 1, pid: 424244, startedAt: new Date(0).toISOString() }),
      );

      const child = spawnDaemon(proj);
      await waitFor(() => fs.existsSync(runtimeJsonPath(proj)), { timeoutMs: 15_000 });
      child.kill("SIGTERM");
      await waitExit(child);

      expect(fs.existsSync(runtimeJsonPath(proj))).toBe(false); // 대상 프로젝트만 제거
      expect(fs.existsSync(otherRtPath)).toBe(true); // 다른 프로젝트 기록 잔존
    }, 45000);
  },
);
