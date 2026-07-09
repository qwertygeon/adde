/**
 * 채널 무지 소스 어댑터 인터페이스.
 * 슈퍼바이저가 telegram/markdown 을 동일 시그니처로 다루도록 추상화.
 * 권한 표면화 방식(telegram=inline 버튼, markdown=승인 노트 체크박스)은 구현이 흡수.
 */
import type { PermRequest } from "../gate/gate.js";
import type { LanePaths } from "../shared/paths.js";
import type { LaneConf } from "../shared/conf.js";
import type { RenderHint } from "../core/queue.js";
import type { LaneAddOptions, LaneAddResult } from "../core/lane-config.js";
import type { DoctorCheck } from "../core/diagnostics.js";
import type { Ask } from "../cli/prompt.js";

export type Decision = "allow" | "deny";
export type DecisionCallback = (reqId: string, decision: Decision) => void;

/** enqueue 연속 실패가 이 횟수에 도달하면 운영자에게 1회 알림 — 어댑터 공통 임계. */
export const ENQUEUE_FAIL_THRESHOLD = 3;

/**
 * 소스 팩토리 공통 컨텍스트 — 모든 어댑터가 동일 시그니처로 생성된다.
 * 어댑터별 설정(markdown=root/inbox, telegram=chat_id/allow_from)은 conf 에서 self-resolve 한다.
 */
export interface SourceContext {
  lane: string;
  proj: string;
  engine: string;
  paths: LanePaths;
  conf: LaneConf;
  /** 인바운드 enqueue 직후 호출(injector 깨우기). in-process 신호 — watch 불요. */
  onInbound?: (() => void) | undefined;
}

/** 소스 어댑터 팩토리 — 레지스트리(SOURCE_REGISTRY)가 source id 로 조회해 생성. */
export type SourceFactory = (ctx: SourceContext) => Source;

/** descriptor.validate 입력 — conf 조립 前/後 값을 모두 담아 위치 이동 없이 위임 가능하게 한다. */
export interface SourceValidateInput {
  conf: LaneConf;
  token?: string | undefined;
  opts: LaneAddOptions;
}

export interface SourceValidateResult {
  errors: string[];
  warnings: string[];
}

/** descriptor.doctorChecks 입력 — 미기동 정적 점검(레인별 doctor 루프에서 호출). */
export interface SourceDoctorInput {
  lane: string;
  conf: LaneConf;
  paths: LanePaths;
}

/** descriptor.wizard.collect 에 전달되는 대화형 질의 함수 묶음(cli/prompt.js Prompter 부분집합). */
export interface WizardCtx {
  ask: Ask;
  askSecret?: ((question: string) => Promise<string>) | undefined;
  askPath?: Ask | undefined;
}

export interface SourceWizard {
  /** 소스별 필드 프롬프트 — 공통 필드는 CLI 가 이미 수집한 뒤 호출. */
  collect: (ctx: WizardCtx) => Promise<Partial<LaneAddOptions>>;
  /** 생성 후 힌트(예: telegram 토큰 설정 안내). 표시할 힌트가 없으면 undefined. */
  postCreateHint?: (result: LaneAddResult) => string | undefined;
}

/**
 * source id 1개의 정의 — factory 만 필수, 나머지 훅은 선택. 미제공 훅은 호출부가
 * optional 체이닝으로 생략해 해당 단계를 오류 없이 스킵한다(공통 처리만 수행).
 */
export interface SourceDescriptor {
  factory: SourceFactory;
  /** 소스별 conf 검증 — 하드 오류(errors)는 생성 거부, warnings 는 생성은 하되 안내. */
  validate?: (input: SourceValidateInput) => SourceValidateResult;
  /** 소스별 doctor 진단. */
  doctorChecks?: (input: SourceDoctorInput) => Promise<DoctorCheck[]>;
  /** 소스별 CLI 위저드 프롬프트·생성 후 힌트. */
  wizard?: SourceWizard;
  /**
   * renderOut 이 멱등(재호출 안전)이면 true — 재시작 시 미전송분을 안전하게 재전송(at-least-once).
   * markdown=true(동일 노트 atomicWrite). 미지정=false(비멱등: telegram 등 실 전송) — 이 경우
   * injector 가 `.sending` 저널로 render 진행 중 크래시를 감지해 재전송 대신 불확실 통지 후 종단한다
   * (at-most-once across restart, 중복 전송 방지). 미선언 소스를 비멱등으로 간주해 중복 회피 방향으로 fail-safe.
   */
  deliveryIdempotent?: boolean;
}

export interface Source {
  /** 인바운드 수신 + 아웃바운드(out 감시) 기동. 대상(chat_id/root)은 conf 에서 self-resolve. */
  start(): Promise<void>;
  /** 리스너·watcher 정지 + in-flight 작업 정리 대기(비동기). */
  stop(): Promise<void>;
  /**
   * 권한 요청을 채널에 표면화한다.
   * 실패(전송/쓰기 오류)는 throw → 게이트가 fail-closed deny.
   */
  requestPermission(req: PermRequest): Promise<void>;
  /** 사용자 결정 수신 콜백 등록(telegram=callback_query, markdown=승인 노트 편집 감지). */
  onDecision(cb: DecisionCallback): void;
  /**
   * out/<id>.out (+ sidecar) 를 채널로 렌더한다(telegram=sendMessage, markdown=출력 노트).
   * in-process 호출(injector 가 writeOut 직후) — out/ fs.watch 를 대체. hint 가 있으면 방금
   * 메모리에서 쓴 텍스트·sidecar 를 써서 디스크 재read 를 생략하고, 없으면(크래시 flush) 디스크에서 읽는다.
   */
  renderOut(id: string, hint?: RenderHint): Promise<void>;
  /**
   * 운영 알림(권한 설정 차이 경고·autopass 기동 배너 등)을 채널에 표면화한다
   * (telegram=메시지, markdown=알림 노트). 보조 신호 — 실패는 throw, 호출자가 로그 후 흡수.
   */
  notify(text: string): Promise<void>;
}
