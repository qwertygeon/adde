/**
 * v1 envelope 스키마·검증·직렬화.
 * 소스 어댑터가 생성하고 큐에 저장하는 레인 메시지 단위.
 */

export interface Attachment {
  kind: "image" | "file";
  path: string;
  name: string;
  mime: string;
}

export interface ReplyRef {
  channel_msg_id: string;
  thread?: string;
}

export interface Envelope {
  v: 1;
  id: string;
  lane: string;
  source: "telegram" | "markdown";
  backend: "acp";
  engine: string;
  project: string;
  ts: string;
  text: string;
  attachments?: Attachment[];
  reply_ref?: ReplyRef;
}

/** text 길이 상한(UTF-16 코드유닛) — 초과 시 거부(과대 입력 OOM 방어). */
const MAX_TEXT_LEN = 256 * 1024;
/** channel_msg_id 허용 문자셋 — 경로/제어문자 주입 방어. */
const CHANNEL_MSG_ID_RE = /^[A-Za-z0-9_:-]+$/;

export function parseEnvelope(json: string): Envelope {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("envelope: JSON parse failed");
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error("envelope: not an object");
  }

  const obj = raw as Record<string, unknown>;

  if (obj["v"] !== 1) {
    throw new Error(`envelope: v must be 1, got ${String(obj["v"])}`);
  }

  const required = ["id", "lane", "source", "backend", "engine", "project", "ts", "text"] as const;
  for (const key of required) {
    if (typeof obj[key] !== "string" || obj[key] === "") {
      throw new Error(`envelope: required field "${key}" missing or empty`);
    }
  }

  // 입력 검증·보안 표면(C): 과대 길이·형식·경로주입 거부(fail-closed).
  if ((obj["text"] as string).length > MAX_TEXT_LEN) {
    throw new Error(
      `envelope: text 길이 상한 초과 (${(obj["text"] as string).length} > ${MAX_TEXT_LEN})`,
    );
  }

  const replyRef = obj["reply_ref"];
  if (replyRef !== undefined) {
    if (typeof replyRef !== "object" || replyRef === null) {
      throw new Error("envelope: reply_ref must be an object");
    }
    const cmid = (replyRef as Record<string, unknown>)["channel_msg_id"];
    if (typeof cmid !== "string" || !CHANNEL_MSG_ID_RE.test(cmid)) {
      throw new Error("envelope: reply_ref.channel_msg_id 형식 위반");
    }
  }

  const attachments = obj["attachments"];
  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) {
      throw new Error("envelope: attachments must be an array");
    }
    for (const a of attachments) {
      if (typeof a !== "object" || a === null) {
        throw new Error("envelope: attachment must be an object");
      }
      const at = a as Record<string, unknown>;
      if (at["kind"] !== "image" && at["kind"] !== "file") {
        throw new Error(`envelope: attachment.kind 위반 (${String(at["kind"])})`);
      }
      for (const f of ["path", "name", "mime"] as const) {
        if (typeof at[f] !== "string" || at[f] === "") {
          throw new Error(`envelope: attachment.${f} missing or empty`);
        }
      }
      const name = at["name"] as string;
      if (name.includes("/") || name.includes("\\") || name.includes("..")) {
        throw new Error(`envelope: attachment.name 경로 traversal 금지 (${name})`);
      }
    }
  }

  return raw as Envelope;
}

export function serializeEnvelope(e: Envelope): string {
  return JSON.stringify(e);
}
