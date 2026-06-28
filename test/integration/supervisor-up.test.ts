import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { supervisorUp } from "../../src/core/supervisor.js";
import { lanePaths } from "../../src/shared/paths.js";

// SC-001: adde up → 레인 프로세스 기동·running 보고
// SC-022: conf 수만큼 레인 기동
//
// integration: fake ACP/봇/fs 더블 사용. MUST NOT 실봇/실엔진 접촉

let tmpBase: string;

const minimalConf = `source=telegram
backend=acp
engine=claude-code-acp
channel=telegram
perm_tier=acp
acp_version=v1
`;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-sup-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function setupProject(projName: string, laneConfs: Record<string, string>) {
  const base = tmpBase;
  const lanesDir = path.join(base, projName, "lanes.d");
  fs.mkdirSync(lanesDir, { recursive: true });
  for (const [lane, confContent] of Object.entries(laneConfs)) {
    fs.writeFileSync(path.join(lanesDir, `${lane}.conf`), confContent);
    // 필요 디렉토리 생성
    const lp = lanePaths(base, projName, lane);
    fs.mkdirSync(lp.queueDir, { recursive: true });
    fs.mkdirSync(lp.processingDir, { recursive: true });
    fs.mkdirSync(lp.outDir, { recursive: true });
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.writeFileSync(lp.envFile, "TELEGRAM_BOT_TOKEN=111111111:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg\n");
  }
  return { base };
}

// fake ACP 더블: 실제 ACP stdio 연결 대신 스텁 제공
// fake ACP quirk: turn 완료 전 prompt 큐잉·protocolVersion 1·usage 미emit
function makeFakeAcpFactory() {
  return vi.fn().mockReturnValue({
    caps: () => ({ plane: "acp", perm_tier: "acp", supports_attachments: false, acp_version: "v1" }),
    launch: vi.fn().mockResolvedValue({ sessionId: "fake-session-001" }),
    inject: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    onPermissionRequest: vi.fn(),
  });
}

describe("supervisorUp (SC-001 레인 기동)", () => {
  it("lanes.d 에 conf 파일이 1개 있으면 레인 1개가 기동된다", async () => {
    const { base } = setupProject("testproj", { "telegram-claude": minimalConf });
    const fakeAcpFactory = makeFakeAcpFactory();

    const result = await supervisorUp("testproj", { base, acpFactory: fakeAcpFactory });

    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]?.status).toBe("running");
    expect(result.lanes[0]?.lane).toBe("telegram-claude");
  });

  it("레인 기동 상태가 running 으로 보고된다 (SC-001)", async () => {
    const { base } = setupProject("testproj", { "telegram-claude": minimalConf });
    const fakeAcpFactory = makeFakeAcpFactory();

    const result = await supervisorUp("testproj", { base, acpFactory: fakeAcpFactory });

    expect(result.lanes.every((l) => l.status === "running")).toBe(true);
  });
});

describe("supervisorUp (SC-022 conf 수만큼 기동)", () => {
  it("lanes.d 에 conf 1개 → 레인 1개 기동 메시지", async () => {
    const { base } = setupProject("proj2", { "single-lane": minimalConf });
    const fakeAcpFactory = makeFakeAcpFactory();

    const result = await supervisorUp("proj2", { base, acpFactory: fakeAcpFactory });

    expect(result.lanes).toHaveLength(1);
    expect(result.message).toMatch(/1/);
  });

  it("lanes.d 에 conf 2개 → 레인 2개 기동", async () => {
    const { base } = setupProject("proj3", {
      "lane-a": minimalConf,
      "lane-b": minimalConf,
    });
    const fakeAcpFactory = makeFakeAcpFactory();

    const result = await supervisorUp("proj3", { base, acpFactory: fakeAcpFactory });

    expect(result.lanes).toHaveLength(2);
  });
});
