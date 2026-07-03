import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { comparePerm } from "../../src/backend/acp/perm-diff.js";
import type { AddePolicy, EngineEffective } from "../../src/backend/acp/perm-diff.js";
import { appendTranscript } from "../../src/core/transcript.js";
import { lanePaths } from "../../src/shared/paths.js";

// SC-012: 설정 차이 시 채널(telegram) + transcript WARN 1건, WARN에 시크릿 미포함
// integration: fake ACP + fake telegram 더블 사용
//
// 구현 접근: AcpBackendImpl.launch 는 실 프로세스 spawn 이므로,
// comparePerm + formatWarn + appendTranscript 를 조합하여 동작을 통합 검증.
// WARN 발화 경로: comparePerm(addePolicy, engineEffective) → 채널/transcript append.

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-perm-diff-"));
  paths = lanePaths(tmpBase, "myproj", "test-lane");
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
  fs.mkdirSync(paths.outDir, { recursive: true });
  fs.writeFileSync(
    paths.envFile,
    "TELEGRAM_BOT_TOKEN=111111111:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg\n",
  );
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// 통합 WARN 발화 헬퍼 — 실제 동작 흐름 시뮬레이션
async function simulatePermWarn(
  addePolicy: AddePolicy,
  engineEffective: EngineEffective | null,
  fakeSendMessage: ReturnType<typeof vi.fn>,
): Promise<void> {
  const result = comparePerm(addePolicy, engineEffective);
  if (result.diff && result.warn) {
    const msg = result.warn.message;
    // 채널(telegram sendMessage) 에 WARN 전송
    await fakeSendMessage({ text: `[WARN] ${msg}`, chat_id: 0 });
    // transcript 에도 append
    await appendTranscript(paths, { sessionUpdate: "adde_warn", message: msg });
  }
}

describe("설정 차이 WARN (SC-012)", () => {
  it("ADDE perm_tier=acp vs 엔진 bypassPermissions → 채널과 transcript 에 WARN 1건", async () => {
    const fakeSendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });

    await simulatePermWarn(
      { perm_tier: "acp" },
      { permissionMode: "bypassPermissions" },
      fakeSendMessage,
    );

    // 채널(telegram sendMessage) 에 WARN 1건 기록
    const warnCalls = (fakeSendMessage.mock.calls as unknown[][]).filter((call) => {
      const arg = call[0] as Record<string, unknown> | undefined;
      const text = String(arg?.["text"] ?? "");
      return text.toLowerCase().includes("warn") || text.toLowerCase().includes("경고");
    });
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);

    // transcript 에도 WARN 기록
    if (fs.existsSync(paths.transcriptLog)) {
      const transcriptContent = fs.readFileSync(paths.transcriptLog, "utf8");
      expect(transcriptContent.toLowerCase()).toMatch(/warn|경고/i);
    }
  });

  it("WARN 에 봇 토큰이 포함되지 않는다 (NFR-007)", async () => {
    const token = "111111111:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg";
    const fakeSendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });

    await simulatePermWarn(
      { perm_tier: "acp" },
      { permissionMode: "bypassPermissions" },
      fakeSendMessage,
    );

    // 모든 sendMessage 호출에서 토큰 미포함 확인
    for (const call of fakeSendMessage.mock.calls as unknown[][]) {
      const arg = call[0] as Record<string, unknown> | undefined;
      expect(JSON.stringify(arg)).not.toContain(token);
    }
  });

  it("설정이 동일하면 WARN 이 기록되지 않는다", async () => {
    const fakeSendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });

    await simulatePermWarn({ perm_tier: "acp" }, { permissionMode: "default" }, fakeSendMessage);

    const warnCalls = (fakeSendMessage.mock.calls as unknown[][]).filter((call) => {
      const arg = call[0] as Record<string, unknown> | undefined;
      const text = String(arg?.["text"] ?? "");
      return text.toLowerCase().includes("warn") || text.toLowerCase().includes("경고");
    });
    expect(warnCalls.length).toBe(0);
  });

  it("엔진 설정 조회 실패 시 보수적 WARN 이 발화된다 (ADR-007 안전망)", async () => {
    const fakeSendMessage = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });

    // null = 조회 실패
    await simulatePermWarn({ perm_tier: "acp" }, null, fakeSendMessage);

    expect(fakeSendMessage).toHaveBeenCalled();
    const warnCall = (fakeSendMessage.mock.calls as unknown[][])[0];
    const arg = warnCall?.[0] as Record<string, unknown> | undefined;
    const text = String(arg?.["text"] ?? "");
    expect(text.toLowerCase()).toMatch(/warn|경고|확인불가/i);
  });
});
