import { describe, expect, it } from "vitest";
import { buildUsage } from "../../src/core/messages.js";

// 메인 도움말 status 행 --json 표기 (FR-012) — SC-022.

describe("메인 도움말 status 행 --json 표기 (SC-022 Happy)", () => {
  it("buildUsage() 의 status 행에 --json 이 포함된다(--all 기존 표기는 유지)", () => {
    const usage = buildUsage();
    const statusLine = usage.split("\n").find((l) => l.trim().startsWith("status "));
    expect(statusLine, "usage.main 에서 status 행을 찾을 수 없음").toBeDefined();
    expect(statusLine).toContain("--json");
    expect(statusLine).toContain("--all");
  });
});
