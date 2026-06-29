import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AcpBackend } from "../../src/backend/acp/client.js";
import { appendTranscript } from "../../src/core/transcript.js";
import type { SessionEvent } from "../../src/core/transcript.js";
import { lanePaths } from "../../src/shared/paths.js";

// SC-006: ACP agent_message_chunk 이벤트 → transcript.log append (이전 내용 보존)
// integration: fake ACP 더블로 구독 흐름 검증
//
// 구현 접근: AcpBackend 인터페이스를 fake 로 구현하고,
// subscribe 콜백이 appendTranscript 를 호출하는 흐름을 검증.

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-transcript-int-"));
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

// fake AcpBackend — 구독자에게 이벤트를 주입할 수 있는 더블
// emit 은 모든 구독자 콜백이 완료될 때까지 await 한다 (async I/O 완료 보장)
function makeFakeAcpBackend(): AcpBackend & { emit(event: SessionEvent): Promise<void> } {
  const subscribers: Array<(e: SessionEvent) => Promise<void> | void> = [];
  return {
    caps: () => ({
      plane: "acp" as const,
      perm_tier: "acp",
      supports_attachments: false,
      acp_version: "v1" as const,
    }),
    launch: vi.fn().mockResolvedValue({ sessionId: "transcript-sess" }),
    inject: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockImplementation((_lane: string, cb: (e: SessionEvent) => Promise<void> | void) => {
      subscribers.push(cb);
    }),
    onPermissionRequest: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    emit: async (event: SessionEvent) => {
      for (const sub of subscribers) {
        await sub(event);
      }
    },
  };
}

describe("AcpBackend subscribe — agent_message_chunk (SC-006)", () => {
  it("fake ACP 가 agent_message_chunk 이벤트를 전송하면 transcript.log 에 append 된다", async () => {
    const fakeBackend = makeFakeAcpBackend();

    await fakeBackend.launch("test-lane");

    // 구독 등록 — appendTranscript 를 호출하는 래퍼
    fakeBackend.subscribe("test-lane", async (event) => {
      await appendTranscript(paths, event);
    });

    // fake ACP 가 agent_message_chunk 이벤트 전송 — await 로 I/O 완료 보장
    await fakeBackend.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "안녕하세요 반갑습니다" },
    });

    const content = fs.readFileSync(paths.transcriptLog, "utf8");
    expect(content).toContain("안녕하세요 반갑습니다");
  });

  it("기존 transcript.log 내용을 보존하고 새 청크를 append 한다 (SC-006 보존)", async () => {
    // 기존 내용
    fs.writeFileSync(paths.transcriptLog, "기존 트랜스크립트\n");

    const fakeBackend = makeFakeAcpBackend();

    await fakeBackend.launch("test-lane");

    fakeBackend.subscribe("test-lane", async (event) => {
      await appendTranscript(paths, event);
    });

    await fakeBackend.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "신규 내용" },
    });

    const content = fs.readFileSync(paths.transcriptLog, "utf8");
    expect(content).toContain("기존 트랜스크립트");
    expect(content).toContain("신규 내용");
  });

  it("appendTranscript 는 transcript.log 에 줄 단위로 append 한다", async () => {
    const event: SessionEvent = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "테스트 메시지" },
    };

    await appendTranscript(paths, event);

    const content = fs.readFileSync(paths.transcriptLog, "utf8");
    // 줄 단위 append — 개행 문자 포함
    expect(content.endsWith("\n")).toBe(true);
    expect(content).toContain("테스트 메시지");
  });
});
