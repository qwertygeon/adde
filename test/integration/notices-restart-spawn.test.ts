import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { waitFor } from "../helpers/wait.js";

// PROC-R18 — SC-037(안내 항목의 재기동 유지)을 dist/cli/adde.js 실 OS 프로세스 spawn 으로
// 관통 검증한다(선례: resume-spawn.test.ts·stop-reservation-spawn.test.ts).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const distEntry = path.join(repoRoot, "dist", "cli", "adde.js");
const distAvailable = fs.existsSync(distEntry);
const FIXTURE = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));

if (!distAvailable) {
  process.stderr.write(
    "[notices-restart-spawn] dist 미존재 — PROC-R18 스킵. `pnpm build` 후 재실행하세요.\n",
  );
}

let tmpBase: string;
let vaultRoot: string;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-notice-spawn-"));
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adde-notice-spawn-vault-"));
  fs.chmodSync(FIXTURE, 0o755);
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  fs.rmSync(vaultRoot, { recursive: true, force: true });
});

function writeProject(
  proj: string,
  sid: string,
  notices: Array<Record<string, unknown>>,
  corruptRecord = false,
) {
  const projDir = path.join(tmpBase, "projects", proj);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "project.conf"), `v=1\nvault=${vaultRoot}\nengine=acp\n`);
  const sessionsDir = path.join(projDir, "sessions.d");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, `${sid}.json`);
  if (corruptRecord) {
    fs.writeFileSync(filePath, "{not valid json");
    return;
  }
  const now = new Date().toISOString();
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      v: 1,
      sid,
      engine: "acp",
      engineRef: null,
      status: "active",
      title: null,
      createdAt: now,
      lastActivityAt: now,
      successorOf: null,
      engineArgs: [],
      warnings: [],
      bindings: [{ surface: "markdown", address: `sessions/${sid}/inbox.md`, sid }],
      rev: 0,
      stopReason: null,
      stoppedAt: null,
      stopPending: null,
      stopNotePending: false,
      notices,
    }),
  );
}

function spawnDaemon(proj: string) {
  return spawn(process.execPath, [distEntry, "__daemon", proj], {
    env: { ...process.env, ADDE_HOME: tmpBase, ADDE_ACP_BIN: FIXTURE },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function inboxPath(proj: string, sid: string): string {
  return path.join(vaultRoot, "adde", "projects", proj, "sessions", sid, "inbox.md");
}

describe.skipIf(!distAvailable)(
  "PROC-R18 실 프로세스 spawn — 안내 항목의 재기동 유지(SC-037)",
  () => {
    it("Happy: 안내 항목이 있는 세션 → 데몬 재기동 후 첫 렌더에 유지된다", async () => {
      const proj = "noticespawn1";
      writeProject(proj, "sess-notice-a", [
        {
          id: "n1",
          mode: "read",
          kind: "compact-done",
          text: "재기동에도 유지될 안내",
          at: new Date().toISOString(),
        },
      ]);
      const child = spawnDaemon(proj);
      try {
        await waitFor(
          () =>
            fs.existsSync(inboxPath(proj, "sess-notice-a")) &&
            fs
              .readFileSync(inboxPath(proj, "sess-notice-a"), "utf8")
              .includes("재기동에도 유지될 안내"),
          { timeoutMs: 10_000 },
        );
      } finally {
        child.kill("SIGTERM");
      }
    }, 20000);

    it("Edge: 재기동 직후 tick 이 rendered 플래그를 세워도 안내를 소비하지 않는다(1회차 유지)", async () => {
      const proj = "noticespawn2";
      writeProject(proj, "sess-notice-b", [
        {
          id: "n2",
          mode: "read",
          kind: "compact-done",
          text: "소비되면 안되는 안내",
          at: new Date().toISOString(),
          rendered: true,
        },
      ]);
      const child = spawnDaemon(proj);
      try {
        await waitFor(() => fs.existsSync(inboxPath(proj, "sess-notice-b")), { timeoutMs: 8_000 });
        await new Promise((r) => setTimeout(r, 3000));
        const content = fs.readFileSync(inboxPath(proj, "sess-notice-b"), "utf8");
        expect(content).toContain("소비되면 안되는 안내");
      } finally {
        child.kill("SIGTERM");
      }
    }, 20000);

    it("Error: 레코드 손상 시 안내 유실 사실이 경고로 표면화되거나 최소한 데몬이 크래시하지 않는다", async () => {
      const proj = "noticespawn3";
      writeProject(proj, "sess-notice-c", [], true);
      const child = spawnDaemon(proj);
      try {
        await new Promise((r) => setTimeout(r, 2000));
        expect(child.exitCode).toBeNull(); // 손상 레코드 1건이 데몬 전체를 죽이지 않는다(격리).
      } finally {
        child.kill("SIGTERM");
      }
    }, 15000);
  },
);
