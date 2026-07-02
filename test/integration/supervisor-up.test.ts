import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { supervisorUp, supervisorDown } from "../../src/core/supervisor.js";
import type { SupervisorUpOptions, SupervisorUpResult } from "../../src/core/supervisor.js";
import { lanePaths } from "../../src/shared/paths.js";

// SC-001: adde up → 레인 프로세스 기동·running 보고
// SC-022: conf 수만큼 레인 기동
//
// integration: fake ACP/봇/fs 더블 사용. MUST NOT 실봇/실엔진 접촉

let tmpBase: string;
// 시작한 레인을 teardown 에서 정지 — fire-and-forget 워처/poll 루프가
// tmp 삭제 후까지 살아남아 ENOENT(unhandled rejection) 내는 것을 막는다.
const startedProjs = new Set<string>();

async function runUp(proj: string, opts: SupervisorUpOptions): Promise<SupervisorUpResult> {
  startedProjs.add(proj);
  return supervisorUp(proj, opts);
}

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

afterEach(async () => {
  for (const proj of startedProjs) {
    try {
      await supervisorDown(proj, { base: tmpBase });
    } catch {
      // teardown best-effort
    }
  }
  startedProjs.clear();
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
    fs.writeFileSync(
      lp.envFile,
      "TELEGRAM_BOT_TOKEN=111111111:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg\n",
    );
  }
  return { base };
}

// fake ACP 더블: 실제 ACP stdio 연결 대신 스텁 제공
// fake ACP quirk: turn 완료 전 prompt 큐잉·protocolVersion 1·usage 미emit
// 실제 백엔드처럼 launch 이전 subscribe/onPermissionRequest 호출은 거부한다
// (레인 state 가 launch 에서 생성되므로) — 등록 순서 회귀 가드.
function makeFakeAcpFactory() {
  return vi.fn().mockImplementation(() => {
    let launched = false;
    const requireLaunch = (fn: string) => {
      if (!launched) throw new Error(`[fake-acp] ${fn} before launch`);
    };
    return {
      caps: () => ({
        plane: "acp",
        perm_tier: "acp",
        supports_attachments: false,
        acp_version: "v1",
      }),
      launch: vi.fn().mockImplementation(async () => {
        launched = true;
        return { sessionId: "fake-session-001" };
      }),
      inject: vi.fn().mockImplementation(async () => {
        requireLaunch("inject");
      }),
      subscribe: vi.fn().mockImplementation(() => {
        requireLaunch("subscribe");
      }),
      onPermissionRequest: vi.fn().mockImplementation(() => {
        requireLaunch("onPermissionRequest");
      }),
      close: vi.fn().mockImplementation(async () => {
        requireLaunch("close");
        launched = false;
      }),
    };
  });
}

// 기동 실패(launch reject) 더블 — FR-8 error 필드 검증용.
function makeFailingAcpFactory(msg: string) {
  return vi.fn().mockImplementation(() => ({
    caps: () => ({
      plane: "acp",
      perm_tier: "acp",
      supports_attachments: false,
      acp_version: "v1",
    }),
    launch: vi.fn().mockRejectedValue(new Error(msg)),
    inject: vi.fn(),
    subscribe: vi.fn(),
    onPermissionRequest: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }));
}

describe("supervisorUp 기동 실패 안내 (FR-8)", () => {
  it("레인 launch 실패 시 status=error 와 사유를 결과에 싣는다", async () => {
    const { base } = setupProject("failproj", { "bad-lane": minimalConf });
    const result = await runUp("failproj", {
      base,
      acpFactory: makeFailingAcpFactory("엔진 spawn 실패: ENOENT"),
    });

    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]?.status).toBe("error");
    expect(result.lanes[0]?.error).toContain("엔진 spawn 실패");
  });
});

describe("supervisorUp (SC-001 레인 기동)", () => {
  it("lanes.d 에 conf 파일이 1개 있으면 레인 1개가 기동된다", async () => {
    const { base } = setupProject("testproj", { "telegram-claude": minimalConf });
    const fakeAcpFactory = makeFakeAcpFactory();

    const result = await runUp("testproj", { base, acpFactory: fakeAcpFactory });

    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]?.status).toBe("running");
    expect(result.lanes[0]?.lane).toBe("telegram-claude");
  });

  it("레인 기동 상태가 running 으로 보고된다 (SC-001)", async () => {
    const { base } = setupProject("testproj", { "telegram-claude": minimalConf });
    const fakeAcpFactory = makeFakeAcpFactory();

    const result = await runUp("testproj", { base, acpFactory: fakeAcpFactory });

    expect(result.lanes.every((l) => l.status === "running")).toBe(true);
  });
});

describe("supervisorUp (SC-022 conf 수만큼 기동)", () => {
  it("lanes.d 에 conf 1개 → 레인 1개 기동 메시지", async () => {
    const { base } = setupProject("proj2", { "single-lane": minimalConf });
    const fakeAcpFactory = makeFakeAcpFactory();

    const result = await runUp("proj2", { base, acpFactory: fakeAcpFactory });

    expect(result.lanes).toHaveLength(1);
    expect(result.message).toMatch(/1/);
  });

  it("lanes.d 에 conf 2개 → 레인 2개 기동", async () => {
    const { base } = setupProject("proj3", {
      "lane-a": minimalConf,
      "lane-b": minimalConf,
    });
    const fakeAcpFactory = makeFakeAcpFactory();

    const result = await runUp("proj3", { base, acpFactory: fakeAcpFactory });

    expect(result.lanes).toHaveLength(2);
  });
});

describe("supervisorUp 라이브니스 파일 (SC1)", () => {
  it("기동 시 runtime.json 을 기록하고 down 시 제거한다", async () => {
    const { base } = setupProject("rtproj", { "telegram-claude": minimalConf });
    const fakeAcpFactory = makeFakeAcpFactory();
    const lp = lanePaths(base, "rtproj", "telegram-claude");

    await runUp("rtproj", { base, acpFactory: fakeAcpFactory });
    expect(fs.existsSync(lp.runtimeJson)).toBe(true);
    const info = JSON.parse(fs.readFileSync(lp.runtimeJson, "utf8")) as {
      pid: number;
      sessionId: string;
    };
    expect(info.pid).toBe(process.pid);
    expect(info.sessionId).toBe("fake-session-001");

    await supervisorDown("rtproj", { base });
    startedProjs.delete("rtproj");
    expect(fs.existsSync(lp.runtimeJson)).toBe(false);
  });
});

describe("supervisorUp source 분기 (markdown)", () => {
  it("source=markdown conf 는 markdown 어댑터로 기동된다 (running)", async () => {
    const rootDir = path.join(tmpBase, "Notes");
    fs.mkdirSync(rootDir, { recursive: true });
    const markdownConf =
      "source=markdown\nbackend=acp\nengine=claude-code-acp\nchannel=markdown\n" +
      `perm_tier=acp\nacp_version=v1\nroot=${rootDir}\ninbox=inbox.md\n`;
    const { base } = setupProject("mdproj", { "markdown-claude": markdownConf });
    const fakeAcpFactory = makeFakeAcpFactory();

    const result = await runUp("mdproj", { base, acpFactory: fakeAcpFactory });

    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]?.status).toBe("running");
  });
});

describe("supervisorUp autopass 기동 배너 (005)", () => {
  it("perm_tier=autopass 레인은 기동 시 채널에 자동 허용 모드 경고 배너를 남긴다", async () => {
    const rootDir = path.join(tmpBase, "NotesAp");
    fs.mkdirSync(rootDir, { recursive: true });
    // markdown 소스 — notify 가 outbox 노트로 표면화되어 네트워크 없이 관찰 가능.
    const conf =
      "source=markdown\nbackend=acp\nengine=claude-code-acp\nchannel=markdown\n" +
      `perm_tier=autopass\ndenylist=Bash\nacp_version=v1\nroot=${rootDir}\ninbox=inbox.md\n`;
    const { base } = setupProject("approj", { "md-ap": conf });

    const result = await runUp("approj", { base, acpFactory: makeFakeAcpFactory() });
    expect(result.lanes[0]?.status).toBe("running");

    // notify 는 fire-and-forget — 파일 기록을 폴링 대기(최대 2초).
    const noticePath = path.join(rootDir, "out", "_adde-notice.md");
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(noticePath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fs.existsSync(noticePath)).toBe(true);
    const note = fs.readFileSync(noticePath, "utf8");
    expect(note).toContain("autopass");
    expect(note).toContain("Bash");
  });

  it("perm_tier=acp 레인은 기동 배너를 남기지 않는다 (기본 동작 불변)", async () => {
    const rootDir = path.join(tmpBase, "NotesAcp");
    fs.mkdirSync(rootDir, { recursive: true });
    const conf =
      "source=markdown\nbackend=acp\nengine=claude-code-acp\nchannel=markdown\n" +
      `perm_tier=acp\nacp_version=v1\nroot=${rootDir}\ninbox=inbox.md\n`;
    const { base } = setupProject("acpproj", { "md-acp": conf });

    await runUp("acpproj", { base, acpFactory: makeFakeAcpFactory() });
    // 배너 미발생 확인 — 짧게 대기 후 부재 단언.
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(path.join(rootDir, "out", "_adde-notice.md"))).toBe(false);
  });
});
