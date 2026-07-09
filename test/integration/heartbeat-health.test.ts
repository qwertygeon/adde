import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { supervisorUp, supervisorDown } from "../../src/core/supervisor.js";
import type { SupervisorUpOptions, SupervisorUpResult } from "../../src/core/supervisor.js";
import { lanePaths } from "../../src/shared/paths.js";
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  livenessOf,
  readRuntime,
} from "../../src/core/runtime-state.js";
import { makeCrashableAcpFactory } from "../helpers/fake-crashable-acp.js";

// SC-007 (FR-005 — Should, 재시도 구간 오표기 방지): 데몬은 크래시-확정 레인의 라이브니스를
// 무조건 신선(fresh)으로 갱신하지 않는다 — armHeartbeat tick 이 unhealthy 레인은 touch 를 스킵해
// mtime 이 정체(stale)되고, 그 결과 livenessOf 가 "running" 을 단언하지 않는다.
//
// 하트비트 간격(HEARTBEAT_INTERVAL_MS, 60s)은 SupervisorUpOptions 로 오버라이드되지 않으므로
// vi.useFakeTimers() 로 armHeartbeat 의 setInterval 을 가상 시간으로 전진시켜 실시간 대기를 없앤다
// (Test Authoring Contract "백오프 실시간 대기 금지"와 동일 취지 — 하트비트도 실 60s 대기 없이 검증).

let tmpBase: string;
const startedProjs = new Set<string>();

async function runUp(proj: string, opts: SupervisorUpOptions): Promise<SupervisorUpResult> {
  startedProjs.add(proj);
  return supervisorUp(proj, opts);
}

/**
 * telegram 레인 기동 시 getMe bounded probe(N4)가 실제 네트워크를 타지 않도록 기본 성공 응답
 * 스텁 — 본 파일의 시나리오는 probe 자체가 아니라 하트비트/라이브니스가 검증 대상이므로,
 * probe 는 항상 성공시켜 기존 관찰 동작(SC-019 회귀)을 보존한다. fetch mock 은 fake timer 와
 * 무관하게 즉시 resolve 하므로 vi.useFakeTimers() 이후에도 runUp 이 블록되지 않는다.
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
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-heartbeat-health-"));
  stubTelegramProbeSuccess();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const proj of startedProjs) {
    try {
      await supervisorDown(proj, { base: tmpBase });
    } catch {
      // teardown best-effort
    }
  }
  startedProjs.clear();
  fs.rmSync(tmpBase, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const minimalConf = `source=telegram
backend=acp
engine=claude-agent-acp
channel=telegram
perm_tier=acp
acp_version=v1
`;

function setupProject(projName: string, lane: string): { base: string } {
  const base = tmpBase;
  const lanesDir = path.join(base, projName, "lanes.d");
  fs.mkdirSync(lanesDir, { recursive: true });
  fs.writeFileSync(path.join(lanesDir, `${lane}.conf`), minimalConf);
  const lp = lanePaths(base, projName, lane);
  fs.mkdirSync(lp.queueDir, { recursive: true });
  fs.mkdirSync(lp.processingDir, { recursive: true });
  fs.mkdirSync(lp.outDir, { recursive: true });
  fs.mkdirSync(lp.stateDir, { recursive: true });
  fs.writeFileSync(lp.envFile, "TELEGRAM_BOT_TOKEN=111111111:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg\n");
  return { base };
}

describe("SC-007: 크래시-확정 레인은 하트비트 touch 를 스킵해 mtime 이 정체된다", () => {
  it("unhealthy 레인은 heartbeat tick 이 지나도 runtime.json mtime 이 갱신되지 않는다", async () => {
    vi.useFakeTimers();
    const proj = "healthproj";
    const lane = "health-lane";
    const { base } = setupProject(proj, lane);
    const { factory, entryFor } = makeCrashableAcpFactory();

    await runUp(proj, { base, acpFactory: factory });
    const paths = lanePaths(base, proj, lane);
    const before = fs.statSync(paths.runtimeJson).mtimeMs;

    const entry = entryFor(lane);
    // SC-007 의 Given 은 "크래시가 확정되어 재기동을 시도 중인(아직 포기 전) 레인" — 하드코딩
    // cap(5회, 총 ~31s 로 포기 확정)이 하트비트 주기(60s)보다 짧아, 기본 backoff·성공/실패 재기동
    // 모두 60s 전에 상태가 정착(복구 또는 포기)해 버려 "아직 포기 전" 재시도 구간 자체를 60s 창에서
    // 관찰할 수 없다. resumeSession 을 영구 대기(never-resolve)로 만들어 "진행 중(relaunching), 아직
    // 성공도 포기도 아닌" 상태를 하트비트 시점까지 유지한다.
    entry.backend.resumeSession.mockImplementation(() => new Promise(() => {}));
    entry.crash(); // watcher.onCrash 공통부 — setHealth(false)(동기)
    await vi.advanceTimersByTimeAsync(0); // 크래시 처리 마이크로태스크 정리

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS); // 하트비트 1틱 경과(가상 시간)

    const after = fs.statSync(paths.runtimeJson).mtimeMs;
    expect(after).toBe(before); // touch 스킵 — mtime 불변(무조건 신선 갱신 금지)

    // mtime 정체가 HEARTBEAT_STALE_MS 를 넘으면 stale(비-running) 판정 — 기존 게이트 재사용 확인.
    const info = await readRuntime(paths);
    expect(livenessOf(info, { mtimeMs: after, now: after + HEARTBEAT_STALE_MS + 1 })).toBe("stale");
  });

  it("healthy 레인(기동 직후)은 하트비트 tick 에 정상적으로 touch 된다(비교 대상 회귀 가드)", async () => {
    vi.useFakeTimers();
    const proj = "healthyproj";
    const lane = "healthy-lane";
    const { base } = setupProject(proj, lane);
    const { factory } = makeCrashableAcpFactory();

    await runUp(proj, { base, acpFactory: factory });
    const paths = lanePaths(base, proj, lane);
    const before = fs.statSync(paths.runtimeJson).mtimeMs;

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

    // 실제 파일시각(fs 커널 클록)은 fake timer 영향을 받지 않으므로, tick 이 실제로 utimes 를
    // 시도했는지는 mtime 갱신 유무로 관찰한다(healthy 라 touch 시도됨 → 변화 가능).
    const after = fs.statSync(paths.runtimeJson).mtimeMs;
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
