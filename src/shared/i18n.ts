/**
 * i18n 로케일 결정·조회 SoT — i18next 단일 인스턴스(인라인 en/ko 리소스).
 * 로케일 우선순위: ADDE_LANG > LC_ALL > LC_MESSAGES > LANG > en (POSIX 관행, DEC-002).
 * 모듈 로드 시 동기 초기화 — 진입점(CLI·데몬·테스트)의 명시 init 불요.
 */
import i18next from "i18next";
import { en } from "./locales/en.js";
import { ko } from "./locales/ko.js";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: typeof en };
  }
}

export const SUPPORTED_LOCALES = ["en", "ko"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** `ko_KR.UTF-8` 류 POSIX 값에서 언어 코드만 취한다. 미지원 언어는 undefined. */
function parseLocale(raw: string | undefined): Locale | undefined {
  if (!raw) return undefined;
  const lang = raw.trim().toLowerCase().split(".")[0]?.split("_")[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(lang ?? "")
    ? (lang as Locale)
    : undefined;
}

/** 환경변수에서 로케일 결정. 미지원 값(C·fr 등)은 건너뛰고 다음 후보로 진행한다. */
export function resolveLocale(env: NodeJS.ProcessEnv = process.env): Locale {
  for (const raw of [env.ADDE_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const locale = parseLocale(raw);
    if (locale) return locale;
  }
  return "en";
}

const instance = i18next.createInstance();
void instance.init({
  lng: resolveLocale(),
  fallbackLng: "en",
  initAsync: false,
  resources: { en: { translation: en }, ko: { translation: ko } },
  interpolation: { escapeValue: false },
});

/** 로케일 강제 전환 — 테스트·명시 재설정용. 인라인 리소스라 동기 반영된다. */
export function setLocale(locale: Locale): void {
  void instance.changeLanguage(locale);
}

export function getLocale(): Locale {
  return parseLocale(instance.language) ?? "en";
}

/** 카탈로그 조회. 키·파라미터 타입은 en 리소스에서 유도된다. init 후 캡처 — changeLanguage 를 따라간다(실측 확인). */
export const t = instance.t;

/**
 * 로케일 고정 t — 레인별 채널 메시지용(LaneConf.lang). locale 미지정·미지원 값이면
 * 전역 로케일 추종 t 를 반환한다(옵트인 기본 불변).
 */
export function tFor(locale?: string): typeof t {
  const parsed = parseLocale(locale);
  return parsed ? instance.getFixedT(parsed) : t;
}
