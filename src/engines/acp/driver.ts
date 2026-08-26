/**
 * ACP 엔진 드라이버(L2) — `backend/acp/client.ts` 를 `EngineDriver`/`EngineSession` 계약으로 재해석.
 * "ADDE 세션 1개 = engineRef 1개 = 동시 open 1개"(research.md ASM-002 귀결) — 인스턴스당 세션 1개였던
 * 현행 `laneState` 단일 슬롯을 `open()` 호출당 독립 클로저(세션 객체)로 승격한다.
 * 재개 실패는 새 세션 폴백 없이 throw(ADR-009). caps 는 정적 선언(FR-021).
 */
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
} from "@agentclientprotocol/sdk";
import type { ChildProcess } from "node:child_process";
import { spawnEngine } from "./spawn.js";
import { withTimeout, killChild, closeChild } from "./lifecycle.js";
import { comparePerm } from "./perm-diff.js";
import type { AddePolicy, EngineEffective } from "./perm-diff.js";
import { maskSecrets, sanitizeEngineText } from "../../shared/mask.js";
import { matchesDenylist } from "../../shared/deny-match.js";
import { DEFAULT_LOG_MAX_BYTES, DEFAULT_LOG_KEEP } from "../../shared/log-rotate.js";
import type {
  EngineCaps,
  EngineDriverDescriptor,
  EngineEvent,
  EngineSession,
  OpenCtx,
} from "../types.js";

/** 실제 어댑터 바이너리(엔진 프로필) — 후속 spec 에서 드라이버별 다변화 대상(현행 단일 값 승계).
 * `ADDE_ACP_BIN` 환경 오버라이드가 있으면 그것을 우선한다(v0.2.x `resolveAdapterBin()` 동등 계약
 * 승계 — 테스트 전용 더블 주입 경로, 실 `claude-agent-acp` 무접촉 원칙 infra.md §4 [MUST NOT]).
 * `open()` 호출 시점마다 재조회한다 — 모듈은 1회만 로드되므로 top-level 상수로 고정하면 테스트가
 * `beforeEach` 에서 바꾼 env 값을 반영하지 못한다. */
function resolveAdapterBin(): string {
  return process.env["ADDE_ACP_BIN"] ?? "claude-agent-acp";
}

/** 핸드셰이크(initialize·newSession) 최대 대기. 초과 시 launch 실패 + child kill. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** close() 시 SIGTERM 후 종료 유예. 초과 시 SIGKILL. */
const CHILD_GRACE_MS = 5_000;

/** toolCallId→원시 도구명 맵 상한 — 초과 시 가장 오래된 항목부터 제거(장수 세션 메모리 상한). */
const TOOL_NAME_MAP_MAX = 512;

function recordToolName(map: Map<string, string>, update: Record<string, unknown>): void {
  if (update["sessionUpdate"] !== "tool_call") return;
  const toolCallId = update["toolCallId"];
  if (typeof toolCallId !== "string") return;
  const meta = update["_meta"];
  if (!meta || typeof meta !== "object") return;
  const claudeCode = (meta as Record<string, unknown>)["claudeCode"];
  if (!claudeCode || typeof claudeCode !== "object") return;
  const toolName = (claudeCode as Record<string, unknown>)["toolName"];
  if (typeof toolName !== "string" || toolName.length === 0) return;
  map.set(toolCallId, toolName);
  if (map.size > TOOL_NAME_MAP_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

function resolveToolName(
  map: Map<string, string>,
  toolCall: Record<string, unknown>,
): string | undefined {
  const toolCallId = toolCall["toolCallId"];
  if (typeof toolCallId === "string") {
    const fromMap = map.get(toolCallId);
    if (fromMap) return fromMap;
  }
  const meta = toolCall["_meta"];
  if (meta && typeof meta === "object") {
    const claudeCode = (meta as Record<string, unknown>)["claudeCode"];
    if (claudeCode && typeof claudeCode === "object") {
      const toolName = (claudeCode as Record<string, unknown>)["toolName"];
      if (typeof toolName === "string" && toolName.length > 0) return toolName;
    }
  }
  return undefined;
}

type PermDecision =
  { kind: "hard_deny" } | { kind: "auto"; via: "allowlist" | "autopass" } | { kind: "ask" };

/** hard-deny → 자동허용(allowlist/autopass) → 채널 승인 순서(보안 핵심 — 순서를 뒤집지 않는다). */
function resolvePermDecision(
  policy: AddePolicy,
  toolName: string | undefined,
  rawInput: unknown,
): PermDecision {
  if (
    toolName !== undefined &&
    matchesDenylist(policy.hard_deny as string[] | undefined, toolName, rawInput)
  ) {
    return { kind: "hard_deny" };
  }
  if (toolName === undefined) return { kind: "ask" };
  if (
    policy.perm_tier === "autopass" &&
    matchesDenylist(policy.denylist as string[] | undefined, toolName, rawInput)
  ) {
    return { kind: "ask" };
  }
  if ((policy.allowlist as string[] | undefined)?.includes(toolName)) {
    return { kind: "auto", via: "allowlist" };
  }
  if (policy.perm_tier === "autopass") return { kind: "auto", via: "autopass" };
  return { kind: "ask" };
}

/** 최소 pull 기반 비동기 큐 — ACP 콜백(push) 과 send() 의 AsyncIterable(pull) 계약을 잇는다. */
class AsyncEventQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<(v: IteratorResult<T>) => void> = [];
  private ended = false;

  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.buffer.push(v);
  }

  end(): void {
    this.ended = true;
    let w: ((v: IteratorResult<T>) => void) | undefined;
    while ((w = this.waiters.shift())) w({ value: undefined as unknown as T, done: true });
  }

  private async next(): Promise<IteratorResult<T>> {
    const head = this.buffer.shift();
    if (head !== undefined) return { value: head, done: false };
    if (this.ended) return { value: undefined as unknown as T, done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: (): Promise<IteratorResult<T>> => this.next() };
  }
}

interface PermissionRequestParams {
  toolCall: { title?: string; toolCallId?: string; rawInput?: unknown };
  sessionId: string;
  options: Array<{ kind: string; optionId: string }>;
}

/** ACP 드라이버 — 정적 caps 선언(FR-021). ACP 는 재개 native·대화형 승인·스트리밍 지원, usage 미제공. */
export const acpDriver: EngineDriverDescriptor = {
  id: "acp",
  caps: {
    resume: "native",
    permission: "callback",
    streaming: true,
    usage: false,
    compact: "native",
    attachments: ["file"],
  } satisfies EngineCaps,

  async open(ctx: OpenCtx): Promise<EngineSession> {
    const engineArgs = [...(ctx.args ?? [])];
    const badArgIndex = engineArgs.findIndex((a) => typeof a !== "string" || a.length === 0);
    if (badArgIndex !== -1) {
      // FR-022(engine_args 승계 계약) — v0.2.x 의 따옴표값 거부(fail-closed 안전망)와 동형: 파싱
      // 불가한 인자는 spawn 하지 않고 즉시 거부한다(엔진 프로세스가 조용히 오작동하지 않도록).
      // 검증은 드라이버 소관이다 — 코어는 caps 만 보고 인자의 형태를 알지 못한다(A-P007).
      throw new Error(
        `ACP 엔진 인자 파싱 실패 — 비어있지 않은 문자열이어야 합니다(index ${badArgIndex}): ${JSON.stringify(engineArgs[badArgIndex])}`,
      );
    }
    const adapterBin = resolveAdapterBin();
    const child = spawnEngine(
      adapterBin,
      engineArgs,
      ctx.stderrLogPath
        ? {
            stderrPath: ctx.stderrLogPath,
            stderrRotate: { maxBytes: DEFAULT_LOG_MAX_BYTES, keep: DEFAULT_LOG_KEEP },
          }
        : {},
    );

    let onSpawnError: (err: Error) => void = (err) =>
      console.error(`[engines/acp] spawn error: ${err.message}`);
    const spawnFailed = new Promise<never>((_, reject) => {
      onSpawnError = (err) =>
        reject(new Error(`ACP 엔진 spawn 실패(${adapterBin}): ${err.message}`));
    });
    child.on("error", (err: Error) => onSpawnError(err));

    const toAgent = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(toAgent, fromAgent);

    const toolNames = new Map<string, string>();
    const policy: AddePolicy = {
      perm_tier: ctx.policy.perm_tier,
      allowlist: ctx.policy.allowlist,
      denylist: ctx.policy.denylist,
      hard_deny: ctx.policy.hard_deny,
    };

    // 현재 진행 중 턴의 이벤트 큐(세션 내 직렬 — TurnRunner 가 single-flight 를 보장한다).
    let currentQueue: AsyncEventQueue<EngineEvent> | null = null;
    let accumulatedText = "";
    const pendingPermissions = new Map<string, (d: "allow" | "deny") => void>();
    let exitHandler:
      ((info: { code: number | null; signal: NodeJS.Signals | null }) => void) | null = null;

    const conn = new acp.ClientSideConnection((_agent) => {
      const clientImpl: acp.Client = {
        async sessionUpdate(params: SessionNotification): Promise<void> {
          const update = params.update as Record<string, unknown>;
          recordToolName(toolNames, update);
          const kind = typeof update["sessionUpdate"] === "string" ? update["sessionUpdate"] : "";

          if (!currentQueue) return; // 턴 밖(session/load replay 등) 이벤트는 무해하게 흘려보낸다.

          if (kind === "agent_message_chunk") {
            const content = update["content"];
            const text =
              typeof content === "string"
                ? content
                : content &&
                    typeof content === "object" &&
                    (content as Record<string, unknown>)["type"] === "text"
                  ? (((content as Record<string, unknown>)["text"] as string | undefined) ?? "")
                  : "";
            accumulatedText += text;
            currentQueue.push({ t: "text", delta: text });
          } else if (kind === "agent_thought_chunk") {
            const content = update["content"];
            const text =
              typeof content === "string"
                ? content
                : content && typeof content === "object"
                  ? (((content as Record<string, unknown>)["text"] as string | undefined) ?? "")
                  : "";
            currentQueue.push({ t: "thinking", delta: text });
          } else if (kind === "tool_call") {
            const toolCallId = update["toolCallId"];
            if (typeof toolCallId === "string") {
              const name =
                resolveToolName(toolNames, update) ??
                (update["title"] as string | undefined) ??
                "unknown";
              currentQueue.push({
                t: "tool_call",
                id: toolCallId,
                name,
                input: update["rawInput"],
              });
            }
          } else if (kind === "tool_call_update") {
            // ACP tool_call_update 의 정확한 스키마는 본 구현에서 재확인하지 않았다(불확실 — best-effort).
            const toolCallId = update["toolCallId"];
            const status = update["status"];
            if (typeof toolCallId === "string" && (status === "completed" || status === "failed")) {
              currentQueue.push({
                t: "tool_result",
                id: toolCallId,
                output: update["rawOutput"] ?? update["content"],
                isError: status === "failed",
              });
            }
          } else if (kind === "usage_update") {
            const usage = update["usage"];
            if (usage && typeof usage === "object") {
              const u = usage as Record<string, unknown>;
              currentQueue.push({
                t: "usage",
                input: typeof u["input"] === "number" ? u["input"] : 0,
                output: typeof u["output"] === "number" ? u["output"] : 0,
                ...(typeof u["costUsd"] === "number" ? { costUsd: u["costUsd"] } : {}),
              });
            }
          } else if (kind === "current_mode_update") {
            const mode = update["mode"];
            if (mode && typeof mode === "object") {
              const m = mode as Record<string, unknown>;
              const effective: EngineEffective = {};
              if (typeof m["permissionMode"] === "string")
                effective.permissionMode = m["permissionMode"];
              if (typeof m["bypassPermissions"] === "boolean") {
                effective.bypassPermissions = m["bypassPermissions"];
              }
              const result = comparePerm(policy, effective);
              if (result.diff && result.warn && ctx.onWarn) ctx.onWarn(result.warn.message);
            }
          }
          // available_commands_update·session_info_update 는 이벤트 기록 대상이 아니다(글로서리 §이벤트 —
          // 응답 조각·도구 호출·도구 결과·권한 요청·사용량·오류·턴 종료만 대상, 프로토콜 관리성 정보 제외).
        },

        async requestPermission(
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> {
          const p = params as unknown as PermissionRequestParams;
          const toolCall = p.toolCall as unknown as Record<string, unknown>;
          const toolTitle = p.toolCall.title ?? "unknown";
          const rawToolName = resolveToolName(toolNames, toolCall);
          const rawInput = toolCall["rawInput"];
          const decision = resolvePermDecision(policy, rawToolName, rawInput);

          if (decision.kind === "hard_deny") {
            return { outcome: { outcome: "cancelled" } };
          }
          if (decision.kind === "auto") {
            const allowOption = p.options.find(
              (o) => o.kind === "allow_once" || o.kind === "allow_always",
            );
            if (allowOption)
              return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
          }

          if (!currentQueue) return { outcome: { outcome: "cancelled" } };
          const reqId = `${p.sessionId.slice(0, 12)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          currentQueue.push({
            t: "permission",
            reqId,
            // 개행·제어문자를 살균 — toolTitle 은 모델이 생성하는 자유 텍스트라 개행 뒤
            // "- [x] allow" 류 삽입으로 승인 노트의 체크박스 파싱을 위조할 수 있다(간접 프롬프트
            // 인젝션 경계). sanitizeEngineText 가 maskSecrets 를 포함한다.
            tool: sanitizeEngineText(rawToolName ? `${rawToolName} · ${toolTitle}` : toolTitle),
            input: maskSecrets(JSON.stringify(rawInput ?? {})),
          });
          const decisionPromise = new Promise<"allow" | "deny">((resolve) => {
            pendingPermissions.set(reqId, resolve);
          });
          const userDecision = await decisionPromise;
          pendingPermissions.delete(reqId);
          if (userDecision === "allow") {
            const allowOption = p.options.find(
              (o) => o.kind === "allow_once" || o.kind === "allow_always",
            );
            if (allowOption)
              return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
          }
          return { outcome: { outcome: "cancelled" } };
        },

        async writeTextFile(_p: WriteTextFileRequest): Promise<WriteTextFileResponse> {
          return {};
        },
        async readTextFile(_p: ReadTextFileRequest): Promise<ReadTextFileResponse> {
          return { content: "" };
        },
      };
      return clientImpl;
    }, stream);

    const timeoutErr = (phase: string): Error =>
      new Error(`ACP 핸드셰이크(${phase}) 시간초과(${HANDSHAKE_TIMEOUT_MS / 1000}초)`);

    try {
      await withTimeout(
        Promise.race([
          conn.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            // fs 능력은 선언하지 않는다 — writeTextFile/readTextFile 핸들러는 항상 no-op
            // 이라(아래 clientImpl), true 선언은 엔진이 이 경로가 실제로 동작한다고 오인하게 한다.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          }),
          spawnFailed,
        ]),
        HANDSHAKE_TIMEOUT_MS,
        () => timeoutErr("initialize"),
      );
    } catch (err) {
      killChild(child);
      throw err;
    }

    let sessionId: string;
    if (ctx.engineRef) {
      // 재개 — 실패는 새 세션 폴백 없이 throw(ADR-009·FR-007). 단 throw 전에 자식을 회수한다:
      // 재개 실패는 정상 계약이라 반복 발생하므로, 정리를 빠뜨리면 실패 1회마다 엔진 프로세스가
      // 하나씩 남는다.
      try {
        await withTimeout(
          Promise.race([
            conn.loadSession({ sessionId: ctx.engineRef, cwd: ctx.cwd, mcpServers: [] }),
            spawnFailed,
          ]),
          HANDSHAKE_TIMEOUT_MS,
          () => timeoutErr("loadSession"),
        );
      } catch (err) {
        killChild(child);
        throw err;
      }
      sessionId = ctx.engineRef;
    } else {
      try {
        const resp = await withTimeout(
          Promise.race([conn.newSession({ cwd: ctx.cwd, mcpServers: [] }), spawnFailed]),
          HANDSHAKE_TIMEOUT_MS,
          () => timeoutErr("newSession"),
        );
        sessionId = resp.sessionId;
      } catch (err) {
        killChild(child);
        throw err;
      }
    }

    // 핸드셰이크 성공 — 이후 child 'error' 는 크래시 대신 로깅.
    onSpawnError = (err) => console.error(`[engines/acp] engine process error: ${err.message}`);

    const thisChild: ChildProcess = child;
    thisChild.on("exit", (code, signal) => {
      exitHandler?.({ code, signal });
    });

    const session: EngineSession = {
      engineRef: sessionId,

      send(input: { text: string }): AsyncIterable<EngineEvent> {
        if (currentQueue) {
          throw new Error("engines/acp: 세션 내 직렬 위반 — 이전 턴이 아직 진행 중입니다.");
        }
        const queue = new AsyncEventQueue<EngineEvent>();
        currentQueue = queue;
        accumulatedText = "";
        conn
          .prompt({ sessionId, prompt: [{ type: "text", text: input.text }] })
          .then(() => {
            queue.push({ t: "text_final", text: accumulatedText });
            currentQueue = null;
            queue.end();
          })
          .catch((err: unknown) => {
            queue.push({
              t: "error",
              message: err instanceof Error ? err.message : String(err),
              fatal: false,
            });
            currentQueue = null;
            queue.end();
          });
        return queue;
      },

      async respondPermission(reqId: string, decision: "allow" | "deny"): Promise<void> {
        const resolve = pendingPermissions.get(reqId);
        if (resolve) resolve(decision);
      },

      async compact(): Promise<void> {
        // 엔진 위임 — 슬래시 텍스트를 그대로 주입(현행 injector.ts 계승, 어댑터가 커맨드 stdout 을 삼킴).
        await conn.prompt({ sessionId, prompt: [{ type: "text", text: "/compact" }] });
      },

      async close(): Promise<void> {
        await closeChild(thisChild, CHILD_GRACE_MS);
      },

      onExit(cb: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): void {
        exitHandler = cb;
      },

      isAlive(): boolean {
        return thisChild.exitCode === null;
      },
    };

    return session;
  },
};
