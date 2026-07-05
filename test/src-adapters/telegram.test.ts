import { waitFor } from "../helpers/wait.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { TelegramSource } from "../../src/src-adapters/telegram.js";
import {
  createTelegramSource,
  splitForTelegram,
  pollBackoffMs,
} from "../../src/src-adapters/telegram.js";
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
// 실제 시간 기반 폴링 — poll loop 의 fetch(비동기)가 병렬 실행 경합에서도 진행하도록.
// 시한 초과 시 throw(setImmediate 만 돌리면 fs/네트워크 완료보다 틱이 먼저 소진돼 위양성).

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
    const body = options.body
      ? (JSON.parse(options.body as string) as Record<string, unknown>)
      : {};

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
    const body = options.body
      ? (JSON.parse(options.body as string) as Record<string, unknown>)
      : {};

    if (method === "getUpdates") {
      capturedOffsets.push((body["offset"] as number) ?? 0);
      getUpdatesCallCount++;
      if (getUpdatesCallCount <= cycleResults.length) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: cycleResults[getUpdatesCallCount - 1] }),
        };
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
    const body = options.body
      ? (JSON.parse(options.body as string) as Record<string, unknown>)
      : {};
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
  fs.writeFileSync(
    paths.envFile,
    "TELEGRAM_BOT_TOKEN=123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg\n",
  );
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
      engine: "claude-agent-acp",
      paths,
      authorizedIds: [99],
    });

    source.start();

    // queue 에 .msg 파일이 생성될 때까지 대기
    await waitFor(
      () => fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg")).length >= 1,
    );

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
      engine: "claude-agent-acp",
      paths,
      authorizedIds: [99],
    });

    source.start();

    // 두 번째 getUpdates 가 호출되고 첫 번째 enqueue 가 완료될 때까지 대기
    await waitFor(
      () =>
        capturedOffsets.length >= 2 &&
        fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg")).length >= 1,
    );

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
  it("renderOut(id) 호출 시 out/<id>.out 를 읽어 sendMessage(reply_to=sidecar id)", async () => {
    const sentMessages: Record<string, unknown>[] = [];

    setupFetchMock((method, params) => {
      if (method === "getUpdates") return [];
      if (method === "sendMessage") {
        sentMessages.push({ ...params });
        return { message_id: 100 };
      }
      return true;
    });

    // renderOut 은 chatId 미지정 시 렌더 생략 → chatId 필요
    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-agent-acp",
      paths,
      chatId: 99,
    });

    fs.writeFileSync(
      path.join(paths.outDir, "m1.out.json"),
      JSON.stringify({ reply_ref: { channel_msg_id: "42" } }),
    );
    fs.writeFileSync(path.join(paths.outDir, "m1.out"), "응답 텍스트");

    await source.renderOut("m1");

    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const lastMsg = sentMessages[sentMessages.length - 1];
    expect(lastMsg?.["reply_to_message_id"]).toBe(42);
    expect(lastMsg?.["text"]).toBe("응답 텍스트");
  });

  it("비숫자 channel_msg_id 면 reply_to_message_id 를 생략한다 (FR-6)", async () => {
    const sentMessages: Record<string, unknown>[] = [];
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
      engine: "claude-agent-acp",
      paths,
      chatId: 99,
    });

    fs.writeFileSync(
      path.join(paths.outDir, "nan.out.json"),
      JSON.stringify({ reply_ref: { channel_msg_id: "not-a-number" } }),
    );
    fs.writeFileSync(path.join(paths.outDir, "nan.out"), "응답");

    await source.renderOut("nan");

    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    // NaN 가드 — reply_to_message_id 가 전송 파라미터에 포함되지 않아야 한다.
    expect(sentMessages[0]?.["reply_to_message_id"]).toBeUndefined();
    expect(sentMessages[0]?.["text"]).toBe("응답");
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
      engine: "claude-agent-acp",
      paths,
      authorizedIds: [99],
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
      engine: "claude-agent-acp",
      paths,
      authorizedIds: [99],
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

  it("알 수 없는 callback decision(allow/deny 외)은 게이트에 전달하지 않는다 (FR-5)", async () => {
    const answeredCallbacks: string[] = [];
    const gateCallbackCalls: string[] = [];

    const bogusUpdate = {
      update_id: 5001,
      callback_query: {
        id: "cbq-bogus",
        from: { id: 99, first_name: "Dev" },
        message: { message_id: 102, chat: { id: 99 } },
        data: "bogus:req-zzz", // allow/deny 가 아님
      },
    };

    const { releasePending } = makeSingleCycleFetch([bogusUpdate], {
      answerCallbackQuery: (params) => {
        answeredCallbacks.push(params["callback_query_id"] as string);
        return true;
      },
    });

    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-agent-acp",
      paths,
      authorizedIds: [99],
    });
    source.onCallbackQuery((reqId, decision) => {
      gateCallbackCalls.push(`${reqId}:${decision}`);
    });

    source.start();
    // ack(스피너 해제)는 여전히 수행됨.
    await waitFor(() => answeredCallbacks.length >= 1);
    releasePending();
    source.stop();

    expect(answeredCallbacks).toContain("cbq-bogus");
    // 미지 decision 은 핸들러에 디스패치되지 않음(fail-closed — 게이트는 타임아웃 deny).
    expect(gateCallbackCalls).toHaveLength(0);
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
      engine: "claude-agent-acp",
      paths,
      authorizedIds: [99],
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

describe("splitForTelegram (011-A 4096 청킹)", () => {
  it("4096 이하는 단일 청크", () => {
    expect(splitForTelegram("짧은 응답")).toEqual(["짧은 응답"]);
    const exact = "x".repeat(4096);
    expect(splitForTelegram(exact)).toEqual([exact]);
  });

  it("개행 없는 초과 텍스트는 하드 분할(데이터 손실 없음)", () => {
    const text = "a".repeat(10000);
    const chunks = splitForTelegram(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
    expect(chunks.join("")).toBe(text); // 개행이 없으니 손실 없이 재결합
  });

  it("줄 경계를 우선해 분할한다", () => {
    const line = "b".repeat(1000);
    const text = Array.from({ length: 10 }, () => line).join("\n"); // ~10kB, 개행 포함
    const chunks = splitForTelegram(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
  });
});

describe("pollBackoffMs 지수 백오프 (012-Q)", () => {
  it("연속 실패가 늘수록 지수 증가, 상한 30s 고정", () => {
    expect(pollBackoffMs(1)).toBe(1000);
    expect(pollBackoffMs(2)).toBe(2000);
    expect(pollBackoffMs(3)).toBe(4000);
    expect(pollBackoffMs(4)).toBe(8000);
    expect(pollBackoffMs(20)).toBe(30000); // 상한
    expect(pollBackoffMs(0)).toBe(1000); // 방어적 하한
  });
});

describe("callBotApi 429 레이트리밋 재시도 (012-P)", () => {
  it("429(retry_after) 후 재시도해 성공한다", async () => {
    let sendCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        const method = url.split("/").pop() ?? "";
        if (method === "getUpdates")
          return { ok: true, json: async () => ({ ok: true, result: [] }) };
        if (method === "sendMessage") {
          sendCalls++;
          if (sendCalls === 1) {
            return {
              ok: false,
              status: 429,
              headers: { get: () => "0" },
              json: async () => ({ ok: false, error_code: 429, parameters: { retry_after: 0 } }),
            };
          }
          return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
        }
        return { ok: true, json: async () => ({ ok: true, result: true }) };
      }),
    );

    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-agent-acp",
      paths,
      chatId: 99,
    });
    fs.writeFileSync(
      path.join(paths.outDir, "rl.out.json"),
      JSON.stringify({ reply_ref: { channel_msg_id: "42" } }),
    );
    fs.writeFileSync(path.join(paths.outDir, "rl.out"), "응답");

    await source.renderOut("rl");

    expect(sendCalls).toBe(2); // 429 1회 → 재시도 성공
  });
});

describe("renderOut 4096 초과 분할 전송 (011-A)", () => {
  it("긴 응답을 여러 sendMessage 로 나눠 보내고 첫 청크만 reply_to", async () => {
    const sent: Record<string, unknown>[] = [];
    setupFetchMock((method, params) => {
      if (method === "getUpdates") return [];
      if (method === "sendMessage") {
        sent.push({ ...params });
        return { message_id: 1 };
      }
      return true;
    });

    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-agent-acp",
      paths,
      chatId: 99,
    });

    fs.writeFileSync(
      path.join(paths.outDir, "big.out.json"),
      JSON.stringify({ reply_ref: { channel_msg_id: "42" } }),
    );
    fs.writeFileSync(path.join(paths.outDir, "big.out"), "y".repeat(9000));

    await source.renderOut("big");

    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((m) => (m["text"] as string).length <= 4096)).toBe(true);
    expect(sent[0]?.["reply_to_message_id"]).toBe(42);
    // 후속 청크는 reply_to 없음(클러터 방지)
    expect(sent[1]?.["reply_to_message_id"]).toBeUndefined();
  });
});

describe("인바운드 인증 거부 (e2e 폴 루프)", () => {
  it("미허가 발신자의 메시지는 큐에 적재하지 않는다 (fail-closed drop)", async () => {
    // authorizedIds=[99] 인데 발신자(from.id=555, chat.id=555)는 미허가 → drop 되어야 한다.
    const fakeUpdate = {
      update_id: 5001,
      message: {
        message_id: 70,
        from: { id: 555, first_name: "Stranger" },
        chat: { id: 555, type: "private" },
        text: "무단 지시",
        date: 1700000000,
      },
    };
    const { fetchMock, releasePending } = makeSingleCycleFetch([fakeUpdate]);

    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-agent-acp",
      paths,
      authorizedIds: [99],
    });

    source.start();
    // 두 번째 getUpdates 호출 = 첫 update 처리 완료 신호(그 시점엔 이미 drop 판정 끝).
    await waitFor(() => fetchMock.mock.calls.length >= 2);
    releasePending();
    await source.stop();

    const msgs = fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg"));
    expect(msgs.length).toBe(0); // 미허가 → enqueue 안 됨
  });

  it("허가 발신자의 메시지는 정상 적재한다 (positive 경로 대조)", async () => {
    const fakeUpdate = {
      update_id: 5002,
      message: {
        message_id: 71,
        from: { id: 99, first_name: "Owner" },
        chat: { id: 99, type: "private" },
        text: "정상 지시",
        date: 1700000000,
      },
    };
    const { releasePending } = makeSingleCycleFetch([fakeUpdate]);

    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-agent-acp",
      paths,
      authorizedIds: [99],
    });

    source.start();
    await waitFor(
      () => fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg")).length >= 1,
    );
    releasePending();
    await source.stop();

    expect(fs.readdirSync(paths.queueDir).filter((f) => f.endsWith(".msg")).length).toBe(1);
  });

  it("미허가 발신자의 권한 콜백은 게이트에 전달하지 않는다 (스피너는 해제)", async () => {
    // 그룹 시나리오: 프롬프트는 그룹(chatId=-100, 음수라 인증 앵커 아님)에 게시되고,
    // allow_from 밖 멤버(from.id=999)가 Allow 를 누른다 → from.id·chat.id 모두 미허가 → 무시.
    const answeredCallbacks: string[] = [];
    const gateCallbackCalls: string[] = [];
    const fakeUpdate = {
      update_id: 5003,
      callback_query: {
        id: "cbq-unauth",
        from: { id: 999, first_name: "Stranger" }, // allow_from 밖
        message: { message_id: 100, chat: { id: -100 } }, // 그룹 chat(음수)
        data: "allow:req-1",
      },
    };
    const { fetchMock, releasePending } = makeSingleCycleFetch([fakeUpdate], {
      answerCallbackQuery: (params) => {
        answeredCallbacks.push(params["callback_query_id"] as string);
        return true;
      },
    });

    const source: TelegramSource = createTelegramSource({
      lane: "test-lane",
      proj: "myproj",
      engine: "claude-agent-acp",
      paths,
      chatId: -100, // 그룹 회신 대상(자기 인증 앵커 아님)
      authorizedIds: [111], // 허가 멤버는 111 뿐
    });
    source.onCallbackQuery((reqId, decision) => {
      gateCallbackCalls.push(`${reqId}:${decision}`);
    });

    source.start();
    // 스피너 해제(answerCallbackQuery)는 인증과 무관하게 호출됨 — 그걸 처리 완료 신호로 사용.
    await waitFor(() => answeredCallbacks.length >= 1);
    // 폴 루프가 다음 getUpdates 로 진행(= 콜백 처리 완료)까지 대기 후 판정.
    await waitFor(() => fetchMock.mock.calls.length >= 2);
    releasePending();
    await source.stop();

    expect(answeredCallbacks).toContain("cbq-unauth"); // 스피너는 해제
    expect(gateCallbackCalls.length).toBe(0); // 결정은 게이트에 미전달(무단 승인 차단)
  });
});
