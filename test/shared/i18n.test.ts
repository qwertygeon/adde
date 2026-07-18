import { describe, expect, it, afterAll } from "vitest";
import { resolveLocale, setLocale, getLocale, t } from "../../src/shared/i18n.js";

const env = (v: Record<string, string>) => v as NodeJS.ProcessEnv;

describe("resolveLocale — 우선순위·POSIX 파싱", () => {
  it("ADDE_LANG 이 최우선", () => {
    expect(
      resolveLocale(env({ ADDE_LANG: "en", LC_ALL: "ko_KR.UTF-8", LANG: "ko_KR.UTF-8" })),
    ).toBe("en");
  });

  it("LC_ALL > LC_MESSAGES > LANG 순서", () => {
    expect(resolveLocale(env({ LC_ALL: "ko_KR.UTF-8", LANG: "en_US.UTF-8" }))).toBe("ko");
    expect(resolveLocale(env({ LC_MESSAGES: "en_US.UTF-8", LANG: "ko_KR.UTF-8" }))).toBe("en");
    expect(resolveLocale(env({ LANG: "ko_KR.UTF-8" }))).toBe("ko");
  });

  it("ko_KR.UTF-8 형태에서 언어 코드만 파싱", () => {
    expect(resolveLocale(env({ LANG: "ko_KR.UTF-8" }))).toBe("ko");
    expect(resolveLocale(env({ LANG: "KO" }))).toBe("ko");
  });

  it("미지원 값(C·fr 등)은 건너뛰고 다음 후보 → 최종 en 폴백", () => {
    expect(resolveLocale(env({ LANG: "C" }))).toBe("en");
    expect(resolveLocale(env({ ADDE_LANG: "fr", LANG: "ko_KR.UTF-8" }))).toBe("ko");
    expect(resolveLocale(env({}))).toBe("en");
  });
});

describe("t/setLocale — 카탈로그 전환", () => {
  afterAll(() => setLocale(resolveLocale()));

  it("ko 로케일에서 한국어, en 로케일에서 영어를 반환한다", () => {
    setLocale("ko");
    expect(getLocale()).toBe("ko");
    // usage.up 본문(플래그 표기 등)은 CLI 표면 변경으로 달라질 수 있어 로케일 판별 접두만 검증.
    expect(t("usage.up")).toMatch(/^사용법: adde up <proj>/);
    setLocale("en");
    expect(getLocale()).toBe("en");
    expect(t("usage.up")).toMatch(/^Usage: adde up <proj>/);
  });

  it("보간 파라미터가 두 로케일에서 모두 치환된다", () => {
    setLocale("ko");
    expect(t("cli.cmdError", { cmd: "up", detail: "x" })).toBe("[adde up] 오류: x");
    setLocale("en");
    expect(t("cli.cmdError", { cmd: "up", detail: "x" })).toBe("[adde up] error: x");
  });
});
