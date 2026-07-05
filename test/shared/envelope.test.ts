import { describe, expect, it } from "vitest";
import { parseEnvelope, serializeEnvelope } from "../../src/shared/envelope.js";

// SC-014 일부: envelope v1 스키마 파싱·검증·직렬화

const validEnvelope = {
  v: 1 as const,
  id: "msg-001",
  lane: "test-lane",
  source: "telegram" as const,
  backend: "acp" as const,
  engine: "claude-agent-acp",
  project: "myproject",
  ts: "2026-06-25T23:00:00.000Z",
  text: "안녕하세요",
};

describe("control 필드 (세션 제어 envelope)", () => {
  it("유효한 control(clear/compact/resume/sessions)을 파싱한다", () => {
    for (const kind of ["clear", "compact", "resume", "sessions"]) {
      const env = parseEnvelope(JSON.stringify({ ...validEnvelope, control: { kind } }));
      expect(env.control?.kind).toBe(kind);
    }
    const withId = parseEnvelope(
      JSON.stringify({ ...validEnvelope, control: { kind: "resume", sessionId: "abc-123" } }),
    );
    expect(withId.control?.sessionId).toBe("abc-123");
  });

  it("알 수 없는 control.kind 는 거부한다", () => {
    expect(() =>
      parseEnvelope(JSON.stringify({ ...validEnvelope, control: { kind: "reboot" } })),
    ).toThrow(/control\.kind/);
  });

  it("sessionId 허용 문자셋 위반(경로 주입)은 거부한다", () => {
    expect(() =>
      parseEnvelope(
        JSON.stringify({
          ...validEnvelope,
          control: { kind: "resume", sessionId: "../etc/passwd" },
        }),
      ),
    ).toThrow(/sessionId/);
  });
});

describe("parseEnvelope 입력 검증·보안 (011-C)", () => {
  it("text 256KB 초과는 거부한다", () => {
    const big = { ...validEnvelope, text: "x".repeat(256 * 1024 + 1) };
    expect(() => parseEnvelope(JSON.stringify(big))).toThrow();
  });

  it("256KB 이하 text 는 통과", () => {
    const ok = { ...validEnvelope, text: "x".repeat(1000) };
    expect(parseEnvelope(JSON.stringify(ok)).text.length).toBe(1000);
  });

  it("channel_msg_id 형식 위반(경로문자)을 거부한다", () => {
    const bad = { ...validEnvelope, reply_ref: { channel_msg_id: "../etc/passwd" } };
    expect(() => parseEnvelope(JSON.stringify(bad))).toThrow();
  });

  it("정상 channel_msg_id(숫자/uuid)는 통과", () => {
    const num = { ...validEnvelope, reply_ref: { channel_msg_id: "12345" } };
    expect(parseEnvelope(JSON.stringify(num)).reply_ref?.channel_msg_id).toBe("12345");
    const uuid = { ...validEnvelope, reply_ref: { channel_msg_id: "a1b2-c3d4-e5" } };
    expect(parseEnvelope(JSON.stringify(uuid)).reply_ref?.channel_msg_id).toBe("a1b2-c3d4-e5");
  });

  it("attachment name 경로 traversal 을 거부한다", () => {
    const bad = {
      ...validEnvelope,
      attachments: [{ kind: "file", path: "/x", name: "../evil", mime: "text/plain" }],
    };
    expect(() => parseEnvelope(JSON.stringify(bad))).toThrow();
  });

  it("attachment kind 위반을 거부한다", () => {
    const bad = {
      ...validEnvelope,
      attachments: [{ kind: "exe", path: "/x", name: "a", mime: "x" }],
    };
    expect(() => parseEnvelope(JSON.stringify(bad))).toThrow();
  });

  it("정상 attachment 는 통과", () => {
    const ok = {
      ...validEnvelope,
      attachments: [{ kind: "image", path: "/x.png", name: "x.png", mime: "image/png" }],
    };
    expect(parseEnvelope(JSON.stringify(ok)).attachments?.length).toBe(1);
  });
});

describe("parseEnvelope (SC-014 envelope 정규화)", () => {
  it("유효한 v1 JSON 을 파싱한다", () => {
    const json = JSON.stringify(validEnvelope);
    const result = parseEnvelope(json);
    expect(result.v).toBe(1);
    expect(result.id).toBe("msg-001");
    expect(result.lane).toBe("test-lane");
    expect(result.text).toBe("안녕하세요");
  });

  it("v !== 1 인 경우 예외를 던진다", () => {
    const invalid = { ...validEnvelope, v: 2 };
    expect(() => parseEnvelope(JSON.stringify(invalid))).toThrow();
  });

  it("필수 필드(id) 누락 시 예외를 던진다", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, ...withoutId } = validEnvelope;
    expect(() => parseEnvelope(JSON.stringify(withoutId))).toThrow();
  });

  it("필수 필드(text) 누락 시 예외를 던진다", () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { text: _text, ...withoutText } = validEnvelope;
    expect(() => parseEnvelope(JSON.stringify(withoutText))).toThrow();
  });

  it("reply_ref 옵션 필드가 존재하면 파싱한다", () => {
    const withRef = {
      ...validEnvelope,
      reply_ref: { channel_msg_id: "42" },
    };
    const result = parseEnvelope(JSON.stringify(withRef));
    expect(result.reply_ref?.channel_msg_id).toBe("42");
  });

  it("attachments 옵션 필드가 존재하면 파싱한다", () => {
    const withAttachments = {
      ...validEnvelope,
      attachments: [
        { kind: "image" as const, path: "/tmp/img.png", name: "img.png", mime: "image/png" },
      ],
    };
    const result = parseEnvelope(JSON.stringify(withAttachments));
    expect(result.attachments).toHaveLength(1);
  });
});

describe("serializeEnvelope (SC-014 직렬화)", () => {
  it("Envelope 을 JSON 문자열로 직렬화한다", () => {
    const json = serializeEnvelope(validEnvelope);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed["v"]).toBe(1);
    expect(parsed["id"]).toBe("msg-001");
  });

  it("직렬화 후 파싱하면 원본과 동일하다 (round-trip)", () => {
    const json = serializeEnvelope(validEnvelope);
    const result = parseEnvelope(json);
    expect(result.id).toBe(validEnvelope.id);
    expect(result.text).toBe(validEnvelope.text);
  });
});
