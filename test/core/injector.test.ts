import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Injector } from "../../src/core/injector.js";
import { createInjector } from "../../src/core/injector.js";
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
    injector.onSessionEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "안녕" } });
    injector.onSessionEvent({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "하세요" } });

    resolveInject();
    await startP;
    await waitUntil(() => fs.existsSync(path.join(paths.outDir, "b1.out.json")));

    const outText = fs.readFileSync(path.join(paths.outDir, "b1.out"), "utf8");
    expect(outText).toBe("안녕하세요");
    const sidecar = JSON.parse(fs.readFileSync(path.join(paths.outDir, "b1.out.json"), "utf8"));
    expect(sidecar.reply_ref.channel_msg_id).toBe("orig-42");
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
