/**
 * ACP 세션 라이프사이클·구독.
 * FR-008/009/010/011/019/ADR-002: initialize→session/new→prompt 루프.
 * session/update 이벤트 구독 → transcript·injector·gate 라우팅.
 */
import { t, tFor } from "../../shared/i18n.js";
import { errMsg } from "../../shared/errors.js";
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
import { maskSecrets } from "../../shared/mask.js";
import { comparePerm, formatWarn } from "./perm-diff.js";
import { formatException, formatWarnNote } from "../../shared/notify.js";
import { matchesDenylist } from "../../shared/deny-match.js";
import { withTimeout, killChild, closeChild } from "./lifecycle.js";

/** 핸드셰이크(initialize·newSession) 최대 대기 (DEC-002). 초과 시 launch 실패 + child kill. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
/** close() 시 SIGTERM 후 종료 유예 (DEC-003). 초과 시 SIGKILL. */
const CHILD_GRACE_MS = 5_000;

/** allowlist 자동 허용 판정 — 도구명이 레인 allowlist 에 있으면 true (A2/DEC-002). */
export function shouldAutoAllow(allowlist: string[] | undefined, toolName: string): boolean {
  return allowlist?.includes(toolName) ?? false;
}

/**
 * autopass 자동 허용 판정 — perm_tier=autopass 이고 denylist 에 걸리지 않으면 true.
 * denylist 는 `Tool`(전체)·`Tool(glob)`(대표 인자 패턴) 을 지원하며,
 * 매칭 도구는 false → 기존 채널 승인 게이트(fail-closed)로 폴백한다.
 */
export function shouldAutopass(
  policy: AddePolicy | undefined,
  toolName: string,
  rawInput?: unknown,
): boolean {
  if (policy?.perm_tier !== "autopass") return false;
  return !matchesDenylist(policy.denylist, toolName, rawInput);
}

/** toolCallId→원시 도구명 맵 상한 — 초과 시 가장 오래된 항목부터 제거(장수 세션 메모리 상한). */
const TOOL_NAME_MAP_MAX = 512;

/**
 * tool_call 세션 업데이트에서 원시 도구명을 기록한다.
 * requestPermission 의 toolCall.title 은 인자 포함 표시 문자열(예: Bash → "`rm -rf build/`")이라
 * allowlist/denylist 매칭 키로 쓸 수 없다 — claude-code-acp 는 원시 도구명을
 * tool_call 업데이트의 _meta.claudeCode.toolName 으로만 노출한다.
 */
export function recordToolName(map: Map<string, string>, update: SessionEvent): void {
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

/** 권한 요청의 원시 도구명 해석 — 맵 우선, 요청 자체의 _meta 폴백. 미해석 시 undefined. */
export function resolveToolName(
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

/**
 * 자동 허용 판정 통합 — 반환 "allowlist" | "autopass" | null(채널 승인 경로).
 * fail-closed: 도구명 미해석(undefined) 시 자동 허용하지 않는다(채널 승인 폴백).
 * autopass 의 denylist 는 allowlist 보다 우선한다 — 매칭되면 채널 승인.
 */
export function decideAutoAllow(
  policy: AddePolicy | undefined,
  toolName: string | undefined,
  rawInput?: unknown,
): "allowlist" | "autopass" | null {
  if (toolName === undefined) return null;
  if (policy?.perm_tier === "autopass" && matchesDenylist(policy.denylist, toolName, rawInput)) {
    return null;
  }
  if (shouldAutoAllow(policy?.allowlist, toolName)) return "allowlist";
  if (shouldAutopass(policy, toolName, rawInput)) return "autopass";
  return null;
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
  /** 채널 메시지 로케일(LaneConf.lang). 미지정 시 전역 로케일. */
  lang?: string | undefined;
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
    const tl = tFor(config?.lang);
    const laneCwd = config?.cwd && config.cwd.length > 0 ? config.cwd : process.cwd();
    const channel = config?.channel ?? "telegram";

    // paths 가 있으면 엔진 stderr 를 레인 engine.log 로 캡처(없으면 inherit — 테스트/레거시).
    const child = spawnEngine(this.adapterBin, [], paths ? { stderrPath: paths.engineLog } : {});

    // child 'error'(예: 바이너리 ENOENT) 는 미처리 시 프로세스를 크래시시킨다.
    // 핸드셰이크 완료 전에는 launch 실패로 전환하고, 이후에는 로깅한다(상시 리스너 유지).
    let onSpawnError: (err: Error) => void = (err) =>
      console.error(t("log.acp.engineProcessError", { lane, error: err.message }));
    const spawnFailed = new Promise<never>((_, reject) => {
      onSpawnError = (err) =>
        reject(
          new Error(
            formatException(
              {
                situation: t("acp.spawnFail.situation", {
                  bin: this.adapterBin,
                  error: err.message,
                }),
                action: t("acp.spawnFail.action"),
              },
              tl,
            ),
          ),
        );
    });
    child.on("error", (err: Error) => onSpawnError(err));

    const toAgent = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(toAgent, fromAgent);

    const laneRef: { state: LaneState | null } = { state: null };
    // toolCallId→원시 도구명 — tool_call 업데이트에서 채집, 권한 매칭에 사용.
    const toolNames = new Map<string, string>();

    const conn = new acp.ClientSideConnection((_agent) => {
      const clientImpl: acp.Client = {
        async sessionUpdate(params: SessionNotification): Promise<void> {
          const update = params.update as SessionEvent;
          recordToolName(toolNames, update);

          if (laneRef.state) {
            for (const sub of laneRef.state.subscribers) {
              try {
                sub(update);
              } catch (err) {
                // 무음 흡수 금지(H1/DEC-005) — 다른 구독자는 계속하되 실패 신호는 큰소리로 기록.
                console.error(
                  t("log.acp.subscriberError", {
                    lane,
                    error: errMsg(err),
                  }),
                );
                if (paths) {
                  await appendTranscript(paths, {
                    sessionUpdate: "adde_warn",
                    message: t("acp.subscriberError", {
                      error: errMsg(err),
                    }),
                  }).catch((e: unknown) =>
                    console.error(
                      t("log.acp.transcriptWriteFail", {
                        lane,
                        error: errMsg(e),
                      }),
                    ),
                  );
                }
              }
            }

            if (paths) {
              await appendTranscript(paths, update).catch((e: unknown) =>
                console.error(
                  t("log.acp.transcriptWriteFail", {
                    lane,
                    error: errMsg(e),
                  }),
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
              const result = comparePerm(addePolicy, engineEffective, tl);
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
          // 표시용 제목(인자 포함) — 채널 프롬프트에 노출. 매칭 키가 아니다(인자 포함 문자열이라 도구명과 불일치).
          const toolTitle = params.toolCall.title ?? "unknown";
          // 매칭용 원시 도구명 — tool_call 업데이트 채집 맵에서 해석. 미해석 시 자동 허용 안 함(fail-closed).
          const rawToolName = resolveToolName(
            toolNames,
            params.toolCall as unknown as Record<string, unknown>,
          );

          // A2: allowlist / autopass 자동 허용 — 채널 프롬프트 없이 allow 로 결정(게이트는 끄지 않고 결정).
          // autopass: denylist 외 전 도구 자동 허용, denylist 도구는 아래 채널 승인 폴백.
          // 투명성(A-P006 no-silent): 트랜스크립트에 auto-allow 기록.
          const rawInput = (params.toolCall as unknown as Record<string, unknown>)["rawInput"];
          const autoAllowVia = decideAutoAllow(addePolicy, rawToolName, rawInput);
          if (autoAllowVia) {
            const allowOption = params.options.find(
              (o) => o.kind === "allow_once" || o.kind === "allow_always",
            );
            if (allowOption) {
              if (paths) {
                await appendTranscript(paths, {
                  sessionUpdate: "adde_auto_allow",
                  message: `auto-allow (${autoAllowVia}): ${rawToolName} — ${toolTitle}`,
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
            // 채널 표시: "도구명 · 제목" — 제목(인자 포함)은 사용자 판단 근거, 도구명은 식별자.
            // 제목은 도구 인자를 포함하므로 detail 과 동일하게 마스킹한다.
            tool: maskSecrets(rawToolName ? `${rawToolName} · ${toolTitle}` : toolTitle),
            // 시크릿 마스킹(⑦) — detail 은 채널(telegram 메시지·markdown 승인 노트)에 평문 표면화된다.
            detail: maskSecrets(JSON.stringify(params.toolCall)),
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
        formatException(
          {
            situation: t("acp.handshakeTimeout.situation", {
              phase,
              seconds: HANDSHAKE_TIMEOUT_MS / 1000,
            }),
            action: t("acp.handshakeTimeout.action"),
          },
          tl,
        ),
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
    onSpawnError = (err) =>
      console.error(t("log.acp.engineProcessError", { lane, error: err.message }));

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
      const result = comparePerm(addePolicy, engineEffective, tl);
      if (result.diff && result.warn) {
        // 차이 확인(정책차이)·확인불가(조회실패) 모두 경고 후 기동 계속 — 이전의 launch 거부를
        // 사용자 요청으로 완화. A-P006 의 요구는 "차이 표기"이며 여기서 충족한다.
        const note =
          result.warn.reason === "정책차이"
            ? formatWarnNote(
                {
                  situation: result.warn.message,
                  action: tl("acp.bypassAction"),
                },
                tl,
              )
            : result.warn.message;
        console.warn(t("log.acp.permDiff", { note }));
        if (channelWarn) channelWarn(note);
        await appendTranscript(paths, {
          sessionUpdate: "adde_warn",
          message: note,
        }).catch((e: unknown) =>
          console.error(
            t("log.acp.transcriptWriteFail", {
              lane,
              error: errMsg(e),
            }),
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

    // prompt 는 turn 종료에 resolve 한다 — injector 는 inject() resolve 로 turn 종료를 감지해 다음 큐를
    // 진행하므로(injector.ts) 별도 idle 콜백 배선은 불필요. stopReason 분기 없이 완료만 대기한다.
    await state.conn.prompt({
      sessionId: state.sessionId,
      prompt: [{ type: "text", text }],
    });
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

  /** 레인 종료 — 엔진 child 정리(SIGTERM→유예→SIGKILL) + 상태 제거(C1/C2/DEC-003). */
  async close(lane: string): Promise<void> {
    const state = this.lanes.get(lane);
    this.lanes.delete(lane);
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
