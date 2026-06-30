import { describe, expect, it } from "vitest";
import { readVersion } from "../src/core/version.js";
import { COMMANDS, buildUsage } from "../src/core/messages.js";

describe("cli usage", () => {
  it("usage 텍스트에 두 명령 표면을 모두 노출한다", () => {
    const usage = buildUsage();
    expect(usage).toContain(COMMANDS.primary);
    expect(usage).toContain(COMMANDS.short);
  });
});

describe("version", () => {
  it("루트 VERSION(SemVer)을 SoT 로 읽는다", () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
