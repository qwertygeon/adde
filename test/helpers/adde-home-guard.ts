/**
 * 006 — CLI 진입점(`runSession`/`runFactoryReset`)이 `deps.base` 오버라이드를 아직 소비하지
 * 않는 개발 중간 상태(PPG-1)에서도, `defaultBase()`(src/shared/paths.ts)가 읽는
 * `ADDE_HOME` 환경변수를 격리 tmp 경로로 강제해 실 사용자 설정 루트(`~/.config/adde`)를
 * 절대 건드리지 않는다(안전 이중화 — deps.base 가 나중에 배선돼도 무해하다). 실 v0.2.x
 * 데이터가 그 경로에 있으므로 이 격리는 협상 대상이 아니다.
 */
export function installAddeHomeGuard(getBase: () => string): {
  before(): void;
  after(): void;
} {
  let orig: string | undefined;
  return {
    before(): void {
      orig = process.env["ADDE_HOME"];
      process.env["ADDE_HOME"] = getBase();
    },
    after(): void {
      if (orig === undefined) delete process.env["ADDE_HOME"];
      else process.env["ADDE_HOME"] = orig;
    },
  };
}
