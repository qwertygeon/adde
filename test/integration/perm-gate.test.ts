import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { gateRequestDecision } from "../../src/gate/gate.js";
import type { PermRequest } from "../../src/gate/gate.js";
import { lanePaths } from "../../src/shared/paths.js";

// SC-019: ACP request_permission → telegram inline 버튼 메시지 전송 (SC-017 통합)
// integration: fake ACP + fake telegram 더블
//
// 구현 접근: gateRequestDecision 이 sendPermPrompt (TelegramSource 경유) 를 호출하고
// fake telegram 이 inline_keyboard 를 포함한 sendMessage 를 받는 흐름을 검증.

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-perm-gate-"));
  paths = lanePaths(tmpBase, "myproj", "test-lane");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  fs.mkdirSync(paths.outDir, { recursive: true });
  fs.writeFileSync(paths.envFile, "TELEGRAM_BOT_TOKEN=111111111:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg\n");
  vi.useFakeTimers();
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// fake sendPermPrompt — inline_keyboard 를 포함한 sendMessage 를 기록
function makeFakeSendPermPrompt(fakeSendMessage: ReturnType<typeof vi.fn>) {
  return async (_chatId: number, _reqId: string, req: PermRequest): Promise<{ messageId: number }> => {
    await fakeSendMessage({
      chat_id: 0,
      text: `권한 요청: ${req.tool}`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "allow", callback_data: `allow:${req.id}` },
            { text: "deny", callback_data: `deny:${req.id}` },
          ],
        ],
      },
    });
    return { messageId: 200 };
  };
}

describe("request_permission → telegram inline 버튼 (SC-019)", () => {
  it("ACP request_permission 수신 시 fake telegram 의 sendMessage 에 inline_keyboard 가 포함된다", async () => {
    const fakeSendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 200 } });

    const req: PermRequest = {
      v: 1,
      id: "perm-sc019",
      lane: "test-lane",
      channel: "telegram",
      tool: "Bash: rm -rf build/",
      detail: JSON.stringify({ title: "Bash: rm -rf build/" }),
      cwd: "/tmp/myproject",
      ts: new Date().toISOString(),
    };

    const fakeSendPermPrompt = makeFakeSendPermPrompt(fakeSendMessage);

    // gateRequestDecision 을 통해 sendPermPrompt 호출
    const decisionPromise = gateRequestDecision(req, {
      sendPermPrompt: async (permReq) => {
        await fakeSendPermPrompt(0, permReq.id, permReq);
      },
      waitForDecision: () => new Promise(() => {}), // 영원히 pending (타임아웃으로 deny)
      timeoutMs: 100,
    });

    await vi.runAllTimersAsync();
    const result = await decisionPromise;
    expect(result.decision).toBe("deny"); // 타임아웃 → deny

    // sendMessage 가 호출되었고 reply_markup 에 inline_keyboard 포함
    const permCalls = (fakeSendMessage.mock.calls as unknown[][]).filter((call) => {
      const arg = call[0] as Record<string, unknown> | undefined;
      return arg?.["reply_markup"] !== undefined;
    });
    expect(permCalls.length).toBeGreaterThanOrEqual(1);

    const firstPermCall = permCalls[0];
    if (firstPermCall) {
      const arg = firstPermCall[0] as Record<string, unknown> | undefined;
      const markup = arg?.["reply_markup"] as Record<string, unknown> | undefined;
      const keyboard = markup?.["inline_keyboard"] as unknown[][] | undefined;
      expect(keyboard).toBeDefined();
      if (keyboard) {
        const row = keyboard[0] as Record<string, unknown>[] | undefined;
        const buttonTexts = row?.map((b) => b["text"]);
        expect(buttonTexts).toContain("allow");
        expect(buttonTexts).toContain("deny");
      }
    }
  });

  it("allow 콜백 수신 시 decision=allow 가 게이트로 전달된다", async () => {
    const fakeSendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 201 } });

    const req: PermRequest = {
      v: 1,
      id: "perm-allow",
      lane: "test-lane",
      channel: "telegram",
      tool: "Read",
      detail: "{}",
      cwd: "/tmp",
      ts: new Date().toISOString(),
    };

    // 즉시 allow 결정 반환
    const result = await gateRequestDecision(req, {
      sendPermPrompt: async () => {
        await fakeSendMessage({ text: "권한 요청", reply_markup: { inline_keyboard: [[]] } });
      },
      waitForDecision: () => Promise.resolve("allow"),
      timeoutMs: 5000,
    });

    expect(result.decision).toBe("allow");
    expect(result.id).toBe("perm-allow");
  });
});
