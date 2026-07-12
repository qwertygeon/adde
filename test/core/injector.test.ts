import { waitFor } from "../helpers/wait.js";
import { makeEnvelope } from "../helpers/envelope.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Injector } from "../../src/core/injector.js";
import { createInjector, questionExcerpt } from "../../src/core/injector.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { lanePaths } from "../../src/shared/paths.js";
import { enqueue } from "../../src/core/queue.js";
import { writeOutBody, setDone, setSending, setAborted } from "../../src/core/out-ledger.js";
import type { Envelope } from "../../src/shared/envelope.js";

// idle 게이트·notify·크래시 재처리(SC-003·SC-004·SC-005·SC-A1·SC-A2 라벨)는 선행 spec 번호로,
// 013-out-state-ledger 의 SC 번호와 겹치지 않는다(code-is-truth — STALE_SC 비차단, test-agent.md).
// 013-out-state-ledger 현재 SC 매핑: SC-002(응답 누적→body+ledger sidecar) · SC-004(dedup, 149행)
// · SC-006·007·008(A3 전송 dedup 블록) · SC-012(실패 가시성) · SC-020(이중전송 가드).
//
// 013-out-state-ledger 이전: 마커파일(.out.json/.sent/.sending/.aborted/.failed) 존재단언 →
// ledger entry(state) 단언으로 대체. 행위 단언(render 호출 수·onUncertain·재주입 없음)은 동일 유지(research §F).

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

/** ledger.json 동기 읽기 — waitFor 의 동기 조건함수에서 상태 폴링용(entry 부재 시 undefined). */
function ledgerEntry(id: string): { state?: string; reason?: string } | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.outLedgerFile, "utf8")) as {
      entries: Record<string, { state?: string; reason?: string }>;
    };
    return raw.entries[id];
  } catch {
    return undefined;
  }
}

/** setImmediate 큐 flush — injectNext 의 비동기 진행 1틱. */
const flush = () => new Promise<void>((r) => setImmediate(r));

/** 즉시 resolve 하는 기본 backend 더블. */
function makeBackend(inject = vi.fn().mockResolvedValue(undefined)) {
  return {
    inject,
    caps: vi.fn(),
    launch: vi.fn(),
    subscribe: vi.fn(),
    onPermissionRequest: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-injector-"));
  paths = lanePaths(tmpBase, "myproj", "test-lane");
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  fs.mkdirSync(paths.outDir, { recursive: true });
  fs.mkdirSync(paths.stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("questionExcerpt", () => {
  it("첫 줄만 취하고 80자 초과는 말줄임한다", () => {
    expect(questionExcerpt("한 줄 질문\n둘째 줄")).toBe("한 줄 질문");
    const long = "a".repeat(100);
    const out = questionExcerpt(long);
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("Injector 상태기계", () => {
  it("초기 상태는 idle 이다", () => {
    const injector: Injector = createInjector(paths, "test-lane", makeBackend());
    expect(injector.getState()).toBe("idle");
  });

  it("start() 후 빈 큐면 idle 유지, inject 미호출", async () => {
    const backend = makeBackend();
    const injector: Injector = createInjector(paths, "test-lane", backend);
    await injector.start();
    expect(injector.getState()).toBe("idle");
    expect(backend.inject).not.toHaveBeenCalled();
  });

  it("turn 종료(inject resolve) 후 idle 로 복귀한다", async () => {
    const backend = makeBackend();
    const injector: Injector = createInjector(paths, "test-lane", backend);
    await enqueue(paths, makeEnvelope("t1"));
    await injector.start();
    await flush();
    expect(backend.inject).toHaveBeenCalledWith("test-lane", "테스트");
    expect(injector.getState()).toBe("idle");
  });
});

describe("SC-A1: notify() 로 idle 레인 깨우기", () => {
  it("start 후 enqueue + notify() 하면 해당 메시지를 inject 한다", async () => {
    const backend = makeBackend();
    const injector: Injector = createInjector(paths, "test-lane", backend);
    await injector.start(); // 빈 큐 → idle
    expect(backend.inject).not.toHaveBeenCalled();

    await enqueue(paths, makeEnvelope("late", "지각 메시지"));
    injector.notify();
    await waitFor(() => backend.inject.mock.calls.length > 0);

    expect(backend.inject).toHaveBeenCalledWith("test-lane", "지각 메시지");
  });
});

describe("SC-004: active 동안 다음 envelope 미주입 (idle 게이트)", () => {
  it("inject 가 진행 중이면 다음 메시지는 큐 대기, turn 종료 후 진행(SC-A2)", async () => {
    // 첫 inject 는 수동 resolve — turn 이 끝나기 전 상태를 검증.
    let resolveFirst!: () => void;
    const inject = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (resolveFirst = r)))
      .mockResolvedValue(undefined);
    const backend = makeBackend(inject);
    const injector: Injector = createInjector(paths, "test-lane", backend);

    await enqueue(paths, makeEnvelope("first", "첫째"));
    await enqueue(paths, makeEnvelope("second", "둘째"));

    const startP = injector.start(); // first inject 에서 pending
    await waitFor(() => inject.mock.calls.length >= 1);

    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenLastCalledWith("test-lane", "첫째");
    expect(injector.getState()).toBe("active");

    // turn 종료 → 둘째 자동 진행(SC-A2)
    resolveFirst();
    await startP;
    await waitFor(() => inject.mock.calls.length >= 2 && injector.getState() === "idle");

    expect(inject).toHaveBeenCalledTimes(2);
    expect(inject).toHaveBeenLastCalledWith("test-lane", "둘째");
    expect(injector.getState()).toBe("idle");
  });
});

describe("SC-004: ledger done entry 존재 id dedup — inject 미호출", () => {
  it("ledger done entry 가 존재하면 dedup, inject 미호출", async () => {
    const backend = makeBackend();
    const env = makeEnvelope("dedup-id");
    fs.writeFileSync(path.join(paths.processingDir, "dedup-id.msg"), JSON.stringify(env));
    await writeOutBody(paths, "dedup-id", "이미 처리됨");
    await setDone(paths, "dedup-id", {});

    const injector: Injector = createInjector(paths, "test-lane", backend);
    await injector.start();

    expect(backend.inject).not.toHaveBeenCalled();
  });
});

describe("M5: processing 정리(성공·dedup 후 processing/<id>.msg 제거)", () => {
  it("정상 처리 완료 후 processing/<id>.msg 를 제거한다(out durable → 잉여)", async () => {
    const backend = makeBackend();
    const injector: Injector = createInjector(paths, "test-lane", backend);

    await enqueue(paths, makeEnvelope("m5-ok"));
    await injector.start();
    await waitFor(() => fs.existsSync(path.join(paths.outDir, "m5-ok.out")));

    // out 은 남고(dedup 앵커), processing 잉여 파일은 제거되어 재기동 재스캔 대상이 아니다.
    expect(fs.existsSync(path.join(paths.outDir, "m5-ok.out"))).toBe(true);
    expect(fs.existsSync(path.join(paths.processingDir, "m5-ok.msg"))).toBe(false);
  });

  it("재기동 스캔에서 이미 done 인 processing 잔존분을 정리한다(dedup 유지, inject 미호출)", async () => {
    const backend = makeBackend();
    // 크래시로 남은 done 상태(ledger entry 있음 + processing 잔존) 모사.
    const env = makeEnvelope("m5-done");
    fs.writeFileSync(path.join(paths.processingDir, "m5-done.msg"), JSON.stringify(env));
    await writeOutBody(paths, "m5-done", "이미 처리됨");
    await setDone(paths, "m5-done", {});

    const injector: Injector = createInjector(paths, "test-lane", backend);
    await injector.start();

    expect(backend.inject).not.toHaveBeenCalled(); // dedup 유지
    expect(fs.existsSync(path.join(paths.processingDir, "m5-done.msg"))).toBe(false); // 잉여 정리
  });
});

describe("SC-003: 크래시 후 processing 잔존 파일 재처리", () => {
  it("processing 에 있고 out 에 없으면 재처리(inject 호출)", async () => {
    const backend = makeBackend();
    const env = makeEnvelope("crash-recover");
    fs.writeFileSync(path.join(paths.processingDir, "crash-recover.msg"), JSON.stringify(env));

    const injector: Injector = createInjector(paths, "test-lane", backend);
    await injector.start();
    await flush();

    expect(backend.inject).toHaveBeenCalledWith("test-lane", env.text);
  });
});

describe("SC-002: 응답 누적 → writeOutBody(out/<id>.out) + setDone(ledger sidecar)", () => {
  it("agent_message_chunk 를 누적해 turn 종료 시 body+ledger 에 기록(reply_ref 포함)", async () => {
    let resolveInject!: () => void;
    const inject = vi.fn().mockImplementation(() => new Promise<void>((r) => (resolveInject = r)));
    const backend = makeBackend(inject);
    const injector: Injector = createInjector(paths, "test-lane", backend);

    await enqueue(paths, makeEnvelope("b1", "질문", "orig-42"));
    const startP = injector.start();
    await waitFor(() => typeof resolveInject === "function");

    // inject 진행(active) 중 엔진 청크 수신 → 누적
    injector.onSessionEvent({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "안녕" },
    });
    injector.onSessionEvent({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "하세요" },
    });

    resolveInject();
    await startP;
    await waitFor(() => ledgerEntry("b1") !== undefined);

    const outText = fs.readFileSync(path.join(paths.outDir, "b1.out"), "utf8");
    expect(outText).toBe("안녕하세요");
    const raw = JSON.parse(fs.readFileSync(paths.outLedgerFile, "utf8")) as {
      entries: Record<string, { reply_ref?: { channel_msg_id: string } }>;
    };
    expect(raw.entries["b1"]?.reply_ref?.channel_msg_id).toBe("orig-42");
  });

  it("ledger entry 에 원본 전송 시각(origin_ts)·질문 발췌(question)를 기록한다", async () => {
    const backend = makeBackend();
    const injector: Injector = createInjector(paths, "test-lane", backend);

    const env = makeEnvelope("b2", "빌드 오류 원인 분석해줘\n두 번째 줄은 발췌 제외");
    await enqueue(paths, env);
    await injector.start();
    await waitFor(() => ledgerEntry("b2") !== undefined);

    const raw = JSON.parse(fs.readFileSync(paths.outLedgerFile, "utf8")) as {
      entries: Record<string, { origin_ts?: string; question?: string }>;
    };
    expect(raw.entries["b2"]?.origin_ts).toBe(env.ts);
    expect(raw.entries["b2"]?.question).toBe("빌드 오류 원인 분석해줘");
  });
});

describe("SC-B2: writeOut 후 render(id) 호출", () => {
  it("turn 종료 시 render 콜백을 active id 로 호출한다", async () => {
    const backend = makeBackend();
    const rendered: string[] = [];
    const render = vi.fn().mockImplementation(async (id: string) => {
      rendered.push(id);
    });
    const injector: Injector = createInjector(paths, "test-lane", backend, render);

    await enqueue(paths, makeEnvelope("r1"));
    await injector.start();
    await flush();

    expect(rendered).toContain("r1");
  });

  it("render 실패해도 out/ 는 유지되고 예외가 전파되지 않는다(fail-closed)", async () => {
    const backend = makeBackend();
    const render = vi.fn().mockRejectedValue(new Error("render boom"));
    const injector: Injector = createInjector(paths, "test-lane", backend, render);

    await enqueue(paths, makeEnvelope("r2"));
    await expect(injector.start()).resolves.toBeUndefined();
    await flush();

    expect(fs.existsSync(path.join(paths.outDir, "r2.out"))).toBe(true);
  });
});

describe("세션 제어 envelope (control)", () => {
  function controlEnvelope(id: string, control: NonNullable<Envelope["control"]>): Envelope {
    return { ...makeEnvelope(id, `/${control.kind}`), control };
  }

  it("clear → backend.reset 호출, 완료 통지를 out 으로 기록", async () => {
    const backend = {
      ...makeBackend(),
      reset: vi.fn().mockResolvedValue({ sessionId: "fresh-1" }),
    };
    const injector: Injector = createInjector(paths, "test-lane", backend);
    await enqueue(paths, controlEnvelope("c1", { kind: "clear" }));
    await injector.start();
    await waitFor(() => fs.existsSync(path.join(paths.outDir, "c1.out")));

    expect(backend.reset).toHaveBeenCalledWith("test-lane");
    expect(backend.inject).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(paths.outDir, "c1.out"), "utf8")).toContain("새 세션");
    // 새 세션이 장부에 기록됨
    const ledger = JSON.parse(fs.readFileSync(paths.sessionsFile, "utf8")) as Array<{ id: string }>;
    expect(ledger.some((e) => e.id === "fresh-1")).toBe(true);
  });

  it("compact → 엔진에 /compact 슬래시 텍스트 주입 + 완료 통지", async () => {
    const backend = makeBackend();
    const injector: Injector = createInjector(paths, "test-lane", backend);
    await enqueue(paths, controlEnvelope("c2", { kind: "compact" }));
    await injector.start();
    await waitFor(() => fs.existsSync(path.join(paths.outDir, "c2.out")));

    expect(backend.inject).toHaveBeenCalledWith("test-lane", "/compact");
    expect(fs.readFileSync(path.join(paths.outDir, "c2.out"), "utf8")).toContain("압축");
  });

  it("resume(sessionId) → backend.resumeSession 호출, 성공 통지", async () => {
    const backend = {
      ...makeBackend(),
      resumeSession: vi.fn().mockResolvedValue({ sessionId: "old-9", resumed: true }),
    };
    const injector: Injector = createInjector(paths, "test-lane", backend);
    await enqueue(paths, controlEnvelope("c3", { kind: "resume", sessionId: "old-9" }));
    await injector.start();
    await waitFor(() => fs.existsSync(path.join(paths.outDir, "c3.out")));

    expect(backend.resumeSession).toHaveBeenCalledWith("test-lane", "old-9");
    expect(fs.readFileSync(path.join(paths.outDir, "c3.out"), "utf8")).toContain("old-9");
  });

  it("resume 복귀 실패(resumed=false) → 새 세션 폴백 통지", async () => {
    const backend = {
      ...makeBackend(),
      resumeSession: vi.fn().mockResolvedValue({ sessionId: "fresh-2", resumed: false }),
    };
    const injector: Injector = createInjector(paths, "test-lane", backend);
    await enqueue(paths, controlEnvelope("c4", { kind: "resume", sessionId: "gone-1" }));
    await injector.start();
    await waitFor(() => fs.existsSync(path.join(paths.outDir, "c4.out")));

    expect(fs.readFileSync(path.join(paths.outDir, "c4.out"), "utf8")).toContain("실패");
  });

  it("resume sessionId 없음 → 재개 대상 없음 통지(백엔드 미호출)", async () => {
    const backend = {
      ...makeBackend(),
      resumeSession: vi.fn(),
    };
    const injector: Injector = createInjector(paths, "test-lane", backend);
    await enqueue(paths, controlEnvelope("c5", { kind: "resume" }));
    await injector.start();
    await waitFor(() => fs.existsSync(path.join(paths.outDir, "c5.out")));

    expect(backend.resumeSession).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(paths.outDir, "c5.out"), "utf8")).toContain("없습니다");
  });

  it("sessions → 장부 목록(마지막 대화 시각 포함) 통지", async () => {
    fs.writeFileSync(
      paths.sessionsFile,
      JSON.stringify([
        {
          id: "s-a",
          createdAt: "2026-07-01T00:00:00Z",
          lastActivityAt: new Date(2026, 6, 3, 15, 30).toISOString(),
          label: "빌드 오류 분석",
        },
      ]),
    );
    const backend = makeBackend();
    const injector: Injector = createInjector(paths, "test-lane", backend);
    await enqueue(paths, controlEnvelope("c6", { kind: "sessions" }));
    await injector.start();
    await waitFor(() => fs.existsSync(path.join(paths.outDir, "c6.out")));

    const out = fs.readFileSync(path.join(paths.outDir, "c6.out"), "utf8");
    expect(out).toContain("빌드 오류 분석");
    expect(out).toContain("07-03 15:30"); // 마지막 대화 시각 표기
    expect(out).toContain("s-a");
  });

  it("reset 미지원 백엔드의 clear → 미지원 통지(크래시 없음)", async () => {
    const backend = makeBackend(); // reset/resumeSession 없음
    const injector: Injector = createInjector(paths, "test-lane", backend);
    await enqueue(paths, controlEnvelope("c7", { kind: "clear" }));
    await injector.start();
    await waitFor(() => fs.existsSync(path.join(paths.outDir, "c7.out")));

    expect(fs.readFileSync(path.join(paths.outDir, "c7.out"), "utf8")).toContain(
      "지원하지 않습니다",
    );
  });
});

describe("주입 실패 채널 표면화 (onFail)", () => {
  it("inject 실패 시 onFail(id, detail) 을 호출한다", async () => {
    const inject = vi.fn().mockRejectedValue(new Error("engine boom"));
    const backend = makeBackend(inject);
    const failures: Array<{ id: string; detail: string }> = [];
    const onFail = vi.fn().mockImplementation(async (id: string, detail: string) => {
      failures.push({ id, detail });
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const injector: Injector = createInjector(paths, "test-lane", backend, undefined, onFail);

    await enqueue(paths, makeEnvelope("f1"));
    await injector.start();
    await waitFor(() => failures.length >= 1);

    expect(failures[0]).toEqual({ id: "f1", detail: "engine boom" });
    // failed 가시성 기록은 ledger state="failed" 로 유지(구 .failed 사이드카 동등)
    await waitFor(() => ledgerEntry("f1")?.state === "failed");
    errSpy.mockRestore();
  });

  it("onFail 자체가 실패해도 예외가 전파되지 않는다(보조 신호 흡수)", async () => {
    const inject = vi.fn().mockRejectedValue(new Error("engine boom"));
    const backend = makeBackend(inject);
    const onFail = vi.fn().mockRejectedValue(new Error("notify boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const injector: Injector = createInjector(paths, "test-lane", backend, undefined, onFail);

    await enqueue(paths, makeEnvelope("f2"));
    await expect(injector.start()).resolves.toBeUndefined();
    await waitFor(() => ledgerEntry("f2")?.state === "failed");
    errSpy.mockRestore();
  });
});

describe("FR-1: render 실패 시 재전송 (ledger state=sent)", () => {
  it("render 성공 시 ledger state=sent 기록, 재호출 없음(dedup 유지)", async () => {
    const backend = makeBackend();
    const render = vi.fn().mockResolvedValue(undefined);
    const injector: Injector = createInjector(paths, "test-lane", backend, render);

    await enqueue(paths, makeEnvelope("s-ok"));
    await injector.start();
    await waitFor(() => ledgerEntry("s-ok")?.state === "sent");

    expect(render).toHaveBeenCalledTimes(1);
    // hot-path 는 hint(메모리 텍스트·sidecar)를 넘겨 어댑터가 디스크 재read 를 생략한다(M7).
    expect(render).toHaveBeenCalledWith(
      "s-ok",
      expect.objectContaining({ text: expect.any(String) }),
    );

    // 추가 notify 사이클에도 재전송하지 않는다(state=sent → flushUnsent 대상 아님).
    injector.notify();
    await flush();
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("render 실패 시 state=sent 미기록 → 응답은 out/ 에 durable, 이후 사이클에서 재전송", async () => {
    const backend = makeBackend();
    // 첫 render 는 실패, 이후 성공 — 재전송이 일어나면 state=sent 가 된다.
    const render = vi
      .fn()
      .mockRejectedValueOnce(new Error("send boom"))
      .mockResolvedValue(undefined);
    const injector: Injector = createInjector(paths, "test-lane", backend, render);

    await enqueue(paths, makeEnvelope("s-retry", "응답대상"));
    await injector.start();

    // 응답은 기록되고(.out), 재전송으로 결국 state=sent 가 된다.
    expect(fs.existsSync(path.join(paths.outDir, "s-retry.out"))).toBe(true);
    await waitFor(() => ledgerEntry("s-retry")?.state === "sent");
    expect(render.mock.calls.length).toBeGreaterThanOrEqual(2); // 최초 실패 + 재전송
  });

  it("크래시 재개: body 있고 state=sent 아니면 start() 가 재전송한다", async () => {
    const backend = makeBackend();
    const render = vi.fn().mockResolvedValue(undefined);
    // 이전 실행에서 응답은 기록됐으나 전송 전 크래시한 상태를 모사(body-first: body+ledger done 확정).
    await writeOutBody(paths, "orphan", "미전송 응답");
    await setDone(paths, "orphan", {});

    const injector: Injector = createInjector(paths, "test-lane", backend, render);
    await injector.start();
    await waitFor(() => ledgerEntry("orphan")?.state === "sent");

    // 크래시 flush 경로는 hint 없이 호출 → 어댑터가 디스크에서 읽는다(M7 재read 생략은 hot-path 만).
    expect(render).toHaveBeenCalledWith("orphan", undefined);
    // 재주입(엔진 재실행)은 하지 않는다 — 전송만 복구.
    expect(backend.inject).not.toHaveBeenCalled();
  });

  it("start() 와 notify() 가 겹쳐도 같은 응답을 한 번만 전송한다 (이중전송 가드, SC-020)", async () => {
    const backend = makeBackend();
    const calls: string[] = [];
    // 느린 render 로 동시 진입 창을 키운다.
    const render = vi.fn().mockImplementation(async (id: string) => {
      calls.push(id);
      await new Promise<void>((r) => setTimeout(r, 5));
    });
    await writeOutBody(paths, "dup", "한 번만 전송");
    await setDone(paths, "dup", {});

    const injector: Injector = createInjector(paths, "test-lane", backend, render);
    // start 의 flushUnsent 와 notify 발 injectNext 의 flushUnsent 를 동시에 유발.
    const startP = injector.start();
    injector.notify();
    injector.notify();
    await startP;
    await waitFor(() => ledgerEntry("dup")?.state === "sent");
    await flush();
    await flush();

    expect(calls.filter((id) => id === "dup")).toHaveLength(1);
  });
});

describe("A3: 전송 dedup — sending 상태 / at-most-once (비멱등 소스, SC-006·SC-007·SC-008)", () => {
  it("SC-1 비멱등: state=sending 잔존(전송 중 크래시) → 재전송 대신 불확실 통지 1회 + state=aborted 종단", async () => {
    const backend = makeBackend();
    const render = vi.fn().mockResolvedValue(undefined);
    const uncertain: string[] = [];
    const onUncertain = vi.fn().mockImplementation(async (id: string) => {
      uncertain.push(id);
    });
    // render 진행 중 크래시 모사: body+ledger done 확정 후 sending 전이, sent 미도달.
    await writeOutBody(paths, "midsend", "전송 중이던 응답");
    await setDone(paths, "midsend", {});
    await setSending(paths, "midsend");

    const injector: Injector = createInjector(
      paths,
      "test-lane",
      backend,
      render,
      undefined,
      undefined,
      {
        idempotent: false,
        onUncertain,
      },
    );
    await injector.start();
    await waitFor(() => ledgerEntry("midsend")?.state === "aborted");

    expect(render).not.toHaveBeenCalled(); // 재전송 안 함
    expect(uncertain).toEqual(["midsend"]); // 불확실 통지 정확히 1회
    expect(ledgerEntry("midsend")?.state).toBe("aborted");
  });

  it("SC-2 비멱등: state=done 만(전송 이전 크래시) → 재시작 시 정상 전송(state=sent), 불확실 통지 없음", async () => {
    const backend = makeBackend();
    const render = vi.fn().mockResolvedValue(undefined);
    const onUncertain = vi.fn().mockResolvedValue(undefined);
    await writeOutBody(paths, "pre", "아직 안 보낸 응답");
    await setDone(paths, "pre", {});

    const injector: Injector = createInjector(
      paths,
      "test-lane",
      backend,
      render,
      undefined,
      undefined,
      {
        idempotent: false,
        onUncertain,
      },
    );
    await injector.start();
    await waitFor(() => ledgerEntry("pre")?.state === "sent");

    expect(render).toHaveBeenCalledWith("pre", undefined);
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it("SC-3 비멱등 정상: render 직전 state=sending → 성공 시 state=sent 로 정리(불확실 없음)", async () => {
    const backend = makeBackend();
    let sawSendingDuringRender = false;
    const render = vi.fn().mockImplementation(async (id: string) => {
      sawSendingDuringRender = ledgerEntry(id)?.state === "sending";
    });
    const onUncertain = vi.fn().mockResolvedValue(undefined);
    const injector: Injector = createInjector(
      paths,
      "test-lane",
      backend,
      render,
      undefined,
      undefined,
      {
        idempotent: false,
        onUncertain,
      },
    );

    await enqueue(paths, makeEnvelope("h1"));
    await injector.start();
    await waitFor(() => ledgerEntry("h1")?.state === "sent");

    expect(sawSendingDuringRender).toBe(true); // render 중 상태=sending 관측
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it("SC-4 멱등(markdown): sending 상태 미경유, 재전송 안전(불확실 없음)", async () => {
    const backend = makeBackend();
    let sawSending = false;
    const render = vi.fn().mockImplementation(async (id: string) => {
      if (ledgerEntry(id)?.state === "sending") sawSending = true;
    });
    const onUncertain = vi.fn().mockResolvedValue(undefined);
    const injector: Injector = createInjector(
      paths,
      "test-lane",
      backend,
      render,
      undefined,
      undefined,
      {
        idempotent: true,
        onUncertain,
      },
    );

    await enqueue(paths, makeEnvelope("m1"));
    await injector.start();
    await waitFor(() => ledgerEntry("m1")?.state === "sent");

    expect(sawSending).toBe(false); // 멱등 소스는 sending 상태 미사용
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it("SC-8 멱등(markdown) render 실패 → 재전송(at-least-once)되고 sending 상태가 전혀 기록되지 않는다", async () => {
    const backend = makeBackend();
    let sawSendingEver = false;
    const render = vi
      .fn()
      .mockImplementationOnce(async (id: string) => {
        if (ledgerEntry(id)?.state === "sending") sawSendingEver = true;
        throw new Error("markdown render boom");
      })
      .mockImplementation(async (id: string) => {
        if (ledgerEntry(id)?.state === "sending") sawSendingEver = true;
      });
    const onUncertain = vi.fn().mockResolvedValue(undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const injector: Injector = createInjector(
      paths,
      "test-lane",
      backend,
      render,
      undefined,
      undefined,
      { idempotent: true, onUncertain },
    );

    await enqueue(paths, makeEnvelope("md1", "멱등 응답대상"));
    await injector.start();
    await waitFor(() => ledgerEntry("md1")?.state === "sent");

    expect(render.mock.calls.length).toBeGreaterThanOrEqual(2); // 최초 실패 + 재전송(at-least-once)
    expect(sawSendingEver).toBe(false); // 멱등 소스는 전송 진행 저널(state=sending)을 전혀 쓰지 않는다
    expect(onUncertain).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("SC-5 비멱등 프로세스 내 render 실패 → done 으로 되돌린 후 재시도(state=sent), aborted·불확실 없음", async () => {
    const backend = makeBackend();
    const render = vi
      .fn()
      .mockRejectedValueOnce(new Error("send boom"))
      .mockResolvedValue(undefined);
    const onUncertain = vi.fn().mockResolvedValue(undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const injector: Injector = createInjector(
      paths,
      "test-lane",
      backend,
      render,
      undefined,
      undefined,
      {
        idempotent: false,
        onUncertain,
      },
    );

    await enqueue(paths, makeEnvelope("w1", "응답대상"));
    await injector.start();
    await waitFor(() => ledgerEntry("w1")?.state === "sent");

    expect(render.mock.calls.length).toBeGreaterThanOrEqual(2); // 최초 실패 + 재시도
    expect(onUncertain).not.toHaveBeenCalled(); // 프로세스 내 실패는 불확실 아님(at-least-once 유지)
    errSpy.mockRestore();
  });

  it("SC-6 state=aborted 종단 id 는 이후 재시작에서 재통지·재전송하지 않는다", async () => {
    const backend = makeBackend();
    const render = vi.fn().mockResolvedValue(undefined);
    const onUncertain = vi.fn().mockResolvedValue(undefined);
    await writeOutBody(paths, "done", "x");
    await setDone(paths, "done", {});
    await setAborted(paths, "done");

    const injector: Injector = createInjector(
      paths,
      "test-lane",
      backend,
      render,
      undefined,
      undefined,
      {
        idempotent: false,
        onUncertain,
      },
    );
    await injector.start();
    await flush();
    await flush();

    expect(render).not.toHaveBeenCalled();
    expect(onUncertain).not.toHaveBeenCalled();
  });
});

describe("FR-2: 손상 큐 메시지 격리 (SC-012)", () => {
  it("start() 재개 시 손상 processing 메시지를 격리(.corrupt) + ledger state=failed, 재기동 반복 안 함", async () => {
    const backend = makeBackend();
    fs.writeFileSync(path.join(paths.processingDir, "bad.msg"), "{ not valid json");

    const injector: Injector = createInjector(paths, "test-lane", backend);
    await expect(injector.start()).resolves.toBeUndefined();

    expect(fs.existsSync(path.join(paths.processingDir, "bad.msg"))).toBe(false);
    expect(fs.existsSync(path.join(paths.processingDir, "bad.msg.corrupt"))).toBe(true);
    expect(ledgerEntry("bad")?.state).toBe("failed");
    expect(backend.inject).not.toHaveBeenCalled();

    // 재기동해도 .corrupt 는 scanProcessing 대상이 아니라 다시 처리되지 않는다.
    const injector2: Injector = createInjector(paths, "test-lane", backend);
    await injector2.start();
    expect(backend.inject).not.toHaveBeenCalled();
  });
});

describe("inject 실패 보존 (011-E1, SC-012)", () => {
  it("inject 실패 시 ledger state=failed 를 남기고 processing 은 유지(재처리), body(.out)는 없음", async () => {
    const inject = vi.fn().mockRejectedValue(new Error("boom"));
    const backend = makeBackend(inject);
    const injector: Injector = createInjector(paths, "test-lane", backend);

    await enqueue(paths, makeEnvelope("ef1", "실패 메시지"));
    injector.notify();
    await waitFor(() => ledgerEntry("ef1")?.state === "failed");

    expect(ledgerEntry("ef1")?.state).toBe("failed");
    // processing 잔존 → 재기동 시 재처리(at-least-once). dedup 앵커(body)는 미생성.
    expect(fs.existsSync(path.join(paths.processingDir, "ef1.msg"))).toBe(true);
    expect(fs.existsSync(path.join(paths.outDir, "ef1.out"))).toBe(false);
  });
});
