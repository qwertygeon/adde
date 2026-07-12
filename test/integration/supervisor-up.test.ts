import { FAKE_ACP_CAPS } from "../helpers/fake-acp.js";
import { waitFor } from "../helpers/wait.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { supervisorUp, supervisorDown } from "../../src/core/supervisor.js";
import type { SupervisorUpOptions, SupervisorUpResult } from "../../src/core/supervisor.js";
import { lanePaths } from "../../src/shared/paths.js";

// SC-011 (FR-009): async 완료/실패 stub source — supervisor 가 기동 완료(또는 실패)를 실제로
// 대기한 뒤에만 레인 상태를 확정하는지 검증하기 위해, start() 를 테스트에서 resolve/reject
// 시점을 제어할 수 있는 컨트롤 가능한 stub 소스를 레지스트리에 추가한다(SOURCE_REGISTRY 를
// 테스트 전용으로 확장 — markdown/telegram 실 동작은 무변경). vi.mock factory 는 파일 최상단으로
// hoist 되므로, 참조하는 가변 상태·상수는 vi.hoisted 로 함께 hoist 한다(TDZ 회피).
const stubSource = vi.hoisted(() => {
  const ASYNC_STUB_SOURCE_ID = "async-stub-sc011";
  let deferred: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let stopCalls = 0;
  return {
    ASYNC_STUB_SOURCE_ID,
    getDeferred: () => deferred,
    setDeferred: (d: typeof deferred) => {
      deferred = d;
    },
    getStopCalls: () => stopCalls,
    resetStopCalls: () => {
      stopCalls = 0;
    },
    incStopCalls: () => {
      stopCalls += 1;
    },
  };
});
const ASYNC_STUB_SOURCE_ID = stubSource.ASYNC_STUB_SOURCE_ID;

vi.mock("../../src/src-adapters/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/src-adapters/index.js")>();
  const asyncStubDescriptor = {
    factory: () => ({
      start: () =>
        new Promise<void>((resolve, reject) => {
          stubSource.setDeferred({ resolve, reject });
        }),
      stop: async () => {
        stubSource.incStopCalls();
      },
      requestPermission: async () => {},
      onDecision: () => {},
      renderOut: async () => {},
      notify: async () => {},
    }),
  };
  return {
    ...actual,
    SOURCE_REGISTRY: { ...actual.SOURCE_REGISTRY, [stubSource.ASYNC_STUB_SOURCE_ID]: asyncStubDescriptor },
  };
});

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

/**
 * telegram 레인 기동 시 getMe bounded probe(N4)가 실제 네트워크를 타지 않도록 기본 성공 응답
 * 스텁 — 본 파일의 시나리오는 probe 자체가 아니라 supervisor lifecycle(레인 기동·격리)이 검증
 * 대상이므로, probe 는 항상 성공시켜 기존 관찰 동작(SC-019 회귀)을 보존한다.
 */
function stubTelegramProbeSuccess(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: true }),
    } as Response),
  );
}

const minimalConf = `source=telegram
backend=acp
engine=claude-agent-acp
channel=telegram
perm_tier=acp
acp_version=v1
`;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-sup-"));
  stubTelegramProbeSuccess();
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
  vi.unstubAllGlobals();
  stubSource.setDeferred(null);
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
      caps: () => FAKE_ACP_CAPS,
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
    caps: () => FAKE_ACP_CAPS,
    launch: vi.fn().mockRejectedValue(new Error(msg)),
    inject: vi.fn(),
    subscribe: vi.fn(),
    onPermissionRequest: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  }));
}

/**
 * outbox 출력노트 탐색 — stamp 파생 날짜 폴더 파티셔닝(FR-001) 이후엔 top-level 이 아니라
 * `<outboxDir>/<YYYY-MM-DD>/` 하위에 놓이므로 1단계 하위까지 탐색한다(알림류 `_*.md` 제외).
 */
function findOutNote(outDir: string): string | null {
  if (!fs.existsSync(outDir)) return null;
  for (const entry of fs.readdirSync(outDir)) {
    const full = path.join(outDir, entry);
    if (entry.endsWith(".md") && !entry.startsWith("_")) return full;
    if (/^\d{4}-\d{2}-\d{2}$/.test(entry) && fs.statSync(full).isDirectory()) {
      const nested = fs.readdirSync(full).find((f) => f.endsWith(".md") && !f.startsWith("_"));
      if (nested) return path.join(full, nested);
    }
  }
  return null;
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

  it("root 없는 markdown 레인은 소스 생성 throw 를 status=error 로 격리하고 다른 레인은 기동한다", async () => {
    // 기본 소스 markdown 전환 회귀 가드 — createMarkdownSource(root/inbox 누락)의 throw 가
    // per-lane try 밖에서 나면 up 전체가 크래시했다. 이제 그 레인만 error 로 격리돼야 한다.
    const mdNoRoot = `source=markdown
backend=acp
engine=claude-agent-acp
channel=markdown
perm_tier=acp
acp_version=v1
`;
    const { base } = setupProject("mixproj", {
      "md-broken": mdNoRoot,
      "telegram-claude": minimalConf,
    });
    const result = await runUp("mixproj", { base, acpFactory: makeFakeAcpFactory() });

    const md = result.lanes.find((l) => l.lane === "md-broken");
    const tg = result.lanes.find((l) => l.lane === "telegram-claude");
    expect(md?.status).toBe("error");
    expect(md?.error).toMatch(/root/i);
    // 다른 정상 레인은 기동 — up 전체가 무너지지 않음
    expect(tg?.status).toBe("running");
  });

  it("미등록 소스(source=bogus)는 status=error 로 격리한다 (레지스트리 fail-closed — telegram 폴백 없음)", async () => {
    // B2 레지스트리: 미지 소스를 조용히 telegram 으로 폴백하지 않고 팩토리 부재로 throw → 이 레인만 error.
    // 구 코드는 "markdown 아니면 telegram" 삼항이라 bogus 를 telegram 으로 오분류해 기동했다.
    const bogus = `source=bogus
backend=acp
engine=claude-agent-acp
perm_tier=acp
acp_version=v1
`;
    const { base } = setupProject("bogusproj", {
      "x-lane": bogus,
      "telegram-claude": minimalConf,
    });
    const result = await runUp("bogusproj", { base, acpFactory: makeFakeAcpFactory() });

    const bad = result.lanes.find((l) => l.lane === "x-lane");
    const tg = result.lanes.find((l) => l.lane === "telegram-claude");
    expect(bad?.status).toBe("error");
    expect(bad?.error).toMatch(/bogus/); // 소스명이 오류에 표기 — telegram 으로 새지 않음
    expect(tg?.status).toBe("running");
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
      "source=markdown\nbackend=acp\nengine=claude-agent-acp\nchannel=markdown\n" +
      `perm_tier=acp\nacp_version=v1\nmarkdown.root=${rootDir}\nmarkdown.inbox=inbox.md\n`;
    const { base } = setupProject("mdproj", { "markdown-claude": markdownConf });
    const fakeAcpFactory = makeFakeAcpFactory();

    const result = await runUp("mdproj", { base, acpFactory: fakeAcpFactory });

    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]?.status).toBe("running");
  });

  it("전체 턴 관통 — inbox send → inject → out 노트 렌더 (renderOut 배선 e2e, M7 hint 경로)", async () => {
    const rootDir = path.join(tmpBase, "NotesTurn");
    fs.mkdirSync(rootDir, { recursive: true });
    const conf =
      "source=markdown\nbackend=acp\nengine=claude-agent-acp\nchannel=markdown\n" +
      `perm_tier=acp\nacp_version=v1\nmarkdown.root=${rootDir}\nmarkdown.inbox=inbox.md\n`;
    const { base } = setupProject("turnproj", { "md-turn": conf });

    // 응답 청크를 emit 하는 fake — inject 시 구독자에게 "pong" 전달 후 resolve(turn 종료).
    const acpFactory = vi.fn().mockImplementation(() => {
      let subscriber: ((e: unknown) => void) | null = null;
      return {
        caps: () => FAKE_ACP_CAPS,
        launch: vi.fn().mockResolvedValue({ sessionId: "turn-001" }),
        subscribe: vi.fn().mockImplementation((_lane: string, cb: (e: unknown) => void) => {
          subscriber = cb;
        }),
        inject: vi.fn().mockImplementation(async () => {
          subscriber?.({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "pong" },
          });
        }),
        onPermissionRequest: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      };
    });

    // inbox 에 send 트리거 → 어댑터가 감시·enqueue → injector inject → writeOut → renderOut(out 노트).
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "안녕\n- [x] send\n");
    const result = await runUp("turnproj", { base, acpFactory });
    expect(result.lanes[0]?.status).toBe("running");

    // 렌더된 out 노트(outbox=inbox 형제 out/)가 응답을 담으면 renderOut 이 전 경로로 배선된 것.
    // 출력노트는 stamp 파생 날짜 폴더 하위에 놓이므로(FR-001) top-level + 1단계 하위까지 탐색한다.
    const outDir = path.join(rootDir, "out");
    const deadline = Date.now() + 3000;
    let notePath: string | null = null;
    while (Date.now() < deadline) {
      notePath = findOutNote(outDir);
      if (notePath) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(notePath).not.toBeNull();
    expect(fs.readFileSync(notePath!, "utf8")).toContain("pong");
  });
});

describe("supervisorUp autopass 기동 배너 (005)", () => {
  it("perm_tier=autopass 레인은 기동 시 채널에 자동 허용 모드 경고 배너를 남긴다", async () => {
    const rootDir = path.join(tmpBase, "NotesAp");
    fs.mkdirSync(rootDir, { recursive: true });
    // markdown 소스 — notify 가 outbox 노트로 표면화되어 네트워크 없이 관찰 가능.
    const conf =
      "source=markdown\nbackend=acp\nengine=claude-agent-acp\nchannel=markdown\n" +
      `perm_tier=autopass\ndenylist=Bash\nacp_version=v1\nmarkdown.root=${rootDir}\nmarkdown.inbox=inbox.md\n`;
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
      "source=markdown\nbackend=acp\nengine=claude-agent-acp\nchannel=markdown\n" +
      `perm_tier=acp\nacp_version=v1\nmarkdown.root=${rootDir}\nmarkdown.inbox=inbox.md\n`;
    const { base } = setupProject("acpproj", { "md-acp": conf });

    await runUp("acpproj", { base, acpFactory: makeFakeAcpFactory() });
    // 배너 미발생 확인 — 짧게 대기 후 부재 단언.
    await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(path.join(rootDir, "out", "_adde-notice.md"))).toBe(false);
  });
});

describe("supervisorUp — async 소스 기동 완료/실패 대기 (SC-011)", () => {
  it("start() 가 늦게 resolve 해도 supervisor 는 완료를 대기한 뒤에만 running 을 확정한다", async () => {
    const conf = `source=${ASYNC_STUB_SOURCE_ID}\nbackend=acp\nengine=claude-agent-acp\nperm_tier=acp\nacp_version=v1\n`;
    const { base } = setupProject("asyncstubproj", { "stub-lane": conf });

    const resultPromise = runUp("asyncstubproj", { base, acpFactory: makeFakeAcpFactory() });
    await waitFor(() => stubSource.getDeferred() !== null);
    // 아직 resolve 전 — 레인 runtime.json 이 기록되지 않았어야 한다(완료 대기 중).
    const lp = lanePaths(base, "asyncstubproj", "stub-lane");
    expect(fs.existsSync(lp.runtimeJson)).toBe(false);

    stubSource.getDeferred()!.resolve();
    const result = await resultPromise;
    expect(result.lanes[0]?.status).toBe("running");
    expect(fs.existsSync(lp.runtimeJson)).toBe(true);
  });

  it("start() 가 비동기로 reject 하면 supervisor 는 상태를 error 로 확정한다(running 미기록)", async () => {
    const conf = `source=${ASYNC_STUB_SOURCE_ID}\nbackend=acp\nengine=claude-agent-acp\nperm_tier=acp\nacp_version=v1\n`;
    const { base } = setupProject("asyncstubfailproj", { "stub-lane": conf });

    const resultPromise = runUp("asyncstubfailproj", { base, acpFactory: makeFakeAcpFactory() });
    await waitFor(() => stubSource.getDeferred() !== null);
    stubSource.getDeferred()!.reject(new Error("stub start failed"));

    const result = await resultPromise;
    expect(result.lanes[0]?.status).toBe("error");
    expect(result.lanes[0]?.error).toContain("stub start failed");
    // running 미기록 — runtime.json 이 기록되더라도 status:"error" 여야 한다(조용한 running 없음).
    const lp = lanePaths(base, "asyncstubfailproj", "stub-lane");
    const info = JSON.parse(fs.readFileSync(lp.runtimeJson, "utf8")) as { status?: string };
    expect(info.status).toBe("error");
  });

  it("start() 가 reject 하면 이미 launch 된 엔진 백엔드를 close 하여 고아 프로세스를 남기지 않는다 (회귀)", async () => {
    // 회귀: start() async 화 이전엔 start 가 reject 불가라 stop 핸들이 항상 등록됐으나,
    // async+probe 도입 후 launch 이후 start reject 시 stop 핸들 미등록 → 엔진 child 고아.
    // 실패 경로가 backend.close 를 호출해야 한다.
    const conf = `source=${ASYNC_STUB_SOURCE_ID}\nbackend=acp\nengine=claude-agent-acp\nperm_tier=acp\nacp_version=v1\n`;
    const { base } = setupProject("orphanproj", { "stub-lane": conf });
    const acpFactory = makeFakeAcpFactory();
    stubSource.resetStopCalls();

    const resultPromise = runUp("orphanproj", { base, acpFactory });
    await waitFor(() => stubSource.getDeferred() !== null);
    stubSource.getDeferred()!.reject(new Error("stub start failed"));
    const result = await resultPromise;

    expect(result.lanes[0]?.status).toBe("error");
    // 고아 방지 핵심 단언: launch 된 백엔드가 정확히 1회 close 되어야 한다(기동 실패 경로 정리).
    const backendInstance = acpFactory.mock.results[0]?.value as {
      launch: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    };
    expect(backendInstance.launch).toHaveBeenCalledTimes(1);
    expect(backendInstance.close).toHaveBeenCalledTimes(1);
    // 방어 정리: 생성된 소스도 stop 되어야 한다(연결형 소스 자원 누수 방지).
    expect(stubSource.getStopCalls()).toBe(1);
  });
});

describe("supervisorUp — telegram 기동 연결 확인 실패 → status:error (SC-014, integration)", () => {
  it("fake bot probe 실패(getMe 401) telegram 레인은 up 이후 상태가 error 로 표시된다(running 아님)", async () => {
    // beforeEach 의 기본 성공 스텁(stubTelegramProbeSuccess)을 이 테스트만 실패로 재정의.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        const method = (url as string).split("/").pop() ?? "";
        if (method === "getMe") {
          return { ok: false, status: 401, json: async () => ({ ok: false }) } as Response;
        }
        return { ok: true, json: async () => ({ ok: true, result: [] }) } as Response;
      }),
    );

    const { base } = setupProject("sc014proj", { "telegram-claude": minimalConf });
    const result = await runUp("sc014proj", { base, acpFactory: makeFakeAcpFactory() });
    expect(result.lanes[0]?.status).toBe("error");

    // "adde status" 가 읽는 것과 동일한 소스(runtime.json)로 재확인 — running 아님.
    const lp = lanePaths(base, "sc014proj", "telegram-claude");
    const info = JSON.parse(fs.readFileSync(lp.runtimeJson, "utf8")) as { status?: string };
    expect(info.status).toBe("error");
  });
});

// ── 016-engine-wiring ────────────────────────────────────────────────────

describe("supervisorUp — 미지원/오타 engine·backend 거부 (SC-001/SC-003)", () => {
  it("미지원 engine(codex-acp)은 spawn 전 거부되고 status:error 다 (SC-001 Error)", async () => {
    const conf = minimalConf.replace("engine=claude-agent-acp", "engine=codex-acp");
    const { base } = setupProject("badengineproj", { "bad-lane": conf });
    const result = await runUp("badengineproj", { base, acpFactory: makeFakeAcpFactory() });
    expect(result.lanes[0]?.status).toBe("error");
    expect(result.lanes[0]?.error).toContain("codex-acp");
  });

  it("오타 engine(clade)도 동일하게 거부된다 (SC-001 Error)", async () => {
    const conf = minimalConf.replace("engine=claude-agent-acp", "engine=clade");
    const { base } = setupProject("typoengineproj", { "typo-lane": conf });
    const result = await runUp("typoengineproj", { base, acpFactory: makeFakeAcpFactory() });
    expect(result.lanes[0]?.status).toBe("error");
    expect(result.lanes[0]?.error).toContain("clade");
  });

  it("미지원 backend(rest)는 spawn 전 거부되고 status:error 다 (SC-003 Error)", async () => {
    const conf = minimalConf.replace("backend=acp", "backend=rest");
    const { base } = setupProject("badbackendproj", { "bad-lane": conf });
    const result = await runUp("badbackendproj", { base, acpFactory: makeFakeAcpFactory() });
    expect(result.lanes[0]?.status).toBe("error");
    expect(result.lanes[0]?.error).toContain("rest");
  });
});

describe("supervisorUp — engine 미지정/빈 값은 안전 기본 엔진으로 기동한다 (SC-006)", () => {
  it("engine 라인이 아예 없는 conf 도 기본 엔진으로 기동한다 (Happy, 관측 불변)", async () => {
    const conf = "source=telegram\nbackend=acp\nperm_tier=acp\nacp_version=v1\n"; // engine 라인 부재
    const { base } = setupProject("noengineproj", { "lane1": conf });
    const result = await runUp("noengineproj", { base, acpFactory: makeFakeAcpFactory() });
    expect(result.lanes[0]?.status).toBe("running");

    const { DEFAULT_ENGINE } = await import("../../src/shared/conf.js");
    const lp = lanePaths(base, "noengineproj", "lane1");
    const info = JSON.parse(fs.readFileSync(lp.runtimeJson, "utf8")) as { engine?: string };
    expect(info.engine).toBe(DEFAULT_ENGINE);
  });

  it("engine=(빈 값)도 동일하게 기본 엔진으로 처리한다 (Edge)", async () => {
    const conf = "source=telegram\nbackend=acp\nengine=\nperm_tier=acp\nacp_version=v1\n";
    const { base } = setupProject("emptyengineproj", { "lane1": conf });
    const result = await runUp("emptyengineproj", { base, acpFactory: makeFakeAcpFactory() });
    expect(result.lanes[0]?.status).toBe("running");

    const { DEFAULT_ENGINE } = await import("../../src/shared/conf.js");
    const lp = lanePaths(base, "emptyengineproj", "lane1");
    const info = JSON.parse(fs.readFileSync(lp.runtimeJson, "utf8")) as { engine?: string };
    expect(info.engine).toBe(DEFAULT_ENGINE);
  });
});

describe("supervisorUp — engine_args 파싱 실패 거부 (SC-011)", () => {
  it("따옴표 포함 engine_args 는 spawn 전 거부되고 status:error 다", async () => {
    const conf = minimalConf + `engine_args=--x "a b"\n`;
    const { base } = setupProject("badargsproj", { "bad-lane": conf });
    const result = await runUp("badargsproj", { base, acpFactory: makeFakeAcpFactory() });
    expect(result.lanes[0]?.status).toBe("error");
  });
});

describe("supervisorUp — engine_args 관측 지점 마스킹 (SC-012)", () => {
  // mask.test.ts 의 봇 토큰 패턴(\d{5,}:[A-Za-z0-9_-]{30,})과 정합하는 토큰류 문자열 재사용.
  const TOKEN_LIKE = "123456789:AAECBAUGBwgJCgsMDQ4PEBESExQVFhcYGRob";

  it("engine_args 에 토큰류 문자열이 있으면 기동 로그가 마스킹되어 평문 노출이 없다", async () => {
    const conf = minimalConf + `engine_args=--token ${TOKEN_LIKE}\n`;
    const { base } = setupProject("maskproj", { "mask-lane": conf });
    const logSpy = vi.spyOn(console, "log");
    try {
      const result = await runUp("maskproj", { base, acpFactory: makeFakeAcpFactory() });
      expect(result.lanes[0]?.status).toBe("running");

      const engineArgsLogs = logSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes("engine args"));
      expect(engineArgsLogs.length).toBeGreaterThan(0);
      for (const line of engineArgsLogs) {
        expect(line).not.toContain(TOKEN_LIKE);
        expect(line).toContain("***");
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  it("engine_args 파싱 실패 시 오류 메시지도 마스킹된다(평문 노출 0)", async () => {
    const conf = minimalConf + `engine_args=--x "${TOKEN_LIKE} a b"\n`;
    const { base } = setupProject("maskfailproj", { "mask-lane": conf });
    const result = await runUp("maskfailproj", { base, acpFactory: makeFakeAcpFactory() });
    expect(result.lanes[0]?.status).toBe("error");
    expect(result.lanes[0]?.error).not.toContain(TOKEN_LIKE);
  });
});
