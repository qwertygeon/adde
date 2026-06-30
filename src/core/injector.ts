/**
 * 직렬 idle 게이트·dedup·turn 라이프사이클 루프.
 * FR-004/005/011/ADR-003: state=idle|active. active 동안 다음 envelope 미주입.
 * 크래시 재개: 기동 시 scanProcessing → 각 id 에 isDone? 스킵 : 재처리.
 * 응답 캡처(DEC-002): backend.inject() resolve(=turn 종료) 시 누적 응답을 writeOut + 렌더 트리거 → 다음 큐 진행.
 *   turn 종료 신호는 inject() resolve 로 감지한다(conn.prompt 가 turn 종료에 resolve) — 별도 idleCallback 배선 불요.
 */
import {
  claimNext,
  scanProcessing,
  isDone,
  writeOut,
  writeFailed,
  processingFilePath,
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
): Injector {
  let state: InjectorState = "idle";
  let responseText = "";
  // claim→처리 진입을 직렬화(E4): idle 체크와 processOne(state=active) 사이의 두 await(claimNext·isDone)
  // 창에서 두 injectNext 가 각각 다른 메시지를 claim 해 동시 turn 이 뜨는 경합 방지(rename 은 동일
  // 메시지 중복만 막음). advancing 은 injectNext 전 구간을 감싸 한 번에 하나만 진행하게 한다.
  let advancing = false;

  function onSessionEvent(event: SessionEvent): void {
    if (state !== "active") return;
    if (isAgentMessageChunk(event)) responseText += chunkText(event);
  }

  /** 한 메시지의 turn 을 처리: inject → (turn 종료) 응답 기록 + 렌더. */
  async function processOne(id: string, envelope: Envelope): Promise<void> {
    state = "active";
    responseText = "";
    try {
      await backend.inject(lane, envelope.text);
      // inject resolve = turn 종료 — 누적 응답을 마스킹 후 out 기록(DEC-003) + 렌더(DEC-002).
      const sidecar: OutSidecar = { ts: new Date().toISOString() };
      if (envelope.reply_ref?.channel_msg_id) {
        sidecar.reply_ref = { channel_msg_id: envelope.reply_ref.channel_msg_id };
      }
      await writeOut(paths, id, maskSecrets(responseText), sidecar);
      if (render) {
        await render(id).catch((err: unknown) => {
          // 렌더는 보조 — 실패해도 durable out/ 는 남아 재개 가능(NFR-2 fail-closed).
          console.error(
            `[injector] 렌더 오류 lane=${lane} id=${id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[injector] inject 오류 lane=${lane} id=${id}: ${detail}`);
      // 실패를 .failed 사이드카로 보존(E1) — processing/<id>.msg 는 남아 재기동 시 재처리(at-least-once).
      await writeFailed(paths, id, `inject 실패 @ ${new Date().toISOString()}: ${detail}`).catch(
        (e: unknown) =>
          console.error(
            `[injector] .failed 기록 실패 lane=${lane} id=${id}: ${e instanceof Error ? e.message : String(e)}`,
          ),
      );
    } finally {
      state = "idle";
      responseText = "";
    }
  }

  /** 다음 injectNext 를 비동기 예약 — rejection(예: 일시적 fs 오류)은 로깅(unhandled 방지). */
  function scheduleNext(): void {
    setImmediate(() => {
      void injectNext().catch((err: unknown) => {
        console.error(
          `[injector] 진행 오류 lane=${lane}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  async function injectNext(): Promise<void> {
    if (state !== "idle" || advancing) return;
    advancing = true;
    try {
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
    // 크래시 재개: processing 잔존 파일을 순차 재처리.
    const pendingIds = await scanProcessing(paths);
    for (const id of pendingIds) {
      if (await isDone(paths, id)) continue; // dedup — 이미 out 있음
      try {
        const { readFile } = await import("node:fs/promises");
        const json = await readFile(processingFilePath(paths, id), "utf8");
        await processOne(id, parseEnvelope(json));
      } catch (err) {
        console.error(
          `[injector] 재처리 오류 lane=${lane} id=${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
