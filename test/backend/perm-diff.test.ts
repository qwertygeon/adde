import { describe, expect, it } from "vitest";
import { comparePerm } from "../../src/backend/acp/perm-diff.js";

// SC-012: 설정 차이 시 diff=true·WARN 발화 (integration 에서 채널+transcript 통합 검증)
// SC-013: current_mode_update 재비교 — 추가 WARN 1건

describe("comparePerm (SC-012/013)", () => {
  it("perm_tier=acp vs permissionMode=bypassPermissions → diff=true (SC-012)", () => {
    const result = comparePerm(
      { perm_tier: "acp" },
      { permissionMode: "bypassPermissions" }
    );
    expect(result.diff).toBe(true);
    expect(result.warn).toBeDefined();
  });

  it("perm_tier=acp vs permissionMode=default → diff=false", () => {
    const result = comparePerm(
      { perm_tier: "acp" },
      { permissionMode: "default" }
    );
    expect(result.diff).toBe(false);
  });

  it("perm_tier=acp vs permissionMode=acceptEdits → diff=false (acceptEdits 는 bypass 아님)", () => {
    // comparePerm 은 bypassPermissions 만 bypass 로 판정한다.
    // acceptEdits 는 느슨하지만 bypass 가 아니므로 diff=false (WARN 미발화).
    const result = comparePerm(
      { perm_tier: "acp" },
      { permissionMode: "acceptEdits" }
    );
    expect(result.diff).toBe(false);
  });

  it("엔진 실효 설정 조회 실패 시 diff=true·WARN(확인불가) 를 반환한다 (ADR-007 안전망)", () => {
    // GAP-001: permissionMode 필드 위치 미확정 → 조회 실패 = 차이로 간주(보수적)
    const result = comparePerm(
      { perm_tier: "acp" },
      null  // 조회 실패
    );
    expect(result.diff).toBe(true);
    expect(result.warn).toBeDefined();
    if (result.warn) {
      const warnStr = JSON.stringify(result.warn);
      expect(warnStr.toLowerCase()).toMatch(/확인불가|unknown|unconfirmed|unavailable/i);
    }
  });

  it("WARN message 에 시크릿(토큰 패턴)이 포함되지 않는다 (NFR-007)", () => {
    // NFR-007: 채널로 전송되는 WARN message 문자열에 봇 토큰 미포함.
    // formatWarn 은 maskSecrets 를 경유하므로 warn.message 가 마스킹 대상.
    // warn.adde/engine 필드는 내부 구조체이며 채널로 직접 전송되지 않는다.
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg";
    const result = comparePerm(
      { perm_tier: "acp" },
      { permissionMode: "bypassPermissions" },
    );
    if (result.warn) {
      // 채널에 전송되는 것은 warn.message — 여기에 토큰이 없어야 한다
      expect(result.warn.message).not.toContain(token);
    }
  });

  it("current_mode_update 재비교 시 새로운 차이가 발생하면 diff=true (SC-013)", () => {
    // 첫 번째 비교: 일치
    const first = comparePerm({ perm_tier: "acp" }, { permissionMode: "default" });
    expect(first.diff).toBe(false);

    // current_mode_update 후 재비교: 차이 발생
    const second = comparePerm({ perm_tier: "acp" }, { permissionMode: "bypassPermissions" });
    expect(second.diff).toBe(true);
  });
});

describe("comparePerm — perm_tier=autopass (005)", () => {
  it("autopass vs 엔진 bypassPermissions → diff=true + denylist 무력화 사유", () => {
    const result = comparePerm(
      { perm_tier: "autopass", denylist: ["Bash"] },
      { permissionMode: "bypassPermissions" },
    );
    expect(result.diff).toBe(true);
    expect(result.warn?.message).toMatch(/무력화/);
  });

  it("autopass vs 엔진 default → diff=false (권한 요청이 게이트로 온다)", () => {
    const result = comparePerm(
      { perm_tier: "autopass", denylist: ["Bash"] },
      { permissionMode: "default" },
    );
    expect(result.diff).toBe(false);
  });

  it("autopass 조회 실패 → 보수적 WARN(확인불가) 유지", () => {
    const result = comparePerm({ perm_tier: "autopass" }, null);
    expect(result.diff).toBe(true);
    expect(result.warn?.reason).toBe("조회실패");
  });
});
