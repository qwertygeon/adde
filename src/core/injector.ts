/**
 * 직렬 idle 게이트·dedup·turn 라이프사이클 루프.
 * FR-004/005/011/ADR-003: state=idle|active. active 동안 다음 envelope 미주입.
 * 크래시 재개: 기동 시 scanProcessing → 각 id 에 isDone? 스킵 : 재처리.
 * 응답 캡처(DEC-002): backend.inject() resolve(=turn 종료) 시 누적 응답을 writeOut + 렌더 트리거 → 다음 큐 진행.
 *   turn 종료 신호는 inject() resolve 로 감지한다(conn.prompt 가 turn 종료에 resolve) — 별도 idleCallback 배선 불요.
 */
import { t } from "../shared/i18n.js";
import type { NotifyT } from "../shared/notify.js";
import { readFile } from "node:fs/promises";
import { appendTranscript } from "./transcript.js";
import { recordSession, touchSession, readLedger, formatWhen } from "./session-ledger.js";
import { errMsg } from "../shared/errors.js";
import {
  claimNext,
  scanProcessing,
  isDone,
  writeOut,
  writeFailed,
  processingFilePath,
  markSent,
  isSent,
  findUnsent,
  quarantineCorrupt,
} from "./queue.js";
import type { OutSidecar } from "./queue.js";
import type { LanePaths } from "../shared/paths.js";
import type { AcpBackend } from "../backend/acp/client.js";
import type { SessionEvent } from "./transcript.js";
import { maskSecrets } from "../shared/mask.js";
import { parseEnvelope } from "../shared/envelope.js";
import type { Envelope } from "../shared/envelope.js";

export type InjectorState = "idle" | "active";

/** 처리 결과를 채널로 렌더하는 in-process 콜백(소스 renderOut 주입). 실패는 흡수(durable out/ 유지). */
export type RenderCallback = (id: string) => Promise<void>;

/**
 * 주입 실패를 채널로 표면화하는 콜백(supervisor 가 Source.notify 로 배선).
 * 보조 신호 — 알림 실패는 로그 후 흡수하고 .failed 사이드카·재처리 경로는 그대로 유지.
 */
export type FailNotifyCallback = (id: string, detail: string) => Promise<void>;

export interface Injector {
  start(): Promise<void>;
  /** enqueue 등 외부 신호로 idle 레인을 깨워 다음 메시지를 처리한다(in-process, watch 불요). */
  notify(): void;
  /** backend 세션 이벤트 수신 — active turn 의 agent_message_chunk 텍스트를 누적. */
  onSessionEvent(event: SessionEvent): void;
  getState(): InjectorState;
}

/** agent_message_chunk 이벤트 종류 판정(ACP sessionUpdate / 단순 type 양식 모두). */
function isAgentMessageChunk(event: SessionEvent): boolean {
  const kind =
    "sessionUpdate" in event && typeof event["sessionUpdate"] === "string"
      ? event["sessionUpdate"]
      : "type" in event && typeof event["type"] === "string"
        ? event["type"]
        : "";
  return kind === "agent_message_chunk";
}

/** 질문 발췌(첫 줄 80자, 마스킹) — 채널 렌더 헤더의 맥락 표시용 보조 정보. */
export function questionExcerpt(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const masked = maskSecrets(firstLine.trim());
  return masked.length > 80 ? `${masked.slice(0, 79)}…` : masked;
}

/** agent_message_chunk content 에서 텍스트 추출(string | {type,text}). */
function chunkText(event: SessionEvent): string {
  const raw = event["content"];
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const c = raw as { type?: string; text?: string };
    return c.type === "text" ? (c.text ?? "") : "";
  }
  return "";
}

export function createInjector(
  paths: LanePaths,
  lane: string,
  backend: AcpBackend,
  render?: RenderCallback,
  onFail?: FailNotifyCallback,
  /** 제어 결과 등 채널 대면 문구의 로케일(레인 lang). 미지정 시 전역 t. */
  laneT: NotifyT = t,
): Injector {
  let state: InjectorState = "idle";
  let responseText = "";
  // claim→처리 진입을 직렬화(E4): idle 체크와 processOne(state=active) 사이의 두 await(claimNext·isDone)
  // 창에서 두 injectNext 가 각각 다른 메시지를 claim 해 동시 turn 이 뜨는 경합 방지(rename 은 동일
  // 메시지 중복만 막음). advancing 은 injectNext 전 구간을 감싸 한 번에 하나만 진행하게 한다.
  let advancing = false;
  // 전송 중인 id — start() 의 flushUnsent 는 advancing 가드 밖이라, 기동 중 notify 발 injectNext 의
  // flushUnsent 와 동시 진입할 수 있다. deliver 진입 가드(in-flight Set + isSent 재확인)로 같은 응답의
  // 이중 전송(중복 render)을 차단한다.
  const delivering = new Set<string>();

  function onSessionEvent(event: SessionEvent): void {
    if (state !== "active") return;
    if (isAgentMessageChunk(event)) responseText += chunkText(event);
  }

  /** state/<lane>/session.id 읽기 — 장부 갱신용(부재 시 null, 보조 데이터). */
  async function currentSessionId(): Promise<string | null> {
    try {
      return (await readFile(paths.sessionIdFile, "utf8")).trim() || null;
    } catch {
      return null;
    }
  }

  /** 제어 요청 수행 — 채널 통지 문구를 반환(레인 로케일). 실패는 throw(처리부 공통 실패 경로). */
  async function runControl(envelope: Envelope): Promise<string> {
    const control = envelope.control!;
    switch (control.kind) {
      case "clear": {
        if (!backend.reset) return laneT("injector.control.unsupported");
        let sessionId: string;
        try {
          ({ sessionId } = await backend.reset(lane));
        } catch (err) {
          // 재기동 실패 = 레인 엔진 사망 가능 — 일반 실패와 구분해 복구 절차를 명시 통지.
          console.error(t("log.injector.relaunchError", { lane, error: errMsg(err) }));
          return laneT("injector.control.relaunchFailed", { error: maskSecrets(errMsg(err)) });
        }
        await recordSession(paths, sessionId).catch(() => {});
        return laneT("injector.control.cleared");
      }
      case "compact": {
        // 엔진 위임(DEC-001) — 슬래시 텍스트를 그대로 주입하면 엔진이 compaction 수행.
        // 어댑터가 커맨드 출력을 삼키므로(local-command-stdout) 완료 통지는 여기서 생성.
        await backend.inject(lane, "/compact");
        const sid = await currentSessionId();
        if (sid) await touchSession(paths, sid).catch(() => {});
        return laneT("injector.control.compacted");
      }
      case "resume": {
        if (!backend.resumeSession) return laneT("injector.control.unsupported");
        if (!control.sessionId) return laneT("injector.control.resumeMissing");
        let r: { sessionId: string; resumed: boolean };
        try {
          r = await backend.resumeSession(lane, control.sessionId);
        } catch (err) {
          console.error(t("log.injector.relaunchError", { lane, error: errMsg(err) }));
          return laneT("injector.control.relaunchFailed", { error: maskSecrets(errMsg(err)) });
        }
        await recordSession(paths, r.sessionId).catch(() => {});
        return r.resumed
          ? laneT("injector.control.resumed", { id: r.sessionId })
          : laneT("injector.control.resumeFallback", { id: control.sessionId });
      }
      case "sessions": {
        const entries = await readLedger(paths);
        if (entries.length === 0) return laneT("injector.control.sessionsEmpty");
        const current = await currentSessionId();
        const lines = entries.map((e, i) => {
          const label = e.label ?? laneT("injector.control.sessionsNoLabel");
          const mark = e.id === current ? " ◀" : "";
          return (
            laneT("injector.control.sessionsItem", {
              n: i + 1,
              label,
              last: formatWhen(e.lastActivityAt),
              id: e.id,
            }) + mark
          );
        });
        return `${laneT("injector.control.sessionsHeader")}\n${lines.join("\n")}\n\n${laneT("injector.control.sessionsHint")}`;
      }
    }
  }

  /** 한 메시지의 turn 을 처리: inject → (turn 종료) 응답 기록 + 렌더. 제어 envelope 는 세션 제어로 분기. */
  async function processOne(id: string, envelope: Envelope): Promise<void> {
    state = "active";
    responseText = "";
    try {
      if (envelope.control) {
        const message = await runControl(envelope);
        await appendTranscript(paths, {
          sessionUpdate: "adde_control",
          message: `${envelope.control.kind}: ${message}`,
        }).catch(() => {});
        const sidecar: OutSidecar = { ts: new Date().toISOString(), origin_ts: envelope.ts };
        if (envelope.reply_ref?.channel_msg_id) {
          sidecar.reply_ref = { channel_msg_id: envelope.reply_ref.channel_msg_id };
        }
        await writeOut(paths, id, message, sidecar);
        await deliver(id);
        return;
      }
      await backend.inject(lane, envelope.text);
      // inject resolve = turn 종료 — 누적 응답을 마스킹 후 out 기록(DEC-003) + 렌더(DEC-002).
      const sidecar: OutSidecar = { ts: new Date().toISOString(), origin_ts: envelope.ts };
      if (envelope.reply_ref?.channel_msg_id) {
        sidecar.reply_ref = { channel_msg_id: envelope.reply_ref.channel_msg_id };
      }
      const question = questionExcerpt(envelope.text);
      if (question.length > 0) sidecar.question = question;
      await writeOut(paths, id, maskSecrets(responseText), sidecar);
      await deliver(id);
      // 세션 장부 갱신(보조): 마지막 대화 시각 + 미기재 시 첫 프롬프트 발췌를 라벨로.
      const sid = await currentSessionId();
      if (sid) await touchSession(paths, sid, question || undefined).catch(() => {});
    } catch (err) {
      const detail = errMsg(err);
      console.error(t("log.injector.injectError", { lane, id, detail }));
      // 실패를 .failed 사이드카로 보존(E1) — processing/<id>.msg 는 남아 재기동 시 재처리(at-least-once).
      await writeFailed(
        paths,
        id,
        t("injector.injectFailed", { ts: new Date().toISOString(), detail }),
      ).catch((e: unknown) =>
        console.error(
          t("log.injector.failedWriteFail", {
            lane,
            id,
            error: errMsg(e),
          }),
        ),
      );
      // 실패를 채널에도 표면화(보조) — 노트/메시지 없이 조용히 사라진 것처럼 보이는 것을 방지.
      if (onFail) {
        await onFail(id, detail).catch((e: unknown) =>
          console.error(
            t("log.injector.failNotifyError", {
              lane,
              id,
              error: errMsg(e),
            }),
          ),
        );
      }
    } finally {
      state = "idle";
      responseText = "";
    }
  }

  /**
   * 응답을 채널로 전송하고 성공 시 .sent 마커 기록(DEC-001/002).
   * render 실패(부분 청크 실패 포함)는 .sent 미기록 → out/ 에 durable 하게 남아 재전송 대상(flushUnsent).
   */
  async function deliver(id: string): Promise<void> {
    // 이중 전송 가드: in-flight 클레임은 await 이전에 동기적으로 잡아야 두 동시 호출이 모두 통과하는
    // 창이 없다. add 후 .sent 재확인으로 직전(완료된) flush 가 이미 보낸 경우(stale 목록)도 건너뛴다.
    if (delivering.has(id)) return;
    delivering.add(id);
    try {
      if (await isSent(paths, id)) return;
      if (!render) {
        // 렌더 대상 없음(예: chat_id 미설정) — 전송 개념 부재로 즉시 종결 처리.
        await markSent(paths, id);
        return;
      }
      await render(id);
      await markSent(paths, id);
    } catch (err) {
      console.error(
        t("log.injector.renderError", {
          lane,
          id,
          error: errMsg(err),
        }),
      );
    } finally {
      delivering.delete(id);
    }
  }

  /** out/ 에 응답은 있으나(.out) 미전송(.sent 부재)인 항목 재전송 — render 실패·크래시 복구. */
  async function flushUnsent(): Promise<void> {
    const ids = await findUnsent(paths);
    for (const id of ids) await deliver(id);
  }

  /** 다음 injectNext 를 비동기 예약 — rejection(예: 일시적 fs 오류)은 로깅(unhandled 방지). */
  function scheduleNext(): void {
    setImmediate(() => {
      void injectNext().catch((err: unknown) => {
        console.error(
          t("log.injector.advanceError", {
            lane,
            error: errMsg(err),
          }),
        );
      });
    });
  }

  async function injectNext(): Promise<void> {
    if (state !== "idle" || advancing) return;
    advancing = true;
    try {
      // 미전송(.out 있고 .sent 부재) 응답을 먼저 재전송 — render 실패·크래시 복구(FR-1).
      await flushUnsent();

      const claimed = await claimNext(paths);
      if (!claimed) return;

      const { id, envelope } = claimed;

      if (await isDone(paths, id)) {
        // dedup: out 이미 존재 → prompt 미호출, 다음으로 진행.
        scheduleNext();
        return;
      }

      await processOne(id, envelope);
      // turn 종료 후 다음 큐 메시지로 진행(FR-A2).
      scheduleNext();
    } finally {
      advancing = false;
    }
  }

  async function start(): Promise<void> {
    // 크래시 재개: 응답은 기록됐으나 미전송된 항목 먼저 재전송(FR-1).
    await flushUnsent();
    // processing 잔존 파일을 순차 재처리.
    const pendingIds = await scanProcessing(paths);
    for (const id of pendingIds) {
      if (await isDone(paths, id)) continue; // dedup — 이미 out 있음
      let envelope: Envelope;
      try {
        const { readFile } = await import("node:fs/promises");
        envelope = parseEnvelope(await readFile(processingFilePath(paths, id), "utf8"));
      } catch (err) {
        // 손상 메시지 — 격리 후 다음으로(매 기동 동일 파싱오류 반복 차단, FR-2).
        await quarantineCorrupt(paths, id, err);
        continue;
      }
      await processOne(id, envelope); // processOne 은 자체 try/catch(.failed)로 throw 하지 않음
    }
    await injectNext();
  }

  function notify(): void {
    scheduleNext();
  }

  function getState(): InjectorState {
    return state;
  }

  return { start, notify, onSessionEvent, getState };
}

export { writeOut };
