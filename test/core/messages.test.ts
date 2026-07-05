import { beforeAll, describe, expect, it } from "vitest";
import {
  COMMANDS,
  buildUsage,
  USAGE,
  buildLaneUsage,
  cmdError,
  laneError,
  unknownLaneSub,
} from "../../src/core/messages.js";
import { setLocale } from "../../src/shared/i18n.js";

// SC3: messages.ts 가 CLI 사용자 노출 문자열의 SoT (문구 본문은 i18n 카탈로그 소유).
// 문구 어서션은 로케일 의존 → ko 고정 후 검증(실행 환경 LANG 비의존).

beforeAll(() => setLocale("ko"));

describe("messages — 도움말/사용법 SoT", () => {
  it("buildUsage 는 명령 표면과 신규 명령(status/doctor/logs)을 노출한다", () => {
    const u = buildUsage();
    expect(u).toContain(COMMANDS.primary);
    expect(u).toContain(COMMANDS.short);
    for (const cmd of ["status", "doctor", "logs", "up", "down", "lane"]) {
      expect(u).toContain(cmd);
    }
  });

  it("USAGE 의 각 명령 사용법은 'adde' 로 시작한다(첫 줄)", () => {
    // 대부분 한 줄. completion 은 왜/무엇/어디 설명을 담은 상세 블록이라 여러 줄 허용 —
    // 불변식은 '첫 줄이 사용법: adde 로 시작'.
    for (const usage of Object.values(USAGE)) {
      const firstLine = usage.split("\n")[0] ?? "";
      expect(firstLine).toMatch(/^사용법: adde /);
    }
  });

  it("buildLaneUsage 는 4개 서브커맨드를 모두 포함", () => {
    const laneUsage = buildLaneUsage();
    for (const sub of ["lane add", "lane ls", "lane show", "lane rm"]) {
      expect(laneUsage).toContain(sub);
    }
  });
});

describe("messages — 오류 빌더", () => {
  it("cmdError 는 [adde <cmd>] 오류 형식", () => {
    expect(cmdError("up", "x 실패")).toBe("[adde up] 오류: x 실패");
  });

  it("laneError 는 [adde lane] 접두", () => {
    expect(laneError("이미 존재")).toBe("[adde lane] 이미 존재");
  });

  it("unknownLaneSub 는 입력 서브커맨드와 사용법을 함께 안내", () => {
    const out = unknownLaneSub("frob");
    expect(out).toContain("frob");
    expect(out).toContain("lane add");
  });
});
