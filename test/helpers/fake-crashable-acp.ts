import { vi } from "vitest";
import { FAKE_ACP_CAPS } from "./fake-acp.js";
import type { PermRequest, PermResponse } from "../../src/gate/gate.js";
import type { AcpBackend } from "../../src/backend/acp/client.js";

/**
 * 002-lane-engine-recovery 공용 fake ACP 백엔드 — crash/재기동/미결승인 시뮬레이션 지원.
 * 계약 강제(테스트 더블 계약 — typescript.md): launch 전 onExit/subscribe/inject/onPermissionRequest
 * throw, close 후 exit 신호 억제(현재-child 가드 모사), relaunch(resumeSession) 시 구독자 승계.
 * no-op 더블 금지 — 크래시·재기동은 실제 상태 전이(launched/alive/injectBehavior)로 반영된다.
 */

type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };
type ExitCb = (lane: string, info: ExitInfo) => void;

export interface FakeCrashableBackendEntry {
  backend: {
    caps: () => ReturnType<AcpBackend["caps"]>;
    launch: ReturnType<typeof vi.fn>;
    inject: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    onPermissionRequest: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    onExit: ReturnType<typeof vi.fn>;
    isAlive: ReturnType<typeof vi.fn>;
    resumeSession: ReturnType<typeof vi.fn>;
  };
  /** inject() 다음 호출의 동작 전환 — "ok"(정상, pong 알림) | "crash"(전송단절 실패, 원문 보존 유발). */
  setInjectBehavior(behavior: "ok" | "crash"): void;
  /** 실 child 크래시를 모사 — 등록된 onExit 콜백을 호출(watcher 트리거). close 후 호출 시 무해(억제). */
  crash(info?: ExitInfo): void;
  /** in-flight 권한 요청 시뮬레이션 — supervisor 가 등록한 handler 를 직접 호출해 미결 상태를 만든다. */
  invokePermHandler(req: PermRequest): Promise<PermResponse>;
  isAliveNow(): boolean;
}

function buildFakeBackend(lane: string, seq: { n: number }): FakeCrashableBackendEntry {
  let launched = false;
  let alive = false;
  let exitCb: ExitCb | null = null;
  let subscriber: ((e: unknown) => void) | null = null;
  let permHandler: ((req: PermRequest) => Promise<PermResponse>) | null = null;
  let injectBehavior: "ok" | "crash" = "ok";

  const requireLaunch = (fn: string): void => {
    if (!launched) throw new Error(`[fake-crashable-acp] ${fn} before launch`);
  };

  const backend = {
    caps: () => FAKE_ACP_CAPS,
    launch: vi.fn().mockImplementation(async () => {
      launched = true;
      alive = true;
      return { sessionId: `fake-${lane}-${++seq.n}` };
    }),
    inject: vi.fn().mockImplementation(async (_l: string, _text: string) => {
      requireLaunch("inject");
      if (injectBehavior === "crash") {
        alive = false;
        // 실제 크래시는 진행 중인 conn.prompt() 를 전송단절로 reject 시킨다(스트림 종료) — 페이크가
        // 그 결과를 재현한다(no-op 더블 금지 — 단순 성공 흉내는 SC-010 회귀를 놓친다).
        throw new Error("engine transport closed (simulated crash mid-turn)");
      }
      subscriber?.({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "pong" },
      });
    }),
    subscribe: vi.fn().mockImplementation((_l: string, cb: (e: unknown) => void) => {
      requireLaunch("subscribe");
      subscriber = cb;
    }),
    onPermissionRequest: vi
      .fn()
      .mockImplementation((_l: string, handler: (req: PermRequest) => Promise<PermResponse>) => {
        requireLaunch("onPermissionRequest");
        permHandler = handler;
      }),
    close: vi.fn().mockImplementation(async () => {
      launched = false;
      alive = false;
      // close 후 exit 신호 억제 — 의도적 종료는 현재-child 가드로 자연 필터되는 실동작 모사(SC-004).
      exitCb = null;
    }),
    onExit: vi.fn().mockImplementation((_l: string, cb: ExitCb) => {
      requireLaunch("onExit"); // subscribe/onPermissionRequest 미러 — launch 전 등록은 계약 위반.
      exitCb = cb;
    }),
    isAlive: vi.fn().mockImplementation(() => alive),
    resumeSession: vi.fn().mockImplementation(async (_l: string, sessionId: string) => {
      launched = true;
      alive = true;
      injectBehavior = "ok"; // 재기동 성공 후 정상 처리 재개(승계된 구독자는 유지 — 상태 미초기화)
      return { sessionId, resumed: true };
    }),
  };

  return {
    backend: backend as unknown as FakeCrashableBackendEntry["backend"],
    setInjectBehavior(behavior: "ok" | "crash"): void {
      injectBehavior = behavior;
    },
    crash(info: ExitInfo = { code: 1, signal: null }): void {
      alive = false;
      exitCb?.(lane, info);
    },
    invokePermHandler(req: PermRequest): Promise<PermResponse> {
      if (!permHandler) throw new Error("[fake-crashable-acp] no permHandler registered");
      return permHandler(req);
    },
    isAliveNow(): boolean {
      return alive;
    },
  };
}

/** acpFactory 로 주입할 팩토리 + 레인별 fake backend 핸들 조회기를 함께 반환. */
export function makeCrashableAcpFactory(): {
  factory: (lane: string, adapterBin: string) => AcpBackend;
  entryFor(lane: string): FakeCrashableBackendEntry;
} {
  const registry = new Map<string, FakeCrashableBackendEntry>();
  const seq = { n: 0 };
  const factory = vi.fn((lane: string, _adapterBin: string): AcpBackend => {
    const entry = buildFakeBackend(lane, seq);
    registry.set(lane, entry);
    return entry.backend as unknown as AcpBackend;
  });
  return {
    factory,
    entryFor(lane: string): FakeCrashableBackendEntry {
      const entry = registry.get(lane);
      if (!entry)
        throw new Error(`[fake-crashable-acp] no fake backend registered for lane ${lane}`);
      return entry;
    },
  };
}
