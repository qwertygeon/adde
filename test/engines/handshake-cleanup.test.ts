/**
 * 핸드셰이크 실패 시 자식 프로세스 정리 — 실패 경로마다 spawn 된 엔진 프로세스가 남지 않아야 한다.
 *
 * 재개 실패는 throw 로 확정되는 정상 계약이지만(ADR-009), 그 throw 가 spawn 된 프로세스를 데리고
 * 나가지 않으면 재개 실패 1회마다 엔진 프로세스가 하나씩 누적된다. `rejects.toThrow()` 단언은
 * 이 누수를 통과시키므로 실제 pid 의 생존을 직접 관측한다.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../fixtures/fake-acp-agent.mjs", import.meta.url));
let tmpBase: string;
let loadLog: string;
const origBin = process.env["ADDE_ACP_BIN"];
const origLog = process.env["FAKE_ACP_SESSION_LOAD_LOG"];

beforeEach(() => {
  fs.chmodSync(FIXTURE, 0o755);
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-acp-cleanup-"));
  loadLog = path.join(tmpBase, "session-load.jsonl");
  process.env["ADDE_ACP_BIN"] = FIXTURE;
  process.env["FAKE_ACP_SESSION_LOAD_LOG"] = loadLog;
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  if (origBin === undefined) delete process.env["ADDE_ACP_BIN"];
  else process.env["ADDE_ACP_BIN"] = origBin;
  if (origLog === undefined) delete process.env["FAKE_ACP_SESSION_LOAD_LOG"];
  else process.env["FAKE_ACP_SESSION_LOAD_LOG"] = origLog;
});

/** pid 생존 판정 — 시그널 0 은 전송하지 않고 도달 가능성만 검사한다. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

/** 픽스처가 session/load 수신 시 남긴 자신의 pid — 실패해서 사라진 세션의 프로세스를 추적한다. */
function loadedPid(logPath: string): number {
  const lines = fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  expect(lines.length).toBe(1);
  const pid = (JSON.parse(lines[0]!) as { pid: number }).pid;
  expect(typeof pid).toBe("number");
  return pid;
}

describe("재개(session/load) 실패 시 엔진 프로세스 정리", () => {
  it("미지의 세션 재개가 실패하면 spawn 된 엔진 프로세스를 남기지 않는다", async () => {
    const engines = await import("../../src/engines/index.js");
    const driver = engines.ENGINE_REGISTRY["acp"];

    await expect(
      driver!.open({
        cwd: tmpBase,
        engineRef: "unknown-session-id",
        policy: { perm_tier: "acp" },
      } as never),
    ).rejects.toThrow();

    const pid = loadedPid(loadLog);
    try {
      expect(await waitUntilDead(pid)).toBe(true);
    } finally {
      // 단언 실패 시 이 테스트가 orphan 을 남기지 않도록 직접 회수한다.
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});
