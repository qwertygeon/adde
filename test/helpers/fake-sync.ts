/**
 * T-D12 더블 확장 — 보관 이관(retention) 물질화(materialize) 훅 더블 + dataless 파일 흉내.
 * `runRetention(ctx, policy, materialize)` 의 materialize 매개변수를 대상으로 성공/타임아웃/예외
 * 3경로를 재현한다(quirk: 물질화는 파일별 결정이며 실패는 그 파일만 skip 시켜야 한다 — SC-048).
 */
import { open } from "node:fs/promises";

export type Materialize = (p: string) => Promise<"ready" | "skip">;

export interface FakeMaterializeControl {
  materialize: Materialize;
  calls(): string[];
}

/**
 * 경로별 결과를 사전 지정할 수 있는 materialize 더블. 미지정 경로는 기본값(dflt, 기본 "ready").
 * "throw" 지정 시 그 파일에서 예외를 던진다(호출부가 그 파일만 skip 처리해야 함을 검증).
 */
export function makeFakeMaterialize(
  perPath: Record<string, "ready" | "skip" | "throw">,
  dflt: "ready" | "skip" | "throw" = "ready",
): FakeMaterializeControl {
  const seen: string[] = [];
  const materialize: Materialize = async (p: string) => {
    seen.push(p);
    const outcome = perPath[p] ?? dflt;
    if (outcome === "throw") throw new Error(`[fake-sync] materialize 예외: ${p}`);
    return outcome;
  };
  return { materialize, calls: () => seen };
}

/**
 * sparse 파일(blocks=0, size>0)로 iCloud dataless placeholder 시그니처를 실 fs 로 재현한다
 * (018 선례 — 더블이 아니라 실 fs 특성을 이용, `read` 후에도 blocks=0 인 quirk까지 유지된다).
 * 파일시스템이 sparse 를 지원하지 않으면 null 을 반환한다(호출측이 ctx.skip() 으로 처리).
 */
export async function createSparseDatalessFile(
  filePath: string,
  sizeBytes = 1024 * 1024,
): Promise<boolean> {
  const fh = await open(filePath, "w");
  try {
    await fh.truncate(sizeBytes);
  } finally {
    await fh.close();
  }
  const { stat } = await import("node:fs/promises");
  const s = await stat(filePath);
  return s.blocks === 0 && s.size > 0;
}
