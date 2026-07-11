import { afterEach, describe, expect, it, vi } from "vitest";

// 미지원 플래그 거부 — SC-006. 오류 메시지 + 해당 명령(또는 전역) usage 를 stderr 에 출력하고 exit 1.

function captureStdio(): {
  out: () => string;
  err: () => string;
  restore: () => void;
} {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const spyOut = vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => {
    outChunks.push(String(s));
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
    errChunks.push(String(s));
    return true;
  });
  return {
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
    restore: () => {
      spyOut.mockRestore();
      spyErr.mockRestore();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("adde doctor --nonsense — 미지원 플래그 + 명령 usage (SC-006 Error)", () => {
  it("stderr 에 --nonsense 언급 오류와 doctor usage 를 함께 출력하고 exit 1", async () => {
    const { run } = await import("../../src/cli/run.js");
    const cap = captureStdio();
    const code = await run(["doctor", "--nonsense"]);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.err()).toContain("--nonsense");
    expect(cap.err()).toContain("adde doctor");
  });
});

describe("adde --nonsense — 명령 미식별 위치의 미지원 전역 플래그 (SC-006 Error)", () => {
  it("stderr 에 오류와 전역 usage 를 함께 출력하고 exit 1", async () => {
    const { run } = await import("../../src/cli/run.js");
    const cap = captureStdio();
    const code = await run(["--nonsense"]);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.err()).toContain("--nonsense");
    expect(cap.err()).toMatch(/status|doctor|logs/); // 전역 usage 표식
  });
});
