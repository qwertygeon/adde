import { describe, expect, it } from "vitest";

// 확정 시그니처(Test Authoring Contract):
// PALETTE_SENTINEL = "<!-- adde:palette -->"
// renderPalette(caps, enabled): string[] — 그룹 머리글 포함(**records**/**session**), stop 신설.
// healLayout(lines, opts): { lines; changed } — 4존(경고→안내→팔레트→작성 경계) 순서 재구성.

const FULL_CAPS = {
  resume: "native",
  permission: "callback",
  streaming: true,
  usage: false,
  compact: "native",
  attachments: [],
} as const;

const NO_COMPACT_CAPS = { ...FULL_CAPS, compact: "none" } as const;

describe("SC-021: 팔레트가 기록·세션 두 그룹으로 나뉘어 머리글과 함께 나타난다", () => {
  it("Happy: compact 지원 엔진 → 기록 그룹(archive) + 세션 그룹(compact·clear·stop·resume)", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const items = inbox.renderPalette(FULL_CAPS as never, true);
    const joined = items.join("\n");
    expect(joined).toContain("**records**");
    expect(joined).toContain("**session**");
    expect(items.some((i) => /archive/i.test(i))).toBe(true);
    expect(items.some((i) => /compact/i.test(i))).toBe(true);
    expect(items.some((i) => /clear/i.test(i))).toBe(true);
    expect(items.some((i) => /⏹️|stop/i.test(i))).toBe(true);
    expect(items.some((i) => /♻️|resume/i.test(i))).toBe(true);
    // 기록 그룹 머리글이 세션 그룹 머리글보다 먼저 나온다(design.md §6 예시 순서).
    expect(joined.indexOf("**records**")).toBeLessThan(joined.indexOf("**session**"));
  });

  it("Edge: caps.compact==='none' 이면 compact 항목만 제거되고 그룹 구조는 유지된다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const items = inbox.renderPalette(NO_COMPACT_CAPS as never, true);
    expect(items.some((i) => /compact/i.test(i))).toBe(false);
    expect(items.join("\n")).toContain("**session**");
    expect(items.some((i) => /clear/i.test(i))).toBe(true);
    expect(items.some((i) => /stop/i.test(i))).toBe(true);
  });

  it("Error: 팔레트가 비활성(markdown.palette=off)이면 팔레트 존 전체가 부재한다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const items = inbox.renderPalette(FULL_CAPS as never, false);
    expect(items).toEqual([]);
    const healed = inbox.healLayout([], { paletteEnabled: false, caps: FULL_CAPS as never });
    expect(healed.lines.some((l) => l.trim() === inbox.PALETTE_SENTINEL)).toBe(false);
  });
});

describe("SC-022: 팔레트 그룹 머리글은 액션으로 파싱되지 않고 초안으로도 취급되지 않는다", () => {
  it("Happy: 머리글이 있는 노트를 파싱하면 액션 0건이고 전송 본문에 머리글이 섞이지 않는다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const healed = inbox.healLayout([], { paletteEnabled: true, caps: FULL_CAPS as never });
    const content = healed.lines.join("\n") + "\n";
    const parsed = inbox.parseInbox(content);
    // 머리글(`**records**`/`**session**`)은 체크박스가 아니므로 파싱된 팔레트 액션에 걸리지 않는다.
    expect(parsed.actions.length).toBe(0);

    // 초안 영역(작성 경계 아래)에 send 를 체크해 실제 전송 본문을 확인한다.
    const withSend = content.replace("- [ ] 📤 send", "지시 본문\n- [x] 📤 send");
    const sent = inbox.parseInbox(withSend);
    const fresh = sent.actions.find((a) => a.kind === "fresh");
    expect(fresh?.text).not.toContain("**records**");
    expect(fresh?.text).not.toContain("**session**");
  });

  it("Edge: 사용자가 머리글 텍스트를 초안 영역에 그대로 복사해도 초안으로만 취급된다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const content = [
      inbox.COMPOSE_SENTINEL,
      "**records** 를 언급하는 초안입니다",
      "- [x] 📤 send",
      inbox.RECORDS_ANCHOR,
    ].join("\n");
    const parsed = inbox.parseInbox(content);
    const fresh = parsed.actions.find((a) => a.kind === "fresh");
    expect(fresh?.text).toContain("**records** 를 언급하는 초안입니다");
  });

  it("Error: 팔레트 머리글이 지워진 손상 노트도 치유가 canonical 구조로 재구성한다(초안 보존)", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const broken = [
      "- [ ] 🗄️ archive", // 머리글 없이 항목만 남은 손상 상태
      inbox.COMPOSE_SENTINEL,
      "보존돼야 할 초안",
      "- [ ] 📤 send",
      inbox.RECORDS_ANCHOR,
    ];
    const healed = inbox.healLayout(broken, { paletteEnabled: true, caps: FULL_CAPS as never });
    const content = healed.lines.join("\n") + "\n";
    expect(content).toContain("**records**");
    expect(content).toContain("**session**");
    const parsed = inbox.parseInbox(content);
    const composeIdx = parsed.composeIndex!;
    const sendIdx = parsed.lines.findIndex((l) => l.includes("📤 send"));
    const draft = parsed.lines.slice(composeIdx + 1, sendIdx).join("\n");
    expect(draft).toContain("보존돼야 할 초안");
  });
});
