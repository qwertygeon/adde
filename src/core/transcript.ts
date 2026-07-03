/**
 * transcript 렌더·append·마스킹.
 * FR-006/007: session/update 이벤트를 사람이 읽을 텍스트로 렌더 → mask → append.
 * append 실패는 보조(warn↑ 로그 후 흡수) — error-handling.md 보조 분류.
 */
import { t } from "../shared/i18n.js";
import { errMsg } from "../shared/errors.js";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { maskSecrets } from "../shared/mask.js";
import type { LanePaths } from "../shared/paths.js";

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

/**
 * transcript.log 에 이벤트를 append.
 * 보조 실패(파일 append 오류)는 warn↑ 로그 후 흡수.
 */
export async function appendTranscript(paths: LanePaths, event: SessionEvent): Promise<void> {
  const rendered = renderEvent(event);
  const masked = maskSecrets(rendered);
  const line = `${masked}\n`;

  try {
    await mkdir(dirname(paths.transcriptLog), { recursive: true });
    await appendFile(paths.transcriptLog, line, "utf8");
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
}
