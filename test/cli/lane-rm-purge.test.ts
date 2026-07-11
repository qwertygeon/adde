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
    // error-가드가 실제로 발동했음을 purgeRunning 메시지로 확정 — 이 문구가 없으면 non-TTY needForce
    // 폴백(구코드 경로)과 구분되지 않아 vacuous 해진다(error 가 가드에 없던 구코드는 여기 도달 못 함).
    expect(errs.join("")).toContain("안전하게 정리할 수 없습니다");
  });

  it("--force 면 error 레인이어도 purge 를 진행한다", async () => {
    collectStatus.mockResolvedValue([{ lane: "main", status: "error", error: "spawn ENOENT" }]);
    laneRemove.mockResolvedValue({ confPath: "/x/main.conf", purged: true });
    const code = await runLane(["rm", "demo", "main", "--purge", "--force"]);
    expect(code).toBe(0);
    expect(laneRemove).toHaveBeenCalledWith("demo", "main", { purge: true });
  });
});

// GAP-003 (SC-012 보충): 위 활성-레인 가드(error 상태)와는 별개의, 더 뒤에 있는 확인 게이트
// (이름 재입력/비TTY --force 요구) 자체를 검증한다. 활성-레인 가드를 통과시키기 위해 상태를
// "stopped"(비활성)로 고정해야 이 게이트 분기에 실제로 도달한다.
describe("adde lane rm --purge — 확인 게이트(이름 재입력/비TTY --force)", () => {
  afterEach(() => vi.clearAllMocks());

  it("활성 아닌 레인 + 비TTY + --force 없음 → purgeNeedForce 로 거부", async () => {
    collectStatus.mockResolvedValue([{ lane: "main", status: "stopped" }]);
    const errs: string[] = [];
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errs.push(String(s));
      return true;
    });
    // process.stdin.isTTY 는 vitest 기본 실행에서 이미 falsy — 비TTY 분기로 자연 진입한다.
    const code = await runLane(["rm", "demo", "main", "--purge"]);
    spyErr.mockRestore();
    expect(code).toBe(1);
    expect(laneRemove).not.toHaveBeenCalled();
    // "확인 없이" 문구로 확인 게이트(purgeNeedForce) 도달을 확정 — 활성-레인 거부(purgeRunning,
    // "안전하게 정리할 수 없습니다")와 구분해 이 테스트가 실제로 다른 분기를 검증함을 보장한다.
    expect(errs.join("")).toContain("확인 없이");
    expect(errs.join("")).not.toContain("안전하게 정리할 수 없습니다");
  });
});
