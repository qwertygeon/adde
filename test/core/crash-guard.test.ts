import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { installCrashGuard } from "../../src/core/crash-guard.js";
import type { CrashGuardDeps, ShutdownState } from "../../src/core/crash-guard.js";
import { waitFor } from "../helpers/wait.js";

// 확정 시그니처 SSOT: design/research.md "확정 시그니처" 절.
// SC-001·002·004·005·006·N02 — installCrashGuard(deps). fake emitter(node:events) 주입으로
// 실 process 미접촉(uncaughtException/unhandledRejection 을 emitter 에 직접 emit).

interface Harness {
  deps: CrashGuardDeps;
  emitter: EventEmitter;
  state: ShutdownState;
  logs: string[];
  exitCodes: number[];
  cleanupCalls: number;
}

function makeHarness(overrides: Partial<CrashGuardDeps> = {}): Harness {
  const emitter = new EventEmitter();
  const logs: string[] = [];
  const exitCodes: number[] = [];
  const counter = { cleanupCalls: 0 };
  const state: ShutdownState = { active: false };
  // exactOptionalPropertyTypes: true — 옵션 필드(now·rateWindowMs)는 값이 없으면 키 자체를
  // 생략한다("있지만 undefined" 와 "없음" 을 구분, CrashGuardDeps 옵션 타입과 정합).
  const deps: CrashGuardDeps = {
    onCleanup:
      overrides.onCleanup ??
      (async () => {
        counter.cleanupCalls++;
      }),
    exit:
      overrides.exit ??
      ((code: number) => {
        exitCodes.push(code);
      }),
    log:
      overrides.log ??
      ((line: string) => {
        logs.push(line);
      }),
    state: overrides.state ?? state,
    emitter,
    cleanupTimeoutMs: overrides.cleanupTimeoutMs ?? 50,
    ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    ...(overrides.rateWindowMs !== undefined ? { rateWindowMs: overrides.rateWindowMs } : {}),
  };
  return {
    deps,
    emitter,
    state: deps.state,
    logs,
    exitCodes,
    get cleanupCalls() {
      return counter.cleanupCalls;
    },
  } as Harness;
}

describe("installCrashGuard — uncaughtException (SC-001 Happy)", () => {
  it("마스킹 로그 1회 기록 + 유계 정리 호출 + exit(1)", async () => {
    const h = makeHarness();
    installCrashGuard(h.deps);

    h.emitter.emit("uncaughtException", new Error("boom"), "uncaughtException");

    await waitFor(() => h.exitCodes.length > 0);
    expect(h.exitCodes).toEqual([1]);
    expect(h.logs.length).toBe(1);
    expect(h.logs[0]).toMatch(/boom/);
  });
});

describe("installCrashGuard — unhandledRejection (SC-002 Happy)", () => {
  it("마스킹 로그 후 흡수 — exit 미호출·상주 유지", async () => {
    const h = makeHarness();
    installCrashGuard(h.deps);

    h.emitter.emit("unhandledRejection", new Error("rejected-reason"), Promise.resolve());

    // 비동기 로그 경로가 있을 수 있으므로 짧게 대기 후 exit 미호출을 확정한다.
    await new Promise((r) => setTimeout(r, 20));
    expect(h.exitCodes).toEqual([]);
    expect(h.logs.length).toBe(1);
    expect(h.logs[0]).toMatch(/rejected-reason/);
  });
});

describe("installCrashGuard — 정리 훅 실패 (SC-004 Error)", () => {
  it("cleanup 이 throw/reject 해도 exit(1) 도달(무한대기·좀비 없음)", async () => {
    const h = makeHarness({
      onCleanup: async () => {
        throw new Error("cleanup-fail");
      },
    });
    installCrashGuard(h.deps);

    h.emitter.emit("uncaughtException", new Error("boom"), "uncaughtException");

    await waitFor(() => h.exitCodes.length > 0);
    expect(h.exitCodes).toEqual([1]);
  });
});

describe("installCrashGuard — 종료 진행 중 재트리거 (SC-005 Edge)", () => {
  it("state.active=true 상태에서 재발생해도 이중 종결 절차를 시작하지 않는다", async () => {
    const state: ShutdownState = { active: true }; // 이미 종료 진행 중을 시뮬레이션
    const h = makeHarness({ state });
    installCrashGuard(h.deps);

    h.emitter.emit("uncaughtException", new Error("second-crash"), "uncaughtException");

    // 재진입 가드로 즉시 반환 — 짧게 대기해도 cleanup·exit 추가 호출 0.
    await new Promise((r) => setTimeout(r, 20));
    expect(h.exitCodes).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});

describe("installCrashGuard — 동일 reason rate-limit (SC-006 Edge)", () => {
  it("1분 내 동일 reason 10회 발생해도 로그는 분당 1회 수준으로 제한된다", async () => {
    let fakeNow = 1_000_000;
    const h = makeHarness({ now: () => fakeNow, rateWindowMs: 60_000 });
    installCrashGuard(h.deps);

    for (let i = 0; i < 10; i++) {
      h.emitter.emit("unhandledRejection", new Error("same-reason"), Promise.resolve());
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(h.logs.length).toBe(1);

    // 윈도 경과 후 재발생 — 다시 기록되어야 한다.
    fakeNow += 60_000;
    h.emitter.emit("unhandledRejection", new Error("same-reason"), Promise.resolve());
    await new Promise((r) => setTimeout(r, 20));
    expect(h.logs.length).toBe(2);
  });
});

describe("installCrashGuard — 시크릿 마스킹 (SC-N02 Error/보안)", () => {
  it("uncaughtException 스택의 토큰 패턴이 마스킹되어 기록된다(평문 미노출)", async () => {
    const token = "123456:" + "A".repeat(32);
    const h = makeHarness();
    installCrashGuard(h.deps);

    h.emitter.emit(
      "uncaughtException",
      new Error(`leaked token ${token} in stack`),
      "uncaughtException",
    );

    await waitFor(() => h.exitCodes.length > 0);
    const joined = h.logs.join("\n");
    expect(joined).not.toContain(token);
    expect(joined).toContain("***");
  });

  it("unhandledRejection reason 의 토큰 패턴이 마스킹되어 기록된다(평문 미노출)", async () => {
    const token = "654321:" + "B".repeat(32);
    const h = makeHarness();
    installCrashGuard(h.deps);

    h.emitter.emit(
      "unhandledRejection",
      new Error(`leaked token ${token} in reason`),
      Promise.resolve(),
    );

    await new Promise((r) => setTimeout(r, 20));
    const joined = h.logs.join("\n");
    expect(joined).not.toContain(token);
    expect(joined).toContain("***");
  });
});
