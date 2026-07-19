import { afterEach, describe, expect, it, vi } from "vitest";

// 파서 오류(미지원 플래그·값 누락) — SC-005. 오류 메시지 + 해당 명령(또는 전역) usage 를
// stderr 에 출력하고 exit 2(잘못된 호출 계약, FR-004 — 종전 exit 1 에서 behavior change).

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

describe("adde doctor --nonsense — 미지원 플래그 + 명령 usage (SC-005 Error)", () => {
  it("stderr 에 --nonsense 언급 오류와 doctor usage 를 함께 출력하고 exit 2", async () => {
    const { run } = await import("../../src/cli/run.js");
    const cap = captureStdio();
    const code = await run(["doctor", "--nonsense"]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err()).toContain("--nonsense");
    expect(cap.err()).toContain("adde doctor");
  });
});

describe("adde --nonsense — 명령 미식별 위치의 미지원 전역 플래그 (SC-005 Error)", () => {
  it("stderr 에 오류와 전역 usage 를 함께 출력하고 exit 2", async () => {
    const { run } = await import("../../src/cli/run.js");
    const cap = captureStdio();
    const code = await run(["--nonsense"]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err()).toContain("--nonsense");
    expect(cap.err()).toMatch(/status|doctor|logs/); // 전역 usage 표식
  });
});

describe("adde lane add — 값 플래그 값 누락 (SC-005 Error)", () => {
  it("--source 뒤 값 없이 끝나면 stderr 에 value-required 오류 + lane usage, exit 2", async () => {
    const { runLane } = await import("../../src/cli/lane.js");
    const cap = captureStdio();
    const code = await runLane(["add", "p", "l", "--source"]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err()).toContain("--source");
    expect(cap.err()).toMatch(/adde lane/);
  });

  it("값 플래그 뒤 다른 플래그형 토큰이 오면 값으로 흡수하지 않고 value-required 오류, exit 2", async () => {
    const { runLane } = await import("../../src/cli/lane.js");
    const cap = captureStdio();
    const code = await runLane(["add", "p", "l", "--source", "--force"]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err()).toContain("--source");
  });
});
