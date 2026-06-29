import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { withTimeout, killChild, closeChild } from "../../src/backend/acp/lifecycle.js";

/**
 * 살아있는 child 를 spawn 하고 스크립트가 READY 를 출력할 때까지 대기.
 * ('spawn' 이벤트는 스크립트 실행 완료를 보장하지 않아 — SIGTERM 핸들러 설치 전 신호 race 방지.)
 * body 는 READY 출력 *이후* 실행되므로, READY 를 본 시점엔 핸들러가 이미 설치돼 있다.
 */
async function spawnReady(setup: string, body: string) {
  const child = spawn(process.execPath, [
    "-e",
    `${setup}; process.stdout.write('READY\\n'); ${body}`,
  ]);
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (d: Buffer) => {
      if (d.toString().includes("READY")) resolve();
    });
    child.once("error", reject);
  });
  return child;
}

describe("withTimeout (DEC-002)", () => {
  it("제한 내 resolve 하면 값을 그대로 반환한다", async () => {
    await expect(
      withTimeout(Promise.resolve("ok"), 1_000, () => new Error("timeout")),
    ).resolves.toBe("ok");
  });

  it("제한 초과 시 onTimeout 에러로 reject 한다", async () => {
    await expect(
      withTimeout(new Promise(() => {}), 30, () => new Error("핸드셰이크 무응답")),
    ).rejects.toThrow("핸드셰이크 무응답");
  });
});

describe("killChild (실패 경로 강제 종료)", () => {
  it("살아있는 child 를 SIGKILL 로 종료한다", async () => {
    const child = await spawnReady("", "setInterval(() => {}, 1000)");
    const exitP = once(child, "exit") as Promise<[number | null, string | null]>; // 선등록(race 방지)
    killChild(child);
    const [, signal] = await exitP;
    expect(signal).toBe("SIGKILL");
  });
});

describe("closeChild — SIGTERM→유예→SIGKILL (SC1/DEC-003)", () => {
  it("SIGTERM 에 반응하는 프로세스는 유예 내 graceful(SIGTERM) 종료된다", async () => {
    const child = await spawnReady("", "setInterval(() => {}, 1000)"); // 기본 SIGTERM 종료
    await closeChild(child, 5_000);
    // closeChild 는 child exit 시 조기 resolve — 유예 만료 전 SIGTERM 으로 종료됨.
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("SIGTERM 을 무시하는 프로세스는 유예 후 SIGKILL 된다", async () => {
    const child = await spawnReady(
      "process.on('SIGTERM', () => {})",
      "setInterval(() => {}, 1000)",
    );
    const exitP = once(child, "exit") as Promise<[number | null, string | null]>; // SIGKILL exit 누락 방지(선등록)
    await closeChild(child, 120); // 짧은 유예 → SIGKILL
    const [, signal] = await exitP;
    expect(signal).toBe("SIGKILL");
  });

  it("이미 종료된 child 에 대해서는 즉시 resolve 한다", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    await once(child, "exit");
    await expect(closeChild(child, 1_000)).resolves.toBeUndefined();
  });
});
