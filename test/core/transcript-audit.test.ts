import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SC 011-E2: transcript append 실패 시 감사 이벤트(adde_warn/adde_auto_allow)는 error 로 승격,
// 일반 이벤트는 warn 으로 흡수.

// appendFile 을 항상 실패시켜 catch 경로를 강제한다(mkdir 은 통과).
vi.mock("node:fs/promises", async (orig) => {
  const actual = (await orig()) as typeof import("node:fs/promises");
  return {
    ...actual,
    appendFile: vi.fn().mockRejectedValue(new Error("디스크 오류")),
  };
});

const { appendTranscript } = await import("../../src/core/transcript.js");
import type { LanePaths } from "../../src/shared/paths.js";

const paths = { transcriptLog: "/tmp/adde-nonexistent-xyz/transcript.log" } as LanePaths;

beforeEach(async () => {
  // restoreAllMocks 가 모듈 mock 의 구현을 비우므로 매 테스트 전 appendFile 실패를 재무장.
  const fsp = (await import("node:fs/promises")) as unknown as {
    appendFile: ReturnType<typeof vi.fn>;
  };
  fsp.appendFile.mockRejectedValue(new Error("디스크 오류"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("appendTranscript 감사 이벤트 승격 (011-E2)", () => {
  it("감사 이벤트(adde_warn) append 실패는 console.error 로 승격", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await appendTranscript(paths, { sessionUpdate: "adde_warn", message: "정책 경고" });
    expect(err).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("auto_allow 감사 이벤트도 error 로 승격", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await appendTranscript(paths, { sessionUpdate: "adde_auto_allow", message: "auto-allow Read" });
    expect(err).toHaveBeenCalled();
  });

  it("일반 이벤트 append 실패는 warn 으로 흡수(승격 안 함)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await appendTranscript(paths, { sessionUpdate: "agent_message_chunk", content: "hi" });
    expect(warn).toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});
