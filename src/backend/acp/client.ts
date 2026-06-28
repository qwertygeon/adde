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
import { spawnEngine } from "./spawn.js";
import type { LanePaths } from "../../shared/paths.js";
import { appendTranscript } from "../../core/transcript.js";
import type { SessionEvent } from "../../core/transcript.js";
import type { PermRequest, PermResponse } from "../../gate/gate.js";
import type { AddePolicy, EngineEffective } from "./perm-diff.js";
import { comparePerm, formatWarn } from "./perm-diff.js";

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
}

interface LaneConfig {
  paths?: LanePaths;
  addePolicy?: AddePolicy;
  channelWarn?: (msg: string) => void;
  /** 레인별 엔진 작업 폴더(프로젝트 폴더 매핑). 미지정 시 process.cwd(). */
  cwd?: string | undefined;
  /** 권한 정규화 시 채널 표기. 미지정 시 telegram. */
  channel?: "telegram" | "obsidian" | undefined;
}

interface LaneState {
  conn: acp.ClientSideConnection;
  sessionId: string;
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

    const child = spawnEngine(this.adapterBin, []);

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
              } catch {
                // 구독자 오류는 보조 — 다른 구독자 진행 유지
              }
            }

            if (paths) {
              await appendTranscript(paths, update).catch(() => {});
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
          if (!laneRef.state?.permHandler) {
            return { outcome: { outcome: "cancelled" } };
          }

          const req: PermRequest = {
            v: 1,
            id: params.sessionId,
            lane,
            channel,
            tool: params.toolCall.title ?? "unknown",
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

    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });

    const sessionResp = await conn.newSession({
      cwd: laneCwd,
      mcpServers: [],
    });

    const sessionId = sessionResp.sessionId;

    if (paths) {
      await mkdir(dirname(paths.sessionIdFile), { recursive: true });
      await writeFile(paths.sessionIdFile, sessionId, "utf8");
    }

    const state: LaneState = {
      conn,
      sessionId,
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
        const msg = result.warn.message;
        console.warn(`[acp] launch perm-diff: ${msg}`);
        if (channelWarn) channelWarn(msg);
        await appendTranscript(paths, {
          sessionUpdate: "adde_warn",
          message: msg,
        }).catch(() => {});
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
