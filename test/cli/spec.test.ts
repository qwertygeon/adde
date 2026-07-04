import { describe, expect, it } from "vitest";
import {
  COMMAND_SPECS,
  visibleCommands,
  findCommand,
  suggestCommands,
} from "../../src/cli/spec.js";
import { buildUsage } from "../../src/core/messages.js";

// CLI 명령·플래그 SSOT — 자동완성·도움말·오타 힌트가 파생.

describe("command spec (SSOT)", () => {
  it("visibleCommands 는 hidden(__daemon)을 제외한다", () => {
    const names = visibleCommands().map((c) => c.name);
    expect(names).not.toContain("__daemon");
    expect(names).toContain("up");
    expect(names).toContain("completion");
  });

  it("findCommand 로 usageKey 를 조회한다", () => {
    expect(findCommand("status")?.usageKey).toBe("usage.status");
    expect(findCommand("nope")).toBeUndefined();
  });

  it("노출 명령은 모두 최상위 usage 텍스트에 나타난다 (drift 가드)", () => {
    const usage = buildUsage();
    for (const c of visibleCommands()) {
      expect(usage).toContain(c.name);
    }
  });
});

describe("suggestCommands (오타 힌트)", () => {
  it("근접 오타를 원 명령으로 제안한다", () => {
    expect(suggestCommands("statsu")).toContain("status");
    expect(suggestCommands("doctro")).toContain("doctor");
    expect(suggestCommands("compeltion")).toContain("completion");
  });

  it("무관한 입력에는 제안하지 않는다", () => {
    expect(suggestCommands("xyzzyplugh")).toHaveLength(0);
  });

  it("hidden 명령은 제안 후보가 아니다", () => {
    // __daemon 과 매우 유사한 입력이라도 hidden 은 제외.
    expect(suggestCommands("__daemou")).not.toContain("__daemon");
  });
});

// 스펙과 실제 최상위 명령 이름 집합이 어긋나지 않는지(대표 상수 존재 확인).
describe("COMMAND_SPECS 무결성", () => {
  it("이름 중복이 없다", () => {
    const names = COMMAND_SPECS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
