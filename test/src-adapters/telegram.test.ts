import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { TelegramSource } from "../../src/src-adapters/telegram.js";
import { createTelegramSource } from "../../src/src-adapters/telegram.js";
import { lanePaths } from "../../src/shared/paths.js";

// SC-014: long-poll→envelope→queue 저장
// SC-015: out→quote-reply (sendMessage reply_to=원본 id)
// SC-017: 권한 요청 시 inline 버튼 [[allow,deny]] 전송
// SC-018: 콜백→answerCallbackQuery+게이트 전달
//
// OOM 방지: pollLoop 는 delay 없이 루프한다.
// 두 번째 이후 getUpdates 호출을 pending Promise 로 차단하여 tight loop 방지.
// makeSingleCycleFetch / makeNCycleFetch 헬퍼로 각 테스트에 필요한 사이클 수만 허용.

/** 조건이 참이 될 때까지 setImmediate 로 대기 (최대 N회) */
async function waitFor(condition: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * 단일 poll 사이클을 허용하는 fetch mock 빌더.
 * 첫 번째 getUpdates 호출은 firstResult 를 즉시 반환하고,
 * 두 번째 이후는 releasePending() 호출 전까지 pending 상태를 유지한다.
 * otherMethods: method → params → result 핸들러.
 */
function makeSingleCycleFetch(
  firstResult: unknown,
  otherMethods: Record<string, (params: Record<string, unknown>) => unknown> = {},
): { fetchMock: ReturnType<typeof vi.fn>; releasePending: () => void } {
  let releaseNext!: () => void;
  const pendingPromise = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });

  let getUpdatesCallCount = 0;

  const fetchMock = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    const method = (url as string).split("/").pop() ?? "";
    const body = options.body ? (JSON.parse(options.body as string) as Record<string, unknown>) : {};

    if (method === "getUpdates") {
      getUpdatesCallCount++;
      if (getUpdatesCallCount === 1) {
        return { ok: true, json: async () => ({ ok: true, result: firstResult }) };
      }
      // 두 번째 이후는 차단 — tight loop OOM 방지
      await pendingPromise;
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    }

    const handler = otherMethods[method];
    const result = handler ? handler(body) : true;
    return { ok: true, json: async () => ({ ok: true, result }) };
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, releasePending: releaseNext };
}

/**
 * N 사이클 poll 을 허용하는 fetch mock 빌더.
 * getUpdates 가 n 번 호출된 후 (n+1) 번째는 releaseAfterN() 호출 전까지 차단한다.
 * cycleResults: 사이클별 응답 배열. 길이보다 많은 호출은 [] 반환.
 */
function makeNCycleFetch(
  cycleResults: unknown[],
  otherMethods: Record<string, (params: Record<string, unknown>) => unknown> = {},
): {
  fetchMock: ReturnType<typeof vi.fn>;
  releaseAfterN: () => void;
  capturedOffsets: number[];
} {
  let releaseNext!: () => void;
  const pendingPromise = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });

  let getUpdatesCallCount = 0;
  const capturedOffsets: number[] = [];

  const fetchMock = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    const method = (url as string).split("/").pop() ?? "";
    const body = options.body ? (JSON.parse(options.body as string) as Record<string, unknown>) : {};

    if (method === "getUpdates") {
      capturedOffsets.push((body["offset"] as number) ?? 0);
      getUpdatesCallCount++;
      if (getUpdatesCallCount <= cycleResults.length) {
        return { ok: true, json: async () => ({ ok: true, result: cycleResults[getUpdatesCallCount - 1] }) };
      }
      // N 사이클 후 차단 — tight loop OOM 방지
      await pendingPromise;
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    }

    const handler = otherMethods[method];
    const result = handler ? handler(body) : true;
    return { ok: true, json: async () => ({ ok: true, result }) };
  });

  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, releaseAfterN: releaseNext, capturedOffsets };
}

// Bot API fetch mock 응답 생성 헬퍼 (SC-015, SC-017 전용 — poll loop 없는 테스트)
type BotApiResponder = (method: string, params: Record<string, unknown>) => unknown;

function setupFetchMock(responder: BotApiResponder): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    const method = (url as string).split("/").pop() ?? "";
    const body = options.body ? (JSON.parse(options.body as string) as Record<string, unknown>) : {};
    const result = responder(method, body);
    return {
      ok: true,
      json: async () => ({ ok: true, result }),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-telegram-"));
  paths = lanePaths(tmpBase, "myproj", "test-lane");
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  fs.mkdirSync(paths.outDir, { recursive: true });
  fs.mkdirSync(paths.stateDir, { recursive: true });
  // 봇 토큰 — 토큰 형식과 무관하게 readBotToken 이 읽으므로 임의 값 허용
  fs.writeFileSync(paths.envFile, "TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg\n");
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TelegramSource long-poll (SC-014)", () => {
  it("getUpdates 응답에서 메시지를 envelope 으로 정규화하여 queue 에 저장한다", async () => {
    const fakeUpdate = {
      update_id: 1001,
      message: {
        message_id: 42,
        from: { id: 99, first_name: "Dev" },
        chat: { id: 99, type: "private" },
        text: "안녕하세요",
        date: 1700000000,
      },
    };

    // 첫 poll: fakeUpdate 반환, 두 번째 이후: 차단 (OOM 방지)
    const { releasePending } = makeSingleCycleFetch([fakeUpdate]);

    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-code-acp",
      paths,
    });

    source.start();

    // queue 에 .msg 파일이 생성될 때까지 대기
    await waitFor(() => fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg")).length >= 1);

    // 차단 해제 → poll loop 종료 가능
    releasePending();
    source.stop();

    const files = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"));
    expect(files.length).toBeGreaterThanOrEqual(1);

    const content = fs.readFileSync(path.join(paths.queueDir, files[0]!), "utf8");
    const envelope = JSON.parse(content) as Record<string, unknown>;
    expect(envelope["v"]).toBe(1);
    expect(envelope["text"]).toBe("안녕하세요");
    expect(envelope["source"]).toBe("telegram");
  });

  it("getUpdates offset 중복 처리 — 동일 update_id 재처리 안 함 (fake telegram quirk)", async () => {
    // fake telegram quirk: getUpdates offset 없이 반복 호출하면 동일 update 가 중복 수신됨
    // → TelegramSource 는 offset 을 update_id+1 로 설정하여 중복 방지
    const fakeUpdate = {
      update_id: 2001,
      message: {
        message_id: 43,
        from: { id: 99, first_name: "Dev" },
        chat: { id: 99, type: "private" },
        text: "중복 테스트",
        date: 1700000001,
      },
    };

    // 2사이클: 첫 poll → fakeUpdate, 두 번째 poll → fakeUpdate(quirk: 같은 update 재수신)
    // 세 번째 이후는 차단 (capturedOffsets.length >= 2 를 waitFor 로 대기 후 해제)
    const { releaseAfterN, capturedOffsets } = makeNCycleFetch([[fakeUpdate], [fakeUpdate]]);

    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-code-acp",
      paths,
    });

    source.start();

    // 두 번째 getUpdates 가 호출되고 첫 번째 enqueue 가 완료될 때까지 대기
    await waitFor(() => capturedOffsets.length >= 2 && fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg")).length >= 1);

    releaseAfterN();
    source.stop();

    // 두 번째 poll 의 offset 이 2002 이어야 함 (update_id + 1)
    // 실제 Telegram API 는 offset=2002 이면 update_id=2001 을 재전송하지 않음
    // → TelegramSource 가 올바른 offset 을 전송하는지만 검증
    expect(capturedOffsets.length).toBeGreaterThanOrEqual(2);
    expect(capturedOffsets[1]).toBe(2002);
  });
});

describe("TelegramSource out→quote-reply (SC-015)", () => {
  it("out/<id>.out 파일 생성 감지 시 sendMessage(reply_to=원본 id) 를 호출한다", async () => {
    const sentMessages: Record<string, unknown>[] = [];

    // SC-015 는 sendReply 직접 호출 — poll loop 없으므로 setupFetchMock 으로 충분
    setupFetchMock((method, params) => {
      if (method === "getUpdates") return [];
      if (method === "sendMessage") {
        sentMessages.push({ ...params });
        return { message_id: 100 };
      }
      return true;
    });

    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-code-acp",
      paths,
    });

    // sendReply 를 직접 호출하여 SC-015 핵심 동작 검증 (poll loop 미사용)
    await source.sendReply(99, "응답 텍스트", 42);

    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const lastMsg = sentMessages[sentMessages.length - 1];
    expect(lastMsg?.["reply_to_message_id"]).toBe(42);
    expect(lastMsg?.["text"]).toBe("응답 텍스트");
  });
});

describe("TelegramSource inline 버튼 (SC-017)", () => {
  it("권한 요청 시 sendMessage(reply_markup inline_keyboard [[allow,deny]]) 를 호출한다", async () => {
    const sentMessages: Record<string, unknown>[] = [];

    // SC-017 는 sendPermPrompt 직접 호출 — poll loop 없으므로 setupFetchMock 으로 충분
    setupFetchMock((method, params) => {
      if (method === "getUpdates") return [];
      if (method === "sendMessage") {
        sentMessages.push({ ...params });
        return { message_id: 200 };
      }
      return true;
    });

    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-code-acp",
      paths,
    });

    await source.sendPermPrompt(0, "perm-001", {
      v: 1,
      id: "perm-001",
      lane: "test-lane",
      channel: "telegram",
      tool: "Bash",
      detail: "rm -rf build/",
      cwd: "/tmp/myproject",
      ts: new Date().toISOString(),
    });

    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const permMsg = sentMessages[0];
    expect(permMsg?.["reply_markup"]).toBeDefined();
    const markup = permMsg?.["reply_markup"] as Record<string, unknown> | undefined;
    const keyboard = markup?.["inline_keyboard"] as unknown[][];
    expect(keyboard).toBeDefined();

    const row = keyboard?.[0] as Record<string, unknown>[] | undefined;
    expect(row).toHaveLength(2);
    const buttonTexts = row?.map((b) => b["text"] as string);
    expect(buttonTexts?.map((t) => t.toLowerCase())).toContain("allow");
    expect(buttonTexts?.map((t) => t.toLowerCase())).toContain("deny");
  });
});

describe("TelegramSource 콜백 처리 (SC-018)", () => {
  it("callback_query(data=allow:reqId) 수신 시 answerCallbackQuery 를 즉시 호출한다 (스피너 해제)", async () => {
    // fake telegram quirk: answerCallbackQuery 를 호출하지 않으면 스피너가 지속됨
    const answeredCallbacks: string[] = [];
    const gateCallbackCalls: string[] = [];

    const callbackUpdate = {
      update_id: 3001,
      callback_query: {
        id: "cbq-001",
        from: { id: 99, first_name: "Dev" },
        message: { message_id: 100, chat: { id: 99 } },
        data: "allow:req-abc",
      },
    };

    // 첫 poll: callbackUpdate 반환 → answerCallbackQuery 호출됨
    // 두 번째 이후: 차단 (OOM 방지)
    const { releasePending } = makeSingleCycleFetch([callbackUpdate], {
      answerCallbackQuery: (params) => {
        answeredCallbacks.push(params["callback_query_id"] as string);
        return true;
      },
    });

    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-code-acp",
      paths,
    });

    source.onCallbackQuery((reqId, decision) => {
      gateCallbackCalls.push(`${reqId}:${decision}`);
    });

    source.start();

    // answerCallbackQuery 가 호출될 때까지 대기
    await waitFor(() => answeredCallbacks.length >= 1);

    releasePending();
    source.stop();

    // answerCallbackQuery 가 호출되어야 스피너가 해제됨
    expect(answeredCallbacks).toContain("cbq-001");
    // 게이트 콜백에 allow 결정이 전달되어야 함
    expect(gateCallbackCalls.some((s) => s.includes("allow"))).toBe(true);
  });

  it("callback_query data=deny 수신 시 deny 결정을 게이트에 전달한다", async () => {
    const gateCallbackCalls: string[] = [];

    const denyUpdate = {
      update_id: 4001,
      callback_query: {
        id: "cbq-002",
        from: { id: 99, first_name: "Dev" },
        message: { message_id: 101, chat: { id: 99 } },
        data: "deny:req-xyz",
      },
    };

    // 첫 poll: denyUpdate 반환 → gateCallbackCalls 에 deny 추가됨
    // 두 번째 이후: 차단 (OOM 방지)
    const { releasePending } = makeSingleCycleFetch([denyUpdate]);

    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-code-acp",
      paths,
    });

    source.onCallbackQuery((reqId, decision) => {
      gateCallbackCalls.push(`${reqId}:${decision}`);
    });

    source.start();

    // deny 결정이 게이트 콜백에 전달될 때까지 대기
    await waitFor(() => gateCallbackCalls.some((s) => s.includes("deny")));

    releasePending();
    source.stop();

    expect(gateCallbackCalls.some((s) => s.includes("deny"))).toBe(true);
  });
});
