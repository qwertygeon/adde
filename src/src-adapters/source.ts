/**
 * 채널 무지 소스 어댑터 인터페이스.
 * 슈퍼바이저가 telegram/markdown 을 동일 시그니처로 다루도록 추상화.
 * 권한 표면화 방식(telegram=inline 버튼, markdown=승인 노트 체크박스)은 구현이 흡수.
 */
import type { PermRequest } from "../gate/gate.js";

export type Decision = "allow" | "deny";
export type DecisionCallback = (reqId: string, decision: Decision) => void;

/** enqueue 연속 실패가 이 횟수에 도달하면 운영자에게 1회 알림 — 어댑터 공통 임계. */
export const ENQUEUE_FAIL_THRESHOLD = 3;

export interface Source {
  /** 인바운드 수신 + 아웃바운드(out 감시) 기동. 대상(chat_id/root)은 conf 에서 self-resolve. */
  start(): void;
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
   * out/<id>.out (+ sidecar) 를 읽어 채널로 렌더한다(telegram=sendMessage, markdown=출력 노트).
   * in-process 호출(injector 가 writeOut 직후) — out/ fs.watch 를 대체.
   */
  renderOut(id: string): Promise<void>;
  /**
   * 운영 알림(권한 설정 차이 경고·autopass 기동 배너 등)을 채널에 표면화한다
   * (telegram=메시지, markdown=알림 노트). 보조 신호 — 실패는 throw, 호출자가 로그 후 흡수.
   */
  notify(text: string): Promise<void>;
}
