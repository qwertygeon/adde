import { describe, expect, it } from "vitest";
import { parseLaneConf } from "../../src/shared/conf.js";

// parseLaneConf: ini 형식 레인 설정 파싱 — FR-001/021

describe("parseLaneConf", () => {
  const minimalConf = `source=telegram
backend=acp
engine=claude-code-acp
channel=telegram
`;

  it("필수 필드를 파싱한다", () => {
    const result = parseLaneConf(minimalConf);
    expect(result.source).toBe("telegram");
    expect(result.backend).toBe("acp");
    expect(result.engine).toBe("claude-code-acp");
    expect(result.channel).toBe("telegram");
  });

  it("acp_version 기본값이 v1 이다", () => {
    const result = parseLaneConf(minimalConf);
    expect(result.acp_version).toBe("v1");
  });

  it("perm_tier 기본값이 acp 이다", () => {
    const result = parseLaneConf(minimalConf);
    expect(result.perm_tier).toBe("acp");
  });

  it("명시된 acp_version 이 기본값을 덮어쓴다", () => {
    const conf = minimalConf + "acp_version=v2\n";
    const result = parseLaneConf(conf);
    expect(result.acp_version).toBe("v2");
  });

  it("알 수 없는 키는 무시한다 (forward-compat)", () => {
    const conf = minimalConf + "unknown_future_key=value\n";
    expect(() => parseLaneConf(conf)).not.toThrow();
  });

  it("allowlist 필드를 파싱한다 (선택 필드)", () => {
    const conf = minimalConf + "allowlist=Bash,Read\n";
    const result = parseLaneConf(conf);
    expect(result.allowlist).toBeDefined();
  });
});
