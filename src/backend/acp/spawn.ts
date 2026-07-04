/**
 * 엔진 서브프로세스 spawn — clean env 보장.
 * CLAUDECODE·CLAUDE_CODE_ENTRYPOINT 삭제 후 spawn.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { maskSecrets } from "../../shared/mask.js";

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
    // 로그 스트림 오류는 흡수(진단 로그 — 엔진 동작 비차단, unhandled 'error' 방지).
    ws.on("error", () => {});
    // engine.log 는 마스킹되지 않는 side channel — 라인 단위로 maskSecrets 적용 후 기록
    // (transcript 만 마스킹하면 엔진 stderr 로 토큰·민감경로가 평문 유출될 수 있음).
    // pipe 대신 data 핸들러로 소비 — pipe 한 stream 미소비 시 backpressure 로 child 가 막힌다.
    let buf = "";
    // 개행 없는 초장문 방어 — 상한 초과 시 마스킹해 flush(메모리 무한 증가 방지).
    const MAX_BUF = 1 << 20; // 1MB
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        ws.write(maskSecrets(line) + "\n");
      }
      if (buf.length > MAX_BUF) {
        ws.write(maskSecrets(buf));
        buf = "";
      }
    });
    // stderr EOF('end') 에서 잔여 부분 라인 flush 후 스트림 정리 — 'exit' 는 stderr 버퍼 배출을
    // 보장하지 않아 write-after-end·꼬리 라인 마스킹 누락을 유발할 수 있다(EOF 는 데이터 완결 보장).
    child.stderr.on("end", () => {
      if (buf.length > 0) ws.write(maskSecrets(buf));
      ws.end();
    });
  }

  return child;
}
