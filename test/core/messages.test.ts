import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  buildUsage,
  USAGE,
  LANE_USAGE,
  cmdError,
  laneError,
  unknownLaneSub,
} from "../../src/core/messages.js";

// SC3: messages.ts 가 CLI 사용자 노출 문자열의 SoT.

describe("messages — 도움말/사용법 SoT", () => {
  it("buildUsage 는 명령 표면과 신규 명령(status/doctor/logs)을 노출한다", () => {
    const u = buildUsage();
    expect(u).toContain(COMMANDS.primary);
    expect(u).toContain(COMMANDS.short);
    for (const cmd of ["status", "doctor", "logs", "up", "down", "lane"]) {
      expect(u).toContain(cmd);
    }
  });

  it("USAGE 의 각 명령 사용법은 'adde' 로 시작하는 한 줄", () => {
    for (const line of Object.values(USAGE)) {
      expect(line).toMatch(/^사용법: adde /);
      expect(line).not.toContain("\n");
    }
  });

  it("LANE_USAGE 는 4개 서브커맨드를 모두 포함", () => {
    for (const sub of ["lane add", "lane ls", "lane show", "lane rm"]) {
      expect(LANE_USAGE).toContain(sub);
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
