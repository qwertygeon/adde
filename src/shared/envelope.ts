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
  source: "telegram" | "obsidian";
  backend: "acp";
  engine: string;
  project: string;
  ts: string;
  text: string;
  attachments?: Attachment[];
  reply_ref?: ReplyRef;
}

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

  return raw as Envelope;
}

export function serializeEnvelope(e: Envelope): string {
  return JSON.stringify(e);
}
