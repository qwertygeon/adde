import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gateRequestDecision, DEFAULT_GATE_TIMEOUT_MS } from "../../src/gate/gate.js";
import type { PermRequest } from "../../src/gate/gate.js";

// SC-020: 타임아웃 시 decision=deny (fail-closed)
// SC-021: 채널 오류(sendMessage 500) 시 decision=deny

// NFR-003: default deny — allow 는 명시적 사용자 승인 시에만

const makePermRequest = (id = "req-001"): PermRequest => ({
  v: 1,
  id,
  lane: "test-lane",
  channel: "telegram",
  tool: "Bash",
  detail: "rm -rf build/",
  cwd: "/tmp/myproject",
  ts: new Date().toISOString(),
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DEFAULT_GATE_TIMEOUT_MS (DEC-001)", () => {
  it("기본 타임아웃 값이 600000ms(600초, 10분) 이다", () => {
    // 사용자 명시 선택 600초(10분) — 가역적(conf 재정의 가능)
    expect(DEFAULT_GATE_TIMEOUT_MS).toBe(600_000);
  });
});

describe("gateRequestDecision (SC-020 타임아웃 deny)", () => {
  it("타임아웃 경과 시 decision=deny 를 반환한다 (fail-closed)", async () => {
    // 타임아웃 값은 테스트 주입 가능 (GAP-002 안전망 — 짧은 테스트 타임아웃)
    const req = makePermRequest("timeout-001");

    // 사용자 응답 없이 타임아웃 경과
    const decisionPromise = gateRequestDecision(req, {
      sendPermPrompt: vi.fn().mockResolvedValue(undefined),
      waitForDecision: () => new Promise(() => {}), // 영원히 pending
      timeoutMs: 100, // 테스트용 짧은 타임아웃
    });

    // 타임아웃 경과
    await vi.runAllTimersAsync();

    const result = await decisionPromise;
    expect(result.decision).toBe("deny");
    expect(result.id).toBe("timeout-001");
  });

  it("타임아웃 기본값이 deny 임을 확인한다 (NFR-003)", async () => {
    const req = makePermRequest("default-deny");
    const decisionPromise = gateRequestDecision(req, {
      sendPermPrompt: vi.fn().mockResolvedValue(undefined),
      waitForDecision: () => new Promise(() => {}),
      timeoutMs: 50,
    });

    await vi.runAllTimersAsync();
    const result = await decisionPromise;
    expect(result.decision).toBe("deny");
  });
});

describe("gateRequestDecision (SC-021 채널 오류 deny)", () => {
  it("sendMessage 500 오류 시 decision=deny 를 반환한다", async () => {
    // fake telegram Bot API 가 sendMessage 에 500 반환
    const req = makePermRequest("channel-error");
    const result = await gateRequestDecision(req, {
      sendPermPrompt: vi.fn().mockRejectedValue(new Error("HTTP 500 Internal Server Error")),
      waitForDecision: () => new Promise(() => {}),
      timeoutMs: 5000,
    });
    expect(result.decision).toBe("deny");
  });

  it("채널 도달 실패를 빈 결과로 흡수하지 않고 deny 로 전파한다 (error-handling.md)", async () => {
    // 게이트 도달 실패 = 흡수 금지 → deny 전파
    const req = makePermRequest("reach-fail");
    const result = await gateRequestDecision(req, {
      sendPermPrompt: vi.fn().mockRejectedValue(new Error("Network unreachable")),
      waitForDecision: () => new Promise(() => {}),
      timeoutMs: 5000,
    });
    expect(result.decision).toBe("deny");
    // undefined·null 이 아닌 deny 문자열이어야 함
    expect(typeof result.decision).toBe("string");
  });
});

describe("gateRequestDecision (allow — 명시적 사용자 승인)", () => {
  it("명시적 allow 콜백 수신 시 decision=allow 를 반환한다", async () => {
    const req = makePermRequest("allow-001");
    const result = await gateRequestDecision(req, {
      sendPermPrompt: vi.fn().mockResolvedValue(undefined),
      waitForDecision: () => Promise.resolve("allow"),
      timeoutMs: 5000,
    });
    expect(result.decision).toBe("allow");
  });

  it("deny 콜백 수신 시 decision=deny 를 반환한다", async () => {
    const req = makePermRequest("deny-001");
    const result = await gateRequestDecision(req, {
      sendPermPrompt: vi.fn().mockResolvedValue(undefined),
      waitForDecision: () => Promise.resolve("deny"),
      timeoutMs: 5000,
    });
    expect(result.decision).toBe("deny");
  });
});

// F12b: 결정/오류 종결 경로에서 타임아웃 타이머를 clear — 미clear 시 결정 후에도 timeoutMs(기본 10분)
// 만큼 타이머가 상주해 24h 기동 시 누적된다.
describe("gateRequestDecision (F12b 타임아웃 타이머 clear)", () => {
  it("결정 승리 시 타임아웃 타이머를 clear 한다 (상주 타이머 0)", async () => {
    const req = makePermRequest("clear-on-decision");
    const result = await gateRequestDecision(req, {
      sendPermPrompt: vi.fn().mockResolvedValue(undefined),
      waitForDecision: () => Promise.resolve("allow"),
      timeoutMs: 600_000,
    });
    expect(result.decision).toBe("allow");
    // 미clear 면 600s 타임아웃 타이머가 남는다.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("전송 오류 deny 경로도 타임아웃 타이머를 clear 한다", async () => {
    const req = makePermRequest("clear-on-error");
    const result = await gateRequestDecision(req, {
      sendPermPrompt: vi.fn().mockRejectedValue(new Error("channel down")),
      waitForDecision: () => new Promise(() => {}),
      timeoutMs: 600_000,
    });
    expect(result.decision).toBe("deny");
    expect(vi.getTimerCount()).toBe(0);
  });
});
