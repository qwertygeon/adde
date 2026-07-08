import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv, spawnEngine } from "../../src/backend/acp/spawn.js";

// SC-008: clean env — CLAUDECODE·CLAUDE_CODE_ENTRYPOINT 제거
// cleanEnv 함수는 spawnEngine 에서 분리 export 되어 단위 테스트 주입 가능

describe("cleanEnv (SC-008 clean env spawn)", () => {
  it("CLAUDECODE 키를 제거한다", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      CLAUDECODE: "1",
      OTHER: "value",
    };
    const result = cleanEnv(env);
    expect("CLAUDECODE" in result).toBe(false);
  });

  it("CLAUDE_CODE_ENTRYPOINT 키를 제거한다", () => {
    const env = {
      PATH: "/usr/bin",
      CLAUDE_CODE_ENTRYPOINT: "/path/to/entry",
    };
    const result = cleanEnv(env);
    expect("CLAUDE_CODE_ENTRYPOINT" in result).toBe(false);
  });

  it("두 키 모두 동시에 제거한다", () => {
    const env = {
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "/entry",
      NODE_ENV: "test",
    };
    const result = cleanEnv(env);
    expect("CLAUDECODE" in result).toBe(false);
    expect("CLAUDE_CODE_ENTRYPOINT" in result).toBe(false);
  });

  it("다른 환경변수는 유지된다", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      NODE_ENV: "production",
      CLAUDECODE: "1",
    };
    const result = cleanEnv(env);
    expect(result["PATH"]).toBe("/usr/bin");
    expect(result["HOME"]).toBe("/Users/test");
    expect(result["NODE_ENV"]).toBe("production");
  });

  it("두 키가 없는 env 는 그대로 반환한다", () => {
    const env = { PATH: "/usr/bin", NODE_ENV: "test" };
    const result = cleanEnv(env);
    expect(result["PATH"]).toBe("/usr/bin");
    expect(result["NODE_ENV"]).toBe("test");
  });

  it("원본 env 를 변경하지 않는다 (불변성)", () => {
    const env = { PATH: "/usr/bin", CLAUDECODE: "1" };
    const original = { ...env };
    cleanEnv(env);
    expect(env).toEqual(original);
  });
});

// SC-R1/R3: stderr 캡처 — 실프로세스로 검증(스트림·종료 로직은 mock 으로 못 잡음).
describe("spawnEngine stderr 캡처 (SC-R1)", () => {
  /** 파일이 기대 내용을 담을 때까지 실타이머로 폴링(setImmediate 폴링은 부하 시 위양성). */
  async function waitForContent(path: string, needle: string, timeoutMs = 3000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const text = await readFile(path, "utf8");
        if (text.includes(needle)) return text;
      } catch {
        // 아직 생성 전 — 재시도.
      }
      if (Date.now() > deadline) throw new Error(`타임아웃: "${needle}" 를 ${path} 에서 못 봄`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("stderrPath 지정 시 엔진 stderr 를 파일로 append 한다 (디렉터리 자동 생성)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adde-spawn-"));
    // 중첩 경로 — mkdirSync(recursive) 가 디렉터리를 만드는지 함께 검증.
    const logPath = join(dir, "state", "lane1", "engine.log");
    try {
      const child = spawnEngine(
        process.execPath,
        ["-e", "process.stderr.write('hello-stderr\\n')"],
        { stderrPath: logPath },
      );
      const text = await waitForContent(logPath, "hello-stderr");
      expect(text).toContain("hello-stderr");
      // stdout 은 ACP 채널이라 pipe 로 남는다(inherit 아님).
      expect(child.stdout).not.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("같은 경로에 두 번째 spawn 은 append 한다 (덮어쓰지 않음)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adde-spawn-"));
    const logPath = join(dir, "engine.log");
    try {
      spawnEngine(process.execPath, ["-e", "process.stderr.write('first\\n')"], {
        stderrPath: logPath,
      });
      await waitForContent(logPath, "first");
      spawnEngine(process.execPath, ["-e", "process.stderr.write('second\\n')"], {
        stderrPath: logPath,
      });
      const text = await waitForContent(logPath, "second");
      expect(text).toContain("first");
      expect(text).toContain("second");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stderrPath 미지정 시 캡처하지 않는다 (stderr=null, inherit 동작)", () => {
    const child = spawnEngine(process.execPath, ["-e", "0"]);
    // inherit 모드면 child.stderr 는 노출되지 않는다(null).
    expect(child.stderr).toBeNull();
    child.kill();
  });

  it("engine.log 는 시크릿을 마스킹해 기록한다 (side channel 유출 차단)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adde-spawn-mask-"));
    const logPath = join(dir, "engine.log");
    try {
      // 봇 토큰 형식 문자열을 stderr 로 뱉는 엔진 — 마스킹되어야 한다.
      spawnEngine(
        process.execPath,
        [
          "-e",
          "process.stderr.write('err TELEGRAM_BOT_TOKEN=123456:AAaabbccddeeff00112233445566778899x done\\n')",
        ],
        { stderrPath: logPath },
      );
      const text = await waitForContent(logPath, "done");
      expect(text).toContain("done"); // 비시크릿 텍스트는 보존
      expect(text).not.toContain("123456:AAaabbccddeeff00112233445566778899x"); // 토큰 원문 미노출
      expect(text).toContain("***");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// SC-016 (FR-008 — 통합): engine 로그 스트림 재열기 창에서 stderr chunk 가 유실되지 않는다.
// 실 child + 실 파일 스트림으로 회전(다회) 중 유입되는 chunk 전부가 현재 또는 보관 세대
// 어딘가에 기록되는지 검증(write-after-end 무음 유실 0). keep 을 예상 회전 횟수보다 크게
// 잡아 "세대 보관 상한으로 인한 정상 소실"과 "재열기 창 버그로 인한 유실"을 구분한다.
describe("spawnEngine stderrRotate — 재열기 창 무손실 (SC-016)", () => {
  async function waitForExit(child: ReturnType<typeof spawnEngine>): Promise<void> {
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
  }

  it("회전이 여러 차례 발생해도 모든 stderr 마커가 손실 없이 기록된다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "adde-spawn-rotate-"));
    const logPath = join(dir, "engine.log");
    const N = 20;
    try {
      const script = `
        (async () => {
          for (let i = 0; i < ${N}; i++) {
            process.stderr.write('MARK-' + i + '-' + 'y'.repeat(15) + '\\n');
            await new Promise((r) => setTimeout(r, 2));
          }
        })();
      `;
      const child = spawnEngine(process.execPath, ["-e", script], {
        stderrPath: logPath,
        stderrRotate: { maxBytes: 100, keep: 10 },
      });

      await waitForExit(child);
      // stderr 'end' flush 까지 약간의 여유(마지막 라인 write 완료 대기).
      await new Promise((r) => setTimeout(r, 50));

      const files = (await readdirDir(dir)).filter((f) => f.startsWith("engine.log"));
      expect(files.length).toBeGreaterThan(1); // 회전이 최소 1회 이상 발생

      const combined = (
        await Promise.all(files.map((f) => readFile(join(dir, f), "utf8")))
      ).join("\n");

      for (let i = 0; i < N; i++) {
        expect(combined).toContain(`MARK-${i}-`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function readdirDir(dir: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}
