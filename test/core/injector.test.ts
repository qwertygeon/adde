import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Injector } from "../../src/core/injector.js";
import { createInjector, questionExcerpt } from "../../src/core/injector.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { lanePaths } from "../../src/shared/paths.js";
import { enqueue } from "../../src/core/queue.js";
import type { Envelope } from "../../src/shared/envelope.js";

// SC-003: 크래시 후 processing 잔존 파일 재처리
// SC-004: active 동안 다음 envelope 미주입 (idle 게이트)
// SC-005: out 존재 id dedup — backend.inject 미호출
// SC-A1: notify() 로 idle 레인 깨우기  · SC-A2: turn 종료 후 다음 메시지 자동 진행
// SC-B1: agent_message_chunk 누적 → writeOut(out/<id>.out + sidecar)  · SC-B2: render(id) 호출

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

const makeEnvelope = (id: string, text = "test", replyMsgId?: string): Envelope => ({
  v: 1,
  id,
  lane: "test-lane",
  source: "telegram",
  backend: "acp",
  engine: "claude-code-acp",
  project: "myproj",
  ts: new Date().toISOString(),
  text,
  ...(replyMsgId ? { reply_ref: { channel_msg_id: replyMsgId } } : {}),
});

/** setImmediate 큐 flush — injectNext 의 비동기 진행 1틱. */
const flush = () => new Promise<void>((r) => setImmediate(r));

/**
 * 조건 충족까지 폴링 대기. injectNext/processOne 의 fs IO(mkdir·write·rename)는
 * libuv 스레드풀에서 처리되므로, setImmediate 같은 CPU 틱만 돌리면 전체 스위트 병렬
 * 실행 시 디스크 경합으로 fs 완료보다 틱이 먼저 소진돼 위양성(flaky)이 났다.
 * → 실제 시간을 흘려보내는 타이머로 폴링하고, 시한 초과 시 조용히 통과하지 않고 throw 한다.
 */
async function waitUntil(cond: () => boolean, tries = 300): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setTimeout(r, 2));
  }
  if (!cond()) throw new Error("waitUntil: 조건이 제한 시간 내 충족되지 않음");
}

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
    expect(backend.inject).toHaveBeenCalledWith("test-lane", "test");
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
    await waitUntil(() => backend.inject.mock.calls.length > 0);

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
    await waitUntil(() => inject.mock.calls.length >= 1);

    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenLastCalledWith("test-lane", "첫째");
    expect(injector.getState()).toBe("active");

    // turn 종료 → 둘째 자동 진행(SC-A2)
    resolveFirst();
    await startP;
    await waitUntil(() => inject.mock.calls.length >= 2 && injector.getState() === "idle");

    expect(inject).toHaveBeenCalledTimes(2);
    expect(inject).toHaveBeenLastCalledWith("test-lane", "둘째");
    expect(injector.getState()).toBe("idle");
  });
});

describe("SC-005: out 존재 id dedup — inject 미호출", () => {
  it("out/<id>.out 가 존재하면 dedup, inject 미호출", async () => {
    const backend = makeBackend();
    const env = makeEnvelope("dedup-id");
    fs.writeFileSync(path.join(paths.processingDir, "dedup-id.msg"), JSON.stringify(env));
    fs.writeFileSync(path.join(paths.outDir, "dedup-id.out"), "이미 처리됨");

    const injector: Injector = createInjector(paths, "test-lane", backend);
    await injector.start();

    expect(backend.inject).not.toHaveBeenCalled();
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

describe("SC-B1: 응답 누적 → writeOut(out/<id>.out + sidecar)", () => {
  it("agent_message_chunk 를 누적해 turn 종료 시 out 에 기록(reply_ref 포함)", async () => {
    let resolveInject!: () => void;
    const inject = vi.fn().mockImplementation(() => new Promise<void>((r) => (resolveInject = r)));
    const backend = makeBackend(inject);
    const injector: Injector = createInjector(paths, "test-lane", backend);

    await enqueue(paths, makeEnvelope("b1", "질문", "orig-42"));
    const startP = injector.start();
    await waitUntil(() => typeof resolveInject === "function");

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
    await waitUntil(() => fs.existsSync(path.join(paths.outDir, "b1.out.json")));

    const outText = fs.readFileSync(path.join(paths.outDir, "b1.out"), "utf8");
    expect(outText).toBe("안녕하세요");
    const sidecar = JSON.parse(fs.readFileSync(path.join(paths.outDir, "b1.out.json"), "utf8"));
    expect(sidecar.reply_ref.channel_msg_id).toBe("orig-42");
  });

  it("sidecar 에 원본 전송 시각(origin_ts)·질문 발췌(question)를 기록한다", async () => {
    const backend = makeBackend();
    const injector: Injector = createInjector(paths, "test-lane", backend);

    const env = makeEnvelope("b2", "빌드 오류 원인 분석해줘\n두 번째 줄은 발췌 제외");
    await enqueue(paths, env);
    await injector.start();
    await waitUntil(() => fs.existsSync(path.join(paths.outDir, "b2.out.json")));

    const sidecar = JSON.parse(fs.readFileSync(path.join(paths.outDir, "b2.out.json"), "utf8"));
    expect(sidecar.origin_ts).toBe(env.ts);
    expect(sidecar.question).toBe("빌드 오류 원인 분석해줘");
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
    await waitUntil(() => failures.length >= 1);

    expect(failures[0]).toEqual({ id: "f1", detail: "engine boom" });
    // .failed 사이드카 기록은 기존대로 유지
    expect(fs.existsSync(path.join(paths.outDir, "f1.failed"))).toBe(true);
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
    await waitUntil(() => fs.existsSync(path.join(paths.outDir, "f2.failed")));
    errSpy.mockRestore();
  });
});

describe("FR-1: render 실패 시 재전송 (.sent 마커)", () => {
  it("render 성공 시 out/<id>.sent 기록, 재호출 없음(dedup 유지)", async () => {
    const backend = makeBackend();
    const render = vi.fn().mockResolvedValue(undefined);
    const injector: Injector = createInjector(paths, "test-lane", backend, render);

    await enqueue(paths, makeEnvelope("s-ok"));
    await injector.start();
    await waitUntil(() => fs.existsSync(path.join(paths.outDir, "s-ok.sent")));

    expect(render).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(paths.outDir, "s-ok.sent"))).toBe(true);

    // 추가 notify 사이클에도 재전송하지 않는다(.sent 존재 → flushUnsent 대상 아님).
    injector.notify();
    await flush();
    await flush();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("render 실패 시 .sent 미기록 → 응답은 out/ 에 durable, 이후 사이클에서 재전송", async () => {
    const backend = makeBackend();
    // 첫 render 는 실패, 이후 성공 — 재전송이 일어나면 .sent 가 생긴다.
    const render = vi
      .fn()
      .mockRejectedValueOnce(new Error("send boom"))
      .mockResolvedValue(undefined);
    const injector: Injector = createInjector(paths, "test-lane", backend, render);

    await enqueue(paths, makeEnvelope("s-retry", "응답대상"));
    await injector.start();

    // 응답은 기록되고(.out), 재전송으로 결국 .sent 가 생긴다.
    expect(fs.existsSync(path.join(paths.outDir, "s-retry.out"))).toBe(true);
    await waitUntil(() => fs.existsSync(path.join(paths.outDir, "s-retry.sent")));
    expect(render.mock.calls.length).toBeGreaterThanOrEqual(2); // 최초 실패 + 재전송
  });

  it("크래시 재개: out 있고 .sent 없으면 start() 가 재전송한다", async () => {
    const backend = makeBackend();
    const render = vi.fn().mockResolvedValue(undefined);
    // 이전 실행에서 응답은 기록됐으나 전송 전 크래시한 상태를 모사.
    fs.writeFileSync(path.join(paths.outDir, "orphan.out"), "미전송 응답");
    fs.writeFileSync(path.join(paths.outDir, "orphan.out.json"), JSON.stringify({ ts: "x" }));

    const injector: Injector = createInjector(paths, "test-lane", backend, render);
    await injector.start();
    await waitUntil(() => fs.existsSync(path.join(paths.outDir, "orphan.sent")));

    expect(render).toHaveBeenCalledWith("orphan");
    // 재주입(엔진 재실행)은 하지 않는다 — 전송만 복구.
    expect(backend.inject).not.toHaveBeenCalled();
  });

  it("start() 와 notify() 가 겹쳐도 같은 응답을 한 번만 전송한다 (이중전송 가드)", async () => {
    const backend = makeBackend();
    const calls: string[] = [];
    // 느린 render 로 동시 진입 창을 키운다.
    const render = vi.fn().mockImplementation(async (id: string) => {
      calls.push(id);
      await new Promise<void>((r) => setTimeout(r, 5));
    });
    fs.writeFileSync(path.join(paths.outDir, "dup.out"), "한 번만 전송");
    fs.writeFileSync(path.join(paths.outDir, "dup.out.json"), JSON.stringify({ ts: "x" }));

    const injector: Injector = createInjector(paths, "test-lane", backend, render);
    // start 의 flushUnsent 와 notify 발 injectNext 의 flushUnsent 를 동시에 유발.
    const startP = injector.start();
    injector.notify();
    injector.notify();
    await startP;
    await waitUntil(() => fs.existsSync(path.join(paths.outDir, "dup.sent")));
    await flush();
    await flush();

    expect(calls.filter((id) => id === "dup")).toHaveLength(1);
  });
});

describe("FR-2: 손상 큐 메시지 격리", () => {
  it("start() 재개 시 손상 processing 메시지를 격리(.corrupt) + .failed, 재기동 반복 안 함", async () => {
    const backend = makeBackend();
    fs.writeFileSync(path.join(paths.processingDir, "bad.msg"), "{ not valid json");

    const injector: Injector = createInjector(paths, "test-lane", backend);
    await expect(injector.start()).resolves.toBeUndefined();

    expect(fs.existsSync(path.join(paths.processingDir, "bad.msg"))).toBe(false);
    expect(fs.existsSync(path.join(paths.processingDir, "bad.msg.corrupt"))).toBe(true);
    expect(fs.existsSync(path.join(paths.outDir, "bad.failed"))).toBe(true);
    expect(backend.inject).not.toHaveBeenCalled();

    // 재기동해도 .corrupt 는 scanProcessing 대상이 아니라 다시 처리되지 않는다.
    const injector2: Injector = createInjector(paths, "test-lane", backend);
    await injector2.start();
    expect(backend.inject).not.toHaveBeenCalled();
  });
});

describe("inject 실패 보존 (011-E1)", () => {
  it("inject 실패 시 out/<id>.failed 를 남기고 processing 은 유지(재처리), .out 은 없음", async () => {
    const inject = vi.fn().mockRejectedValue(new Error("boom"));
    const backend = makeBackend(inject);
    const injector: Injector = createInjector(paths, "test-lane", backend);

    await enqueue(paths, makeEnvelope("ef1", "실패 메시지"));
    injector.notify();
    await waitUntil(() => fs.existsSync(path.join(paths.outDir, "ef1.failed")));

    expect(fs.existsSync(path.join(paths.outDir, "ef1.failed"))).toBe(true);
    // processing 잔존 → 재기동 시 재처리(at-least-once). dedup 마커(.out)는 미생성.
    expect(fs.existsSync(path.join(paths.processingDir, "ef1.msg"))).toBe(true);
    expect(fs.existsSync(path.join(paths.outDir, "ef1.out"))).toBe(false);
  });
});
