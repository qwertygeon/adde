/**
 * T-D12 더블 확장 — v2 EngineDriver/EngineSession 더블(design.md §인터페이스 계약 L2).
 * quirk 재현 의무(infra.md §4 [MUST]): caps 조합(resume native/none · permission
 * callback/policy-only/none · compact native/prompt/none) · 재개 성공/실패 · 권한 타임아웃 ·
 * usage 유무 · 턴 완료 전 추가 prompt 큐잉 · 엔진 강제 종료(크래시) 신호를 모두 재현한다.
 * no-op 더블 금지(conventions.md CV-3) — 상태 전이(open/close/crash)를 실제로 반영한다.
 */
import { vi } from "vitest";

export interface FakeEngineCaps {
  resume: "native" | "none";
  permission: "callback" | "policy-only" | "none";
  streaming: boolean;
  usage: boolean;
  compact: "native" | "prompt" | "none";
  attachments: readonly ("image" | "file")[];
}

export type FakeEngineEvent =
  | { t: "text"; role: "assistant"; delta: string }
  | { t: "text_final"; role: "assistant"; text: string }
  | { t: "tool_call"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; output: unknown }
  | { t: "permission"; reqId: string; tool: string; input: unknown }
  | { t: "usage"; input: number; output: number }
  | { t: "turn_end"; stopReason: string };

export interface FakeOpenCtx {
  cwd: string;
  engineRef?: string | undefined;
  args?: readonly string[] | undefined;
}

export interface FakeEngineSession {
  readonly engineRef: string;
  send(input: { text: string }): AsyncIterable<FakeEngineEvent>;
  respondPermission(reqId: string, decision: "allow" | "deny"): Promise<void>;
  compact?(): Promise<void>;
  close(): Promise<void>;
  onExit(cb: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): void;
  isAlive(): boolean;
}

export interface FakeEngineControl {
  /** 다음 open() 이 실패(재개 실패 등)로 throw 하도록 예약 — 1회 발동 후 자동 해제. */
  failNextOpen(reason?: string): void;
  /** 상주 중인 세션의 엔진을 강제 종료(크래시)한 것처럼 onExit 콜백을 발화한다. */
  crash(engineRef: string, info?: { code: number | null; signal: NodeJS.Signals | null }): void;
  /** 다음 send() 의 권한 요청을 타임아웃(응답 없음)으로 만든다 — respondPermission 이 도달하지 않음. */
  hangNextPermission(): void;
  /** send() 호출 중 턴 종료 전에 추가로 도착한 prompt 큐를 재현 — TurnRunner 의 single-flight 처리 검증용. */
  queueExtraPromptBeforeTurnEnd(text: string): void;
  /**
   * 다음 send() 를 turn_end 직전에서 수동 release() 까지 정지시킨다(세션 간 병렬·세션 내 직렬
   * 관측 — SC-002). release() 호출 전까지 해당 세션의 턴은 "진행 중"으로 관측된다.
   */
  holdNextTurn(): () => void;
  isAlive(engineRef: string): boolean;
  openCallCount(): number;
}

/**
 * caps 를 입력으로 받아 EngineDriverDescriptor 형태의 더블을 만든다.
 * id·caps·open() 만 제공(doctorChecks 는 본 더블 범위 밖).
 */
export function makeFakeEngineDriver(
  id: string,
  caps: FakeEngineCaps,
): {
  descriptor: {
    id: string;
    caps: FakeEngineCaps;
    open: (ctx: FakeOpenCtx) => Promise<FakeEngineSession>;
  };
  control: FakeEngineControl;
} {
  let seq = 0;
  let failNext: string | undefined;
  let hangNextPerm = false;
  const alive = new Map<string, boolean>();
  const exitCbs = new Map<
    string,
    (info: { code: number | null; signal: NodeJS.Signals | null }) => void
  >();
  let openCalls = 0;
  const extraQueue: string[] = [];
  let pendingHold: { promise: Promise<void>; release: () => void } | undefined;

  const open = vi.fn(async (ctx: FakeOpenCtx): Promise<FakeEngineSession> => {
    openCalls++;
    if (failNext !== undefined) {
      const reason = failNext;
      failNext = undefined;
      throw new Error(`[fake-engine:${id}] open failed: ${reason}`);
    }
    const engineRef = ctx.engineRef ?? `fake-${id}-${++seq}`;
    alive.set(engineRef, true);

    const session: FakeEngineSession = {
      engineRef,
      async *send(input) {
        if (!alive.get(engineRef)) throw new Error(`[fake-engine:${id}] send after close/crash`);
        yield { t: "text", role: "assistant", delta: `echo:${input.text}` };
        if (caps.permission !== "none") {
          const reqId = `perm-${engineRef}-${++seq}`;
          yield { t: "permission", reqId, tool: "Bash", input: { cmd: "echo hi" } };
          if (hangNextPerm) {
            hangNextPerm = false;
            // 타임아웃 재현 — respondPermission 이 결코 도달하지 않는 상태를 흉내낸다(게이트가
            // 자체 타임아웃으로 deny 를 결정해야 하며, 본 더블은 그 결정을 강제하지 않는다).
            return;
          }
        }
        while (extraQueue.length > 0) {
          const extra = extraQueue.shift()!;
          yield { t: "text", role: "assistant", delta: `queued-before-end:${extra}` };
        }
        if (pendingHold) {
          const hold = pendingHold;
          pendingHold = undefined;
          await hold.promise;
        }
        yield { t: "text_final", role: "assistant", text: `echo:${input.text}` };
        if (caps.usage) yield { t: "usage", input: 10, output: 20 };
        yield { t: "turn_end", stopReason: "end_turn" };
      },
      async respondPermission() {
        // fail-closed 검증 대상은 게이트 쪽 — 더블은 단순 수신만 확인한다.
      },
      ...(caps.compact !== "none" ? { compact: async () => {} } : {}),
      async close() {
        alive.set(engineRef, false);
        exitCbs.delete(engineRef);
      },
      onExit(cb) {
        exitCbs.set(engineRef, cb);
      },
      isAlive() {
        return alive.get(engineRef) ?? false;
      },
    };
    return session;
  });

  return {
    descriptor: { id, caps, open },
    control: {
      failNextOpen(reason = "resume rejected") {
        failNext = reason;
      },
      crash(engineRef, info = { code: null, signal: "SIGKILL" }) {
        alive.set(engineRef, false);
        exitCbs.get(engineRef)?.(info);
      },
      hangNextPermission() {
        hangNextPerm = true;
      },
      queueExtraPromptBeforeTurnEnd(text) {
        extraQueue.push(text);
      },
      holdNextTurn() {
        let release!: () => void;
        const promise = new Promise<void>((r) => {
          release = r;
        });
        pendingHold = { promise, release };
        return release;
      },
      isAlive(engineRef) {
        return alive.get(engineRef) ?? false;
      },
      openCallCount() {
        return openCalls;
      },
    },
  };
}

/** 자주 쓰는 caps 프리셋 — SC-021·SC-023 등 caps 조합 더블에 사용. */
export const FAKE_CAPS_PRESETS = {
  fullNative: {
    resume: "native",
    permission: "callback",
    streaming: true,
    usage: true,
    compact: "native",
    attachments: ["file"],
  } satisfies FakeEngineCaps,
  noResume: {
    resume: "none",
    permission: "callback",
    streaming: true,
    usage: false,
    compact: "none",
    attachments: [],
  } satisfies FakeEngineCaps,
  policyOnlyPermission: {
    resume: "native",
    permission: "policy-only",
    streaming: true,
    usage: false,
    compact: "prompt",
    attachments: [],
  } satisfies FakeEngineCaps,
  noPermission: {
    resume: "native",
    permission: "none",
    streaming: false,
    usage: false,
    compact: "none",
    attachments: [],
  } satisfies FakeEngineCaps,
};
