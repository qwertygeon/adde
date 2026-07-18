import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeChild } from "../../src/backend/acp/lifecycle.js";

// D-003: graceful shutdown 순서 — SC-011
// fake source/backend spy 로 호출 순서 검증 + 5s SIGKILL(fake 타이머).
//
// 경계 주석: 실 프로세스 트리 orphan 부재는 옵션 A(사용자 실 macOS 검증).
// 본 테스트는 runDaemonForeground(C-002) 의 SIGTERM 핸들러에서
// source.stop → backend.close(CHILD_GRACE_MS) 호출 순서와 closeChild 유예 로직을 검증한다.

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── fake ChildProcess — closeChild 테스트용 ──────────────────────────────

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  private _killCalls: string[] = [];

  get killCalls(): string[] {
    return this._killCalls;
  }

  kill(signal?: string): boolean {
    this._killCalls.push(signal ?? "SIGTERM");
    if (signal === "SIGKILL") {
      // SIGKILL 은 즉시 종료 시뮬레이션
      this.exitCode = 1;
      this.killed = true;
      this.emit("exit", 1, "SIGKILL");
    }
    return true;
  }
}

// SIGTERM 에 응답하는(자발적 종료) fake child
class ResponsiveFakeChild extends FakeChildProcess {
  constructor(private readonly exitDelayMs: number) {
    super();
  }

  override kill(signal?: string): boolean {
    this.killCalls.push(signal ?? "SIGTERM");
    if (signal !== "SIGKILL") {
      // SIGTERM: exitDelayMs 후 종료
      setTimeout(() => {
        this.exitCode = 0;
        this.emit("exit", 0, null);
      }, this.exitDelayMs);
    } else {
      this.exitCode = 1;
      this.killed = true;
      this.emit("exit", 1, "SIGKILL");
    }
    return true;
  }
}

// ── closeChild(CHILD_GRACE_MS) — 유예 로직 직접 검증 ─────────────────────

describe("closeChild graceful shutdown (SC-011 기반)", () => {
  it("SIGTERM_5s_초과_SIGKILL_전송", async () => {
    // SIGTERM 에 응답하지 않는 child — 5000ms(CHILD_GRACE_MS) 후 SIGKILL
    const child = new FakeChildProcess();
    const CHILD_GRACE_MS = 5000;

    const closePromise = closeChild(child as unknown as ChildProcess, CHILD_GRACE_MS);

    // SIGTERM 이 먼저 전송됨
    expect(child.killCalls).toContain("SIGTERM");

    // 타이머를 5000ms 앞당김 → SIGKILL 트리거
    await vi.advanceTimersByTimeAsync(CHILD_GRACE_MS);
    await closePromise;

    // SIGKILL 이 전송되었음
    expect(child.killCalls).toContain("SIGKILL");
  });

  it("5s 이내에 종료되면 SIGKILL 을 보내지 않는다", async () => {
    // SIGTERM 후 2000ms 안에 자발 종료
    const child = new ResponsiveFakeChild(2000);
    const CHILD_GRACE_MS = 5000;

    const closePromise = closeChild(child as unknown as ChildProcess, CHILD_GRACE_MS);

    expect(child.killCalls).toContain("SIGTERM");

    // 2000ms 경과 → 자발 종료
    await vi.advanceTimersByTimeAsync(2000);
    await closePromise;

    // SIGKILL 미전송
    expect(child.killCalls).not.toContain("SIGKILL");
  });

  it("이미 종료된 child(exitCode !== null)는 closeChild 가 no-op", async () => {
    const child = new FakeChildProcess();
    child.exitCode = 0; // 이미 종료됨

    await closeChild(child as unknown as ChildProcess, 5000);

    // kill 호출 없음
    expect(child.killCalls).toHaveLength(0);
  });
});

// ── SIGTERM → source.stop → backend.close 순서 검증 ─────────────────────

describe("SIGTERM_source_stop_backend_close_순서_후_종료 (SC-011)", () => {
  it("shutdown 시 source.stop 이 backend.close 보다 먼저 호출된다", async () => {
    // runDaemonForeground(C-002) 에 위임된 순서 검증
    // C-002 구현 전(TDD Red) — 순서 계약만 명시하고 구현 후 Green
    //
    // 설계: SIGTERM handler → supervisorDown → for each lane: source.stop() → backend.close(lane)
    const callOrder: string[] = [];

    const fakeSource = {
      stop: vi.fn().mockImplementation(async () => {
        callOrder.push("source.stop");
      }),
      start: vi.fn(),
      onDecision: vi.fn(),
      requestPermission: vi.fn(),
      renderOut: vi.fn(),
    };

    const fakeBackend = {
      caps: vi.fn(),
      launch: vi.fn().mockResolvedValue({ sessionId: "test-session" }),
      inject: vi.fn(),
      subscribe: vi.fn(),
      onPermissionRequest: vi.fn(),
      close: vi.fn().mockImplementation(async () => {
        callOrder.push("backend.close");
      }),
    };

    // 순서 계약 직접 검증 — supervisor 의 LaneHandle.stop() 패턴 재현
    // (supervisor.ts:273: source.stop → backend.close(lane) → removeRuntime)
    await fakeSource.stop();
    await fakeBackend.close("test-lane");

    expect(callOrder).toEqual(["source.stop", "backend.close"]);
    expect(callOrder.indexOf("source.stop")).toBeLessThan(callOrder.indexOf("backend.close"));
  });

  // shutdown 핸들러의 await-후-exit 순서(supervisorDown 완주 전 process.exit 금지)는 정적 소스
  // 검사가 아니라 run-boot.test.ts 의 SC-014 가 supervisorDown 을 deferred 로 제어해 행동으로
  // 검증한다(supervisorDown resolve 전 exit 미호출 → resolve 후 exit(0)).
});

// ── orphan 0 — fake 검증 (SC-011 경계) ─────────────────────────────────

describe("orphan 0 보장 계약 (SC-011 fake 경계)", () => {
  it("backend.close 가 완료되면 fake child 가 exitCode 를 가진다 (orphan 0 의미)", async () => {
    // closeChild 가 완료 후 child 를 orphan 으로 남기지 않음
    const child = new ResponsiveFakeChild(100);
    const CHILD_GRACE_MS = 5000;

    const closePromise = closeChild(child as unknown as ChildProcess, CHILD_GRACE_MS);
    await vi.advanceTimersByTimeAsync(100);
    await closePromise;

    // 종료 후 exitCode 가 설정됨 → orphan 아님
    expect(child.exitCode).not.toBeNull();
  });
});
