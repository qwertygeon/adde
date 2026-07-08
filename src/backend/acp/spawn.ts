/**
 * 엔진 서브프로세스 spawn — clean env 보장.
 * CLAUDECODE·CLAUDE_CODE_ENTRYPOINT 삭제 후 spawn.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { maskSecrets } from "../../shared/mask.js";
import { rotateGenerations } from "../../shared/log-rotate.js";
import { t } from "../../shared/i18n.js";
import { errMsg } from "../../shared/errors.js";

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
  /** engine.log 세대 회전 설정(신규, 옵션 — 하위호환). 미지정 시 회전 안 함(기존 동작). */
  stderrRotate?: { maxBytes: number; keep: number };
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
    const rotate = opts.stderrRotate;
    mkdirSync(dirname(path), { recursive: true });
    // let — 회전 시 재열기(신 inode)로 참조를 스왑한다. data/end 핸들러는 클로저로 최신 ws 를 본다.
    let ws = createWriteStream(path, { flags: "a" });
    // 로그 스트림 오류는 흡수(진단 로그 — 엔진 동작 비차단, unhandled 'error' 방지).
    ws.on("error", () => {});
    // 회전 임계 누적 바이트 — 기존 파일 크기로 시드(append 모드라 현 세대가 이미 채워져 있을 수 있음).
    let written = rotate ? (statSync(path, { throwIfNoEntry: false })?.size ?? 0) : 0;
    // 회전 진행 중 재트리거 방지 플래그(rotateGenerations 완료까지 재진입 금지).
    let rotating = false;

    /**
     * 회전 트리거 — rename(fire-and-forget) 완료 후 참조 스왑 + 옛 ws.end().
     * 순서 불변: rename → 신 ws 생성·스왑 → 옛 ws.end(). 스왑 전 도착 chunk 는 옛 ws(rename 후에도
     * 동일 inode 참조라 무손실)로, 스왑 후 chunk 는 신 ws 로 — 재열기 창 무손실.
     */
    function maybeRotate(): void {
      if (!rotate || rotating || written < rotate.maxBytes) return;
      rotating = true;
      rotateGenerations(path, rotate)
        .then(() => {
          const old = ws;
          ws = createWriteStream(path, { flags: "a" });
          ws.on("error", () => {});
          written = 0;
          old.end();
        })
        .catch((err: unknown) => {
          // fail-open — 회전 실패는 기록을 막지 않는다.
          console.warn(t("log.rotate.fail", { path, detail: errMsg(err) }));
        })
        .finally(() => {
          rotating = false;
        });
    }

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
        const out = maskSecrets(line) + "\n";
        ws.write(out);
        written += Buffer.byteLength(out);
        maybeRotate();
      }
      if (buf.length > MAX_BUF) {
        const out = maskSecrets(buf);
        ws.write(out);
        written += Buffer.byteLength(out);
        buf = "";
        maybeRotate();
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
