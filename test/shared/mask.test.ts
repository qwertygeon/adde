import { describe, expect, it } from "vitest";
import { maskSecrets } from "../../src/shared/mask.js";

// SC-007: 봇 토큰 마스킹 — 토큰 형식 문자열이 ***로 치환되고 비토큰 텍스트는 불변

// 봇 토큰 패턴: \d{5,}:[A-Za-z0-9_-]{35}  (5자 이상 숫자 + 콜론 + 35자 알파숫자)
// 테스트 토큰은 이 패턴을 충족해야 한다.
const TEST_TOKEN_35 = "AAECBAUGBwgJCgsMDQ4PEBESExQVFhcYGRob"; // 35자 알파숫자
const TEST_TOKEN_35B = "BBECBAUGBwgJCgsMDQ4PEBESExQVFhcYGRob"; // 35자 다른 토큰

describe("maskSecrets (SC-007)", () => {
  it("봇 토큰 패턴 문자열을 *** 로 마스킹한다", () => {
    // 패턴: \d{5,}:[A-Za-z0-9_-]{35}
    const token = `123456789:${TEST_TOKEN_35}`;
    const input = `메시지 본문에 토큰 ${token} 포함`;
    const result = maskSecrets(input);
    expect(result).not.toContain(token);
    expect(result).toContain("***");
  });

  it("비토큰 텍스트는 변경하지 않는다", () => {
    const input = "일반 텍스트 메시지 — 토큰 없음";
    expect(maskSecrets(input)).toBe(input);
  });

  it("토큰이 여러 개 포함된 경우 전부 마스킹한다", () => {
    const token1 = `111111111:${TEST_TOKEN_35}`;
    const token2 = `222222222:${TEST_TOKEN_35B}`;
    const input = `${token1} 그리고 ${token2}`;
    const result = maskSecrets(input);
    expect(result).not.toContain(token1);
    expect(result).not.toContain(token2);
  });

  it("토큰 패턴이 ACP 이벤트 텍스트에 유입되어도 마스킹한다", () => {
    // 트랜스크립트 저장 직전에 mask 를 거치는 경로(SC-007)
    const token = `987654321:${TEST_TOKEN_35}`;
    const acpEvent = `{"type":"agent_message_chunk","content":"token=${token}"}`;
    const result = maskSecrets(acpEvent);
    expect(result).not.toContain(token);
  });
});

describe("maskSecrets 확장 패턴 (011-C)", () => {
  it("API 키 접두(sk-/ghp_)를 마스킹한다", () => {
    const sk = "sk-abcdefghijklmnopqrstuvwx";
    expect(maskSecrets(`키: ${sk} 끝`)).not.toContain(sk);
    const ghp = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(maskSecrets(ghp)).not.toContain(ghp);
  });

  it("Bearer 토큰을 마스킹한다", () => {
    const r = maskSecrets("Authorization: Bearer abcdef12345.token-x");
    expect(r).toContain("Bearer ***");
    expect(r).not.toContain("abcdef12345.token-x");
  });

  it("KEY=값 형태는 값만 마스킹하고 키는 보존한다", () => {
    const r = maskSecrets("API_KEY=supersecretvalue123");
    expect(r).toContain("API_KEY=");
    expect(r).not.toContain("supersecretvalue123");
  });

  it("시크릿 키워드가 없는 평문은 변경하지 않는다", () => {
    const input = "그냥 key 라는 단어가 든 일반 문장";
    expect(maskSecrets(input)).toBe(input);
  });
});
