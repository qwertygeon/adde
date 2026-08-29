import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  writeMinimalProjectConf,
  makeSessionManagerDeps,
  type V2TmpRoots,
  bindSessionManager,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { waitFor } from "../helpers/wait.js";
import { installAddeHomeGuard } from "../helpers/adde-home-guard.js";

// SC-055~058 — `session stop`/`resume` CLI 가 control 큐(design.md §4) 를 경유해 데몬과 동기화된다.
// "데몬 상주" 시나리오는 별도(가상) SessionManager 인스턴스가 `absorbControl()` 을 짧은 간격으로
// 반복 호출하는 것으로 재현한다(실 프로세스 spawn 은 stop-reservation-spawn.test.ts 등 PROC-R18
// 대상만 — 여기는 in-process 관통으로 충분히 판별 가능).

const PROJ = "p1";
let roots: V2TmpRoots;
let drainTimer: ReturnType<typeof setInterval> | undefined;
const addeHomeGuard = installAddeHomeGuard(() => roots.base);

beforeEach(() => {
  roots = makeV2TmpRoots();
  writeMinimalProjectConf(roots.base, PROJ, { vault: roots.vaultRoot });
  addeHomeGuard.before();
});

afterEach(() => {
  if (drainTimer) clearInterval(drainTimer);
  addeHomeGuard.after();
  cleanupV2TmpRoots(roots);
});

async function makeDaemonSM() {
  const sessionManagerMod = await import("../../src/core/session-manager.js");
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
  const sm = sessionManagerMod.createSessionManager(deps);
  bindSessionManager(deps, sm);
  await sm.load();
  return { sm, fakeDriver };
}

/** 데몬 상주를 재현 — absorbControl() 을 짧은 간격으로 반복 호출한다. */
function startDrainLoop(sm: { absorbControl(): Promise<void> }) {
  drainTimer = setInterval(() => void sm.absorbControl(), 100);
}

async function runSessionCli(argv: readonly string[]): Promise<{ code: number; out: string }> {
  const mod = await import("../../src/cli/session.js");
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => {
    chunks.push(String(c));
    return true;
  }) as never;
  // 상태 불일치·대상 부재 안내는 `groupError` 경유로 process.stderr 에 나간다(handleStop/
  // handleResume — `[adde session] 오류: …`) — stdout 만 캡처하면 그 문구를 놓친다.
  process.stderr.write = ((c: string) => {
    chunks.push(String(c));
    return true;
  }) as never;
  try {
    const code = await (
      mod as unknown as {
        runSession: (a: readonly string[], d?: Record<string, unknown>) => Promise<number>;
      }
    ).runSession(argv, { base: roots.base, interactive: false });
    return { code, out: chunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe("SC-055: session stop 은 CLI 에서 중지 전이(또는 예약)를 결과로 보고한다", () => {
  it("Happy: 활성 세션 stop → 중지 전이 + 결과 출력", async () => {
    const { sm } = await makeDaemonSM();
    const created = await sm.create({ engine: "acp" });
    startDrainLoop(sm);
    const { code, out } = await runSessionCli(["stop", PROJ, created.sid]);
    expect(code).toBe(0);
    expect(out.length).toBeGreaterThan(0);
    await waitFor(() => sm.get(created.sid)?.status === "stopped", { timeoutMs: 8_000 });
  }, 15000);

  it("Error: 데몬 흡수를 확인할 수 없으면 거부하고 사유를 출력한다(무동작 성공 금지)", async () => {
    // 드레인 루프를 시작하지 않는다 — claim 되지 않고 회수(unclaimed)로 CLI 가 직접 적용하거나,
    // 회수 실패 시 거부한다. 여기서는 세션 레코드 자체가 없어 회수 후 직접 적용도 mismatch 로
    // 귀결되는 극단 케이스로 "무동작 성공 보고 0" 을 확인한다.
    const { code, out } = await runSessionCli(["stop", PROJ, "no-such-sid"]);
    expect(code).not.toBe(0);
    expect(out + "").not.toMatch(/성공|stopped\b.*OK/i);
  }, 10000);
});

describe("SC-056: session resume 은 활성 계열로 전이하고 노트를 정상 스켈레톤으로 복구한다", () => {
  it("Happy: 중지 세션 resume → 활성 계열 전이", async () => {
    const { sm } = await makeDaemonSM();
    const created = await sm.create({ engine: "acp" });
    const smApi = sm as unknown as {
      stop: (sid: string, opts: unknown) => Promise<unknown>;
    };
    await smApi.stop(created.sid, { reason: "r", source: "cli" });
    startDrainLoop(sm);
    const { code } = await runSessionCli(["resume", PROJ, created.sid]);
    expect(code).toBe(0);
    await waitFor(() => sm.get(created.sid)?.status === "active", { timeoutMs: 8_000 });
  }, 15000);
});

describe("SC-057: 상태 불일치·대상 0건은 안내로 처리된다", () => {
  it("Happy: 이미 중지된 세션에 stop → 불일치 안내", async () => {
    const { sm } = await makeDaemonSM();
    const created = await sm.create({ engine: "acp" });
    const smApi = sm as unknown as { stop: (sid: string, opts: unknown) => Promise<unknown> };
    await smApi.stop(created.sid, { reason: "r", source: "cli" });
    startDrainLoop(sm);
    const { code, out } = await runSessionCli(["stop", PROJ, created.sid]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/이미|already|mismatch/i);
  }, 15000);

  it("Edge: 활성 세션에 resume → 불일치 안내", async () => {
    const { sm } = await makeDaemonSM();
    const created = await sm.create({ engine: "acp" });
    startDrainLoop(sm);
    const { code, out } = await runSessionCli(["resume", PROJ, created.sid]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/이미|already|mismatch/i);
  }, 15000);

  it("Error: 대상 없이 재개 시도 → 0건 안내 + exit 1", async () => {
    const { sm } = await makeDaemonSM();
    startDrainLoop(sm);
    const { code, out } = await runSessionCli(["resume", PROJ]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/없|0건|no.*session/i);
  }, 10000);
});

describe("SC-058: 데몬 상주 중 CLI 중지는 폴 대상에서 이탈하고 되살아나지 않는다", () => {
  it("Happy: CLI 중지 후 데몬(SessionManager)의 in-memory 레코드도 중지로 흡수된다(rev CAS)", async () => {
    const { sm } = await makeDaemonSM();
    const created = await sm.create({ engine: "acp" });
    startDrainLoop(sm);
    await runSessionCli(["stop", PROJ, created.sid]);
    await waitFor(() => sm.get(created.sid)?.status === "stopped", { timeoutMs: 8_000 });
    await new Promise((r) => setTimeout(r, 500));
    expect(sm.get(created.sid)?.status).toBe("stopped"); // 되쓰기로 active 로 되살아나지 않는다.
  }, 15000);

  it("Happy(witness): 낮은 rev 의 되쓰기가 더 높은 disk rev 를 되돌리지 않는다(rev CAS 판별력 보강)", async () => {
    // 위 "Happy" 케이스는 CLI→control 큐→같은 인스턴스의 드레인 루프 라는 단일 SessionManager
    // 구조라 실제 경쟁(다른 writer)이 재현되지 않는다(test-report.md 판별력 공백 관측·GAP-020 인접
    // — coverage-gap.md SC-058 항목). 여기서는 같은 base/vaultRoot 를 공유하는 **독립된 두
    // SessionManager 인스턴스**(A=오래된 in-memory 상태를 쥔 프로세스, B=먼저 stop 을 반영한
    // 프로세스)로 진짜 되쓰기 경쟁을 만든다. CAS(`persist()` 의 diskRev>memRev 흡수)가 없으면
    // A 가 자신의 stale "active" 레코드를 그대로 써 B 의 stop 결과를 지운다 — 있으면 A 의 쓰기가
    // disk 상태를 흡수해 stopped 로 수렴한다.
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const sessionManagerMod = await import("../../src/core/session-manager.js");
    const depsA = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
    const a = sessionManagerMod.createSessionManager(depsA);
    bindSessionManager(depsA, a);
    await a.load();
    const created = await a.create({ engine: "acp" });

    // B: 별도 인스턴스가 같은 세션을 로드해 stop 을 반영 — disk rev 가 A 의 in-memory rev 를
    // 앞지른다(A 는 이 시점 이후로도 갱신을 모른다 — reload 를 유발하는 어떤 호출도 안 한다).
    const depsB = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
    const b = sessionManagerMod.createSessionManager(depsB);
    bindSessionManager(depsB, b);
    await b.load();
    await b.stop(created.sid, { reason: "witness", source: "cli" });
    expect(b.get(created.sid)?.status).toBe("stopped");

    // A 는 여전히 stale "active" 를 메모리에 쥐고 있다 — registerBinding 은 disk 를 재조회하지
    // 않고 A 의 현재 in-memory 레코드를 그대로 persist() 에 넘긴다(CAS 관통 지점).
    expect(a.get(created.sid)?.status).toBe("active");
    await a.registerBinding(created.sid, { surface: "witness", address: "x", sid: created.sid });

    // CAS 가 살아있으면 A 의 쓰기가 disk 의 더 높은 rev(stopped)를 흡수해 자신도 stopped 로
    // 수렴한다 — CAS 가 제거되면 A 가 stale "active" 를 그대로 써 B 의 stop 이 사라진다.
    expect(a.get(created.sid)?.status).toBe("stopped");
    const sessionStore = await import("../../src/core/session-store.js");
    const onDisk = (await sessionStore.loadSessions(roots.base, PROJ)).find(
      (r) => r.sid === created.sid,
    );
    expect(onDisk?.status).toBe("stopped");
  }, 12000);

  it("Edge: 데몬 없음(드레인 루프 미기동) → CLI 가 회수 후 직접 적용해 성공한다", async () => {
    const { sm } = await makeDaemonSM();
    const created = await sm.create({ engine: "acp" });
    // startDrainLoop 를 부르지 않는다 — 데몬이 claim 하지 않으므로 CLI 가 회수(unclaimed) 판정 후
    // 직접 적용해야 한다(design.md §4 3-b 분기). 성공 여부는 레코드 파일 자체로 관측한다.
    const { code } = await runSessionCli(["stop", PROJ, created.sid]);
    expect(code).toBe(0);
    const sessionStore = await import("../../src/core/session-store.js");
    const rec = (await sessionStore.loadSessions(roots.base, PROJ)).find(
      (r) => r.sid === created.sid,
    );
    expect(rec?.status).toBe("stopped");
  }, 12000);
});
