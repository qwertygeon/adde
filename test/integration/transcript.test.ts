import { FAKE_ACP_CAPS } from "../helpers/fake-acp.js";
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
    caps: () => FAKE_ACP_CAPS,
    launch: vi.fn().mockResolvedValue({ sessionId: "transcript-sess" }),
    inject: vi.fn().mockResolvedValue(undefined),
    subscribe: vi
      .fn()
      .mockImplementation((_lane: string, cb: (e: SessionEvent) => Promise<void> | void) => {
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

// SC-008 (FR-008): 동시 진행 중인 transcript append + 회전 경합에서도 기록 손실이 없다
// (세대 소실 0). 실 fs + 실 동시 디스패치(Promise.all)로 경합을 재현한다 — ADR-003 경로별
// Promise-chain 뮤텍스가 stat→rotate 인터리브(이중 회전에 의한 세대 소실)를 막는지 검증.
describe("appendTranscript 동시 회전 무손실 (SC-008 Edge — 경합)", () => {
  it("작은 임계로 다수 동시 append 해도 모든 이벤트가 정확히 1회씩 어딘가에 존재한다(소실·중복 없음)", async () => {
    const N = 20;
    // keep 을 N 보다 크게 잡아 "정상적인 keep 상한 소실"과 "버그로 인한 유실"을 구분한다 —
    // 최대 회전 횟수는 append 횟수(N)를 넘지 않으므로 keep=N+5 면 세대 보관 상한으로 인한
    // 정상 소실이 발생하지 않는다(이 테스트의 관심사는 오직 경합으로 인한 유실·중복 여부).
    const rotateOpts = { rotate: { maxBytes: 60, keep: N + 5 } };

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendTranscript(
          paths,
          { type: "agent_message_chunk" as const, content: `EVT-${i}` },
          rotateOpts,
        ),
      ),
    );

    const files = fs
      .readdirSync(path.dirname(paths.transcriptLog))
      .filter((f) => f.startsWith(path.basename(paths.transcriptLog)))
      .map((f) => path.join(path.dirname(paths.transcriptLog), f));
    const combined = files.map((p) => fs.readFileSync(p, "utf8")).join("\n");

    // N 개 이벤트 전부 정확히 1회씩 존재 — 손실(0회) 도 중복(2회+) 도 없다.
    // 경계(뒤에 숫자가 오지 않음) 확인 필수 — 그냥 substring 매칭이면 "EVT-1" 이 "EVT-10".."EVT-19"
    // 에도 매칭되어 오탐(false positive)이 난다.
    for (let i = 0; i < N; i++) {
      const marker = new RegExp(`EVT-${i}(?!\\d)`, "g");
      const occurrences = (combined.match(marker) ?? []).length;
      expect(occurrences).toBe(1);
    }
  });
});
