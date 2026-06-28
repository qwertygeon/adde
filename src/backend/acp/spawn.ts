/**
 * 엔진 서브프로세스 spawn — clean env 보장.
 * FR-008/NFR-001/ADR-005: CLAUDECODE·CLAUDE_CODE_ENTRYPOINT 삭제 후 spawn.
 * PoC spike.ts:69-71 패턴.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

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

/**
 * ACP 엔진 바이너리를 clean env 로 spawn 한다.
 * stdio는 pipe 모드: stdin/stdout 을 ACP JSON-RPC 채널로 사용.
 */
export function spawnEngine(bin: string, args: string[]): ChildProcess {
  return spawn(bin, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: cleanEnv(process.env),
  });
}
