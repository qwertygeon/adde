import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { supervisorUp, supervisorDown } from "../../src/core/supervisor.js";
import type { SupervisorUpOptions, SupervisorUpResult } from "../../src/core/supervisor.js";
import { lanePaths } from "../../src/shared/paths.js";
import { createInjector } from "../../src/core/injector.js";
import { createLaneWatcher } from "../../src/core/lane-watcher.js";
import { enqueue } from "../../src/core/queue.js";
import { makeCrashableAcpFactory } from "../helpers/fake-crashable-acp.js";
import { FAKE_ACP_CAPS } from "../helpers/fake-acp.js";
import { makeEnvelope } from "../helpers/envelope.js";
import { waitFor } from "../helpers/wait.js";

// SC-002(FR-002·NFR-002 — 정상 회복): 크래시된 엔진이 세션·구독을 보존한 채 재기동되어 후속
//   인바운드를 처리한다.
// SC-011(FR-002·NFR-004 — 기본 활성): 옵트인 플래그·추가 설정 없이 기본 구성에서 자가 재기동 동작.
// SC-014(FR-008·FR-005 — OFF 레인): auto_relaunch=false 크래시 → 재기동 0·즉시 error·deny·통지 1회.
// SC-010(NFR-001 — 무손실·무중복): turn 중간 크래시로 실패 기록된 메시지가 processing 에 보존되고,
//   재기동 로직 자체는 out/queue/processing 을 건드리지 않으며, 데몬 재시작 후 정확히 1회만 재처리.
//
// integration: 격리 샌드박스(tmp) + fake ACP(실봇·실엔진 무접촉). fake 는 launch 가드·close 후
// exit 억제·resumeSession 승계를 강제하는 계약 더블(테스트 더블 계약 — no-op 금지).

let tmpBase: string;
const startedProjs = new Set<string>();

async function runUp(proj: string, opts: SupervisorUpOptions): Promise<SupervisorUpResult> {
  startedProjs.add(proj);
  return supervisorUp(proj, opts);
}

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-self-recovery-"));
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
});

/** markdown 레인 conf + 감시 대상 root 준비(네트워크 무접촉 — telegram 폴링 회피). */
function setupMdLane(
  proj: string,
  lane: string,
  extraConfLines: string[] = [],
): { base: string; rootDir: string } {
  const rootDir = path.join(tmpBase, `${proj}-${lane}-notes`);
  fs.mkdirSync(rootDir, { recursive: true });
  const lanesDir = path.join(tmpBase, proj, "lanes.d");
  fs.mkdirSync(lanesDir, { recursive: true });
  const lines = [
    "source=markdown",
    "backend=acp",
    "engine=claude-agent-acp",
    "channel=markdown",
    "perm_tier=acp",
    "acp_version=v1",
    `markdown.root=${rootDir}`,
    "markdown.inbox=inbox.md",
    ...extraConfLines,
  ];
  fs.writeFileSync(path.join(lanesDir, `${lane}.conf`), lines.join("\n") + "\n");
  return { base: tmpBase, rootDir };
}

describe("SC-002: 크래시 → 백오프 → resumeSession 재기동 후 인바운드 정상 처리", () => {
  it("동일 세션·구독을 승계한 채 재기동되어 재기동 후 도착 인바운드가 정상 처리된다", async () => {
    const proj = "recoverproj";
    const lane = "recover-lane";
    const { base, rootDir } = setupMdLane(proj, lane);
    const { factory, entryFor } = makeCrashableAcpFactory();

    const result = await runUp(proj, { base, acpFactory: factory });
    expect(result.lanes[0]?.status).toBe("running");

    const entry = entryFor(lane);
    entry.crash(); // 크래시 신호 — watcher 트리거(하드코딩 백오프, 초기 1s)

    await waitFor(() => entry.backend.resumeSession.mock.calls.length > 0, { timeoutMs: 8000 });
    await waitFor(() => entry.isAliveNow(), { timeoutMs: 4000 });

    // 재기동 후 도착 인바운드 — 승계된 구독자가 응답을 수신해 out 노트로 렌더된다.
    const outDir = path.join(rootDir, "out");
    fs.writeFileSync(path.join(rootDir, "inbox.md"), "복구 후 문의\n- [x] send\n");
    await waitFor(
      () =>
        fs.existsSync(outDir) &&
        fs.readdirSync(outDir).some((f) => f.endsWith(".md") && !f.startsWith("_")),
      { timeoutMs: 8000 },
    );
    const note = fs.readdirSync(outDir).find((f) => f.endsWith(".md") && !f.startsWith("_"))!;
    expect(fs.readFileSync(path.join(outDir, note), "utf8")).toContain("pong");
  }, 20000); // 실 백오프(초기 1s) + I/O 왕복 — 부하 시 vitest 기본 5s 타임아웃 여유 확보.
});

describe("SC-011: 옵트인 플래그 없이 자가 재기동(default-on)", () => {
  it("auto_relaunch 키가 없는 기본 conf 로 기동된 레인도 크래시 시 재기동을 시도한다", async () => {
    const proj = "defaultonproj";
    const lane = "default-lane";
    const { base } = setupMdLane(proj, lane); // auto_relaunch 키 미기재(기본 ON)
    const { factory, entryFor } = makeCrashableAcpFactory();

    const result = await runUp(proj, { base, acpFactory: factory });
    expect(result.lanes[0]?.status).toBe("running");

    entryFor(lane).crash();
    await waitFor(() => entryFor(lane).backend.resumeSession.mock.calls.length > 0, {
      timeoutMs: 8000,
    });
    expect(entryFor(lane).isAliveNow()).toBe(true);
  }, 20000); // 실 백오프(초기 1s) — 부하 시 vitest 기본 5s 타임아웃 여유 확보.
});

describe("SC-014: auto_relaunch=false 레인 — 재기동 0·즉시 error·deny·통지 1회", () => {
  it("OFF 레인 크래시 시 재기동을 시도하지 않고 즉시 error 확정 + 미결 승인 deny + 통지 정확히 1회", async () => {
    const proj = "offproj";
    const lane = "off-lane";
    const { base, rootDir } = setupMdLane(proj, lane, ["auto_relaunch=false"]);
    const { factory, entryFor } = makeCrashableAcpFactory();

    const result = await runUp(proj, { base, acpFactory: factory });
    expect(result.lanes[0]?.status).toBe("running");

    const entry = entryFor(lane);

    // in-flight 미결 승인 — 엔진이 권한 요청을 보냈고 아직 결정이 안 난 상태를 모사.
    const permPromise = entry.invokePermHandler({
      v: 1,
      id: "perm-off-1",
      lane,
      channel: "markdown",
      tool: "Bash",
      detail: "{}",
      cwd: rootDir,
      ts: new Date().toISOString(),
    });

    // "in-flight" 상태 확정 대기 — sendPermPrompt(markdown 승인 노트 기록)가 완료된 뒤에야
    // gateRequestDecision 이 pendingDecisions 에 등록한다(gate.ts). 등록 전에 crash 하면
    // denyPending() 이 빈 맵을 스냅샷해 이 요청을 놓친다(진짜 레이스 — 등록 완료를 관찰로 확정).
    const approvalNote = path.join(rootDir, "approvals", "perm-off-1.md");
    await waitFor(() => fs.existsSync(approvalNote), { timeoutMs: 6000 });

    entry.crash(); // OFF: 재기동 시도 없이 즉시 error 확정 + deny + 통지 1회

    // 미결 승인이 게이트 타임아웃(기본 600초)까지 hang 하지 않고 신속히 deny 로 종결된다.
    const resp = await Promise.race([
      permPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("게이트가 신속히 종결되지 않음(hang)")), 3000),
      ),
    ]);
    expect(resp.decision).toBe("deny");

    expect(entry.backend.resumeSession).not.toHaveBeenCalled(); // 재기동 시도 0회

    // 즉시 error 확정(cap 대기 없음) — runtime.json 이 status:error 로 갱신된다.
    const paths = lanePaths(base, proj, lane);
    await waitFor(
      () => {
        const info = JSON.parse(fs.readFileSync(paths.runtimeJson, "utf8")) as { status?: string };
        return info.status === "error";
      },
      { timeoutMs: 6000 },
    );

    // 채널 통지 정확히 1회 — markdown _adde-notice.md 에 통지 블록 1개.
    const noticePath = path.join(rootDir, "out", "_adde-notice.md");
    await waitFor(() => fs.existsSync(noticePath), { timeoutMs: 6000 });
    const countBlocks = (): number =>
      (fs.readFileSync(noticePath, "utf8").match(/^> \d{4}-\d{2}-\d{2}T/gm) ?? []).length;
    expect(countBlocks()).toBe(1);

    // 재진입(중복 크래시 신호)에도 통지가 재발생하지 않는다(terminal 가드).
    entry.crash();
    await new Promise((r) => setTimeout(r, 100));
    expect(countBlocks()).toBe(1);
  }, 20000); // 승인 노트 I/O + 3s 레이스가드 대기 — 부하 시 vitest 기본 5s 타임아웃 여유 확보.
});

describe("SC-010: 무손실·무중복 — 재기동 전후 dedup·큐·processing 불변", () => {
  /**
   * 결정적 fake scheduler(lane-watcher.test.ts 와 동일 패턴, 이 describe 안에 로컬 정의 — SC-010
   * 만 결정화하라는 재작업 지시 범위를 지키기 위해 공용 헬퍼는 건드리지 않는다). deps.scheduler 로
   * 주입해 하드코딩 backoff(1s+) 실대기를 제거한다 — supervisorUp 은 backoff/scheduler 오버라이드를
   * 노출하지 않으므로(C4 는 하드코딩 상수만 사용), 이 SC 는 supervisorUp 을 거치지 않고 createInjector
   * + createLaneWatcher 를 직접 구성해(실제 production 함수 그대로, ACP backend 만 얇은 fake) SC-010
   * 이 요구하는 "재기동 로직이 queue/processing/out 을 건드리지 않는다"를 결정적으로 검증한다.
   * (spec.md 도 SC-010 을 [env:unit] 으로 태깅 — 원 계약의 integration 배치보다 이 구성이 더 정합하다.)
   */
  function makeManualScheduler(): {
    scheduler: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
    fire(): void;
  } {
    let seq = 0;
    const timers = new Map<number, () => void>();
    const handle = (id: number): NodeJS.Timeout =>
      ({ id, unref: () => handle(id) }) as unknown as NodeJS.Timeout;
    return {
      scheduler: {
        setTimeout: ((cb: (...args: unknown[]) => void) => {
          const id = seq++;
          timers.set(id, () => cb());
          return handle(id);
        }) as unknown as typeof setTimeout,
        clearTimeout: ((h: unknown) => {
          const id = (h as { id?: number } | undefined)?.id;
          if (id !== undefined) timers.delete(id);
        }) as typeof clearTimeout,
      },
      fire(): void {
        const entry = [...timers.entries()][0];
        if (!entry) throw new Error("no pending timer to fire");
        const [id, cb] = entry;
        timers.delete(id);
        cb();
      },
    };
  }

  it("turn 중간 크래시로 실패 기록된 메시지는 processing 에 보존되고, 재기동 로직은 out/queue/processing 을 건드리지 않으며, 재시작(신규 injector.start()) 후 정확히 1회만 재처리된다", async () => {
    const lane = "dedup-lane";
    const paths = lanePaths(tmpBase, "dedupproj", lane);
    fs.mkdirSync(paths.queueDir, { recursive: true });
    fs.mkdirSync(paths.processingDir, { recursive: true });
    fs.mkdirSync(paths.outDir, { recursive: true });
    fs.mkdirSync(paths.stateDir, { recursive: true });

    // 1) turn 중간 크래시로 인한 inject 실패 상태를 실제 injector 로 구성 — 실패 시 .failed 기록 +
    //    processing 보존은 기존 injector 계약(변경 없음, test/core/injector.test.ts 가 이미 커버).
    let injectBehavior: "crash" | "ok" = "crash";
    const backend = {
      caps: () => FAKE_ACP_CAPS,
      launch: vi.fn(),
      inject: vi.fn().mockImplementation(async () => {
        if (injectBehavior === "crash") {
          throw new Error("engine transport closed (simulated crash mid-turn)");
        }
      }),
      subscribe: vi.fn(),
      onPermissionRequest: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const id = "mid-turn";
    await enqueue(paths, makeEnvelope(id, "진행 중 문의"));
    const injector = createInjector(paths, lane, backend);
    await injector.start();

    expect(fs.existsSync(path.join(paths.outDir, `${id}.failed`))).toBe(true);
    expect(fs.existsSync(path.join(paths.processingDir, `${id}.msg`))).toBe(true); // 원문 보존
    expect(fs.existsSync(path.join(paths.outDir, `${id}.out`))).toBe(false); // 성공 마커 아직 없음

    // 2) 자가 회복 watcher — 결정적 backoff(초 단위 아님, ms) 로 크래시→재기동을 즉시 구동.
    const resumeSession = vi.fn().mockImplementation(async () => {
      injectBehavior = "ok"; // 재기동 성공 → 이후 inject 는 정상 처리
      return { sessionId: "recovered-1", resumed: true };
    });
    const { scheduler, fire } = makeManualScheduler();
    const watcher = createLaneWatcher({
      lane,
      autoRelaunch: true,
      resumeSession,
      isAlive: () => false,
      lastSessionId: async () => "s1",
      denyPending: () => {},
      setHealth: () => {},
      writeError: async () => {},
      onSessionUpdated: async () => {},
      notify: () => {},
      backoff: {
        initialDelayMs: 5,
        multiplier: 2,
        maxDelayMs: 20,
        maxAttempts: 5,
        stabilityResetMs: 1_000_000,
      },
      scheduler,
    });
    watcher.arm();
    watcher.onCrash({ code: 1, signal: null });
    fire(); // 백오프 만료(결정적) — resumeSession 즉시 호출
    await waitFor(() => resumeSession.mock.calls.length > 0, { timeoutMs: 2000 });

    // 재기동 로직 자체는 queue/processing/out 을 건드리지 않는다(불변) — 재기동 완료 직후 재확인.
    expect(fs.existsSync(path.join(paths.processingDir, `${id}.msg`))).toBe(true);
    expect(fs.existsSync(path.join(paths.outDir, `${id}.out`))).toBe(false);

    // 3) 재시작(신규 injector 인스턴스 — 데몬 재기동 시 scanProcessing 이 재개하는 경로와 동형)이
    //    보존된 메시지를 재처리한다(at-least-once). 자가 회복 watcher 는 이 경로를 대체하지 않는다
    //    (research.md 인정 한계).
    const injector2 = createInjector(paths, lane, backend);
    await injector2.start();

    // 동일 id 의 중복 출력 0 — .out 파일은 정확히 1개, 유실도 0(실제로 기록됨).
    const outFiles = fs.readdirSync(paths.outDir).filter((f) => f === `${id}.out`);
    expect(outFiles).toHaveLength(1);
  });
});
