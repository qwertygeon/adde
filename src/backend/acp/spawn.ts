/**
 * 엔진 서브프로세스 spawn — clean env 보장.
 * CLAUDECODE·CLAUDE_CODE_ENTRYPOINT 삭제 후 spawn.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** CLAUDECODE 중첩 유발 환경변수 목록. */
const NESTED_GUARD_KEYS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"] as const;

/**
 * process.env 복사본에서 중첩 유발 키를 제거한 clean env 반환.
 * 테스트 주입 가능하도록 분리 export.
 */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of NESTED_GUARD_KEYS) {
    delete result[key];
  }
  return result;
}

/** spawnEngine 옵션. */
export interface SpawnEngineOptions {
  /**
   * 지정되면 엔진 stderr 를 이 경로로 append 캡처한다(디렉터리 자동 생성).
   * 미지정 시 기존 동작(부모 stderr inherit)을 유지한다 — 테스트/레거시 호환.
   */
  stderrPath?: string;
}

/**
 * ACP 엔진 바이너리를 clean env 로 spawn 한다.
 * stdio는 pipe 모드: stdin/stdout 을 ACP JSON-RPC 채널로 사용.
 * opts.stderrPath 지정 시 stderr 를 파일로 append 캡처(미지정 시 inherit).
 */
export function spawnEngine(
  bin: string,
  args: string[],
  opts: SpawnEngineOptions = {},
): ChildProcess {
  const captureStderr = opts.stderrPath !== undefined;
  const child = spawn(bin, args, {
    // stderr: 캡처 시 pipe(소비 필수 — 미소비 시 backpressure 로 child 가 막힘), 아니면 inherit.
    stdio: ["pipe", "pipe", captureStderr ? "pipe" : "inherit"],
    env: cleanEnv(process.env),
  });

  if (captureStderr && child.stderr) {
    const path = opts.stderrPath as string;
    mkdirSync(dirname(path), { recursive: true });
    const ws = createWriteStream(path, { flags: "a" });
    // pipe 한 stream 은 반드시 소비해야 child 가 막히지 않는다 → 즉시 파일에 연결.
    child.stderr.pipe(ws);
    // child 종료 시 스트림 정리(파일 핸들 누수 방지).
    child.once("exit", () => ws.end());
  }

  return child;
}
