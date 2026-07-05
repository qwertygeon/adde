import type { Envelope } from "../../src/shared/envelope.js";

/** 테스트 공용 envelope 픽스처 — 필드 기본값은 큐/인젝터 어서션이 의존하지 않는 값. */
export function makeEnvelope(id = "msg-001", text = "테스트", replyMsgId?: string): Envelope {
  return {
    v: 1,
    id,
    lane: "test-lane",
    source: "telegram",
    backend: "acp",
    engine: "claude-agent-acp",
    project: "myproj",
    ts: new Date().toISOString(),
    text,
    ...(replyMsgId ? { reply_ref: { channel_msg_id: replyMsgId } } : {}),
  };
}
