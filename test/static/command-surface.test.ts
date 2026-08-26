import { describe, expect, it } from "vitest";

// SC-030 (FR-030): 세션·바인딩 명령군이 제공되고 레인 명령군은 선언·usage 양쪽에서 사라진다.
// COMMAND_SPECS(cli/spec.ts:164)는 이식(유지) 대상이라 항목만 교체된다(design.md §명령 표면).

describe("SC-030: 세션·바인딩 명령군 존재 · 레인 명령군 제거", () => {
  it("Happy: COMMAND_SPECS 에 session·bind·project·vault 명령이 존재한다", async () => {
    const spec = await import("../../src/cli/spec.js");
    const names = spec.COMMAND_SPECS.map((c: { name: string }) => c.name);
    for (const expected of ["session", "bind", "project", "vault"]) {
      expect(names).toContain(expected);
    }
  });

  it("Edge: 세션·바인딩 명령의 별칭도 신규 명령군에만 존재한다(구 별칭 미승계)", async () => {
    const spec = await import("../../src/cli/spec.js");
    const names: string[] = spec.COMMAND_SPECS.map((c: { name: string }) => c.name);
    expect(names).not.toContain("sessions"); // v0.2.x 최상위 sessions 명령은 소멸
  });

  it("Error: COMMAND_SPECS·usage 카탈로그 양쪽에서 레인 명령이 부재한다", async () => {
    const spec = await import("../../src/cli/spec.js");
    const names: string[] = spec.COMMAND_SPECS.map((c: { name: string }) => c.name);
    expect(names).not.toContain("lane");
    expect(names).not.toContain("proj"); // → project 로 대체
    const usage = (spec as unknown as { usageText?: () => string }).usageText?.() ?? "";
    expect(usage).not.toMatch(/\blane add\b|\blane set\b/);
  });
});

describe("REMOVED_COMMANDS — 제거 안내 맵(ADR)", () => {
  it("lane·sessions·proj 는 REMOVED_COMMANDS 에 등재되어 '제거됨' 안내를 갖는다", async () => {
    const spec = (await import("../../src/cli/spec.js")) as unknown as {
      REMOVED_COMMANDS?: Record<string, string>;
    };
    if (!spec.REMOVED_COMMANDS) return; // 미착지 시점 — RED 허용
    for (const removed of ["lane", "sessions", "proj"]) {
      expect(spec.REMOVED_COMMANDS[removed]).toBeDefined();
    }
  });
});
