/**
 * 직렬 idle 게이트·dedup·turn 라이프사이클 루프.
 * state=idle|active. active 동안 다음 envelope 미주입.
 * 크래시 재개: 기동 시 scanProcessing → 각 id 에 isDone? 스킵 : 재처리.
 * 응답 캡처: backend.inject() resolve(=turn 종료) 시 누적 응답을 writeOutBody+setDone + 렌더 트리거 →
 *   다음 큐 진행. turn 종료 신호는 inject() resolve 로 감지한다(conn.prompt 가 turn 종료에 resolve) —
 *   별도 idleCallback 배선 불요.
 * out-상태(done/sending/sent/aborted/failed)는 out-ledger.ts 가 SSOT.
 * 진행 직렬화는 단일 runLoop promise chain 이 담당(single-flight) — 과거
 * advancing bool·delivering Set·setImmediate 자기예약 3중 가드를 대체한다.
 */
import { t } from "../shared/i18n.js";
import type { NotifyT } from "../shared/notify.js";
import { readFile } from "node:fs/promises";
import { appendTranscript } from "./transcript.js";
import { recordSession, touchSession, readLedger, formatWhen } from "./session-ledger.js";
import { errMsg } from "../shared/errors.js";
import { claimNext, scanProcessing, processingFilePath, clearProcessing, quarantineCorrupt } from "./queue.js";
import {
  isDone,
  writeOutBody,
  setDone,
  setFailed,
  setSent,
  setSending,
  setAborted,
  findUnsent,
  getEntry,
  migrateLegacyOut,
  TERMINAL_STATES,
  projectSidecar,
} from "./out-ledger.js";
import type { OutSidecar, RenderHint } from "./out-ledger.js";
import type { LanePaths } from "../shared/paths.js";
import type { AcpBackend } from "../backend/acp/client.js";
import type { SessionEvent } from "./transcript.js";
import { maskSecrets } from "../shared/mask.js";
import { parseEnvelope } from "../shared/envelope.js";
import type { Envelope } from "../shared/envelope.js";

export type InjectorState = "idle" | "active";

/** 처리 결과를 채널로 렌더하는 in-process 콜백(소스 renderOut 주입). 실패는 흡수(durable out/ 유지).
 * hint 는 방금 메모리에서 쓴 텍스트·sidecar(디스크 재read 생략, M7) — flush 재전송 경로엔 없다. */
export type RenderCallback = (id: string, hint?: RenderHint) => Promise<void>;

/**
 * 주입 실패를 채널로 표면화하는 콜백(supervisor 가 Source.notify 로 배선).
 * 보조 신호 — 알림 실패는 로그 후 흡수하고 ledger state=failed·재처리 경로는 그대로 유지.
 */
export type FailNotifyCallback = (id: string, detail: string) => Promise<void>;

/** 전송 dedup 옵션(소스별). SourceDescriptor.deliveryIdempotent 에서 supervisor 가 파생해 주입. */
export interface DeliveryOptions {
  /**
   * renderOut 이 멱등(재호출 안전)이면 true — state=sending 저널을 쓰지 않고 재시작 재전송을 허용한다
   * (at-least-once, markdown). 기본 false(비멱등, telegram 등): render 직전 state=sending 을 남겨
   * render 진행 중 크래시를 재시작 시 "전달 불확실"로 판정하고 재전송 대신 통지 후 종단한다(at-most-once).
   */
  idempotent?: boolean;
  /** 전달 불확실(render 진행 중 크래시) 종단 시 채널 통지(보조 — 실패는 로그 후 흡수). */
  onUncertain?: (id: string) => Promise<void>;
}

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
  /** 소스별 전송 dedup 옵션(멱등성·불확실 통지). 미지정 = 비멱등(중복 회피 방향 fail-safe). */
  delivery: DeliveryOptions = {},
): Injector {
  const idempotentDelivery = delivery.idempotent ?? false;
  const onDeliveryUncertain = delivery.onUncertain;
  let state: InjectorState = "idle";
  let responseText = "";
  // 진행 직렬화(single-flight) — notify()·turn 종료 후속 진행·start() 의 초기 진행을 모두 이 체인에
  // 편입해 단일 진행을 보장한다. 각 스텝은 자체 catch 로 흡수해 체인이 죽지 않는다(re-arm 불요 —
  // runLoop 자체가 항상 resolve 하므로 다음 enqueueStep 이 정상 이어진다).
  let runLoop: Promise<void> = Promise.resolve();
  // 미전송(state=done|sending) id 의 in-memory 추적(M5) — flushUnsent 가 매 턴 ledger 를 O(n) 재조회
  // 하지 않도록. start() 에서 findUnsent 로 1회 시드(크래시 복구), 이후 setDone→add / setSent(등
  // 종단)→delete 로 injector 가 단독 갱신한다. 재전송 대상은 이 집합만 순회한다.
  const unsent = new Set<string>();

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
        // 엔진 위임 — 슬래시 텍스트를 그대로 주입하면 엔진이 compaction 수행.
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

  /**
   * 응답을 채널로 전송하고 성공 시 state=sent 전이. entry.state∈TERMINAL 재확인은 stale(직전
   * flush 가 이미 종단 처리)에 대비한 방어 — 진행이 단일 체인으로 완전 직렬화된 상태에서도 유지한다.
   * 멱등 소스(markdown): state=sending 미경유 → render 실패해도 state=done 유지 → 다음 flush 재전송
   * (at-least-once). 비멱등 소스(telegram): render 직전 state=sending 저널 — 재시작 잔존 또는
   * 같은 프로세스의 markSent-throw edge(설정 직후 커밋 실패) 시 다음 진입에서 전달 불확실로 판정해
   * 재전송 대신 통지 후 state=aborted 종단(at-most-once across restart). 프로세스 내 render 실패는
   * state=done 으로 되돌려 다음 flush 가 정상 재시도한다(at-least-once within one process life).
   */
  async function deliver(id: string, hint?: RenderHint): Promise<void> {
    try {
      const entry = await getEntry(paths, id);
      if (!entry || TERMINAL_STATES.has(entry.state)) {
        unsent.delete(id); // 직전 flush 가 이미 종단 처리했거나 entry 부재(stale) — 추적 해제
        return;
      }
      if (!idempotentDelivery && entry.state === "sending") {
        if (onDeliveryUncertain) {
          await onDeliveryUncertain(id).catch((e: unknown) =>
            console.error(t("log.injector.uncertainNotifyError", { lane, id, error: errMsg(e) })),
          );
        }
        await setAborted(paths, id); // 종단(findUnsent 제외) → 재시작마다 반복 통지 없음
        unsent.delete(id);
        return;
      }
      if (!render) {
        // 렌더 대상 없음(예: chat_id 미설정) — 전송 개념 부재로 즉시 종결 처리.
        await setSent(paths, id);
        unsent.delete(id);
        return;
      }
      if (!idempotentDelivery) await setSending(paths, id); // render 직전 저널(크래시 감지 앵커)
      try {
        await render(id, hint);
      } catch (err) {
        // 프로세스 내 render 실패 — 저널을 done 으로 되돌린 후 재던짐. 재시작이 아니므로 다음 턴
        // flush 가 정상 재시도(at-least-once within process). sidecar 는 현재 entry 에서 투영해
        // reply_ref/origin_ts/question 을 잃지 않는다.
        if (!idempotentDelivery) {
          await setDone(paths, id, projectSidecar(entry));
        }
        throw err;
      }
      await setSent(paths, id);
      unsent.delete(id); // 전송 확정 → 미전송 추적 해제(render 실패 시엔 남겨 재전송)
    } catch (err) {
      console.error(
        t("log.injector.renderError", {
          lane,
          id,
          error: errMsg(err),
        }),
      );
    }
  }

  /** 미전송 in-memory 집합만 순회 재전송(M5) — ledger O(n) 재조회 없음. deliver 성공 시 집합에서
   * 제거된다. hint 없이 호출 → 어댑터가 디스크에서 읽는다(재전송 시점엔 메모리 텍스트가 없으므로 정상). */
  async function flushUnsent(): Promise<void> {
    for (const id of [...unsent]) await deliver(id);
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
        // body-first → ledger done 전이(commit point): 두 쓰기 사이 크래시해도 리더는
        // "전이 전"(entry 부재) 상태만 관측한다.
        await writeOutBody(paths, id, message);
        await setDone(paths, id, sidecar);
        unsent.add(id); // done 기록됨 → 전송 확인 전까지 미전송 추적(M5)
        await clearProcessing(paths, id); // out durable → processing/<id>.msg 잉여(dedup 앵커=ledger)
        await deliver(id, { text: message, sidecar });
        return;
      }
      await backend.inject(lane, envelope.text);
      // inject resolve = turn 종료 — 누적 응답을 마스킹 후 body+ledger 기록 + 렌더.
      const sidecar: OutSidecar = { ts: new Date().toISOString(), origin_ts: envelope.ts };
      if (envelope.reply_ref?.channel_msg_id) {
        sidecar.reply_ref = { channel_msg_id: envelope.reply_ref.channel_msg_id };
      }
      const question = questionExcerpt(envelope.text);
      if (question.length > 0) sidecar.question = question;
      const outText = maskSecrets(responseText);
      await writeOutBody(paths, id, outText);
      await setDone(paths, id, sidecar);
      unsent.add(id); // done 기록됨 → 전송 확인 전까지 미전송 추적(M5)
      await clearProcessing(paths, id); // out durable → processing/<id>.msg 잉여(dedup 앵커=ledger)
      await deliver(id, { text: outText, sidecar });
      // 세션 장부 갱신(보조): 마지막 대화 시각 + 미기재 시 첫 프롬프트 발췌를 라벨로.
      const sid = await currentSessionId();
      if (sid) await touchSession(paths, sid, question || undefined).catch(() => {});
    } catch (err) {
      const detail = errMsg(err);
      console.error(t("log.injector.injectError", { lane, id, detail }));
      // 실패를 ledger state=failed 로 보존(가시성) — processing/<id>.msg 는 남아 재기동 시
      // 재처리(at-least-once). done 이 아니므로 dedup 대상이 아니다.
      await setFailed(
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

  /** 체인에 다음 스텝을 편입 — 이전 스텝의 성공/실패와 무관하게 이어 실행되어 체인이 끊기지 않는다. */
  function enqueueStep<T>(fn: () => Promise<T>): Promise<T> {
    const result = runLoop.then(fn, fn);
    runLoop = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 체인 1 스텝: flushUnsent → claimNext → (dedup? clearProcessing : processOne). 처리 후 다음
   * 메시지가 남아있을 수 있으므로 스스로 다음 스텝을 예약한다(자기 연쇄 — 큐가 빌 때까지 진행). */
  async function drainOnce(): Promise<void> {
    await flushUnsent();
    const claimed = await claimNext(paths);
    if (!claimed) return;
    const { id, envelope } = claimed;
    if (await isDone(paths, id)) {
      // dedup: ledger 상태가 이미 done 계열 → prompt 미호출. 방금 claim 한 processing/<id>.msg 는
      // 잉여라 정리(M5).
      await clearProcessing(paths, id);
    } else {
      await processOne(id, envelope);
    }
    scheduleStep();
  }

  function scheduleStep(): void {
    enqueueStep(drainOnce).catch((err: unknown) => {
      console.error(t("log.injector.advanceError", { lane, error: errMsg(err) }));
    });
  }

  async function start(): Promise<void> {
    await migrateLegacyOut(paths); // 1회성 — findUnsent 시드·scanProcessing 이전에 수행
    // 크래시 재개: 응답은 기록됐으나 미전송된 항목을 ledger 에서 1회 시드(이후엔 in-memory 로만 추적, M5).
    for (const id of await findUnsent(paths)) unsent.add(id);

    await enqueueStep(async () => {
      await flushUnsent();
      // processing 잔존 파일을 순차 재처리.
      const pendingIds = await scanProcessing(paths);
      for (const id of pendingIds) {
        if (await isDone(paths, id)) {
          await clearProcessing(paths, id); // 이미 done 있음 → 잉여 processing 정리(M5)
          continue;
        }
        let envelope: Envelope;
        try {
          envelope = parseEnvelope(await readFile(processingFilePath(paths, id), "utf8"));
        } catch (err) {
          // 손상 메시지 — 격리 후 다음으로(매 기동 동일 파싱오류 반복 차단).
          await quarantineCorrupt(paths, id, err);
          continue;
        }
        await processOne(id, envelope); // processOne 은 자체 try/catch(state=failed)로 throw 하지 않음
      }
    }).catch((err: unknown) => {
      console.error(t("log.injector.advanceError", { lane, error: errMsg(err) }));
    });

    await enqueueStep(drainOnce).catch((err: unknown) => {
      console.error(t("log.injector.advanceError", { lane, error: errMsg(err) }));
    });
  }

  function notify(): void {
    scheduleStep();
  }

  function getState(): InjectorState {
    return state;
  }

  return { start, notify, onSessionEvent, getState };
}
