import { describe, expect, it } from "vitest";
import { cleanEnv } from "../../src/backend/acp/spawn.js";

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
