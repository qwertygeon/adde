/**
 * 전 테스트 공통 로케일 고정 — 문구 어서션은 ko 기준이므로 실행 머신·CI 의
 * LANG/LC_* 와 무관하게 결정론을 확보한다. i18n 모듈 import 전에 실행되어야
 * 하므로 setupFiles 로 배선(모듈 로드 시 env 를 읽어 초기화).
 * en 경로는 test/shared/i18n.test.ts 가 setLocale 로 명시 검증한다.
 */
process.env.ADDE_LANG = "ko";
