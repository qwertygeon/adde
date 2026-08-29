/**
 * 전 테스트 공통 로케일 고정 — 문구 어서션은 ko 기준이므로 실행 머신·CI 의
 * LANG/LC_* 와 무관하게 결정론을 확보한다. i18n 모듈 import 전에 실행되어야
 * 하므로 setupFiles 로 배선(모듈 로드 시 env 를 읽어 초기화).
 * en 경로는 test/shared/i18n.test.ts 가 setLocale 로 명시 검증한다.
 */
process.env.ADDE_LANG = "ko";

import { afterEach } from "vitest";
import { __drainLiveSessionManagers } from "./helpers/v2-fixtures.js";

/**
 * `makeSessionManagerDeps()`+`bindSessionManager()` 로 등록된 SessionManager 전부를 매 테스트
 * 뒤 일괄 `shutdown()` 한다(GAP-018 구조적 정리 — 개별 테스트가 정리를 잊어도 idle/보관 스윕(60s)·
 * control 드레인(2s) 실 인터벌이 다음 테스트로 새지 않는다). 레지스트리에 등록되지 않은 인스턴스
 * (개별 `sm.shutdown()` 을 직접 호출하는 기존 파일들)에는 영향 없음(no-op 안전).
 */
afterEach(async () => {
  await __drainLiveSessionManagers();
});
