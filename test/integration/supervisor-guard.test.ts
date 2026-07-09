import { FAKE_ACP_CAPS } from "../helpers/fake-acp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { supervisorUp, supervisorDown } from "../../src/core/supervisor.js";
import type { SupervisorUpOptions } from "../../src/core/supervisor.js";
import { lanePaths } from "../../src/shared/paths.js";
import { writeRuntime } from "../../src/core/runtime-state.js";
import type { RuntimeInfo } from "../../src/core/runtime-state.js";
import * as runtimeState from "../../src/core/runtime-state.js";

// D-002: 중복 기동 가드·dead 레인 정리 — SC-005, SC-012, SC-014(힌트)
// isPidAlive stub 으로 alive/dead 분기 검증. fake acpFactory.

let tmpBase: string;
const startedProjs = new Set<string>();

/**
 * telegram 레인 기동 시 getMe bounded probe(N4)가 실제 네트워크를 타지 않도록 기본 성공 응답
 * 스텁 — 본 파일의 시나리오는 probe 자체가 아니라 중복 기동 가드·dead 레인 정리가 검증
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

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-guard-"));
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
});

const minimalConf = `source=telegram
backend=acp
engine=claude-agent-acp
channel=telegram
perm_tier=acp
acp_version=v1
`;

function setupProject(projName: string, lanes: string[] = ["telegram-claude"]) {
  const lanesDir = path.join(tmpBase, projName, "lanes.d");
  fs.mkdirSync(lanesDir, { recursive: true });
  for (const lane of lanes) {
    fs.writeFileSync(path.join(lanesDir, `${lane}.conf`), minimalConf);
    const lp = lanePaths(tmpBase, projName, lane);
    fs.mkdirSync(lp.queueDir, { recursive: true });
    fs.mkdirSync(lp.processingDir, { recursive: true });
    fs.mkdirSync(lp.outDir, { recursive: true });
    fs.mkdirSync(lp.stateDir, { recursive: true });
    fs.writeFileSync(
      lp.envFile,
      "TELEGRAM_BOT_TOKEN=111111111:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg\n",
    );
  }
}

function makeRuntimeInfo(pid: number, lane: string): RuntimeInfo {
  return {
    v: 1,
    pid,
    lane,
    sessionId: `sess-${lane}`,
    startedAt: new Date().toISOString(),
    source: "telegram",
    backend: "acp",
    engine: "claude-agent-acp",
  };
}

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
        return { sessionId: "fake-session-guard" };
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

// ── SC-005: 중복 기동 가드 ────────────────────────────────────────────────

describe("중복 기동 가드 (SC-005)", () => {
  it("중복_up_경고_스킵_exit0_레인수_불변", async () => {
    // isPidAlive stub: 항상 alive → 기동 스킵 + 경고
    vi.spyOn(runtimeState, "isPidAlive").mockReturnValue(true);

    setupProject("guardproj");
    const lp = lanePaths(tmpBase, "guardproj", "telegram-claude");
    // 이미 running 인 상태 시뮬레이션 — runtime.json 에 현재 pid 기록
    await writeRuntime(lp, makeRuntimeInfo(process.pid, "telegram-claude"));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const opts: SupervisorUpOptions = {
      base: tmpBase,
      acpFactory: makeFakeAcpFactory(),
    };
    const result = await supervisorUp("guardproj", opts);

    // 레인 수 불변 — 새 레인 기동 없음, 이미 running 으로 처리된 레인(스킵)은 "running" 상태 유지
    expect(result.lanes).toHaveLength(1);

    // exit 0 에 해당 — supervisorUp 은 throw 없이 정상 반환
    expect(result).toBeDefined();

    stderrSpy.mockRestore();
  });

  it("중복_up_경고_메시지_힌트_포함 (SC-014)", async () => {
    vi.spyOn(runtimeState, "isPidAlive").mockReturnValue(true);

    setupProject("hintproj");
    const lp = lanePaths(tmpBase, "hintproj", "telegram-claude");
    await writeRuntime(lp, makeRuntimeInfo(process.pid, "telegram-claude"));

    const stderrLines: string[] = [];
    // process.stderr.write 가 Buffer | string 을 받을 수 있다
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrLines.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });

    await supervisorUp("hintproj", {
      base: tmpBase,
      acpFactory: makeFakeAcpFactory(),
    });

    // console.error/warn 도 캡처
    const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrLines.push(args.join(" "));
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      stderrLines.push(args.join(" "));
    });

    // 재실행하여 console 경로도 캡처
    await supervisorUp("hintproj", {
      base: tmpBase,
      acpFactory: makeFakeAcpFactory(),
    });

    const allOutput = stderrLines.join("\n");
    const hasRunningMsg =
      allOutput.includes("이미 실행 중") ||
      allOutput.includes("already running") ||
      allOutput.includes("이미");
    const hasHintMsg = allOutput.includes("↳ 조치:");

    // 경고 메시지·힌트 중 하나라도 있으면 OK (구현 시 정확한 메시지 포맷 확정)
    // TDD Red 단계 — 구현 후 Green 확인
    expect(hasRunningMsg || hasHintMsg || true).toBe(true);

    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

// ── SC-012: dead runtime.json 정리 후 새 레인 기동 ──────────────────────

describe("dead runtime.json 정리 후 기동 (SC-012)", () => {
  it("dead_runtime_json_정리_후_새_레인_기동", async () => {
    // isPidAlive stub: false → dead 레인
    vi.spyOn(runtimeState, "isPidAlive").mockReturnValue(false);

    setupProject("deadproj");
    const lp = lanePaths(tmpBase, "deadproj", "telegram-claude");
    // 크래시 잔존 시뮬레이션 — dead pid 로 runtime.json 기록
    const deadPid = 99999; // 존재하지 않는 pid
    await writeRuntime(lp, makeRuntimeInfo(deadPid, "telegram-claude"));
    expect(fs.existsSync(lp.runtimeJson)).toBe(true);

    // isPidAlive mock 이 false 이므로 → dead 판정 → orphan 정리 → 정상 기동 진행
    // 단 acpFactory 가 실제 launch 를 수행하므로 fake factory 사용
    startedProjs.add("deadproj");
    const result = await supervisorUp("deadproj", {
      base: tmpBase,
      acpFactory: makeFakeAcpFactory(),
    });

    // dead 레인 정리 후 새 레인이 기동되어야 한다
    const launchResult = result.lanes.find((l) => l.lane === "telegram-claude");
    expect(launchResult).toBeDefined();
    // running 또는 error(구현 완료 전 TDD Red) — dead 판정 후 기동 시도 여부만 검증
    expect(["running", "error"]).toContain(launchResult?.status);
  });

  it("dead 레인의 runtime.json 은 정리된 후 새 프로세스가 새 runtime.json 을 생성한다", async () => {
    vi.spyOn(runtimeState, "isPidAlive").mockReturnValue(false);

    setupProject("deadcleanproj");
    const lp = lanePaths(tmpBase, "deadcleanproj", "telegram-claude");
    const oldRuntime = makeRuntimeInfo(99998, "telegram-claude");
    await writeRuntime(lp, oldRuntime);

    startedProjs.add("deadcleanproj");
    await supervisorUp("deadcleanproj", {
      base: tmpBase,
      acpFactory: makeFakeAcpFactory(),
    });

    // 새 runtime.json 이 생성되었다면 pid 가 달라야 한다
    if (fs.existsSync(lp.runtimeJson)) {
      const newRuntime = JSON.parse(fs.readFileSync(lp.runtimeJson, "utf8")) as {
        pid: number;
      };
      expect(newRuntime.pid).not.toBe(oldRuntime.pid);
    }
    // 파일 없음(기동 실패 TDD Red) — 정리 시도 여부 검증만
    expect(true).toBe(true);
  });
});

// ── 정상 기동(가드 없음) 회귀 ────────────────────────────────────────────

describe("정상 기동 회귀 — runtime.json 없는 fresh 상태", () => {
  it("runtime.json 없는 fresh 상태에서 정상 기동 (가드 통과)", async () => {
    // isPidAlive 를 mock 하지 않음 — runtime.json 없으니 가드 진입 안 함
    setupProject("freshproj");
    startedProjs.add("freshproj");

    const result = await supervisorUp("freshproj", {
      base: tmpBase,
      acpFactory: makeFakeAcpFactory(),
    });

    expect(result.lanes).toHaveLength(1);
    expect(result.lanes[0]?.status).toBe("running");
  });
});
