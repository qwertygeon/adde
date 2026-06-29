import { describe, it, expect } from "vitest";
import { formatBlock, formatException } from "../../src/shared/notify.js";

describe("notify — 액션형 알림 포매터 (SC7/DEC-007)", () => {
  it("formatBlock 은 [ADDE 차단] 상황 + 조치 2요소를 포함한다", () => {
    const out = formatBlock({
      situation: "엔진이 정책보다 느슨함",
      action: "bypass 해제 후 재기동",
    });
    expect(out).toContain("[ADDE 차단]");
    expect(out).toContain("엔진이 정책보다 느슨함");
    expect(out).toContain("↳ 조치:");
    expect(out).toContain("bypass 해제 후 재기동");
  });

  it("formatException 은 [ADDE 오류] 상황 + 조치 2요소를 포함한다", () => {
    const out = formatException({ situation: "spawn 실패", action: "pnpm install 후 재시도" });
    expect(out).toContain("[ADDE 오류]");
    expect(out).toContain("spawn 실패");
    expect(out).toContain("↳ 조치:");
    expect(out).toContain("pnpm install 후 재시도");
  });

  it("상황 텍스트의 시크릿(봇 토큰)은 마스킹된다", () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi"; // 패턴 일치(콜론 뒤 35자)
    const out = formatException({ situation: `토큰 ${token} 노출`, action: "조치" });
    expect(out).not.toContain(token);
    expect(out).toContain("***");
  });
});
