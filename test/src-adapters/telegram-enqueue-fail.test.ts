import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// SC3: telegram enqueue 연속 실패가 임계(3)에 도달하면 운영자에게 1회 액션형 알림.

// enqueue 를 항상 실패시켜 연속 실패 누적을 유도(디스크풀/권한 시뮬레이션).
vi.mock("../../src/core/queue.js", async (orig) => {
  const actual = (await orig()) as typeof import("../../src/core/queue.js");
  return { ...actual, enqueue: vi.fn().mockRejectedValue(new Error("ENOSPC: no space left")) };
});

const { createTelegramSource } = await import("../../src/src-adapters/telegram.js");
import { lanePaths } from "../../src/shared/paths.js";

async function waitFor(cond: () => boolean, maxTicks = 400): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
}

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-tgfail-"));
  paths = lanePaths(tmpBase, "p", "lane");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.writeFileSync(paths.envFile, "TELEGRAM_BOT_TOKEN=123:ABC\n");
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("telegram enqueue 연속 실패 알림 (SC3)", () => {
  it("연속 3회 실패 시 운영자 채널로 상황+조치 알림을 1회 보낸다", async () => {
    const sent: Record<string, unknown>[] = [];
    const msg = (id: number) => ({
      update_id: id,
      message: { message_id: id, chat: { id: 99 }, text: `m${id}` },
    });

    let getUpdatesCount = 0;
    let releaseNext!: () => void;
    const pending = new Promise<void>((r) => (releaseNext = r));
    const cycles = [[msg(1)], [msg(2)], [msg(3)]];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
        const method = url.split("/").pop() ?? "";
        const body = options.body
          ? (JSON.parse(options.body as string) as Record<string, unknown>)
          : {};
        if (method === "getUpdates") {
          const idx = getUpdatesCount++;
          if (idx < cycles.length) {
            return { ok: true, json: async () => ({ ok: true, result: cycles[idx] }) };
          }
          await pending;
          return { ok: true, json: async () => ({ ok: true, result: [] }) };
        }
        if (method === "sendMessage") {
          sent.push({ ...body });
          return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
        }
        return { ok: true, json: async () => ({ ok: true, result: true }) };
      }),
    );

    const source = createTelegramSource({
      lane: "lane",
      proj: "p",
      engine: "claude-code-acp",
      paths,
      chatId: 99,
    });
    source.start();

    await waitFor(() => sent.some((m) => String(m["text"]).includes("연속")));
    releaseNext();
    await source.stop();

    const alerts = sent.filter((m) => String(m["text"]).includes("연속"));
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0]?.["text"])).toContain("조치");
    expect(String(alerts[0]?.["chat_id"])).toBe("99");
  });
});
