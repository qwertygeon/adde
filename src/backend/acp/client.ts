/**
 * ACP 세션 라이프사이클·구독.
 * FR-008/009/010/011/019/ADR-002: initialize→session/new→prompt 루프.
 * session/update 이벤트 구독 → transcript·injector·gate 라우팅.
 */
import { Writable, Readable } from "node:stream";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
import type { LanePaths } from "../../shared/paths.js";
import { appendTranscript } from "../../core/transcript.js";
import type { SessionEvent } from "../../core/transcript.js";
import type { PermRequest, PermResponse } from "../../gate/gate.js";
import type { AddePolicy, EngineEffective } from "./perm-diff.js";
import { comparePerm, formatWarn } from "./perm-diff.js";
import { formatBlock, formatException } from "../../shared/notify.js";
import { withTimeout, killChild, closeChild } from "./lifecycle.js";

/** 핸드셰이크(initialize·newSession) 최대 대기 (DEC-002). 초과 시 launch 실패 + child kill. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** close() 시 SIGTERM 후 종료 유예 (DEC-003). 초과 시 SIGKILL. */
const CHILD_GRACE_MS = 5_000;

/** allowlist 자동 허용 판정 — 도구명이 레인 allowlist 에 있으면 true (A2/DEC-002). */
export function shouldAutoAllow(allowlist: string[] | undefined, toolName: string): boolean {
  return allowlist?.includes(toolName) ?? false;
}

/** backend 가 코어에 노출하는 동사 인터페이스 (plan §인터페이스계약). */
export interface AcpBackend {
  caps(): {
    plane: "acp";
    perm_tier: string;
    supports_attachments: boolean;
    acp_version: "v1";
  };
  launch(lane: string): Promise<{ sessionId: string }>;
  inject(lane: string, text: string): Promise<void>;
  subscribe(lane: string, on: (e: SessionEvent) => void): void;
  onPermissionRequest(lane: string, handler: (req: PermRequest) => Promise<PermResponse>): void;
  /** 레인 종료 — 엔진 child 프로세스 정리(SIGTERM→유예→SIGKILL). down/셧다운에서 호출. */
  close(lane: string): Promise<void>;
}

interface LaneConfig {
  paths?: LanePaths;
  addePolicy?: AddePolicy;
  channelWarn?: (msg: string) => void;
  /** 레인별 엔진 작업 폴더(프로젝트 폴더 매핑). 미지정 시 process.cwd(). */
  cwd?: string | undefined;
  /** 권한 정규화 시 채널 표기. 미지정 시 telegram. */
  channel?: "telegram" | "markdown" | undefined;
}

interface LaneState {
  conn: acp.ClientSideConnection;
  sessionId: string;
  /** 엔진 서브프로세스 — close() 정리를 위해 보관(C1/C2). */
  child: ChildProcess;
  subscribers: Array<(e: SessionEvent) => void>;
  permHandler: ((req: PermRequest) => Promise<PermResponse>) | null;
  paths: LanePaths;
  addePolicy: AddePolicy;
  onIdle: (() => void) | null;
}

export class AcpBackendImpl implements AcpBackend {
  private readonly adapterBin: string;
  private readonly lanes = new Map<string, LaneState>();
  private readonly laneConfigs = new Map<string, LaneConfig>();
  private idleCallbacks = new Map<string, () => void>();

  constructor(adapterBin: string) {
    this.adapterBin = adapterBin;
  }

  /**
   * launch 전 레인별 경로·정책 설정.
   * AcpBackend 인터페이스 계약 외부 — 구체 타입(AcpBackendImpl) 사용자만 호출.
   */
  configureLane(lane: string, config: LaneConfig): void {
    this.laneConfigs.set(lane, config);
  }

  caps(): {
    plane: "acp";
    perm_tier: string;
    supports_attachments: boolean;
    acp_version: "v1";
  } {
    return {
      plane: "acp",
      perm_tier: "acp",
      supports_attachments: false,
      acp_version: "v1",
    };
  }

  async launch(lane: string): Promise<{ sessionId: string }> {
    const config = this.laneConfigs.get(lane);
    const paths = config?.paths;
    const addePolicy = config?.addePolicy;
    const channelWarn = config?.channelWarn;
    const laneCwd = config?.cwd && config.cwd.length > 0 ? config.cwd : process.cwd();
    const channel = config?.channel ?? "telegram";

    // paths 가 있으면 엔진 stderr 를 레인 engine.log 로 캡처(없으면 inherit — 테스트/레거시).
    const child = spawnEngine(this.adapterBin, [], paths ? { stderrPath: paths.engineLog } : {});

    // child 'error'(예: 바이너리 ENOENT) 는 미처리 시 프로세스를 크래시시킨다.
    // 핸드셰이크 완료 전에는 launch 실패로 전환하고, 이후에는 로깅한다(상시 리스너 유지).
    let onSpawnError: (err: Error) => void = (err) =>
      console.error(`[acp] lane=${lane} 엔진 프로세스 오류: ${err.message}`);
    const spawnFailed = new Promise<never>((_, reject) => {
      onSpawnError = (err) =>
        reject(
          new Error(
            formatException({
              situation: `엔진 프로세스 spawn 실패 (${this.adapterBin}): ${err.message}`,
              action: "어댑터 바이너리 설치를 확인하세요(pnpm install) 후 adde up 재시도.",
            }),
          ),
        );
    });
    child.on("error", (err: Error) => onSpawnError(err));

    const toAgent = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(toAgent, fromAgent);

    const laneRef: { state: LaneState | null } = { state: null };

    const conn = new acp.ClientSideConnection((_agent) => {
      const clientImpl: acp.Client = {
        async sessionUpdate(params: SessionNotification): Promise<void> {
          const update = params.update as SessionEvent;

          if (laneRef.state) {
            for (const sub of laneRef.state.subscribers) {
              try {
                sub(update);
              } catch (err) {
                // 무음 흡수 금지(H1/DEC-005) — 다른 구독자는 계속하되 실패 신호는 큰소리로 기록.
                console.error(
                  `[acp] lane=${lane} 구독자 오류: ${err instanceof Error ? err.message : String(err)}`,
                );
                if (paths) {
                  await appendTranscript(paths, {
                    sessionUpdate: "adde_warn",
                    message: `구독자 처리 오류: ${err instanceof Error ? err.message : String(err)}`,
                  }).catch((e: unknown) =>
                    console.error(
                      `[acp] lane=${lane} transcript 기록 실패: ${e instanceof Error ? e.message : String(e)}`,
                    ),
                  );
                }
              }
            }

            if (paths) {
              await appendTranscript(paths, update).catch((e: unknown) =>
                console.error(
                  `[acp] lane=${lane} transcript 기록 실패: ${e instanceof Error ? e.message : String(e)}`,
                ),
              );
            }

            const updateKind =
              "sessionUpdate" in update && typeof update["sessionUpdate"] === "string"
                ? update["sessionUpdate"]
                : "";

            if (updateKind === "available_commands_update") {
              // 무크래시 처리 — 로깅만
              console.log(`[acp] lane=${lane} available_commands_update`);
            }

            if (updateKind === "current_mode_update" && laneRef.state && addePolicy) {
              const engineEffective = extractEngineMode(update);
              const result = comparePerm(addePolicy, engineEffective);
              if (result.diff && result.warn) {
                const msg = result.warn.message;
                console.warn(`[acp] ${msg}`);
                if (channelWarn) channelWarn(msg);
                if (paths) {
                  await appendTranscript(paths, {
                    sessionUpdate: "adde_warn",
                    message: msg,
                  }).catch(() => {});
                }
              }
            }
          }
        },

        async requestPermission(
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> {
          const toolName = params.toolCall.title ?? "unknown";

          // A2: allowlist 자동 허용 — 채널 프롬프트 없이 allow 로 결정(게이트는 끄지 않고 결정).
          // 투명성(A-P006 no-silent): 트랜스크립트에 auto-allow 기록.
          if (shouldAutoAllow(addePolicy?.allowlist, toolName)) {
            const allowOption = params.options.find(
              (o) => o.kind === "allow_once" || o.kind === "allow_always",
            );
            if (allowOption) {
              if (paths) {
                await appendTranscript(paths, {
                  sessionUpdate: "adde_auto_allow",
                  message: `auto-allow (allowlist): ${toolName}`,
                }).catch(() => {});
              }
              return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
            }
          }

          if (!laneRef.state?.permHandler) {
            return { outcome: { outcome: "cancelled" } };
          }

          const req: PermRequest = {
            v: 1,
            id: params.sessionId,
            lane,
            channel,
            tool: toolName,
            detail: JSON.stringify(params.toolCall),
            cwd: laneCwd,
            ts: new Date().toISOString(),
          };

          const response = await laneRef.state.permHandler(req);

          if (response.decision === "allow") {
            const allowOption = params.options.find(
              (o) => o.kind === "allow_once" || o.kind === "allow_always",
            );
            if (allowOption) {
              return {
                outcome: { outcome: "selected", optionId: allowOption.optionId },
              };
            }
          }
          return { outcome: { outcome: "cancelled" } };
        },

        async writeTextFile(_params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
          return {};
        },

        async readTextFile(_params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
          return { content: "" };
        },
      };
      return clientImpl;
    }, stream);

    // 핸드셰이크 단계에서 spawn 실패가 나면 즉시 reject (행 방지). 추가로 시한(DEC-002)을 둬
    // 엔진이 응답 없이 멈춰도 영구 hang 하지 않게 한다 — 실패 시 child 를 정리하고 actionable 로 던진다.
    const handshakeTimeoutErr = (phase: string): Error =>
      new Error(
        formatException({
          situation: `엔진 핸드셰이크(${phase}) ${HANDSHAKE_TIMEOUT_MS / 1000}초 내 무응답`,
          action: "엔진 바이너리·헬스를 확인하세요 후 adde up 재시도.",
        }),
      );
    try {
      await withTimeout(
        Promise.race([
          conn.initialize({
            protocolVersion: acp.PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: true, writeTextFile: true },
            },
          }),
          spawnFailed,
        ]),
        HANDSHAKE_TIMEOUT_MS,
        () => handshakeTimeoutErr("initialize"),
      );
    } catch (err) {
      killChild(child);
      throw err;
    }

    let sessionResp: { sessionId: string };
    try {
      sessionResp = await withTimeout(
        Promise.race([
          conn.newSession({
            cwd: laneCwd,
            mcpServers: [],
          }),
          spawnFailed,
        ]),
        HANDSHAKE_TIMEOUT_MS,
        () => handshakeTimeoutErr("newSession"),
      );
    } catch (err) {
      killChild(child);
      throw err;
    }

    // 핸드셰이크 성공 — 이후 child 'error' 는 크래시 대신 로깅(spawnFailed 는 더 이상 소비 안 됨).
    onSpawnError = (err) => console.error(`[acp] lane=${lane} 엔진 프로세스 오류: ${err.message}`);

    const sessionId = sessionResp.sessionId;

    if (paths) {
      await mkdir(dirname(paths.sessionIdFile), { recursive: true });
      await writeFile(paths.sessionIdFile, sessionId, "utf8");
    }

    const state: LaneState = {
      conn,
      sessionId,
      child,
      subscribers: [],
      permHandler: null,
      paths: paths ?? ({} as LanePaths),
      addePolicy: addePolicy ?? { perm_tier: "acp", allowlist: [] },
      onIdle: null,
    };
    laneRef.state = state;
    this.lanes.set(lane, state);

    if (paths && addePolicy) {
      const engineEffective = await this.fetchEngineEffective(lane);
      const result = comparePerm(addePolicy, engineEffective);
      if (result.diff && result.warn) {
        if (result.warn.reason === "정책차이") {
          // H2/DEC-001: 엔진이 정책보다 느슨함이 *확인됨* → fail-closed(launch 거부 + child 정리).
          const note = formatBlock({
            situation: result.warn.message,
            action:
              "엔진 권한 설정에서 bypassPermissions 를 해제하거나 ADDE 정책(perm_tier)에 맞게 정렬 후 재기동하세요.",
          });
          console.error(note);
          if (channelWarn) channelWarn(note);
          await appendTranscript(paths, { sessionUpdate: "adde_warn", message: note }).catch(
            (e: unknown) =>
              console.error(
                `[acp] lane=${lane} transcript 기록 실패: ${e instanceof Error ? e.message : String(e)}`,
              ),
          );
          await this.close(lane);
          throw new Error(note);
        }
        // 조회실패(getMode 미지원 등): 확인 불가 → WARN 유지 + 계속(per-tool 게이트가 여전히 강제).
        const msg = result.warn.message;
        console.warn(`[acp] launch perm-diff(확인불가): ${msg}`);
        if (channelWarn) channelWarn(msg);
        await appendTranscript(paths, {
          sessionUpdate: "adde_warn",
          message: msg,
        }).catch((e: unknown) =>
          console.error(
            `[acp] lane=${lane} transcript 기록 실패: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
    }

    return { sessionId };
  }

  private async fetchEngineEffective(lane: string): Promise<EngineEffective | null> {
    const state = this.lanes.get(lane);
    if (!state) return null;
    try {
      const result = await state.conn.extMethod("session/getMode", {
        sessionId: state.sessionId,
      });
      if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        const effective: EngineEffective = {};
        if (typeof r["permissionMode"] === "string") {
          effective.permissionMode = r["permissionMode"];
        }
        if (typeof r["bypassPermissions"] === "boolean") {
          effective.bypassPermissions = r["bypassPermissions"];
        }
        return effective;
      }
    } catch {
      // GAP-001: 조회 실패 → null (ADR-007 안전망으로 보수 WARN)
    }
    return null;
  }

  async inject(lane: string, text: string): Promise<void> {
    const state = this.lanes.get(lane);
    if (!state) throw new Error(`[acp] lane "${lane}" not launched`);

    const resp = await state.conn.prompt({
      sessionId: state.sessionId,
      prompt: [{ type: "text", text }],
    });

    if (
      resp.stopReason === "end_turn" ||
      resp.stopReason === "max_tokens" ||
      resp.stopReason === "max_turn_requests" ||
      resp.stopReason === "cancelled" ||
      resp.stopReason === "refusal"
    ) {
      const idleCallback = this.idleCallbacks.get(lane);
      if (idleCallback) idleCallback();
    }
  }

  subscribe(lane: string, on: (e: SessionEvent) => void): void {
    const state = this.lanes.get(lane);
    if (!state) {
      throw new Error(`[acp] lane "${lane}" not launched`);
    }
    state.subscribers.push(on);
  }

  onPermissionRequest(lane: string, handler: (req: PermRequest) => Promise<PermResponse>): void {
    const state = this.lanes.get(lane);
    if (!state) throw new Error(`[acp] lane "${lane}" not launched`);
    state.permHandler = handler;
  }

  /** 인젝터 idle 콜백 등록 (inject 완료 시 호출). */
  setIdleCallback(lane: string, cb: () => void): void {
    this.idleCallbacks.set(lane, cb);
  }

  /** 레인 종료 — 엔진 child 정리(SIGTERM→유예→SIGKILL) + 상태 제거(C1/C2/DEC-003). */
  async close(lane: string): Promise<void> {
    const state = this.lanes.get(lane);
    this.lanes.delete(lane);
    this.idleCallbacks.delete(lane);
    if (!state) return;
    await closeChild(state.child, CHILD_GRACE_MS);
  }
}

function extractEngineMode(update: SessionEvent): EngineEffective | null {
  const mode = update["mode"];
  if (!mode || typeof mode !== "object") return null;
  const m = mode as Record<string, unknown>;
  const effective: EngineEffective = {};
  if (typeof m["permissionMode"] === "string") {
    effective.permissionMode = m["permissionMode"];
  }
  if (typeof m["bypassPermissions"] === "boolean") {
    effective.bypassPermissions = m["bypassPermissions"];
  }
  return effective;
}

/** formatWarn re-export — 채널 WARN 포맷 일관성. */
export { formatWarn };
