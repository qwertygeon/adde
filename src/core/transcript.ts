/**
 * transcript 렌더·append·마스킹.
 * session/update 이벤트를 사람이 읽을 텍스트로 렌더 → mask → append.
 * append 실패는 보조(warn↑ 로그 후 흡수) — error-handling.md 보조 분류.
 */
import { t } from "../shared/i18n.js";
import { errMsg } from "../shared/errors.js";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { maskSecrets } from "../shared/mask.js";
import type { LanePaths } from "../shared/paths.js";
import {
  rotateGenerations,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LOG_KEEP,
} from "../shared/log-rotate.js";
import type { RotateConfig, RotateDeps } from "../shared/log-rotate.js";

/**
 * session 이벤트 — ACP SDK sessionUpdate 형식 또는 단순 type/content 형식 모두 수용.
 * ACP SDK: { sessionUpdate: string; ... }
 * Telegram adapter / 간단한 이벤트: { type: string; ... }
 */
export type SessionEvent = {
  [key: string]: unknown;
} & ({ sessionUpdate: string } | { type: string });

/** sessionUpdate 키 추출 — 두 형식 모두 지원. */
function getEventKind(event: SessionEvent): string {
  if ("sessionUpdate" in event && typeof event["sessionUpdate"] === "string") {
    return event["sessionUpdate"];
  }
  if ("type" in event && typeof event["type"] === "string") {
    return event["type"];
  }
  return "unknown";
}

/**
 * session/update 이벤트를 사람이 읽을 텍스트 줄로 렌더.
 */
export function renderEvent(event: SessionEvent): string {
  const ts = new Date().toISOString();
  const kind = getEventKind(event);

  switch (kind) {
    case "agent_message_chunk": {
      // ACP SDK 형식: content 가 { type, text } 객체
      // 단순 형식: content 가 string
      const rawContent = event["content"];
      let text: string;
      if (typeof rawContent === "string") {
        text = rawContent;
      } else if (rawContent && typeof rawContent === "object") {
        const c = rawContent as { type?: string; text?: string };
        text = c.type === "text" ? (c.text ?? "") : "";
      } else {
        text = "";
      }
      return `[${ts}] agent: ${text}`;
    }
    case "available_commands_update":
      return t("transcript.commandsUpdated", { ts });
    case "current_mode_update": {
      const mode = event["mode"];
      return `[${ts}] mode_update: ${JSON.stringify(mode)}`;
    }
    case "usage_update": {
      const usage = event["usage"];
      return `[${ts}] usage: ${JSON.stringify(usage)}`;
    }
    case "tool_call": {
      const toolCall = event["toolCall"];
      return `[${ts}] tool_call: ${JSON.stringify(toolCall)}`;
    }
    case "session_info_update": {
      const info = event["sessionInfo"];
      return `[${ts}] session_info: ${JSON.stringify(info)}`;
    }
    default:
      return `[${ts}] ${kind}: ${JSON.stringify(event)}`;
  }
}

/** 경로별 회전+append 직렬화 뮤텍스 — 두 append 가 stat→회전을 인터리브해 이중 회전(세대
 * 소실)하는 것을 방지한다. Node 단일 이벤트루프라 Map 접근 자체는 경합하지 않는다. */
const rotateChains = new Map<string, Promise<void>>();

/**
 * transcript.log 에 이벤트를 append. 임계(기본 5MB) 초과 시 세대 회전(기본 keep=2) 후
 * append — 경로별 직렬화로 동시 append 의 이중 회전을 방지한다.
 * 보조 실패(파일 append 오류)는 warn↑ 로그 후 흡수. 회전 실패도 fail-open.
 */
export async function appendTranscript(
  paths: LanePaths,
  event: SessionEvent,
  opts?: { rotate?: RotateConfig; rotateDeps?: RotateDeps },
): Promise<void> {
  const rendered = renderEvent(event);
  const masked = maskSecrets(rendered);
  const line = `${masked}\n`;
  const cfg: RotateConfig = opts?.rotate ?? { maxBytes: DEFAULT_LOG_MAX_BYTES, keep: DEFAULT_LOG_KEEP };
  const transcriptLog = paths.transcriptLog;

  const prev = rotateChains.get(transcriptLog) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      const size = await stat(transcriptLog)
        .then((s) => s.size)
        .catch(() => 0);
      if (size >= cfg.maxBytes) {
        await rotateGenerations(transcriptLog, cfg, opts?.rotateDeps);
      }
    } catch (err) {
      console.warn(t("log.rotate.fail", { path: transcriptLog, detail: errMsg(err) }));
    }

    try {
      await mkdir(dirname(transcriptLog), { recursive: true });
      await appendFile(transcriptLog, line, "utf8");
    } catch (err) {
      // 감사 이벤트(차단 경고·자동허용)는 소실 시 감사 추적이 불완전해진다 → error 로 승격(E2).
      // 일반 이벤트는 보조 분류로 warn 후 흡수.
      const kind = getEventKind(event);
      const isAudit = kind === "adde_warn" || kind === "adde_auto_allow";
      const detail = errMsg(err);
      if (isAudit) {
        console.error(t("log.transcript.auditAppendFail", { kind, detail }));
      } else {
        console.warn(t("log.transcript.appendFail", { detail }));
      }
    }
  });
  // 체인 끊김 방지 — 이번 호출이 실패해도(위에서 흡수됨) 다음 호출이 이어받을 수 있게 항상 resolve.
  rotateChains.set(transcriptLog, next.catch(() => {}));
  await next;
}
