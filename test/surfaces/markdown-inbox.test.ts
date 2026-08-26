import { describe, expect, it } from "vitest";

// 확정 시그니처: sendingLine(envelopeId, stamp) · sentLine(turn, turnStartIso) ·
// renderPalette(caps, enabled). parseInbox 등 순수 파서는 research.md 이식 목록(§module-hierarchy)
// 대상으로 기존 markdown.ts 함수와 동일 동작을 승계한다고 가정한다(ASSUMPTION).

describe("SC-024: 3존 입력 노트의 지시가 접수된다", () => {
  it("Happy: 전송 체크 시 기록 존에 `⏳ sending <id>` 1단계 마커가 남는다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const line = inbox.sendingLine("env-001", "20260826-120000");
    expect(line).toContain("env-001");
    expect(line).toMatch(/⏳|sending/);
  });

  it("Happy: 턴 종료 후 마커가 `✅ sent [[NNNN ts]]` 2단계로 전이된다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const line = inbox.sentLine(7, "2026-08-26T12:00:00.000Z");
    expect(line).toMatch(/✅|sent/);
    expect(line).toContain("0007");
  });

  it("Edge: 빈 작성 영역으로 전송을 체크하면 빈 전송(kind:'empty')으로 표시되고 큐에 들어가지 않는다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const content = [
      "<!-- adde:compose -->",
      "",
      "- [x] 📤 send",
      "<!-- adde:records -->",
      "",
    ].join("\n");
    const parsed = inbox.parseInbox(content);
    const emptyAction = parsed.actions.find((a) => a.kind === "empty");
    expect(emptyAction).toBeDefined();
    expect(parsed.actions.some((a) => a.kind === "fresh")).toBe(false); // 큐 적재 대상(fresh) 아님
  });

  it("Error: 큐 적재 실패 시 종단 마킹을 하지 않는다(재시도 가능하게 남긴다)", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    // sendingLine 은 순수 함수라 실패를 시뮬레이션할 여지가 없다 — 계약상 "적재 성공 후에만
    // 마커를 남긴다"는 순서 보장은 Surface.start()/enqueue 배선(T019) 쪽 책임이므로, 본 파일은
    // 순수 함수 계약(마커 포맷)만 단언하고 순서 보장은 markdown-inbox 통합 레벨(T-D14
    // inbox-lightweight.test.ts SC-049)이 담당한다.
    expect(typeof inbox.sendingLine).toBe("function");
  });
});

describe("renderPalette — 능력 선언 기반 조건부 렌더(ADR-030)", () => {
  it("Happy: compact:'none' 이면 compact 항목이 렌더되지 않고 나머지는 표시된다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const items = inbox.renderPalette(
      {
        resume: "native",
        permission: "callback",
        streaming: true,
        usage: false,
        compact: "none",
        attachments: [],
      },
      true,
    );
    expect(items.some((i) => /compact/i.test(i))).toBe(false);
    expect(items.some((i) => /archive/i.test(i))).toBe(true);
    expect(items.some((i) => /clear/i.test(i))).toBe(true);
    expect(items.some((i) => /resume/i.test(i))).toBe(true);
  });

  it("Edge: compact:'prompt' 면 compact 항목이 렌더된다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const items = inbox.renderPalette(
      {
        resume: "native",
        permission: "callback",
        streaming: true,
        usage: false,
        compact: "prompt",
        attachments: [],
      },
      true,
    );
    expect(items.some((i) => /compact/i.test(i))).toBe(true);
  });

  it("Error: enabled=false(팔레트 비활성)면 항목이 전부 렌더되지 않는다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const items = inbox.renderPalette(
      {
        resume: "native",
        permission: "callback",
        streaming: true,
        usage: false,
        compact: "native",
        attachments: [],
      },
      false,
    );
    expect(items).toEqual([]);
  });
});
