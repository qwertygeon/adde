#!/usr/bin/env node
/**
 * 최소 ACP ndjson 에이전트 더블 — client 의 launch/loadSession/relaunch 실경로 테스트용.
 * 계약 강제(전역 TS 규칙): initialize 전 세션 요청은 오류, 미지의 세션 load 는 "Session not found".
 * session/prompt 는 응답 청크 알림("pong") 후 end_turn — 구독 승계 검증에 사용.
 */
/* global process */
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
let initialized = false;
let seq = 0;

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined || method === undefined) return; // 알림은 무시

  if (method === "initialize") {
    initialized = true;
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
    return;
  }
  if (!initialized) {
    send({ jsonrpc: "2.0", id, error: { code: -32002, message: "not initialized" } });
    return;
  }
  if (method === "session/new") {
    // pid 를 섞어 프로세스(재기동) 간에도 유일 — reset 검증(새 세션 id 상이)에 필요.
    send({ jsonrpc: "2.0", id, result: { sessionId: `fake-${process.pid}-${++seq}` } });
    return;
  }
  if (method === "session/load") {
    const sid = String(params?.sessionId ?? "");
    if (sid.startsWith("known-")) {
      send({ jsonrpc: "2.0", id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Session not found" } });
    }
    return;
  }
  if (method === "session/prompt") {
    // 응답 청크 알림 → end_turn: 구독자(injector)가 살아있으면 "pong" 이 누적된다.
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: params?.sessionId ?? "fake",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } },
      },
    });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }
  // 그 외 요청(session/getMode 등) — 빈 결과
  send({ jsonrpc: "2.0", id, result: {} });
});
