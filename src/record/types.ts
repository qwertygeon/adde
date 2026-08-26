/**
 * Record Store(L1) 공통 타입 — 대화 이벤트 기록(events.jsonl)의 판별 유니온과 컨텍스트.
 * L1 은 최하위 계층이라 L2/L3/L4 의 타입에 의존하지 않는다(의존 방향 L4→L3→L1, L2→L1).
 */

/** 이 프로젝트·세션 스코프에서 record/* 함수들이 공유하는 컨텍스트. */
export interface RecordCtx {
  /** 설정 루트(session-store 조회 등에 필요). */
  base: string;
  /** 저장소(vault) 루트. */
  vaultRoot: string;
  proj: string;
  sid: string;
  /** 현재 턴 번호 — dedup.classify 등 턴 스코프 함수 호출 시 TurnRunner 가 채워 넘긴다. */
  turn?: number;
  /** 현재 턴 시작 시각(ISO) — dedup 최초 발생 기록 등에 사용. */
  turnStartIso?: string;
}

export interface BlobRef {
  /** `"sha256:<hex>"` */
  blob: string;
  bytes: number;
  mime?: string;
}

/** 턴 참조 — 노트 링크 대상 식별(턴 번호 + 결정론적 턴 시작 시각). L4(surfaces)가 이 타입을 재사용한다. */
export interface TurnRef {
  turn: number;
  turnStartIso: string;
}

/**
 * 이벤트 라인의 `state` 필드가 표현하는 상태 — 영속 SessionRecord.status(4상태) 에 더해
 * 턴 처리 중 회복 가능한 일시적 "오류" 표시를 이벤트 스트림·진단 표면에서만 구분한다
 * (SessionRecord.status 자체는 4상태로 고정 — session-store.ts 참조).
 */
export type SessionEventStatus = "active" | "hibernated" | "detached" | "archived" | "error";

/** 대화 이벤트 기록(events-NNNN.jsonl) 1줄의 판별 유니온(design.md §데이터 모델). */
export type AddeEvent = {
  v: 1;
  sid: string;
  turn: number;
  /** 세션 내 단조 증가 — 세대 경계를 넘어서도 이어진다. */
  seq: number;
  ts: string;
} & (
  | { t: "turn_start"; envelopeId: string; input: { text: string; attachments?: BlobRef[] } }
  | { t: "session"; engineRef: string; resumed: boolean }
  | { t: "text"; role: "assistant"; delta: string }
  | { t: "text_final"; role: "assistant"; text: string | BlobRef }
  | { t: "thinking"; delta: string }
  | { t: "tool_call"; id: string; name: string; input: unknown | BlobRef }
  | { t: "tool_result"; id: string; output: unknown | BlobRef; isError?: boolean }
  | { t: "permission"; reqId: string; tool: string; input: unknown }
  | { t: "permission_decision"; reqId: string; decision: "allow" | "deny"; reason: string }
  | { t: "usage"; input: number; output: number; costUsd?: number }
  | { t: "state"; status: SessionEventStatus; reason: string }
  | { t: "note"; kind: "warning" | "info"; message: string }
  | { t: "error"; message: string; fatal: boolean }
  /** 예약 — 전달 상태를 나중에 이벤트로 표현할 자리(ADR-010, 본 차수 미발화). */
  | { t: "delivered"; surface: string; address: string }
  | { t: "turn_end"; envelopeId: string; stopReason: string; dup?: { of: TurnRef } }
);

export type AddeEventType = AddeEvent["t"];
