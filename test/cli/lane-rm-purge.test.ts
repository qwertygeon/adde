import { afterEach, describe, expect, it, vi } from "vitest";

// `adde lane rm --purge` 의 활성-레인 가드 검증. error 상태(기동 실패 잔존, 데몬이 살아있을 수 있음)
// 레인은 state/토큰을 지우기 전에 --force 를 요구한다. collectStatus/laneRemove 를 모킹해
// 실제 파일 삭제 없이 가드 분기만 검증한다(로케일은 test/setup.ts 가 ko 고정).

const { collectStatus, laneRemove } = vi.hoisted(() => ({
  collectStatus: vi.fn(),
  laneRemove: vi.fn(),
}));

vi.mock("../../src/core/diagnostics.js", () => ({ collectStatus }));
vi.mock("../../src/core/lane-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/lane-config.js")>();
  return { ...actual, laneRemove };
});

import { runLane } from "../../src/cli/lane.js";

describe("adde lane rm --purge — 활성 레인 가드", () => {
  afterEach(() => vi.clearAllMocks());

  it("error 상태 레인은 --force 없이 --purge 를 거부한다", async () => {
    collectStatus.mockResolvedValue([{ lane: "main", status: "error", error: "spawn ENOENT" }]);
    const errs: string[] = [];
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errs.push(String(s));
      return true;
    });
    const code = await runLane(["rm", "demo", "main", "--purge"]);
    spyErr.mockRestore();
    expect(code).toBe(1);
    expect(laneRemove).not.toHaveBeenCalled(); // 삭제 미수행
  });

  it("--force 면 error 레인이어도 purge 를 진행한다", async () => {
    collectStatus.mockResolvedValue([{ lane: "main", status: "error", error: "spawn ENOENT" }]);
    laneRemove.mockResolvedValue({ confPath: "/x/main.conf", purged: true });
    const code = await runLane(["rm", "demo", "main", "--purge", "--force"]);
    expect(code).toBe(0);
    expect(laneRemove).toHaveBeenCalledWith("demo", "main", { purge: true });
  });
});
