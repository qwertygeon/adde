/**
 * fail-closed 권한 게이트.
 * Promise.race([userDecision, timeout]).
 * timeout/sendMessage 오류/도달 실패 → decision:deny (default).
 * allow 는 명시적 사용자 콜백 수신 시에만.
 * 기본 타임아웃 = 600초(10분) (레인 conf 에서 재정의 가능).
 */

export interface PermRequest {
  v: 1;
  id: string;
  lane: string;
  channel: string;
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

/** 기본 게이트 타임아웃 — 600초(10분). 테스트 주입 가능하도록 export. */
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

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"deny">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("deny"), timeoutMs);
  });

  try {
    await sendPermPrompt(req);
  } catch {
    // 전송 실패 즉시 deny — 대기 없이 반환하므로 타임아웃 타이머를 정리해 상주 누수를 막는다.
    clearTimeout(timeoutHandle);
    return { id: req.id, decision: "deny", reason: "채널 전송 오류 — fail-closed deny" };
  }

  try {
    const decision = await Promise.race([waitForDecision(), timeoutPromise]);
    return { id: req.id, decision };
  } finally {
    // 결정 승리 경로에서도 타임아웃 타이머 clear — 미clear 시 결정 후 timeoutMs(기본 10분)만큼
    // 타이머가 상주해 24h 기동 시 누적된다.
    clearTimeout(timeoutHandle);
  }
}
