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
// SC-011: stopReason=end_turn → idle 전환

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

const makeEnvelope = (id: string, text = "test"): Envelope => ({
  v: 1,
  id,
  lane: "test-lane",
  source: "telegram",
  backend: "acp",
  engine: "claude-code-acp",
  project: "myproj",
  ts: new Date().toISOString(),
  text,
});

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-injector-"));
  paths = lanePaths(tmpBase, "myproj", "test-lane");
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  fs.mkdirSync(paths.outDir, { recursive: true });
  fs.mkdirSync(paths.stateDir, { recursive: true });
  vi.useFakeTimers();
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Injector state machine (SC-011 idle 전환)", () => {
  it("초기 상태는 idle 이다", () => {
    const mockBackend = {
      inject: vi.fn().mockResolvedValue(undefined),
      caps: vi.fn(),
      launch: vi.fn(),
      subscribe: vi.fn(),
      onPermissionRequest: vi.fn(),
    };
    const injector: Injector = createInjector(paths, "test-lane", mockBackend);
    expect(injector.getState()).toBe("idle");
  });

  it("start() 후 idle 상태를 유지한다 (빈 큐)", async () => {
    const mockBackend = {
      inject: vi.fn().mockResolvedValue(undefined),
      caps: vi.fn(),
      launch: vi.fn(),
      subscribe: vi.fn(),
      onPermissionRequest: vi.fn(),
    };
    const injector: Injector = createInjector(paths, "test-lane", mockBackend);
    await injector.start();
    expect(injector.getState()).toBe("idle");
    expect(mockBackend.inject).not.toHaveBeenCalled();
  });

  it("onIdle() 호출 시 상태가 idle 로 전환된다 (SC-011)", async () => {
    const mockBackend = {
      inject: vi.fn().mockResolvedValue(undefined),
      caps: vi.fn(),
      launch: vi.fn(),
      subscribe: vi.fn(),
      onPermissionRequest: vi.fn(),
    };
    const injector: Injector = createInjector(paths, "test-lane", mockBackend);
    await enqueue(paths, makeEnvelope("sc011-id"));
    await injector.start();
    // active 상태에서 onIdle 호출
    injector.onIdle();
    // Node 이벤트 루프 처리를 위해 마이크로태스크 flush
    await Promise.resolve();
    expect(injector.getState()).toBe("idle");
  });
});

describe("SC-004: active 동안 다음 envelope 미주입", () => {
  it("첫 번째 inject 가 진행 중일 때 두 번째 envelope 은 queue 에 대기한다", async () => {
    // inject 는 즉시 resolve — start() 가 첫 번째만 처리하고 반환한 뒤 상태 검증.
    // state 는 inject 완료 후에도 active 를 유지한다 (onIdle() 호출 전까지).
    const mockBackend = {
      inject: vi.fn().mockResolvedValue(undefined),
      caps: vi.fn(),
      launch: vi.fn(),
      subscribe: vi.fn(),
      onPermissionRequest: vi.fn(),
    };

    await enqueue(paths, makeEnvelope("first"));
    await enqueue(paths, makeEnvelope("second"));

    const injector: Injector = createInjector(paths, "test-lane", mockBackend);

    // start() 는 injectNext() 를 한 번 호출한다 — claimNext→inject(first).
    // inject 가 즉시 resolve 되므로 start() 도 완료된다.
    await injector.start();

    // inject 는 첫 번째 envelope 에 대해서만 1번 호출되어야 한다.
    // (injectNext 는 start() 내부에서 단 1회 호출 — 두 번째는 onIdle() 트리거 필요)
    expect(mockBackend.inject).toHaveBeenCalledTimes(1);

    // start() 완료 후 state 는 active(inject 후 onIdle 미호출) 또는 idle(구현에 따라 다름)
    // 핵심 불변식: 두 번째 envelope 은 처리되지 않았어야 한다.
    // queue 에 second 가 있거나 processing 에 first 가 남아있어야 함.
    const queueFiles = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"));
    const processingFiles = fs.readdirSync(paths.processingDir).filter((f) => f.endsWith(".msg"));
    // 두 envelope 중 하나는 아직 처리 대기 상태여야 한다
    expect(queueFiles.length + processingFiles.length).toBeGreaterThanOrEqual(1);
    // inject 는 1번만 호출 — 두 번째 미주입
    expect(mockBackend.inject).toHaveBeenCalledTimes(1);
  });
});

describe("SC-005: out 존재 id dedup — backend.inject 미호출", () => {
  it("out/<id>.out 가 존재하면 processing 잔존 파일을 dedup 처리하고 inject 를 호출하지 않는다", async () => {
    const mockBackend = {
      inject: vi.fn().mockResolvedValue(undefined),
      caps: vi.fn(),
      launch: vi.fn(),
      subscribe: vi.fn(),
      onPermissionRequest: vi.fn(),
    };
    const env = makeEnvelope("dedup-id");

    // processing 에 파일 배치 (크래시 상황 시뮬레이션)
    fs.writeFileSync(path.join(paths.processingDir, "dedup-id.msg"), JSON.stringify(env));
    // out 에 이미 결과 파일 존재
    fs.writeFileSync(path.join(paths.outDir, "dedup-id.out"), "이미 처리됨");

    const injector: Injector = createInjector(paths, "test-lane", mockBackend);
    await injector.start();

    // inject 가 호출되면 안 됨 (dedup)
    expect(mockBackend.inject).not.toHaveBeenCalled();
  });
});

describe("SC-003: 크래시 후 processing 잔존 파일 재처리", () => {
  it("processing 에 파일이 있고 out 에 없으면 재처리 대상으로 인식한다", async () => {
    const mockBackend = {
      inject: vi.fn().mockResolvedValue(undefined),
      caps: vi.fn(),
      launch: vi.fn(),
      subscribe: vi.fn(),
      onPermissionRequest: vi.fn(),
    };
    const env = makeEnvelope("crash-recover");

    // processing 에 크래시 잔존 파일
    fs.writeFileSync(path.join(paths.processingDir, "crash-recover.msg"), JSON.stringify(env));
    // out 에는 없음

    const injector: Injector = createInjector(paths, "test-lane", mockBackend);
    await injector.start();

    // inject 가 호출되어야 함 (재처리)
    expect(mockBackend.inject).toHaveBeenCalledWith("test-lane", env.text);
  });
});
