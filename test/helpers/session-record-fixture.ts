/**
 * 006 PPG-1 재정합 — `SessionRecord`(src/core/session-store.ts) 리터럴을 만드는 공용 팩토리.
 * 필드가 흩어진 인라인 리터럴은 스키마에 새 필수 필드가 늘 때마다 N개 파일에서 같은 수정을
 * 반복시킨다(006 차수의 rev·stopReason·stoppedAt·stopPending·stopNotePending·notices 추가가
 * 그 실례) — 팩토리 하나로 수렴해 다음 차수의 반복 비용을 없앤다.
 *
 * 기본값은 신규 세션의 프로덕션 기본과 동형으로 잡는다(rev:0·stopReason:null·stoppedAt:null·
 * stopPending:null·stopNotePending:false·notices:[]) — 어긋나면 그 사실이 테스트 실패로
 * 드러나야 하므로 여기서 프로덕션 기본값을 추측하거나 관대하게 두지 않는다.
 */
import type { SessionRecord, SessionStatus } from "../../src/core/session-store.js";

export function makeSessionRecordFixture(
  sid: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  const now = new Date().toISOString();
  return {
    v: 1,
    sid,
    engine: "acp",
    engineRef: null,
    status: "active" as SessionStatus,
    title: null,
    createdAt: now,
    lastActivityAt: now,
    successorOf: null,
    engineArgs: [],
    warnings: [],
    bindings: [],
    rev: 0,
    stopReason: null,
    stoppedAt: null,
    stopPending: null,
    stopNotePending: false,
    notices: [],
    ...overrides,
  };
}
