/**
 * Surface(L4) 계약 — FR-024·FR-026·FR-027. Surface 는 인바운드 수신·채널 표현·승인 표면화만 소유한다.
 * 노트 산출(렌더)은 L1 투영기 소유(ADR-014) — Surface 는 `deliver`/`onTurnAssigned` 로 마커만 갱신한다.
 */
import type { EngineCaps } from "../engines/types.js";
import type { TurnRef } from "../record/types.js";

export type { TurnRef };

/** 채널 주소와 세션의 연결. 채널은 바인딩만 알고 세션 내부를 모른다. */
export interface Binding {
  surface: string;
  address: string;
  sid: string;
}

export interface OutboundMessage {
  /** 렌더된 노트로의 링크 또는 상태 텍스트. */
  text: string;
  turnRef?: TurnRef;
}

export interface PermRequest {
  reqId: string;
  sid: string;
  tool: string;
  input: unknown;
}

/** Router(L3) 로의 인바운드 진입점 — dispatch(binding, envelope) 로 세션 큐에 적재한다. */
export interface RouterLike {
  dispatch(binding: Binding, env: import("../shared/envelope.js").Envelope): Promise<void>;
}

export interface Surface {
  start(router: RouterLike): Promise<void>;
  stop(): Promise<void>;
  /** 렌더된 노트로의 링크·상태 마커를 전달(FR-024·FR-036). */
  deliver(binding: Binding, msg: OutboundMessage): Promise<void>;
  /** 턴 번호 배정 통지 — `⏳ sending <id>` → `✅ sent [[NNNN <ts>]]` 2단계 전이(ADR-014). */
  onTurnAssigned(binding: Binding, m: { envelopeId: string; turnRef: TurnRef }): Promise<void>;
  /** 권한 요청을 표면화 — 실패는 throw(→ gate 가 deny 로 처리, fail-closed). */
  askPermission(binding: Binding, req: PermRequest): Promise<void>;
  onDecision(cb: (reqId: string, decision: "allow" | "deny") => void): void;
  /** 결정이 이벤트에 기록된 뒤 호출 — 승인 파일 삭제(미호출 시 파일 보존 + 경고, ADR-016). */
  onDecisionRecorded(binding: Binding, reqId: string): Promise<void>;
  /** 팔레트 렌더 항목 — caps 로 조건부(compact) 결정(ADR-030). */
  renderPalette(caps: EngineCaps): string[];
}

export interface SurfaceContext {
  base: string;
  vaultRoot: string;
  proj: string;
  /** L4→L3 의존은 허용된다(design.md 의존 방향). SessionManager·Router 참조는 조립부(daemon)가 주입한다. */
  sessionManager?: import("../core/session-manager.js").SessionManagerWithLoad;
  router?: import("../core/router.js").RouterWithIndex;
  conf?: import("../shared/conf.js").ProjectConf;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ProjectCtx {
  base: string;
  proj: string;
}

export interface SurfaceDoctorInput {
  base: string;
  proj: string;
}

export interface SurfaceDescriptor {
  readonly id: string;
  /** "implemented" 만 factory 를 갖는다 — "stub" 은 바인딩 생성이 거부된다(FR-027). */
  readonly status: "implemented" | "stub";
  factory?: (ctx: SurfaceContext) => Surface;
  validateAddress?: (address: string, ctx: ProjectCtx) => { errors: string[]; warnings: string[] };
  doctorChecks?: (input: SurfaceDoctorInput) => Promise<DoctorCheck[]>;
}
