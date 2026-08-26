/**
 * EngineDriver(L2) 계약 — FR-020·FR-021·NFR-002. 코어는 `EngineDriver`·`EngineCaps` 만 보고
 * 엔진 정체를 모른다(A-P007). 엔진 id 리터럴 비교 분기는 `src/engines/**` 안에만 존재해야 한다.
 */

/** 엔진이 스스로 밝히는 지원 범위 — 코어는 이 선언만 참조해 동작을 결정한다. */
export interface EngineCaps {
  /** 재개 핸들만으로 세션을 다시 열 수 있는가(FR-006·FR-008). */
  resume: "native" | "none";
  /** 권한 요청 처리 방식(FR-023) — "callback" 만 대화형 승인 지원. */
  permission: "callback" | "policy-only" | "none";
  streaming: boolean;
  /** 사용량(usage) 이벤트 제공 여부. */
  usage: boolean;
  /** 컨텍스트 압축 지원 방식(FR-038) — "none" 이면 팔레트에 compact 항목을 렌더하지 않는다. */
  compact: "native" | "prompt" | "none";
  attachments: readonly ("image" | "file")[];
}

export interface PermPolicy {
  perm_tier: string;
  allowlist: readonly string[];
  denylist: readonly string[];
  hard_deny: readonly string[];
  gate_timeout_sec?: number;
}

export interface OpenCtx {
  cwd: string;
  /** 재개 핸들. 있으면 재개를 시도하고, 실패는 throw(새 세션 폴백 금지 — ADR-009). */
  engineRef?: string | undefined;
  args?: readonly string[] | undefined;
  lang?: string | undefined;
  policy: PermPolicy;
  /** 권한 설정 차이 표기 등(ADR-022) — 보조 경고. */
  onWarn?: ((msg: string) => void) | undefined;
  /** 엔진 진단 로그(stderr) 캡처 경로 — 지정 시 회전 허용(FR-043, 계약 외 보조 필드). */
  stderrLogPath?: string | undefined;
}

/** 정규화된 엔진 이벤트 — record/events.ts 의 AddeEvent 판별 유니온과 대응한다(엔진별 원본 페이로드는
 * 드라이버 내부에만 존재 — 코어는 정규화된 형태만 본다, NFR-002). */
export type EngineEvent =
  | { t: "text"; delta: string }
  | { t: "text_final"; text: string }
  | { t: "thinking"; delta: string }
  | { t: "tool_call"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; output: unknown; isError?: boolean }
  | { t: "permission"; reqId: string; tool: string; input: unknown }
  | { t: "usage"; input: number; output: number; costUsd?: number }
  | { t: "error"; message: string; fatal: boolean };

export interface EngineSession {
  /** 엔진 native 세션 식별자 — ADDE 가 영속하여 나중에 재개한다. */
  readonly engineRef: string;
  /** 스트림 종료 = 턴 종료. */
  send(input: { text: string }): AsyncIterable<EngineEvent>;
  respondPermission(reqId: string, decision: "allow" | "deny"): Promise<void>;
  compact?(): Promise<void>;
  close(): Promise<void>;
  onExit(cb: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): void;
  isAlive(): boolean;
}

export interface EngineDoctorInput {
  cwd: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface EngineDriverDescriptor {
  readonly id: string;
  readonly caps: EngineCaps;
  /** engineRef 있으면 재개, 실패는 throw(폴백 금지). */
  open(ctx: OpenCtx): Promise<EngineSession>;
  doctorChecks?(input: EngineDoctorInput): Promise<DoctorCheck[]>;
}
