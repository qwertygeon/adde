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

  it("cwd(프로젝트 폴더) 를 파싱한다 — 미지정 시 undefined", () => {
    expect(parseLaneConf(minimalConf).cwd).toBeUndefined();
    const conf = minimalConf + "cwd=/abs/project/dir\n";
    expect(parseLaneConf(conf).cwd).toBe("/abs/project/dir");
  });

  it("chat_id 를 문자열로 보존한다", () => {
    const conf = minimalConf + "chat_id=12345\n";
    expect(parseLaneConf(conf).chat_id).toBe("12345");
  });

  it("markdown 키(root/inbox/approvals/outbox)를 파싱한다", () => {
    const conf =
      "source=markdown\nchannel=markdown\n" +
      "root=/abs/Notes\ninbox=adde/L/inbox.md\napprovals=adde/L/approvals.md\noutbox=adde/L/out/\n";
    const result = parseLaneConf(conf);
    expect(result.source).toBe("markdown");
    expect(result.root).toBe("/abs/Notes");
    expect(result.inbox).toBe("adde/L/inbox.md");
    expect(result.approvals).toBe("adde/L/approvals.md");
    expect(result.outbox).toBe("adde/L/out/");
  });

  it("빈 값 optional 키는 undefined 로 둔다", () => {
    const conf = minimalConf + "cwd=\n";
    expect(parseLaneConf(conf).cwd).toBeUndefined();
  });
});
