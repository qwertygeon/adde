import { afterEach, describe, expect, it, vi } from "vitest";

// GAP-003 (SC-012 보충): `adde proj rm` 의 확인 게이트(이름 재입력/비TTY --force 요구) 검증.
// 기존 참조 테스트 0건이던 공백 — collectStatus/projRemove/node:fs stat 을 모킹해 실 fs 무접촉으로
// 확인 가드 분기만 격리 검증한다(로케일은 test/setup.ts 가 ko 고정).

const { collectStatus, projRemove, unloadDaemon } = vi.hoisted(() => ({
  collectStatus: vi.fn(),
  projRemove: vi.fn(),
  unloadDaemon: vi.fn(),
}));

vi.mock("../../src/core/diagnostics.js", () => ({ collectStatus, listRegisteredProjects: vi.fn() }));
vi.mock("../../src/core/lane-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/lane-config.js")>();
  return { ...actual, projRemove };
});
// stat 이 항상 resolve(존재 확인 통과) 하도록 모킹 — 실 ADDE_HOME/실 디렉터리 무접촉으로 격리.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn().mockResolvedValue({}) };
});
// darwin 에서 handleProjRemove 가 삭제 직전 unloadDaemon 을 호출한다(--force 경로) — 실 launchd
// 무접촉 격리 정책(프로젝트 테스트 격리 정책·up-already.test.ts 등 형제 테스트 관례)에 맞춰 모킹한다.
vi.mock("../../src/core/launchd.js", () => ({ unloadDaemon }));

import { runProj } from "../../src/cli/proj.js";

describe("adde proj rm — 확인 게이트(이름 재입력/비TTY --force)", () => {
  afterEach(() => vi.clearAllMocks());

  it("활성 레인 없음 + 비TTY + --force 없음 → needForce 로 거부", async () => {
    collectStatus.mockResolvedValue([]);
    const errs: string[] = [];
    const spyErr = vi.spyOn(process.stderr, "write").mockImplementation((s: unknown) => {
      errs.push(String(s));
      return true;
    });
    // process.stdin.isTTY 는 vitest 기본 실행에서 이미 falsy — 비TTY 분기로 자연 진입한다.
    const code = await runProj(["rm", "demo"]);
    spyErr.mockRestore();
    expect(code).toBe(1);
    expect(projRemove).not.toHaveBeenCalled();
    // "확인 없이" 문구로 확인 게이트(proj.needForce) 도달을 확정 — 활성-레인 거부(proj.running,
    // "활성 레인이 있습니다")와 구분해 이 테스트가 실제로 확인 게이트 분기를 검증함을 보장한다.
    expect(errs.join("")).toContain("확인 없이");
    expect(errs.join("")).not.toContain("활성 레인이 있습니다");
  });

  it("--force 면 확인 없이 삭제를 진행한다(확인 게이트 우회 회귀 방지)", async () => {
    collectStatus.mockResolvedValue([]);
    projRemove.mockResolvedValue({ proj: "demo", path: "/tmp/adde/demo" });
    unloadDaemon.mockResolvedValue(undefined);
    const code = await runProj(["rm", "demo", "--force"]);
    expect(code).toBe(0);
    expect(projRemove).toHaveBeenCalledWith("demo");
  });
});
