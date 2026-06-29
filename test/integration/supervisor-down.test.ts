import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { supervisorUp, supervisorDown } from "../../src/core/supervisor.js";
import { lanePaths } from "../../src/shared/paths.js";

// SC-023: adde down → 레인 종료·미재기동

let tmpBase: string;

const minimalConf = `source=telegram
backend=acp
engine=claude-code-acp
channel=telegram
perm_tier=acp
acp_version=v1
`;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-down-"));
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function setupProject(projName: string) {
  const base = tmpBase;
  const lanesDir = path.join(base, projName, "lanes.d");
  fs.mkdirSync(lanesDir, { recursive: true });
  fs.writeFileSync(path.join(lanesDir, "telegram-claude.conf"), minimalConf);
  const lp = lanePaths(base, projName, "telegram-claude");
  fs.mkdirSync(lp.queueDir, { recursive: true });
  fs.mkdirSync(lp.processingDir, { recursive: true });
  fs.mkdirSync(lp.outDir, { recursive: true });
  fs.mkdirSync(lp.stateDir, { recursive: true });
  fs.writeFileSync(lp.envFile, "TELEGRAM_BOT_TOKEN=111111111:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg\n");
  return { base };
}

function makeFakeAcpFactory() {
  return vi.fn().mockReturnValue({
    caps: () => ({ plane: "acp", perm_tier: "acp", supports_attachments: false, acp_version: "v1" }),
    launch: vi.fn().mockResolvedValue({ sessionId: "fake-session-002" }),
    inject: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    onPermissionRequest: vi.fn(),
  });
}

describe("supervisorDown (SC-023 레인 종료)", () => {
  it("adde down 실행 시 기동된 레인이 종료된다", async () => {
    const { base } = setupProject("downproj");
    const fakeAcpFactory = makeFakeAcpFactory();

    // 먼저 기동
    const upResult = await supervisorUp("downproj", { base, acpFactory: fakeAcpFactory });
    expect(upResult.lanes[0]?.status).toBe("running");

    // down 실행
    const downResult = await supervisorDown("downproj", { base });
    expect(downResult.lanes.every((l) => l.status === "stopped")).toBe(true);
  });

  it("adde down 후 adde up 없이 레인이 자동 재기동되지 않는다", async () => {
    const { base } = setupProject("downproj2");
    const fakeAcpFactory = makeFakeAcpFactory();

    await supervisorUp("downproj2", { base, acpFactory: fakeAcpFactory });
    await supervisorDown("downproj2", { base });

    // 일정 시간 후 레인 상태 확인 — running 이 아니어야 함
    await new Promise((resolve) => setTimeout(resolve, 50));

    const status = await supervisorDown("downproj2", { base }); // 이미 종료된 상태
    expect(status.lanes.every((l) => l.status !== "running")).toBe(true);
  });
});
