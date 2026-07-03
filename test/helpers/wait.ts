/**
 * 조건 충족까지 실제 시간 폴링 대기 — 시한 초과 시 throw(조용한 통과 방지).
 * fs IO(mkdir·write·rename)는 libuv 스레드풀 처리라 CPU 틱(setImmediate)만 돌리면
 * 병렬 스위트의 디스크 경합에서 틱이 먼저 소진돼 위양성(flaky)이 난다 → 타이머 폴링.
 */
export async function waitFor(
  cond: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const intervalMs = opts.intervalMs ?? 5;
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: 조건이 제한 시간 내 충족되지 않음");
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
}
