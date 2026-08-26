/**
 * TurnRunner(L3) — 세션 내 직렬(single-flight) 턴 실행. 현행 `injector.ts` 의 single-flight 체인·
 * 제어 envelope 처리를 계승한다. 순서 고정(crash-consistency, design.md §데이터 흐름):
 *   claim → turn_start append → projectTurn(running) 선투영 → onTurnAssigned 통지 → admit()
 *   → send() → 이벤트 append(blob 승격·dedup·권한) → turn_end append → processing/ 삭제
 *   → projectTurn(final). append·선투영 실패는 모두 턴 중단 + 세션 오류 표면화(FR-014·SC-050).
 * 부팅 재적재 판정은 이벤트 기록(`turn_start` 존재) ∪ processing 근거로만 한다(ADR-027·SC-051).
 */
import { appendEvent, lastSeq, loadResumeIndex } from "../record/events.js";
import { putBlob, BLOB_THRESHOLD_BYTES } from "../record/blobs.js";
import { classify } from "../record/dedup.js";
import { projectTurn } from "../record/projector.js";
import type { RecordCtx, TurnRef } from "../record/types.js";
import type { RetentionPolicy } from "../record/retention.js";
import {
  claimNext,
  clearProcessing,
  processingFilePath,
  quarantineCorrupt,
  scanProcessing,
} from "./queue.js";
import { parseEnvelope } from "../shared/envelope.js";
import type { Envelope } from "../shared/envelope.js";
import type { SessionPaths } from "../shared/paths.js";
import type { EngineEvent, EngineSession } from "../engines/types.js";
import { errMsg } from "../shared/errors.js";
import { readFile } from "node:fs/promises";

export interface TurnRunner {
  start(): Promise<void>;
  /** enqueue 등 외부 신호로 idle 세션을 깨워 다음 메시지를 처리한다. */
  notify(): void;
  stop(): Promise<void>;
  state(): "idle" | "active";
}

export interface TurnRunnerDeps {
  base: string;
  vaultRoot: string;
  proj: string;
  sid: string;
  cwd: string;
  sessionPaths: SessionPaths;
  /** 상주 승인(단일 체인) — 필요 시 LRU hibernate 후 EngineSession 반환(ADR-021). */
  admit: () => Promise<EngineSession>;
  /**
   * 권한 요청 전 표면화 + 결정 대기(등록 후 전송 순서·타임아웃·fail-closed 는 이 콜백 내부 소관 —
   * SessionManager/Router 조립부가 Surface·gate.gateRequestDecision 을 배선한다).
   */
  requestPermission: (req: {
    reqId: string;
    tool: string;
    input: string;
  }) => Promise<{ decision: "allow" | "deny"; reason?: string }>;
  /** 결정이 이벤트에 기록된 뒤 승인 파일 삭제 트리거(ADR-016) — 실패는 보조(흡수). */
  onDecisionRecorded?: (reqId: string) => Promise<void>;
  /** 턴 번호 배정 통지 — Surface 마커 2단계 전이(ADR-014). */
  onTurnAssigned?: (envelopeId: string, turnRef: TurnRef) => Promise<void>;
  /** 턴 완료(성공) 알림 — Surface.deliver 배선. */
  onTurnDelivered?: (msg: { text: string; turnRef: TurnRef }) => Promise<void>;
  /** 세션 오류 알림(FR-014) — 기록·선투영 실패로 턴이 중단될 때. */
  onSessionError?: (reason: string) => Promise<void>;
  retentionPolicy?: RetentionPolicy;
  /** 턴 종료 후 세션·프로젝트 노트 갱신(design.md 턴 흐름 8단계) — session-manager 가
   * `project(ctx, {turn, retention, sessionMeta, projectSessions})` 로 배선한다(L1→L3 의존 회피). */
  refreshNotes?: (turn: number) => Promise<void>;
}

function recordCtx(deps: TurnRunnerDeps, turn?: number, turnStartIso?: string): RecordCtx {
  return {
    base: deps.base,
    vaultRoot: deps.vaultRoot,
    proj: deps.proj,
    sid: deps.sid,
    ...(turn !== undefined ? { turn } : {}),
    ...(turnStartIso !== undefined ? { turnStartIso } : {}),
  };
}

/** 도구 입출력 blob 승격 — 임계 초과 시 blob, 이하는 그대로 인라인 보존(FR-017). */
async function maybePromoteBlob(ctx: RecordCtx, value: unknown): Promise<unknown> {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") <= BLOB_THRESHOLD_BYTES) return value;
  return putBlob(ctx, text);
}

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  let running: "idle" | "active" = "idle";
  let seqCounter = 0;
  let turnCounter = 0;
  let countersReady = false;
  let chain: Promise<void> = Promise.resolve();
  let stopped = false;

  async function ensureCounters(): Promise<void> {
    if (countersReady) return;
    const ctx = recordCtx(deps);
    const index = await loadResumeIndex(ctx);
    let maxTurn = 0;
    for (const v of index.values()) if (v.turn > maxTurn) maxTurn = v.turn;
    turnCounter = maxTurn;
    seqCounter = await lastSeq(ctx);
    countersReady = true;
  }

  function nextSeq(): number {
    seqCounter += 1;
    return seqCounter;
  }

  /** 이미 시작된(turn_start 존재) 미완 턴의 turn 번호를 이벤트 기록에서 조회(있으면), 없으면 새 번호 배정. */
  async function resolveTurnForEnvelope(
    envelopeId: string,
  ): Promise<{ turn: number; isNew: boolean }> {
    const index = await loadResumeIndex(recordCtx(deps));
    const existing = index.get(envelopeId);
    if (existing) return { turn: existing.turn, isNew: false };
    turnCounter += 1;
    return { turn: turnCounter, isNew: true };
  }

  async function runControl(envelope: Envelope): Promise<string> {
    // control envelope(clear/compact/resume/sessions) 은 세션 제어이며 턴을 만들지 않는다.
    // v2 에서는 팔레트(ADR-030)가 SessionManager 로 직접 위임하므로 본 경로는 방어적으로만 유지한다.
    return `control:${envelope.control?.kind ?? "unknown"}`;
  }

  async function handlePermission(
    ctx: RecordCtx,
    turn: number,
    engineSession: EngineSession,
    event: Extract<EngineEvent, { t: "permission" }>,
  ): Promise<void> {
    await appendEvent(ctx, {
      v: 1,
      sid: deps.sid,
      turn,
      seq: nextSeq(),
      ts: new Date().toISOString(),
      t: "permission",
      reqId: event.reqId,
      tool: event.tool,
      input: event.input,
    });
    const inputText =
      typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? "");
    const result = await deps.requestPermission({
      reqId: event.reqId,
      tool: event.tool,
      input: inputText,
    });
    await engineSession.respondPermission(event.reqId, result.decision);
    await appendEvent(ctx, {
      v: 1,
      sid: deps.sid,
      turn,
      seq: nextSeq(),
      ts: new Date().toISOString(),
      t: "permission_decision",
      reqId: event.reqId,
      decision: result.decision,
      reason: result.reason ?? "",
    });
    // 결정이 이벤트에 기록된 것을 확인한 뒤에만 승인 파일 삭제(ADR-016) — append 실패 시 여기 도달 안 함.
    if (deps.onDecisionRecorded) {
      await deps.onDecisionRecorded(event.reqId).catch(() => {});
    }
  }

  /** 한 턴(claim 된 envelope)을 처리 — 신규/이어받기 공용. */
  async function runTurn(
    id: string,
    envelope: Envelope,
    turn: number,
    isNew: boolean,
  ): Promise<void> {
    running = "active";
    const turnStartIso = new Date().toISOString();
    const ctxBase = recordCtx(deps, turn, turnStartIso);

    if (envelope.control) {
      // 세션 제어는 턴 기록 대상이 아니다 — 처리 후 즉시 processing 정리.
      await runControl(envelope).catch(() => {});
      await clearProcessing(deps.sessionPaths, id);
      running = "idle";
      return;
    }

    try {
      if (isNew) {
        await appendEvent(ctxBase, {
          v: 1,
          sid: deps.sid,
          turn,
          seq: nextSeq(),
          ts: turnStartIso,
          t: "turn_start",
          envelopeId: id,
          input: { text: envelope.text },
        });
      }
    } catch (err) {
      await deps.onSessionError?.(errMsg(err)).catch(() => {});
      running = "idle";
      return; // 기록 실패 — 턴 중단(FR-014). 큐/processing 은 그대로 남아 재시도 가능.
    }

    try {
      await projectTurn(ctxBase, turn, "running", deps.retentionPolicy);
    } catch (err) {
      await deps.onSessionError?.(errMsg(err)).catch(() => {});
      running = "idle";
      return; // 선투영 실패 — 턴 중단(SC-050). 마커는 접수 단계에 머무른다(Surface 소관).
    }

    const turnRef: TurnRef = { turn, turnStartIso };
    if (deps.onTurnAssigned) {
      await deps.onTurnAssigned(id, turnRef).catch(() => {});
    }

    // user_input dedup 판정(FR-018) — 결과는 turn_end.dup 에 실어 투영기가 소비한다.
    let dupOf: TurnRef | null = null;
    try {
      const r = await classify(recordCtx(deps, turn, turnStartIso), "user_input", envelope.text);
      dupOf = r.dupOf;
    } catch {
      // dedup 은 파생물 판정이라 실패해도 턴을 막지 않는다(보조).
    }

    let engineSession: EngineSession;
    try {
      engineSession = await deps.admit();
    } catch (err) {
      await deps.onSessionError?.(errMsg(err)).catch(() => {});
      running = "idle";
      return;
    }

    let finalText = "";
    let stopReason = "end_turn";
    try {
      for await (const event of engineSession.send({ text: envelope.text })) {
        const ctx = recordCtx(deps, turn, turnStartIso);
        switch (event.t) {
          case "text":
            await appendEvent(ctx, {
              v: 1,
              sid: deps.sid,
              turn,
              seq: nextSeq(),
              ts: new Date().toISOString(),
              t: "text",
              role: "assistant",
              delta: event.delta,
            });
            break;
          case "text_final": {
            finalText = event.text;
            const assistantDup = await classify(ctx, "assistant", event.text).catch(() => ({
              dupOf: null as TurnRef | null,
            }));
            if (!dupOf && assistantDup.dupOf) dupOf = assistantDup.dupOf;
            const promoted = await maybePromoteBlob(ctx, event.text);
            await appendEvent(ctx, {
              v: 1,
              sid: deps.sid,
              turn,
              seq: nextSeq(),
              ts: new Date().toISOString(),
              t: "text_final",
              role: "assistant",
              text: promoted as string | { blob: string; bytes: number },
            });
            break;
          }
          case "thinking":
            await appendEvent(ctx, {
              v: 1,
              sid: deps.sid,
              turn,
              seq: nextSeq(),
              ts: new Date().toISOString(),
              t: "thinking",
              delta: event.delta,
            });
            break;
          case "tool_call": {
            const promotedInput = await maybePromoteBlob(ctx, event.input);
            await appendEvent(ctx, {
              v: 1,
              sid: deps.sid,
              turn,
              seq: nextSeq(),
              ts: new Date().toISOString(),
              t: "tool_call",
              id: event.id,
              name: event.name,
              input: promotedInput,
            });
            break;
          }
          case "tool_result": {
            const promotedOutput = await maybePromoteBlob(ctx, event.output);
            await appendEvent(ctx, {
              v: 1,
              sid: deps.sid,
              turn,
              seq: nextSeq(),
              ts: new Date().toISOString(),
              t: "tool_result",
              id: event.id,
              output: promotedOutput,
              ...(event.isError !== undefined ? { isError: event.isError } : {}),
            });
            break;
          }
          case "permission":
            await handlePermission(ctx, turn, engineSession, event);
            break;
          case "usage":
            await appendEvent(ctx, {
              v: 1,
              sid: deps.sid,
              turn,
              seq: nextSeq(),
              ts: new Date().toISOString(),
              t: "usage",
              input: event.input,
              output: event.output,
              ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
            });
            break;
          case "error":
            stopReason = "error";
            await appendEvent(ctx, {
              v: 1,
              sid: deps.sid,
              turn,
              seq: nextSeq(),
              ts: new Date().toISOString(),
              t: "error",
              message: event.message,
              fatal: event.fatal,
            });
            break;
        }
      }
    } catch (err) {
      await deps.onSessionError?.(errMsg(err)).catch(() => {});
      running = "idle";
      return; // 이벤트 append 실패(fail-closed) — 턴 미완료로 남긴다(재처리 대상).
    }

    try {
      await appendEvent(recordCtx(deps, turn, turnStartIso), {
        v: 1,
        sid: deps.sid,
        turn,
        seq: nextSeq(),
        ts: new Date().toISOString(),
        t: "turn_end",
        envelopeId: id,
        stopReason,
        ...(dupOf ? { dup: { of: dupOf } } : {}),
      });
    } catch (err) {
      await deps.onSessionError?.(errMsg(err)).catch(() => {});
      running = "idle";
      return;
    }

    await clearProcessing(deps.sessionPaths, id);

    try {
      await projectTurn(recordCtx(deps, turn, turnStartIso), turn, "final", deps.retentionPolicy);
      if (deps.refreshNotes) await deps.refreshNotes(turn);
    } catch (err) {
      console.error(
        `turn-runner: 종료 후 투영 실패(sid=${deps.sid}, turn=${turn}): ${errMsg(err)}`,
      );
    }

    if (deps.onTurnDelivered) {
      await deps.onTurnDelivered({ text: finalText, turnRef }).catch(() => {});
    }
    running = "idle";
  }

  async function drainOnce(): Promise<void> {
    if (stopped) return;
    await ensureCounters();
    const claimed = await claimNext(deps.sessionPaths);
    if (!claimed) return;
    const { id, envelope } = claimed;
    const { turn, isNew } = await resolveTurnForEnvelope(id);
    await runTurn(id, envelope, turn, isNew);
    await drainOnce(); // 큐에 남은 다음 메시지를 계속 처리(자기 연쇄).
  }

  function enqueueStep(fn: () => Promise<void>): Promise<void> {
    const result = chain.then(fn, fn);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function recoverProcessing(): Promise<void> {
    await ensureCounters();
    const pendingIds = await scanProcessing(deps.sessionPaths);
    for (const id of pendingIds) {
      let envelope: Envelope;
      try {
        envelope = parseEnvelope(await readFile(processingFilePath(deps.sessionPaths, id), "utf8"));
      } catch (err) {
        await quarantineCorrupt(deps.sessionPaths, id, err);
        continue;
      }
      const { turn, isNew } = await resolveTurnForEnvelope(id);
      await runTurn(id, envelope, turn, isNew);
    }
  }

  return {
    async start(): Promise<void> {
      stopped = false;
      await enqueueStep(recoverProcessing);
      await enqueueStep(drainOnce);
    },
    notify(): void {
      if (stopped) return;
      enqueueStep(drainOnce).catch((err: unknown) => {
        console.error(`turn-runner: 진행 오류(sid=${deps.sid}): ${errMsg(err)}`);
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      await chain.catch(() => {});
    },
    state(): "idle" | "active" {
      return running;
    },
  };
}
