/**
 * Telegram 소스 어댑터 — 수신·출력·inline 버튼.
 * long-poll → envelope → queue.
 * renderOut(id) → sendMessage(quote-reply) (injector in-process 호출).
 * 권한 요청 → inline keyboard [[allow, deny]].
 * 토큰은 state/.env 에서만 읽기.
 */
import { t, tFor } from "../shared/i18n.js";
import { errMsg } from "../shared/errors.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { LanePaths } from "../shared/paths.js";
import { enqueue } from "../core/queue.js";
import { readSidecar } from "../core/out-ledger.js";
import type { RenderHint } from "../core/out-ledger.js";
import type { Envelope, ControlRequest } from "../shared/envelope.js";
import { readLedger, resolveResumeControl } from "../core/session-ledger.js";
import type { PermRequest } from "../gate/gate.js";
import { DEFAULT_GATE_TIMEOUT_MS } from "../gate/gate.js";
import { formatStamp } from "./markdown.js";
import { formatException } from "../shared/notify.js";
import type {
  Source,
  DecisionCallback,
  SourceContext,
  SourceDescriptor,
  SourceValidateInput,
  SourceValidateResult,
  SourceDoctorInput,
  WizardCtx,
} from "./source.js";
import { ENQUEUE_FAIL_THRESHOLD } from "./source.js";
import type { LaneConf } from "../shared/conf.js";
import type { LaneAddOptions, LaneAddResult } from "../core/lane-config.js";
import type { DoctorCheck } from "../core/diagnostics.js";

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
/** stop() 이 pollLoop 종료를 기다리는 상한. 초과 시 포기하고 진행. */
const STOP_WAIT_MS = 3_000;
/** enqueue 실패 지속 동안 폴 사이에 적용하는 백오프. */
const ENQUEUE_BACKOFF_MS = 5_000;
/** 429 레이트리밋 최대 재시도 횟수. */
const MAX_RATE_LIMIT_RETRIES = 3;
/** retry_after 대기 상한 — 비정상적으로 큰 값으로 영구 hang 방지. */
const RETRY_AFTER_CAP_MS = 60_000;
/** 폴 오류 지수 백오프 base·상한. */
const POLL_BACKOFF_BASE_MS = 1_000;
const POLL_BACKOFF_MAX_MS = 30_000;
/**
 * 기동 시 getMe 연결 확인 probe 의 상한(ms) — 무한 대기 회피. 고정 상수(CLI/conf 미노출).
 * 10초 초과 시 abort 하여 기동 실패로 간주한다.
 */
const TELEGRAM_STARTUP_PROBE_TIMEOUT_MS = 10_000;

/** 폴 오류 지수 백오프 간격: min(base·2^(n-1), max). n=연속 실패 횟수(1부터). */
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
  /**
   * 인바운드·권한 콜백을 허용할 발신자 id 집합(chat_id ∪ allow_from). 비면 fail-closed(전부 무시).
   * message 는 chat.id 또는 from.id 가, callback 은 from.id 또는 chat.id 가 이 집합에 있어야 처리한다.
   */
  authorizedIds?: readonly number[] | undefined;
  /** 인바운드 enqueue 직후 호출(injector 깨우기). in-process 신호 — watch 불요. */
  onInbound?: (() => void) | undefined;
  /** 채널 메시지 로케일(LaneConf.lang). 미지정 시 전역 로케일. */
  lang?: string | undefined;
  /** 게이트 타임아웃(ms) — 승인 프롬프트에 자동거부 기한을 표기하기 위해 전달. 미지정 시 기본값. */
  gateTimeoutMs?: number | undefined;
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

/** 봇 토큰을 state/.env 에서 읽는다. argv 미전달. */
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

    // 레이트 리밋(429): retry_after 만큼 대기 후 재시도. 유계 재시도·대기 상한.
    if (resp.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const body = (await resp.json().catch(() => ({}))) as {
        parameters?: { retry_after?: number };
      };
      const headerRetry = Number(resp.headers.get("retry-after"));
      const retryAfterSec = body.parameters?.retry_after ?? (headerRetry || 1);
      const waitMs = Math.min(Math.max(0, retryAfterSec) * 1000, RETRY_AFTER_CAP_MS);
      console.warn(t("log.telegram.rateLimit", { method, waitMs, attempt: attempt + 1 }));
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

/**
 * 발신자 인증 판정(순수) — 후보 id 중 하나라도 허용 집합에 있으면 true.
 * 허용 집합이 비면 항상 false(fail-closed — 미설정 시 전 인바운드 거부).
 * message 후보=[chat.id, from.id], callback 후보=[from.id, chat.id].
 */
export function isAuthorizedSender(
  authorized: ReadonlySet<number>,
  candidates: readonly (number | undefined)[],
): boolean {
  if (authorized.size === 0) return false;
  return candidates.some((id) => id !== undefined && authorized.has(id));
}

/**
 * chatId 를 자기 인증 앵커로 병합할지 결정 — 개인 chat(양수 id = 그 사용자)만 반환, 그룹/채널(음수)은
 * undefined(회신 대상일 뿐 멤버 인증 아님). Telegram 규약: 개인 chat id 는 양수, 그룹은 음수.
 * 그룹 chat.id 를 인증 집합에 넣으면 멤버 누구나 통과해 allow_from 멤버 제한이 무력화되므로 제외한다.
 */
export function selfAuthorizedChatId(chatId: number | undefined): number | undefined {
  return chatId !== undefined && chatId > 0 ? chatId : undefined;
}

/**
 * conf 에서 telegram 회신 대상·인증셋을 조립(순수) — supervisor 인라인에서 어댑터로 이관.
 * chatId = 파싱 가능한 chat_id. authorizedIds = allow_from ∪ (개인 chat 인 chatId).
 * 비면 fail-closed(어댑터가 전 인바운드/콜백 거부). allow_from 파싱 = 트림·빈값 제거·NaN 제외.
 */
export function resolveTelegramAuth(conf: LaneConf): {
  chatId: number | undefined;
  authorizedIds: number[];
} {
  const chatIdRaw = conf.telegram?.chat_id;
  const chatId = chatIdRaw && !Number.isNaN(Number(chatIdRaw)) ? Number(chatIdRaw) : undefined;
  const authorizedIds: number[] = [];
  const selfAuth = selfAuthorizedChatId(chatId);
  if (selfAuth !== undefined) authorizedIds.push(selfAuth);
  const allowFrom = conf.telegram?.allow_from;
  const rawList = allowFrom
    ? allowFrom
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  for (const raw of rawList) {
    const n = Number(raw);
    if (!Number.isNaN(n)) authorizedIds.push(n);
  }
  return { chatId, authorizedIds };
}

/** 레지스트리용 어댑터 — SourceContext 에서 telegram 설정·인증셋을 self-resolve 해 생성. */
export function createTelegramSourceFromContext(ctx: SourceContext): Source {
  const { chatId, authorizedIds } = resolveTelegramAuth(ctx.conf);
  return createTelegramSource({
    lane: ctx.lane,
    proj: ctx.proj,
    engine: ctx.engine,
    paths: ctx.paths,
    chatId,
    authorizedIds,
    onInbound: ctx.onInbound,
    lang: ctx.conf.lang,
    gateTimeoutMs:
      ctx.conf.gate_timeout_sec !== undefined
        ? ctx.conf.gate_timeout_sec * 1000
        : DEFAULT_GATE_TIMEOUT_MS,
  });
}

// --- 소스 정의(descriptor) 훅 — validate/doctorChecks/wizard -----------------

/** telegram chat_id — 그룹은 음수일 수 있음. */
const CHAT_ID_RE = /^-?\d+$/;
/** allow_from 항목 — telegram user/chat id(그룹은 음수). */
const ALLOW_FROM_RE = /^-?\d+$/;
/** 봇 토큰 대략 형식: <숫자id>:<영숫자/_-> (형식 오타 조기 발견용 휴리스틱). */
const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;

/**
 * telegram conf 검증 — chat_id/allow_from 형식(하드)·토큰 형식·무인증 앵커(경고).
 * 교차-소스 옵션 가드(token/allow_from 는 telegram 전용)는 소스 무관 공통 지식이라 lane-config.ts
 * 본문에 유지한다(descriptor 로 분산하면 "옵션은 이 소스 전용" 지식이 흩어져 중앙화 취지가 역행).
 */
function validateTelegramConf(input: SourceValidateInput): SourceValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const chatId = input.opts.chat_id;
  if (chatId !== undefined && chatId !== "" && !CHAT_ID_RE.test(chatId)) {
    errors.push(t("laneConfig.err.badChatId", { chatId }));
  }
  const allowFrom = input.opts.allow_from;
  if (allowFrom !== undefined && allowFrom !== "") {
    for (const id of allowFrom
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      if (!ALLOW_FROM_RE.test(id)) {
        errors.push(t("laneConfig.err.badAllowFrom", { id }));
        break; // 원 동작: 첫 위반에서 즉시 실패
      }
    }
  }

  if (input.token !== undefined && !TELEGRAM_TOKEN_RE.test(input.token)) {
    warnings.push(t("laneConfig.warn.tokenFormat"));
  }
  // 인바운드 인증 앵커 부재 → 기동 시 전 인바운드 fail-closed 무시. 생성 시점에 미리 안내.
  const tg = input.conf.telegram;
  const chatIdNum = tg?.chat_id ? Number(tg.chat_id) : NaN;
  const hasSelfAuth = Number.isFinite(chatIdNum) && chatIdNum > 0;
  if (!hasSelfAuth && !tg?.allow_from) {
    warnings.push(t("laneConfig.warn.telegramNoAuth"));
  }

  return { errors, warnings };
}

/** telegram doctor 진단 — 토큰 존재 여부(.env). */
async function telegramDoctorChecks(input: SourceDoctorInput): Promise<DoctorCheck[]> {
  let hasToken = false;
  try {
    hasToken = (await readFile(input.paths.envFile, "utf8")).includes("TELEGRAM_BOT_TOKEN=");
  } catch {
    // env 파일 부재/읽기 실패 = 토큰 없음(초기값 유지)
  }
  return [
    hasToken
      ? {
          name: t("doctor.token.name", { lane: input.lane }),
          level: "PASS",
          detail: t("doctor.token.present"),
        }
      : {
          name: t("doctor.token.name", { lane: input.lane }),
          level: "FAIL",
          detail: t("doctor.token.missing", { path: input.paths.envFile }),
          hint: t("doctor.token.hint", { path: input.paths.envFile }),
        },
  ];
}

/** telegram 위저드 필드 수집 — chat_id/allow_from(재질의) + 봇 토큰(가려진 입력). */
async function collectTelegramWizardFields(ctx: WizardCtx): Promise<Partial<LaneAddOptions>> {
  const fields: Partial<LaneAddOptions> = {};
  const isNumericId = (v: string): boolean => /^-?\d+$/.test(v);
  const isIdCsv = (v: string): boolean => {
    const ids = v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return ids.length > 0 && ids.every(isNumericId);
  };

  let chatId = await ctx.ask(t("lane.prompt.chatId"), "");
  while (chatId !== "" && !isNumericId(chatId)) chatId = await ctx.ask(t("lane.retry.chatId"), "");
  if (chatId) fields.chat_id = chatId;

  let allowFrom = await ctx.ask(t("lane.prompt.allowFrom"), "");
  while (allowFrom !== "" && !isIdCsv(allowFrom)) {
    allowFrom = await ctx.ask(t("lane.retry.allowFrom"), "");
  }
  if (allowFrom) fields.allow_from = allowFrom;

  // 봇 토큰 — 가려진 입력. 빈 입력이면 생성 후 안내로 위임(시크릿 비노출).
  if (ctx.askSecret) {
    const token = await ctx.askSecret(t("lane.prompt.token"));
    if (token) fields.token = token;
  }

  return fields;
}

/** 생성 후 힌트 — token 을 .env 에 즉시 쓰지 않은 경우 다음 조치 안내. */
function telegramPostCreateHint(result: LaneAddResult): string | undefined {
  return t("lane.tokenNext", {
    envPath: result.confPath.replace(/lanes\.d\/.*$/, `state/${result.lane}/.env`),
  });
}

/** telegram 소스 정의 — SOURCE_REGISTRY 가 등록한다(index.ts). */
export const telegramDescriptor: SourceDescriptor = {
  factory: createTelegramSourceFromContext,
  validate: validateTelegramConf,
  doctorChecks: telegramDoctorChecks,
  wizard: {
    collect: collectTelegramWizardFields,
    postCreateHint: telegramPostCreateHint,
  },
};

export function createTelegramSource(cfg: TelegramConfig): TelegramSource {
  const tl = tFor(cfg.lang);
  let token: string | null = null;
  let offset = 0;
  let running = false;
  // in-flight long-poll fetch 를 stop 에서 중단. pollLoop 종료를 stop 이 대기.
  let pollAbort: AbortController | null = null;
  let pollPromise: Promise<void> | null = null;
  // enqueue 연속 실패 카운터 — 성공 시 0 리셋, 임계 도달 시 1회 알림.
  let consecutiveEnqueueFailures = 0;
  const callbackHandlers: GateDecisionCallback[] = [];
  const gateTimeoutMs = cfg.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  // reqId → 승인 프롬프트 메시지(결정 시 버튼 제거·결정 표기 편집용). 결정·정리 시 삭제.
  const permMessages = new Map<string, { chatId: number; messageId: number; text: string }>();

  // 인바운드/콜백 인증 — 허용 발신자 집합(chat_id ∪ allow_from). 비면 fail-closed.
  // chatId 는 양수(개인 chat = 그 사용자 id)일 때만 자기 인증에 포함(방어적 병합).
  // 음수 chatId(그룹/채널)는 회신 대상일 뿐 인증 앵커가 아니다 — 그룹 멤버는 allow_from 으로만
  // 인증한다(그룹 chat.id 로 blanket 허용하면 멤버 제한이 무력화됨. Telegram 규약: 개인 chat id 는 양수·그룹은 음수).
  const selfAuth = selfAuthorizedChatId(cfg.chatId);
  const authorized = new Set<number>([
    ...(cfg.authorizedIds ?? []),
    ...(selfAuth !== undefined ? [selfAuth] : []),
  ]);
  // 로그 폭주 방지: 미허가 발신자당 1회, 미설정 경고 1회만 남긴다.
  const warnedSenders = new Set<number>();
  let warnedNoAuth = false;

  /** 미허가 발신자 로그를 발신자별 1회로 스로틀. */
  function warnUnauthorized(from: number | undefined, chat: number | undefined): void {
    const key = from ?? chat ?? -1;
    if (warnedSenders.has(key)) return;
    warnedSenders.add(key);
    console.warn(t("log.telegram.unauthorizedMessage", { from: from ?? "?", chat: chat ?? "?" }));
  }

  async function getToken(): Promise<string> {
    if (!token) {
      token = await readBotToken(cfg.paths);
    }
    return token;
  }

  async function sendReply(chatId: number, text: string, replyToMsgId?: number): Promise<void> {
    const tok = await getToken();
    // 4096자 초과 시 분할 순차 전송(A) — 첫 청크만 원본에 quote-reply, 순서 보존.
    // 단일 메시지면 그대로(임계 불변). 다중이면 "(i/N)" 순번 접두를 붙여 도착 순서 단서를 준다 —
    // 접두 길이만큼 여유를 두고 재분할(접두 포함 4096 초과 방지).
    let chunks = splitForTelegram(text);
    const multi = chunks.length > 1;
    if (multi) chunks = splitForTelegram(text, TELEGRAM_MSG_LIMIT - 16);
    for (let i = 0; i < chunks.length; i++) {
      const body = multi ? `(${i + 1}/${chunks.length}) ${chunks[i]}` : chunks[i];
      const params: Record<string, unknown> = { chat_id: chatId, text: body };
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
    // 프롬프트에 cwd(어느 폴더에서 실행되는 도구인지)와 자동거부 기한(무응답 시)을 함께 표기 —
    // markdown 승인 블록과 동일 맥락을 제공(승인 어포던스 채널 간 정합).
    const deadline = formatStamp(new Date(Date.parse(req.ts) + gateTimeoutMs));
    const text = [
      tl("telegram.permPrompt", { tool: req.tool, detail: req.detail }),
      tl("telegram.permPromptCwd", { cwd: req.cwd }),
      tl("telegram.permPromptDeadline", { deadline }),
    ].join("\n");
    const result = await callBotApi(tok, "sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: tl("telegram.permBtnAllow"), callback_data: `allow:${reqId}` },
            { text: tl("telegram.permBtnDeny"), callback_data: `deny:${reqId}` },
          ],
        ],
      },
    });
    const r = result as { message_id: number };
    permMessages.set(reqId, { chatId, messageId: r.message_id, text });
    return { messageId: r.message_id };
  }

  async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const tok = await getToken();
    await callBotApi(tok, "answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  /**
   * 결정 확정 피드백 — 프롬프트 메시지에 결정을 표기하고 버튼을 제거한다(클릭해도 화면이 안 바뀌던
   * 문제·결정 후 stale 버튼 잔존 해소). 메시지 미추적(재기동 등)이면 무동작. 편집 실패는 로그 후 흡수.
   */
  async function finalizePermMessage(reqId: string, decision: "allow" | "deny"): Promise<void> {
    const m = permMessages.get(reqId);
    if (!m) return;
    permMessages.delete(reqId);
    const tok = await getToken();
    const label = tl(decision === "allow" ? "telegram.permAllowed" : "telegram.permDenied");
    await callBotApi(tok, "editMessageText", {
      chat_id: m.chatId,
      message_id: m.messageId,
      text: `${m.text}\n${label}`,
      reply_markup: { inline_keyboard: [] },
    }).catch((err) => {
      console.error(t("log.telegram.answerCallbackError", { error: errMsg(err) }));
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
    control?: ControlRequest,
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
      ...(control ? { control } : {}),
    };
  }

  /**
   * 세션 제어 명령 파싱 — 정확 일치만 제어로 해석(`/clear`·`/compact`·`/resume [n|세션id]`),
   * 그 외 슬래시 포함 텍스트는 일반 프롬프트(오발동 방지). 비제어면 null.
   */
  async function parseControlCommand(text: string): Promise<ControlRequest | null> {
    const trimmed = text.trim();
    // 그룹 채팅의 봇멘션 접미(@botname) 허용 — 그 외 변형(후행 인자 등)은 일반 프롬프트.
    const simple = /^\/(clear|compact)(?:@\S+)?$/.exec(trimmed);
    if (simple) return { kind: simple[1] as "clear" | "compact" };
    const rm = /^\/resume(?:@\S+)?(?:\s+(\S+))?$/.exec(trimmed);
    if (!rm) return null;
    return resolveResumeControl(rm[1], await readLedger(cfg.paths));
  }

  /** long-poll 루프 */
  async function pollLoop(): Promise<void> {
    const tok = await getToken();
    let pollFailures = 0; // 폴 오류 지수 백오프 카운터 — getUpdates 성공 시 리셋.
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
            // 인바운드 인증 — 허용 발신자(chat_id ∪ allow_from)만 큐에 넣는다.
            // 미허가/미설정은 무시(호스트 실행 세션 프롬프트 주입 차단). fail-closed.
            const msg = update.message;
            if (!isAuthorizedSender(authorized, [msg.chat.id, msg.from?.id])) {
              if (authorized.size === 0 && !warnedNoAuth) {
                warnedNoAuth = true;
                console.warn(t("log.telegram.noAuthConfigured"));
              } else if (authorized.size > 0) {
                warnUnauthorized(msg.from?.id, msg.chat.id);
              }
              continue;
            }
            const control = await parseControlCommand(update.message.text);
            const envelope = normalizeMessage(
              update.message,
              cfg.lane,
              cfg.proj,
              cfg.engine,
              control ?? undefined,
            );
            try {
              await enqueue(cfg.paths, envelope);
              consecutiveEnqueueFailures = 0; // 성공 → 연속 실패 리셋
              cfg.onInbound?.(); // injector 깨우기(in-process)
            } catch (err) {
              consecutiveEnqueueFailures++;
              console.error(
                t("log.telegram.enqueueError", {
                  count: consecutiveEnqueueFailures,
                  error: errMsg(err),
                }),
              );
              // 임계 도달 시점에만 1회 알림 — 매 폴 알림 폭주 방지.
              if (consecutiveEnqueueFailures === ENQUEUE_FAIL_THRESHOLD) {
                await alertEnqueueFailure(consecutiveEnqueueFailures);
              }
            }
          } else if (update.message) {
            // 텍스트 없는 메시지(사진·스티커·음성·문서 등) — 인증 발신자면 조용히 버리지 않고
            // 텍스트만 지원함을 회신(무반응 원인 안내). 미인증은 무시(fail-closed — 봇 존재 노출·주입 차단).
            const msg = update.message;
            if (isAuthorizedSender(authorized, [msg.chat.id, msg.from?.id])) {
              await sendReply(msg.chat.id, tl("telegram.nonTextUnsupported"), msg.message_id).catch(
                (err) => console.error(t("log.telegram.nonTextReplyError", { error: errMsg(err) })),
              );
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
                  t("log.telegram.answerCallbackError", {
                    error: errMsg(err),
                  }),
                );
              });

              // 권한 콜백 인증 — 허용 발신자만 승인/거부 반영(미허가는 무시, 게이트는 타임아웃 deny).
              if (!isAuthorizedSender(authorized, [cq.from?.id, cq.message?.chat?.id])) {
                console.warn(t("log.telegram.unauthorizedCallback", { from: cq.from?.id ?? "?" }));
              } else if (rawDecision !== "allow" && rawDecision !== "deny") {
                // callback_data 검증 — allow/deny 외 값은 무시·로그(타입 어설션 우회 차단).
                console.warn(t("log.telegram.unknownCallback", { decision: rawDecision }));
              } else {
                for (const handler of callbackHandlers) {
                  handler(reqId, rawDecision);
                }
                // 결정 확정 피드백 — 메시지에 결정 표기 + 버튼 제거(클릭 무반응·stale 버튼 해소).
                await finalizePermMessage(reqId, rawDecision).catch((err) => {
                  console.error(t("log.telegram.answerCallbackError", { error: errMsg(err) }));
                });
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
        // 지수 백오프: 연속 실패가 누적될수록 재시도 간격 증가(상한 고정). 성공 시 리셋.
        const backoff = pollBackoffMs(pollFailures);
        console.error(
          t("log.telegram.pollError", {
            count: pollFailures,
            backoff,
            error: errMsg(err),
          }),
        );
        await sleep(backoff, pollAbort?.signal);
      }
    }
  }

  /** enqueue 연속 실패 임계 도달 시 운영자 채널로 1회 액션형 알림. */
  async function alertEnqueueFailure(count: number): Promise<void> {
    if (cfg.chatId === undefined) return; // 알림 대상 미지정 — 로그로만 남음
    const note = formatException(
      {
        situation: tl("telegram.enqueueFail.situation", { count }),
        action: tl("telegram.enqueueFail.action"),
      },
      tl,
    );
    await sendReply(cfg.chatId, note).catch((e: unknown) =>
      console.error(t("log.telegram.alertSendError", { error: errMsg(e) })),
    );
  }

  /** out/<id>.out (+ sidecar) → quote-reply 전송. injector 가 writeOutBody+setDone 직후 in-process 호출. */
  async function renderOut(id: string, hint?: RenderHint): Promise<void> {
    const defaultChatId = cfg.chatId ?? 0;
    if (!defaultChatId) return; // 회신 대상 미지정 시 렌더 생략

    // hint(injector 메모리) 있으면 디스크 재read 생략(M7). 없으면(크래시 flush) 디스크에서 읽는다.
    // sidecar 읽기는 queue.readSidecar 로 일원화(부재·파손 → null = reply_to 없이 전송).
    let replyTo: number | undefined;
    const sidecar = hint ? hint.sidecar : await readSidecar(cfg.paths, id);
    if (sidecar?.reply_ref?.channel_msg_id) {
      // 비숫자 channel_msg_id 가드 — NaN 이면 reply_to_message_id 생략(전송 파라미터 오염 방지).
      const parsed = parseInt(sidecar.reply_ref.channel_msg_id, 10);
      if (!Number.isNaN(parsed)) replyTo = parsed;
    }

    const text = hint ? hint.text : await readFile(join(cfg.paths.outDir, `${id}.out`), "utf8");
    await sendReply(defaultChatId, text, replyTo);
  }

  async function start(): Promise<void> {
    // 기동 연결 확인 — running=true·폴 기동 전에 getMe 를 1회 확인한다. 토큰 불량/네트워크
    // 불가달/API 오류(원인 불문) 시 throw → supervisor 가 기동 실패로 반영(status:error).
    // AbortController·상한 타이머는 첫 await(getToken) 전에 동기적으로 등록한다 — 등록을 토큰
    // 읽기(fs I/O) 뒤로 미루면 상한 시작점이 지연돼 실질 상한이 늘어난다(무한 대기 회피 취지 약화).
    const probeController = new AbortController();
    const probeTimer = setTimeout(
      () => probeController.abort(),
      TELEGRAM_STARTUP_PROBE_TIMEOUT_MS,
    );
    try {
      const tok = await getToken();
      // 토큰 읽기(로컬 fs, 네트워크 아님) 중 상한이 이미 지났으면 네트워크 호출 없이 즉시 실패
      // 처리한다 — signal 이 이미 abort 된 뒤에 fetch 를 호출하는 경로를 피한다.
      if (probeController.signal.aborted) {
        throw new Error("[telegram] getMe probe aborted (startup timeout)");
      }
      await callBotApi(tok, "getMe", {}, probeController.signal);
    } finally {
      clearTimeout(probeTimer);
    }

    running = true;
    pollAbort = new AbortController();
    // fire-and-forget 루프 — rejection 이 unhandled 가 되지 않도록 로깅(기동 후 일시 오류는 기존대로 유지).
    // pollPromise 를 보관해 stop() 이 종료를 대기.
    pollPromise = pollLoop().catch((err: unknown) => {
      console.error(t("log.telegram.pollLoopEnd", { error: errMsg(err) }));
    });
    // out 렌더는 injector 가 renderOut() 으로 in-process 호출(out/ watch 제거).
  }

  /** Source 계약: 권한 요청을 inline 버튼으로 표면화(chat_id 는 conf self-resolve). */
  async function requestPermission(req: PermRequest): Promise<void> {
    await sendPermPrompt(cfg.chatId ?? 0, req.id, req);
  }

  /** Source 계약: 운영 알림 — 회신 대상 미지정 시 생략(콘솔·transcript 로만 남음). */
  async function notify(text: string): Promise<void> {
    if (cfg.chatId === undefined) return;
    await sendReply(cfg.chatId, text);
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
    notify,
  };
}
