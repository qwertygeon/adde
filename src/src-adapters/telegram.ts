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
/** Telegram sendMessage 텍스트 한도(UTF-16 코드유닛). 초과 시 분할 전송(A). */
const TELEGRAM_MSG_LIMIT = 4096;

/**
 * 텍스트를 Telegram 한도 이하 청크로 분할. 줄 경계를 우선하되, 한 줄이 한도를 넘으면 하드 분할.
 * 빈 문자열은 빈 청크 1개([""]) — 호출부의 기존 동작 보존(분할 자체는 의미 변경 없음).
 */
export function splitForTelegram(text: string, max = TELEGRAM_MSG_LIMIT): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const nl = rest.lastIndexOf("\n", max);
    const cut = nl > 0 ? nl : max; // 한도 내 개행이 없으면 하드 분할
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, ""); // 분할점의 개행 1개 제거
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
/** stop() 이 pollLoop 종료를 기다리는 상한 (H3/DEC-004). 초과 시 포기하고 진행. */
const STOP_WAIT_MS = 3_000;
/** enqueue 연속 실패가 이 횟수에 도달하면 운영자에게 1회 알림 + 백오프 (DEC-003). */
const ENQUEUE_FAIL_THRESHOLD = 3;
/** enqueue 실패 지속 동안 폴 사이에 적용하는 백오프. */
const ENQUEUE_BACKOFF_MS = 5_000;
/** 429 레이트리밋 최대 재시도 횟수(012-P). */
const MAX_RATE_LIMIT_RETRIES = 3;
/** retry_after 대기 상한(012-P) — 비정상적으로 큰 값으로 영구 hang 방지. */
const RETRY_AFTER_CAP_MS = 60_000;
/** 폴 오류 지수 백오프 base·상한(012-Q). */
const POLL_BACKOFF_BASE_MS = 1_000;
const POLL_BACKOFF_MAX_MS = 30_000;

/** 폴 오류 지수 백오프 간격(012-Q): min(base·2^(n-1), max). n=연속 실패 횟수(1부터). */
export function pollBackoffMs(failures: number): number {
  return Math.min(POLL_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), POLL_BACKOFF_MAX_MS);
}

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

  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      ...(signal ? { signal } : {}),
    });

    // 레이트 리밋(429): retry_after 만큼 대기 후 재시도(012-P). 유계 재시도·대기 상한.
    if (resp.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const body = (await resp.json().catch(() => ({}))) as {
        parameters?: { retry_after?: number };
      };
      const headerRetry = Number(resp.headers.get("retry-after"));
      const retryAfterSec = body.parameters?.retry_after ?? (headerRetry || 1);
      const waitMs = Math.min(Math.max(0, retryAfterSec) * 1000, RETRY_AFTER_CAP_MS);
      console.warn(`[telegram] ${method} 429 레이트리밋 — ${waitMs}ms 후 재시도(${attempt + 1})`);
      await sleep(waitMs, signal);
      continue;
    }

    if (!resp.ok) {
      throw new Error(`[telegram] ${method} 실패: HTTP ${resp.status}`);
    }

    const body = (await resp.json()) as { ok: boolean; result?: unknown };
    if (!body.ok) {
      throw new Error(`[telegram] ${method} 응답 오류: ${JSON.stringify(body)}`);
    }
    return body.result;
  }
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
    // 4096자 초과 시 분할 순차 전송(A) — 첫 청크만 원본에 quote-reply, 순서 보존.
    const chunks = splitForTelegram(text);
    for (let i = 0; i < chunks.length; i++) {
      const params: Record<string, unknown> = { chat_id: chatId, text: chunks[i] };
      if (i === 0 && replyToMsgId !== undefined) {
        params["reply_to_message_id"] = replyToMsgId;
      }
      await callBotApi(tok, "sendMessage", params);
    }
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
    let pollFailures = 0; // 폴 오류 지수 백오프 카운터(012-Q) — getUpdates 성공 시 리셋.
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

        pollFailures = 0; // getUpdates 성공 → 백오프 리셋
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
              const rawDecision = data.slice(0, colonIdx);
              const reqId = data.slice(colonIdx + 1);

              await answerCallbackQuery(cq.id).catch((err) => {
                console.error(
                  `[telegram] answerCallbackQuery 오류: ${err instanceof Error ? err.message : String(err)}`,
                );
              });

              // callback_data 검증(FR-5) — allow/deny 외 값은 무시·로그(타입 어설션 우회 차단).
              // 미디스패치 시 게이트는 타임아웃으로 deny(fail-closed).
              if (rawDecision !== "allow" && rawDecision !== "deny") {
                console.warn(`[telegram] 알 수 없는 callback decision 무시: ${rawDecision}`);
              } else {
                for (const handler of callbackHandlers) {
                  handler(reqId, rawDecision);
                }
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
        pollFailures++;
        // 지수 백오프(012-Q): 연속 실패가 누적될수록 재시도 간격 증가(상한 고정). 성공 시 리셋.
        const backoff = pollBackoffMs(pollFailures);
        console.error(
          `[telegram] poll 오류(${pollFailures}회 연속, ${backoff}ms 후 재시도): ${err instanceof Error ? err.message : String(err)}`,
        );
        await sleep(backoff, pollAbort?.signal);
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
        // 비숫자 channel_msg_id 가드(FR-6) — NaN 이면 reply_to_message_id 생략(전송 파라미터 오염 방지).
        const parsed = parseInt(sidecar.reply_ref.channel_msg_id, 10);
        if (!Number.isNaN(parsed)) replyTo = parsed;
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
