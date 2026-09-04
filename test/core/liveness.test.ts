import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { makeManualScheduler } from "../helpers/manual-scheduler.js";

// SC-005(FR-005)·SC-017(NFR-001)·SC-002 Error(FR-002) 단위 검증 — core/liveness.ts(신규)와
// core/runtime-state.ts(판독 계약 확장)를 대상으로 한다. PPG-1 병렬 중 두 모듈 모두 아직 착지
// 전일 수 있으므로 소스 import 는 각 it() 내부에서 지연 수행해 개별 테스트 단위로 격리한다
// (PROC-R15 — 미착지 참조로 인한 파일 전체 수집 붕괴 방지). 실 프로세스 관통 경로(기록·정상
// 종료 시 제거·SC-001/003/004)는 test/integration/daemon-liveness-spawn.test.ts 가 담당한다
// (NFR-005 — 본 파일은 순수 함수·주입 더블 단위 검증에 한정).

async function loadLiveness() {
  return import("../../src/core/liveness.js");
}
async function loadRuntimeState() {
  return import("../../src/core/runtime-state.js");
}
async function loadPaths() {
  return import("../../src/shared/paths.js");
}

describe("SC-005: 라이브니스 기록·갱신 실패가 상주를 중단시키지 않고 경고로 표면화된다", () => {
  it("Happy: 기록 쓰기 실패에도 상주 핸들이 반환되고 경고가 1건 발신된다", async () => {
    const { startLiveness } = await loadLiveness();
    const { projectPaths } = await loadPaths();
    const warn = vi.fn();
    const scheduler = makeManualScheduler();
    const handle = await startLiveness({
      proj: "p1",
      paths: projectPaths(os.tmpdir(), "adde-liveness-sc005-happy-noop"),
      warn,
      write: () => Promise.reject(new Error("EACCES")),
      scheduler,
    });
    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe("function");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("EACCES");
  });

  it("Edge: 쓰기 불가 권한 경로(실 FS)에서도 예외가 전파되지 않는다", async () => {
    const { startLiveness } = await loadLiveness();
    const { projectPaths } = await loadPaths();
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-liveness-sc005-edge-"));
    const proj = "p1";
    const pp = projectPaths(tmpBase, proj);
    fs.mkdirSync(pp.root, { recursive: true });
    fs.chmodSync(pp.root, 0o500); // 쓰기 불가 — runtimeDir 생성이 EACCES 로 실패한다.
    const warn = vi.fn();
    const scheduler = makeManualScheduler();
    try {
      const handle = await startLiveness({ proj, paths: pp, warn, scheduler });
      expect(handle).toBeDefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      fs.chmodSync(pp.root, 0o700);
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("Error: 기록·갱신·제거 3종 실패 모두 경고로 표면화되고 무음 흡수가 0건이다", async () => {
    const { startLiveness } = await loadLiveness();
    const { projectPaths } = await loadPaths();
    const warn = vi.fn();
    const scheduler = makeManualScheduler();
    const handle = await startLiveness({
      proj: "p1",
      paths: projectPaths(os.tmpdir(), "adde-liveness-sc005-error-noop"),
      warn,
      write: () => Promise.reject(new Error("write-fail")),
      touch: () => Promise.reject(new Error("touch-fail")),
      remove: () => Promise.reject(new Error("remove-fail")),
      scheduler,
    });
    expect(warn).toHaveBeenCalledTimes(1); // write 실패
    scheduler.fireAll();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2)); // touch 실패
    await handle.stop();
    expect(warn).toHaveBeenCalledTimes(3); // remove 실패
    await handle.stop(); // 2회 호출은 무동작(멱등) — 경고 재발신 없음
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe("SC-017: 갱신 주기·응답 없음 임계 상수와 판정", () => {
  it("Happy: 임계 미만은 상주 중, 초과는 응답 없음으로 판정된다", async () => {
    const { livenessOf, HEARTBEAT_STALE_MS } = await loadRuntimeState();
    const now = 1_000_000_000;
    const info = { v: 1 as const, pid: process.pid, startedAt: new Date(now).toISOString() };
    const under = livenessOf(
      { kind: "ok", info, mtimeMs: now - (HEARTBEAT_STALE_MS - 1_000) },
      { now },
    );
    const over = livenessOf(
      { kind: "ok", info, mtimeMs: now - (HEARTBEAT_STALE_MS + 1_000) },
      { now },
    );
    expect(under).toBe("running");
    expect(over).toBe("stale");
  });

  it("Edge: 경과가 임계와 정확히 같으면 상주 중이다(엄격 초과만 stale)", async () => {
    const { livenessOf, HEARTBEAT_STALE_MS } = await loadRuntimeState();
    const now = 1_000_000_000;
    const info = { v: 1 as const, pid: process.pid, startedAt: new Date(now).toISOString() };
    const exact = livenessOf({ kind: "ok", info, mtimeMs: now - HEARTBEAT_STALE_MS }, { now });
    expect(exact).toBe("running");
  });

  it("Error: 상수는 60초·180초로 고정되고 env 오버라이드가 기본값을 바꾸지 않는다", async () => {
    const { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, resolveHeartbeatIntervalMs } =
      await loadRuntimeState();
    expect(HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(HEARTBEAT_STALE_MS).toBe(180_000);
    expect(resolveHeartbeatIntervalMs({})).toBe(60_000);
    expect(resolveHeartbeatIntervalMs({ ADDE_HEARTBEAT_INTERVAL_MS: "abc" })).toBe(60_000);
    expect(resolveHeartbeatIntervalMs({ ADDE_HEARTBEAT_INTERVAL_MS: "0" })).toBe(60_000);
    expect(resolveHeartbeatIntervalMs({ ADDE_HEARTBEAT_INTERVAL_MS: "-1" })).toBe(60_000);
  });
});

describe("SC-002 (Error): 갱신 실패가 반복돼도 타이머가 죽지 않고 매회 경고한다", () => {
  it("Error: touch 가 항상 실패해도 3회 모두 경고하고 예외가 전파되지 않는다", async () => {
    const { startLiveness } = await loadLiveness();
    const { projectPaths } = await loadPaths();
    const warn = vi.fn();
    const scheduler = makeManualScheduler();
    const handle = await startLiveness({
      proj: "p1",
      paths: projectPaths(os.tmpdir(), "adde-liveness-sc002-error-noop"),
      warn,
      write: () => Promise.resolve(),
      touch: () => Promise.reject(new Error("touch-always-fails")),
      scheduler,
    });
    expect(warn).toHaveBeenCalledTimes(0); // write 성공 — 아직 경고 없음

    scheduler.fireAll();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    scheduler.fireAll();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    scheduler.fireAll();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(3));

    await expect(handle.stop()).resolves.toBeUndefined();
  });
});

describe("GAP-009: 판독 스키마가 정수·양수만 pid 로 통과시킨다", () => {
  // process.kill(0, 0)·process.kill(-1, 0) 은 둘 다 예외 없이 반환한다(POSIX 의미상 프로세스
  // 그룹·전체 대상 — main 실측). 소수(pid: 1.5)도 유효한 pid 가 아니다. 검증이 `typeof
  // number` 뿐이면 이 세 값 모두 통과해 손상된 기록이 "상주 중"으로 위장된다 — 판정 불가로
  // 접혀야 한다.
  async function writeRuntimeJson(tmpBase: string, proj: string, content: string): Promise<void> {
    const { projectPaths } = await loadPaths();
    const pp = projectPaths(tmpBase, proj);
    fs.mkdirSync(path.dirname(pp.runtimeJson), { recursive: true });
    fs.writeFileSync(pp.runtimeJson, content);
  }

  it.each([
    ["0(무효 pid)", 0],
    ["음수(-1)", -1],
    ["소수(1.5)", 1.5],
  ])("Error: pid 가 %s 인 기록은 판정 불가(unreadable/schema)로 접힌다", async (_label, pid) => {
    const { readRuntime } = await loadRuntimeState();
    const { projectPaths } = await loadPaths();
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-runtime-gap009-"));
    try {
      const proj = "p1";
      await writeRuntimeJson(
        tmpBase,
        proj,
        JSON.stringify({ v: 1, pid, startedAt: new Date().toISOString() }),
      );
      const read = await readRuntime(projectPaths(tmpBase, proj));
      expect(read.kind).toBe("unreadable");
      if (read.kind === "unreadable") expect(read.reason).toBe("schema");
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("Happy: pid 가 유효한 양의 정수(현재 프로세스 pid)면 판독이 ok 로 성립한다", async () => {
    const { readRuntime } = await loadRuntimeState();
    const { projectPaths } = await loadPaths();
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-runtime-gap009-happy-"));
    try {
      const proj = "p1";
      await writeRuntimeJson(
        tmpBase,
        proj,
        JSON.stringify({ v: 1, pid: process.pid, startedAt: new Date().toISOString() }),
      );
      const read = await readRuntime(projectPaths(tmpBase, proj));
      expect(read.kind).toBe("ok");
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
