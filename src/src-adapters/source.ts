/**
 * 채널 무지 소스 어댑터 인터페이스.
 * 슈퍼바이저가 telegram/markdown 을 동일 시그니처로 다루도록 추상화.
 * 권한 표면화 방식(telegram=inline 버튼, markdown=승인 노트 체크박스)은 구현이 흡수.
 */
import type { PermRequest } from "../gate/gate.js";

export type Decision = "allow" | "deny";
export type DecisionCallback = (reqId: string, decision: Decision) => void;

export interface Source {
  /** 인바운드 수신 + 아웃바운드(out 감시) 기동. 대상(chat_id/root)은 conf 에서 self-resolve. */
  start(): void;
  /** 리스너·watcher 정지. */
  stop(): void;
  /**
   * 권한 요청을 채널에 표면화한다.
   * 실패(전송/쓰기 오류)는 throw → 게이트가 fail-closed deny.
   */
  requestPermission(req: PermRequest): Promise<void>;
  /** 사용자 결정 수신 콜백 등록(telegram=callback_query, markdown=승인 노트 편집 감지). */
  onDecision(cb: DecisionCallback): void;
  /**
   * out/<id>.out (+ sidecar) 를 읽어 채널로 렌더한다(telegram=sendMessage, markdown=출력 노트).
   * in-process 호출(injector 가 writeOut 직후) — out/ fs.watch 를 대체(DEC-001).
   */
  renderOut(id: string): Promise<void>;
}
