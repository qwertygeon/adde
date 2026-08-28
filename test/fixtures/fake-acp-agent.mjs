#!/usr/bin/env node
/**
 * 최소 ACP ndjson 에이전트 더블 — client 의 launch/loadSession/relaunch 실경로 테스트용.
 * 계약 강제(전역 TS 규칙): initialize 전 세션 요청은 오류, 미지의 세션 load 는 "Session not found".
 * session/prompt 는 응답 청크 알림("pong") 후 end_turn — 구독 승계 검증에 사용.
 */
/* global process */
import readline from "node:readline";
import { writeFileSync, appendFileSync } from "node:fs";

// engineArgs 가 spawn argv 로 실제 전달되는지 검증하기 위해,
// 지정 시(FAKE_ACP_ARGV_DUMP) 자신의 argv(바이너리·스크립트 경로 제외분)를 파일로 덤프한다.
// 미지정 시 기존 동작 무변경(옵트인 — 다른 fixture 소비 테스트에 영향 없음).
if (process.env.FAKE_ACP_ARGV_DUMP) {
  try {
    writeFileSync(process.env.FAKE_ACP_ARGV_DUMP, JSON.stringify(process.argv.slice(2)));
  } catch {
    // best-effort — 덤프 실패가 에이전트 더블 본연 동작(핸드셰이크)을 막지 않는다.
  }
}

const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
let initialized = false;
let seq = 0;
// 클라이언트(ADDE) 로 보낸 요청의 응답 대기 — 권한 요청 왕복(옵트인)에 쓴다.
const pendingClientCalls = new Map();
let clientCallId = 10_000;

/**
 * 클라이언트에 요청을 보내고 응답을 기다린다 — 에이전트→클라이언트 방향 호출
 * (session/request_permission 등)의 실경로 재현.
 */
function callClient(method, params) {
  const id = ++clientCallId;
  return new Promise((resolve) => {
    pendingClientCalls.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  // 클라이언트가 보낸 응답(method 없음 + id 있음) — 대기 중인 요청을 깨운다.
  if (method === undefined && id !== undefined && pendingClientCalls.has(id)) {
    const resolve = pendingClientCalls.get(id);
    pendingClientCalls.delete(id);
    resolve(msg.result ?? msg.error ?? null);
    return;
  }
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
    // 재개 관통 witness — 지정 시(FAKE_ACP_SESSION_LOAD_LOG) 실제로 수신한 session/load 호출을
    // JSONL 로 append 한다(GAP-033 — SC-006 의 재개 실행 자체를 상태 필드 불변 대신 이 채널로
    // 직접 관측해 vacuous-pass 를 배제한다). 여러 자식 프로세스가 같은 파일에 동시 append 할 수
    // 있으나 각 write 는 짧은 단일 라인이라 O_APPEND 로 충분히 안전하다.
    if (process.env.FAKE_ACP_SESSION_LOAD_LOG) {
      try {
        appendFileSync(
          process.env.FAKE_ACP_SESSION_LOAD_LOG,
          JSON.stringify({ sessionId: sid, pid: process.pid }) + "\n",
        );
      } catch {
        // best-effort — 덤프 실패가 핸드셰이크 응답 자체를 막지 않는다.
      }
    }
    if (sid.startsWith("known-")) {
      send({ jsonrpc: "2.0", id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: "Session not found" } });
    }
    return;
  }
  if (method === "session/prompt") {
    const sessionId = params?.sessionId ?? "fake";
    // 응답 청크 알림 → end_turn: 구독자(injector)가 살아있으면 "pong" 이 누적된다.
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } },
      },
    });
    // 옵트인: 엔진 실효 권한 모드 변경 알림 — ADDE 정책과의 차이 표기 경로 재현.
    if (process.env.FAKE_ACP_MODE_UPDATE) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: process.env.FAKE_ACP_MODE_UPDATE,
          },
        },
      });
    }
    // 옵트인: 권한 요청 왕복 — 도구명을 지정하면 그 도구로 승인을 요청하고 결과를 덤프한다.
    if (process.env.FAKE_ACP_PERM_TOOL) {
      callClient("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: `tc-${++seq}`,
          title: `${process.env.FAKE_ACP_PERM_TOOL} 실행`,
          rawInput: { command: process.env.FAKE_ACP_PERM_INPUT ?? "echo hi" },
          _meta: { claudeCode: { toolName: process.env.FAKE_ACP_PERM_TOOL } },
        },
        options: [
          { optionId: "allow-once", name: "Allow", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      }).then((outcome) => {
        if (process.env.FAKE_ACP_PERM_OUTCOME_DUMP) {
          try {
            appendFileSync(process.env.FAKE_ACP_PERM_OUTCOME_DUMP, JSON.stringify(outcome) + "\n");
          } catch {
            // best-effort — 덤프 실패가 턴 종료를 막지 않는다.
          }
        }
        send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      });
      return;
    }
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
    return;
  }
  // 그 외 요청(session/getMode 등) — 빈 결과
  send({ jsonrpc: "2.0", id, result: {} });
});
