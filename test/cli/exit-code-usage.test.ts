import { afterEach, describe, expect, it, vi } from "vitest";

// 필수 위치인자 누락 → usage 출력 후 exit 2 (SC-006, FR-004). 잘못된 호출(usage 안내) 계약을
// exit 2 로 고정 — 파서 오류(SC-005)와 함께 "usage 를 출력하고 조기 반환"하는 두 축을 이룬다.

function captureStdio(): { out: () => string; err: () => string; restore: () => void } {
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

describe("adde up — proj 위치인자 누락 (SC-006 Error)", () => {
  it("stderr 에 up usage 를 출력하고 exit 2", async () => {
    const { run } = await import("../../src/cli/run.js");
    const cap = captureStdio();
    const code = await run(["up"]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err()).toMatch(/adde up/);
  });
});

describe("adde down/restart — proj 위치인자 누락 (SC-006 Error)", () => {
  it("down: stderr 에 down usage 를 출력하고 exit 2", async () => {
    const { run } = await import("../../src/cli/run.js");
    const cap = captureStdio();
    const code = await run(["down"]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err()).toMatch(/adde down/);
  });

  it("restart: stderr 에 restart usage 를 출력하고 exit 2", async () => {
    const { run } = await import("../../src/cli/run.js");
    const cap = captureStdio();
    const code = await run(["restart"]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err()).toMatch(/adde restart/);
  });
});

describe("adde lane show — proj/lane 위치인자 누락 (SC-006 Edge)", () => {
  it("lane 누락 시 stderr 에 lane show usage 를 출력하고 exit 2", async () => {
    const { runLane } = await import("../../src/cli/lane.js");
    const cap = captureStdio();
    const code = await runLane(["show", "demo"]);
    cap.restore();
    expect(code).toBe(2);
    expect(cap.err()).toMatch(/adde lane show/);
  });

  it("proj/lane 모두 누락 시에도 exit 2", async () => {
    const { runLane } = await import("../../src/cli/lane.js");
    const cap = captureStdio();
    const code = await runLane(["show"]);
    cap.restore();
    expect(code).toBe(2);
  });
});
