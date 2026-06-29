/**
 * 엔진 child 프로세스 수명 헬퍼 — 타임아웃·종료(SIGTERM→유예→SIGKILL).
 * client.ts 에서 분리(테스트 가능성·관심사 분리). DEC-002/DEC-003.
 */
import type { ChildProcess } from "node:child_process";

/** Promise 를 시한부로 감싼다 — 초과 시 onTimeout() 으로 reject. settle 시 타이머 정리(누수 방지). */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 실패 경로용 즉시 강제 종료 — 핸드셰이크 실패 등에서 child 누수 방지.
 * 종료 판정은 exitCode===null(생존)로만 한다 — child.killed 는 "신호를 보냈다"는 뜻이지
 * "죽었다"가 아니므로 가드에 쓰면 SIGKILL 이 누락된다.
 */
export function killChild(child: ChildProcess): void {
  if (child.exitCode === null) child.kill("SIGKILL");
}

/** graceful 종료: SIGTERM → graceMs 유예 → 미종료 시 SIGKILL. child exit 시 조기 정리. */
export async function closeChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      // SIGTERM 무응답 → 강제 종료. child.killed(신호 전송 여부) 가 아니라 생존 여부로 판정.
      if (child.exitCode === null) child.kill("SIGKILL");
      finish();
    }, graceMs);
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}
