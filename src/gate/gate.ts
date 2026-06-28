/**
 * fail-closed 권한 게이트.
 * FR-019/020/NFR-003/ADR-006: Promise.race([userDecision, timeout]).
 * timeout/sendMessage 오류/도달 실패 → decision:deny (default).
 * allow 는 명시적 사용자 콜백 수신 시에만.
 * DEC-001: 기본 타임아웃 = 600초(10분) (레인 conf 에서 재정의 가능).
 */

export interface PermRequest {
  v: 1;
  id: string;
  lane: string;
  channel: "telegram";
  tool: string;
  detail: string;
  cwd: string;
  ts: string;
}

export interface PermResponse {
  id: string;
  decision: "allow" | "deny";
  reason?: string;
}

/** 기본 게이트 타임아웃 — 600초(10분, DEC-001). 테스트 주입 가능하도록 export. */
export const DEFAULT_GATE_TIMEOUT_MS = 600_000;

export type SendPermPrompt = (req: PermRequest) => Promise<void>;

export interface GateOptions {
  sendPermPrompt: SendPermPrompt;
  /**
   * 사용자 결정을 기다리는 Promise 반환 함수.
   * 테스트에서 주입 가능하도록 함수로 분리(모킹 용이성).
   */
  waitForDecision: () => Promise<"allow" | "deny">;
  timeoutMs?: number;
}

/**
 * 권한 게이트 — fail-closed.
 * sendPermPrompt 가 채널에 inline 버튼을 전송하고, waitForDecision() 반환 Promise 는
 * 콜백 수신 시 resolve 된다.
 * timeout 또는 sendPermPrompt 오류 → deny.
 */
export async function gateRequestDecision(
  req: PermRequest,
  opts: GateOptions,
): Promise<PermResponse> {
  const { sendPermPrompt, waitForDecision, timeoutMs = DEFAULT_GATE_TIMEOUT_MS } = opts;

  const timeoutPromise = new Promise<"deny">((resolve) =>
    setTimeout(() => resolve("deny"), timeoutMs),
  );

  try {
    await sendPermPrompt(req);
  } catch {
    return { id: req.id, decision: "deny", reason: "채널 전송 오류 — fail-closed deny" };
  }

  const decision = await Promise.race([waitForDecision(), timeoutPromise]);
  return { id: req.id, decision };
}
