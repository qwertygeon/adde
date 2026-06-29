/**
 * Telegram 소스 어댑터 — 수신·출력·inline 버튼.
 * FR-014/015/016/017/018: long-poll → envelope → queue.
 * renderOut(id) → sendMessage(quote-reply) (injector in-process 호출).
 * 권한 요청 → inline keyboard [[allow, deny]].
 * 토큰은 state/.env 에서만 읽기(SC-016).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LanePaths } from "../shared/paths.js";
import { enqueue } from "../core/queue.js";
import type { Envelope } from "../shared/envelope.js";
import type { PermRequest } from "../gate/gate.js";
import { formatException } from "../shared/notify.js";
import type { Source, DecisionCallback } from "./source.js";

const TELEGRAM_API = "https://api.telegram.org";
const POLL_TIMEOUT_SECS = 30;
/** stop() 이 pollLoop 종료를 기다리는 상한 (H3/DEC-004). 초과 시 포기하고 진행. */
const STOP_WAIT_MS = 3_000;
/** enqueue 연속 실패가 이 횟수에 도달하면 운영자에게 1회 알림 + 백오프 (DEC-003). */
const ENQUEUE_FAIL_THRESHOLD = 3;
/** enqueue 실패 지속 동안 폴 사이에 적용하는 백오프. */
const ENQUEUE_BACKOFF_MS = 5_000;

/** abort 가능한 sleep — 신호 시 즉시 resolve(정지 응답성 유지). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export interface TelegramConfig {
  lane: string;
  proj: string;
  engine: string;
  paths: LanePaths;
  /** 회신·권한 프롬프트 대상 chat id (conf chat_id). 미지정 시 렌더 비활성. */
  chatId?: number | undefined;
  /** 인바운드 enqueue 직후 호출(injector 깨우기). in-process 신호 — watch 불요(DEC-001). */
  onInbound?: (() => void) | undefined;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    from?: { id: number; username?: string };
  };
  callback_query?: {
    id: string;
    message?: { chat: { id: number }; message_id?: number };
    data?: string;
    from?: { id: number };
  };
}

export type GateDecisionCallback = (requestId: string, decision: "allow" | "deny") => void;

export interface TelegramSource extends Source {
  sendReply(chatId: number, text: string, replyToMsgId?: number): Promise<void>;
  sendPermPrompt(chatId: number, reqId: string, req: PermRequest): Promise<{ messageId: number }>;
  onCallbackQuery(cb: GateDecisionCallback): void;
}

/** 봇 토큰을 state/.env 에서 읽는다. argv 미전달(SC-016). */
async function readBotToken(paths: LanePaths): Promise<string> {
  const content = await readFile(paths.envFile, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("TELEGRAM_BOT_TOKEN=")) {
      return line.slice("TELEGRAM_BOT_TOKEN=".length).trim();
    }
    if (line.startsWith("BOT_TOKEN=")) {
      return line.slice("BOT_TOKEN=".length).trim();
    }
  }
  throw new Error(`[telegram] 봇 토큰을 ${paths.envFile} 에서 찾을 수 없음`);
}

/** Telegram Bot API 호출 helper. */
async function callBotApi(
  token: string,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    ...(signal ? { signal } : {}),
  });

  if (!resp.ok) {
    throw new Error(`[telegram] ${method} 실패: HTTP ${resp.status}`);
  }

  const body = (await resp.json()) as { ok: boolean; result?: unknown };
  if (!body.ok) {
    throw new Error(`[telegram] ${method} 응답 오류: ${JSON.stringify(body)}`);
  }
  return body.result;
}

export function createTelegramSource(cfg: TelegramConfig): TelegramSource {
  let token: string | null = null;
  let offset = 0;
  let running = false;
  // in-flight long-poll fetch 를 stop 에서 중단(H3/DEC-004). pollLoop 종료를 stop 이 대기.
  let pollAbort: AbortController | null = null;
  let pollPromise: Promise<void> | null = null;
  // enqueue 연속 실패 카운터 — 성공 시 0 리셋, 임계 도달 시 1회 알림(DEC-003).
  let consecutiveEnqueueFailures = 0;
  const callbackHandlers: GateDecisionCallback[] = [];

  async function getToken(): Promise<string> {
    if (!token) {
      token = await readBotToken(cfg.paths);
    }
    return token;
  }

  async function sendReply(chatId: number, text: string, replyToMsgId?: number): Promise<void> {
    const tok = await getToken();
    const params: Record<string, unknown> = { chat_id: chatId, text };
    if (replyToMsgId !== undefined) {
      params["reply_to_message_id"] = replyToMsgId;
    }
    await callBotApi(tok, "sendMessage", params);
  }

  async function sendPermPrompt(
    chatId: number,
    reqId: string,
    req: PermRequest,
  ): Promise<{ messageId: number }> {
    const tok = await getToken();
    const result = await callBotApi(tok, "sendMessage", {
      chat_id: chatId,
      text: `권한 요청: ${req.tool}\n${req.detail}`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Allow", callback_data: `allow:${reqId}` },
            { text: "Deny", callback_data: `deny:${reqId}` },
          ],
        ],
      },
    });
    const r = result as { message_id: number };
    return { messageId: r.message_id };
  }

  async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
    const tok = await getToken();
    await callBotApi(tok, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
    });
  }

  function onCallbackQuery(cb: GateDecisionCallback): void {
    callbackHandlers.push(cb);
  }

  /** 메시지 → Envelope 정규화 */
  function normalizeMessage(
    msg: NonNullable<TelegramUpdate["message"]>,
    laneId: string,
    projId: string,
    engine: string,
  ): Envelope {
    return {
      v: 1,
      id: randomUUID(),
      lane: laneId,
      source: "telegram",
      backend: "acp",
      engine,
      project: projId,
      ts: new Date().toISOString(),
      text: msg.text ?? "",
      reply_ref: {
        channel_msg_id: String(msg.message_id),
      },
    };
  }

  /** long-poll 루프 */
  async function pollLoop(): Promise<void> {
    const tok = await getToken();
    while (running) {
      try {
        const result = await callBotApi(
          tok,
          "getUpdates",
          {
            offset,
            timeout: POLL_TIMEOUT_SECS,
            allowed_updates: ["message", "callback_query"],
          },
          pollAbort?.signal,
        );

        const updates = result as TelegramUpdate[];

        for (const update of updates) {
          offset = update.update_id + 1;

          if (update.message?.text) {
            const envelope = normalizeMessage(update.message, cfg.lane, cfg.proj, cfg.engine);
            try {
              await enqueue(cfg.paths, envelope);
              consecutiveEnqueueFailures = 0; // 성공 → 연속 실패 리셋
              cfg.onInbound?.(); // injector 깨우기(in-process)
            } catch (err) {
              consecutiveEnqueueFailures++;
              console.error(
                `[telegram] enqueue 오류(${consecutiveEnqueueFailures}회 연속): ${err instanceof Error ? err.message : String(err)}`,
              );
              // 임계 도달 시점에만 1회 알림 — 매 폴 알림 폭주 방지(DEC-003).
              if (consecutiveEnqueueFailures === ENQUEUE_FAIL_THRESHOLD) {
                await alertEnqueueFailure(consecutiveEnqueueFailures);
              }
            }
          }

          if (update.callback_query) {
            const cq = update.callback_query;
            const data = cq.data ?? "";
            const colonIdx = data.indexOf(":");
            if (colonIdx !== -1) {
              const decision = data.slice(0, colonIdx) as "allow" | "deny";
              const reqId = data.slice(colonIdx + 1);

              await answerCallbackQuery(cq.id).catch((err) => {
                console.error(
                  `[telegram] answerCallbackQuery 오류: ${err instanceof Error ? err.message : String(err)}`,
                );
              });

              for (const handler of callbackHandlers) {
                handler(reqId, decision);
              }
            }
          }
        }

        // enqueue 가 연속 실패 중이면 다음 폴 전 백오프(자원 낭비·로그 폭주 완화). 정지 신호에 즉시 중단.
        if (running && consecutiveEnqueueFailures >= ENQUEUE_FAIL_THRESHOLD) {
          await sleep(ENQUEUE_BACKOFF_MS, pollAbort?.signal);
        }
      } catch (err) {
        if (!running) break;
        console.error(
          `[telegram] poll 오류(재시도): ${err instanceof Error ? err.message : String(err)}`,
        );
        await sleep(2_000, pollAbort?.signal);
      }
    }
  }

  /** enqueue 연속 실패 임계 도달 시 운영자 채널로 1회 액션형 알림(DEC-003). */
  async function alertEnqueueFailure(count: number): Promise<void> {
    if (cfg.chatId === undefined) return; // 알림 대상 미지정 — 로그로만 남음
    const note = formatException({
      situation: `수신 메시지 큐 적재(enqueue)가 연속 ${count}회 실패했습니다`,
      action:
        "서버 디스크 용량과 state 디렉터리 권한을 확인하세요. 해소되기 전까지 수신 메시지가 처리되지 않을 수 있습니다.",
    });
    await sendReply(cfg.chatId, note).catch((e: unknown) =>
      console.error(
        `[telegram] enqueue 실패 알림 전송 오류: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }

  /** out/<id>.out (+ sidecar) → quote-reply 전송. injector 가 writeOut 직후 in-process 호출(DEC-001). */
  async function renderOut(id: string): Promise<void> {
    const defaultChatId = cfg.chatId ?? 0;
    if (!defaultChatId) return; // 회신 대상 미지정 시 렌더 생략

    const outPath = join(cfg.paths.outDir, `${id}.out`);
    const sidecarPath = join(cfg.paths.outDir, `${id}.out.json`);

    let replyTo: number | undefined;
    try {
      const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as {
        reply_ref?: { channel_msg_id: string };
      };
      if (sidecar.reply_ref?.channel_msg_id) {
        replyTo = parseInt(sidecar.reply_ref.channel_msg_id, 10);
      }
    } catch {
      // sidecar 없으면 reply_to 없이 전송
    }

    const text = await readFile(outPath, "utf8");
    await sendReply(defaultChatId, text, replyTo);
  }

  function start(): void {
    running = true;
    pollAbort = new AbortController();
    // fire-and-forget 루프 — rejection 이 unhandled 가 되지 않도록 로깅(토큰 읽기 실패 등).
    // pollPromise 를 보관해 stop() 이 종료를 대기(H3).
    pollPromise = pollLoop().catch((err: unknown) => {
      console.error(
        `[telegram] poll 루프 종료: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    // out 렌더는 injector 가 renderOut() 으로 in-process 호출(out/ watch 제거, DEC-001).
  }

  /** Source 계약: 권한 요청을 inline 버튼으로 표면화(chat_id 는 conf self-resolve). */
  async function requestPermission(req: PermRequest): Promise<void> {
    await sendPermPrompt(cfg.chatId ?? 0, req.id, req);
  }

  /** Source 계약: 결정 콜백 등록(= onCallbackQuery). */
  function onDecision(cb: DecisionCallback): void {
    onCallbackQuery(cb);
  }

  async function stop(): Promise<void> {
    running = false;
    pollAbort?.abort(); // in-flight long-poll fetch 중단
    const pending = pollPromise;
    if (pending) {
      // pollLoop settle 을 유계 대기 — 멈춘 fetch 가 종료를 막지 않게 상한을 둔다.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, STOP_WAIT_MS);
        void pending.finally(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    pollPromise = null;
    pollAbort = null;
  }

  return {
    start,
    stop,
    renderOut,
    sendReply,
    sendPermPrompt,
    onCallbackQuery,
    requestPermission,
    onDecision,
  };
}
