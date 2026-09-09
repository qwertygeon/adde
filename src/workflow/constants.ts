/**
 * 워크플로 스토리지 운영 상수(design_v2 15 §9 `sqliteBusyTimeout`) — 이 값을 상수 하나로 모아
 * `src/workflow/**` 전체가 리터럴 복제 없이 참조한다.
 */

/**
 * 모든 SQLite 연결이 명시 지정하는 busy timeout(ms).
 * `node:sqlite` 의 `timeout` 기본값은 0(경합 즉시 실패) — 단일 사용자 로컬 프로세스에서도
 * 동시 요청이 즉시 실패하지 않도록 여유를 둔다.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * 링크된 SQLite 라이브러리 요구 하한.
 * 3.51.3 은 WAL 리셋 결함이 수정된 최초 버전이다.
 */
export const REQUIRED_SQLITE_LIBRARY_VERSION = "3.51.3";
