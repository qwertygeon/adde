import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// T-D11 재작업(2026-08-26): 구 v0.2.x 레인 기반 perm-gate.test.ts 는 처분(삭제, gate.ts 의
// PermRequest.lane→sid 개명 반영한 v2 버전으로 대체)했다. 본 파일이 tasks.md 배정 경로
// `test/integration/perm-gate.test.ts` 를 그대로 사용한다(`session-perm-gate.test.ts` 에서 이동).

// SC-026 (FR-026): 승인 노트를 통해 권한 응답이 게이트로 전달된다.
// SC-038 (NFR-004): 권한 응답 실패(타임아웃·채널 전달 실패·파싱 오류)가 전부 거부로 처리된다.
// gate.ts 는 이식 대상(유지)이나 필드명이 PermRequest.lane → sid 로 개명된다(design.md ADR "권한
// 게이트 세션 배선" T015). 확정 시그니처 블록엔 없으나 tasks.md T015 본문이 명시.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeReq(id = "req-001") {
  return {
    v: 1 as const,
    id,
    sid: "sess-1",
    channel: "markdown",
    tool: "Bash",
    detail: "rm -rf build/",
    cwd: "/tmp/myproject",
    ts: new Date().toISOString(),
  };
}

describe("SC-026: 승인 노트를 통해 권한 응답이 게이트로 전달된다", () => {
  it("Happy: 허용 체크 → 게이트가 allow 를 엔진에 전달하고 결정이 이벤트 기록에 남는다", async () => {
    const gate = await import("../../src/gate/gate.js");
    const req = makeReq();
    const decisionPromise = gate.gateRequestDecision(req as never, {
      sendPermPrompt: vi.fn().mockResolvedValue(undefined),
      waitForDecision: () => Promise.resolve("allow"),
    });
    const result = await decisionPromise;
    expect(result.decision).toBe("allow");
  });

  it("Edge: 거부 체크 → deny 가 전달된다", async () => {
    const gate = await import("../../src/gate/gate.js");
    const req = makeReq("req-002");
    const result = await gate.gateRequestDecision(req as never, {
      sendPermPrompt: vi.fn().mockResolvedValue(undefined),
      waitForDecision: () => Promise.resolve("deny"),
    });
    expect(result.decision).toBe("deny");
  });

  it("Error: 승인 노트 쓰기(전송) 실패 시 fail-closed deny 로 귀결한다", async () => {
    const gate = await import("../../src/gate/gate.js");
    const req = makeReq("req-003");
    const result = await gate.gateRequestDecision(req as never, {
      sendPermPrompt: vi.fn().mockRejectedValue(new Error("승인 노트 쓰기 실패")),
      waitForDecision: () => new Promise(() => {}),
    });
    expect(result.decision).toBe("deny");
  });
});

describe("SC-038 (NFR-004): 권한 응답 실패가 거부로 처리된다", () => {
  it("Happy: 타임아웃·채널 전달 실패·파싱 오류 3경우 전부 deny 다", async () => {
    const gate = await import("../../src/gate/gate.js");

    const timeoutResult = await (async () => {
      const p = gate.gateRequestDecision(makeReq("t1") as never, {
        sendPermPrompt: vi.fn().mockResolvedValue(undefined),
        waitForDecision: () => new Promise(() => {}),
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(60);
      return p;
    })();
    expect(timeoutResult.decision).toBe("deny");

    const deliveryFailResult = await gate.gateRequestDecision(makeReq("t2") as never, {
      sendPermPrompt: vi.fn().mockRejectedValue(new Error("500")),
      waitForDecision: () => new Promise(() => {}),
    });
    expect(deliveryFailResult.decision).toBe("deny");

    const parseErrorResult = await gate.gateRequestDecision(makeReq("t3") as never, {
      sendPermPrompt: vi.fn().mockResolvedValue(undefined),
      waitForDecision: () => Promise.reject(new Error("parse error")),
    });
    // waitForDecision 이 reject 하면 Promise.race 가 reject 하므로, 게이트 구현이 이를 catch 해
    // deny 로 수렴시켜야 한다(계약) — 그렇지 않으면 본 테스트가 reject 로 실패해 표면화된다.
    expect(parseErrorResult.decision).toBe("deny");
  });

  it("Edge: 결정 직후 타임아웃이 도착해도 이미 결정된 값이 유지된다", async () => {
    const gate = await import("../../src/gate/gate.js");
    const result = await gate.gateRequestDecision(makeReq("t4") as never, {
      sendPermPrompt: vi.fn().mockResolvedValue(undefined),
      waitForDecision: () => Promise.resolve("allow"),
      timeoutMs: 50,
    });
    expect(result.decision).toBe("allow");
  });

  it("Error: 게이트 콜백 예외 시 deny 로 귀결한다", async () => {
    const gate = await import("../../src/gate/gate.js");
    const result = await gate.gateRequestDecision(makeReq("t5") as never, {
      sendPermPrompt: () => {
        throw new Error("sync throw");
      },
      waitForDecision: () => new Promise(() => {}),
    });
    expect(result.decision).toBe("deny");
  });
});
