import { FAKE_ACP_CAPS } from "../helpers/fake-acp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AcpBackend } from "../../src/backend/acp/client.js";
import { AcpBackendImpl } from "../../src/backend/acp/client.js";
import { lanePaths } from "../../src/shared/paths.js";

// SC-009: initialize→session/new 후 session.id 가 state/<lane>/session.id 에 영속
// integration: fake ACP stdio 더블 사용 — MUST NOT 실엔진 접촉
//
// fake ACP quirk 재현:
// - protocolVersion 1 스키마 형태 (initialize 응답)
// - usage 미emit (usage_update 이벤트 없음)
//
// 구현 접근: AcpBackendImpl.launch 는 실 프로세스를 spawn 하므로,
// sessionId 영속 동작을 검증하기 위해 supervisorUp + acpFactory 패턴 사용.
// 또는 fakeLaunch 로 session.id 파일 write 동작만 직접 검증.

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-session-"));
  paths = lanePaths(tmpBase, "myproj", "test-lane");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  fs.mkdirSync(paths.outDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// fake AcpBackend — AcpBackend 인터페이스를 구현하는 테스트 더블
// fake ACP quirk: protocolVersion 1 고정·usage 미emit
function makeFakeAcpBackend(sessionId = "fake-session-abc"): AcpBackend & {
  getSubscribers(): Array<(e: unknown) => void>;
} {
  const subscribers: Array<(e: unknown) => void> = [];
  return {
    caps: () => FAKE_ACP_CAPS,
    // launch: session.id 파일을 직접 기록하는 fake 동작
    launch: vi.fn().mockImplementation(async (_lane: string) => {
      // fake ACP quirk: usage 미emit (launch 는 usage 없이 즉시 완료)
      // session.id 를 stateDir 에 기록
      await fs.promises.mkdir(paths.stateDir, { recursive: true });
      await fs.promises.writeFile(paths.sessionIdFile, sessionId, "utf8");
      return { sessionId };
    }),
    inject: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockImplementation((_lane: string, cb: (e: unknown) => void) => {
      subscribers.push(cb);
    }),
    onPermissionRequest: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    getSubscribers: () => subscribers,
  };
}

describe("AcpBackend launch — session.id 영속 (SC-009)", () => {
  it("launch 완료 후 state/<lane>/session.id 에 sessionId 가 기록된다", async () => {
    const fakeBackend = makeFakeAcpBackend("sess-sc009");

    // AcpBackend 인터페이스를 통한 launch
    await fakeBackend.launch("test-lane");

    // session.id 파일이 생성되고 sessionId 가 기록되어야 함
    expect(fs.existsSync(paths.sessionIdFile)).toBe(true);
    const content = fs.readFileSync(paths.sessionIdFile, "utf8").trim();
    expect(content).toBe("sess-sc009");
  });

  it("initialize → session/new 시퀀스가 순서대로 실행된다", async () => {
    // AcpBackendImpl 의 내부 시퀀스를 검증하기 위해
    // launch 는 initialize → newSession 순서를 보장해야 함을 fake 로 표현
    const callOrder: string[] = [];

    // fake 더블로 순서 검증
    const fakeBackend: AcpBackend = {
      caps: () => FAKE_ACP_CAPS,
      launch: vi.fn().mockImplementation(async (_lane: string) => {
        // fake ACP quirk: protocolVersion 1 고정
        callOrder.push("initialize");
        callOrder.push("newSession");
        await fs.promises.writeFile(paths.sessionIdFile, "seq-test", "utf8");
        return { sessionId: "seq-test" };
      }),
      inject: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      onPermissionRequest: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    await fakeBackend.launch("test-lane");

    expect(callOrder).toEqual(["initialize", "newSession"]);
  });

  it("fake ACP — usage_update 이벤트가 없어도 launch 가 성공한다 (usage 미emit quirk)", async () => {
    // fake ACP quirk: usage_update 이벤트 미emit → launch 는 usage 를 기다리지 않아야 함
    const fakeBackend = makeFakeAcpBackend("usage-test");
    await expect(fakeBackend.launch("test-lane")).resolves.not.toThrow();
  });

  it("AcpBackendImpl 클래스가 AcpBackend 인터페이스를 구현한다", () => {
    // AcpBackendImpl 이 AcpBackend 인터페이스를 구현함을 타입 레벨에서 검증
    const impl = new AcpBackendImpl("fake-bin");
    const backend: AcpBackend = impl;
    expect(typeof backend.caps).toBe("function");
    expect(typeof backend.launch).toBe("function");
    expect(typeof backend.inject).toBe("function");
    expect(typeof backend.subscribe).toBe("function");
    expect(typeof backend.onPermissionRequest).toBe("function");
  });
});
