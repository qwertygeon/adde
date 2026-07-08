import { describe, expect, it } from "vitest";
import { renderPlist } from "../../src/core/launchd.js";

// D-005: renderPlist 출력 직접 검증 — SC-013 (시크릿 비포함)
// 기존 secret-argv.test.ts 는 src 전체 grep — 본 파일은 renderPlist 출력 자체를 검증한다.

// 실제 봇 토큰 패턴(spec SC-013 기준)
const TOKEN_PATTERN = /[0-9]+:[A-Za-z0-9_-]{35,}/;

// plist 렌더 옵션 — 실제 사용 예시에 가까운 값
const baseOpts = {
  nodeBin: "/usr/local/bin/node",
  addeBin: "/usr/local/bin/adde",
  logPath: "/Users/user/.config/adde/myproj/daemon.log",
  autoRestart: true,
};

describe("renderPlist 출력 — 시크릿 비포함 (SC-013)", () => {
  it("renderPlist_출력_토큰_정규식_미검출", () => {
    const xml = renderPlist("myproj", baseOpts);
    expect(xml).not.toMatch(TOKEN_PATTERN);
  });

  it("다양한 proj 이름에서 토큰 패턴 미검출", () => {
    const projs = ["alpha", "beta-test", "proj123", "my-bot"];
    for (const proj of projs) {
      const xml = renderPlist(proj, baseOpts);
      expect(xml).not.toMatch(TOKEN_PATTERN);
    }
  });

  it("ProgramArguments 에 토큰 유사 문자열 미포함", () => {
    const xml = renderPlist("myproj", baseOpts);
    // ProgramArguments 섹션 내에도 토큰 없음
    expect(xml).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(xml).not.toContain("BOT_TOKEN");
  });

  it("EnvironmentVariables 키가 plist 에 없다 — 환경변수 주입 경로 차단", () => {
    const xml = renderPlist("myproj", baseOpts);
    expect(xml).not.toContain("<key>EnvironmentVariables</key>");
  });

  it("plist 는 유효한 XML plist 형식이다", () => {
    const xml = renderPlist("myproj", baseOpts);
    // Apple plist DTD 선언 또는 plist 태그 포함
    expect(xml).toMatch(/<plist/);
    expect(xml).toMatch(/<\/plist>/);
    expect(xml).toContain("<dict>");
  });
});
