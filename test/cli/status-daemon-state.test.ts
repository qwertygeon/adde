import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeSessionRecordFixture } from "../helpers/session-record-fixture.js";

// SC-006(FR-006)·SC-007(FR-007)·SC-012(FR-012) — status 텍스트 모드가 데몬 4(+판정불가=5)상태를
// 구분해 표시하고, 이상 상태에 조치 안내를 동반하며, 손상된 라이브니스 기록이 "미기동"으로 접히지
// 않는다. 격리 ADDE_HOME tmp 픽스처(선례 status-warnings.test.ts) — 실 launchd·실 엔진 무접촉.
//
// core/diagnostics.ts 의 collectDaemonStatus·core/runtime-state.ts 의 RuntimeRead 판별 유니온은
// PPG-1 병렬 중 아직 착지 전일 수 있다 — 픽스처 구성에 쓰는 `isPidAlive`(미변경 export)만 지연
// import 하고, `runStatus`(ops.ts, 시그니처 불변)는 정적 import 로 둔다.

let tmpHome: string;
const origHome = process.env["ADDE_HOME"];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "adde-status-daemon-state-"));
  process.env["ADDE_HOME"] = path.join(tmpHome, "adde");
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  if (origHome === undefined) delete process.env["ADDE_HOME"];
  else process.env["ADDE_HOME"] = origHome;
  vi.restoreAllMocks();
});

function base(): string {
  return process.env["ADDE_HOME"]!;
}

function writeProject(proj: string): void {
  const vaultDir = path.join(tmpHome, `vault-${proj}`);
  fs.mkdirSync(vaultDir, { recursive: true });
  const projDir = path.join(base(), "projects", proj);
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, "project.conf"), `v=1\nvault=${vaultDir}\n`);
}

function runtimeJsonPath(proj: string): string {
  return path.join(base(), "projects", proj, "runtime", "runtime.json");
}

function writeRuntimeRecord(proj: string, pid: number, content?: string): void {
  const p = runtimeJsonPath(proj);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    content ?? JSON.stringify({ v: 1, pid, startedAt: new Date().toISOString() }),
  );
}

async function findDeadPid(): Promise<number> {
  const { isPidAlive } = await import("../../src/core/runtime-state.js");
  for (let candidate = 4_194_304; candidate < 4_194_304 + 5_000; candidate++) {
    if (!isPidAlive(candidate)) return candidate;
  }
  throw new Error("사용 가능한 죽은 pid 를 찾지 못함(테스트 환경 이상)");
}

async function captureStatus(args: string[]): Promise<{ out: string; err: string }> {
  const ops = await import("../../src/cli/ops.js");
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  await ops.runStatus(args);
  return { out, err };
}

function headerColumns(out: string): string[] {
  const firstLine = out.split("\n")[0] ?? "";
  return firstLine.split(/\s{2,}/).filter((c) => c.length > 0);
}

const EXPECTED_HEADER = ["SID", "STATUS", "ENGINE", "PRESENT", "WARN", "TITLE", "LAST_ACTIVITY"];

describe("SC-006: 상태 조회가 네 상태를 각각 구분해 표시하고 컬럼 구성은 불변이다", () => {
  it("Happy: 네 구성(기록 없음/생존/응답없음/비정상종료)이 서로 다른 데몬 상태 표기를 출력한다", async () => {
    const deadPid = await findDeadPid();

    await writeProject("sc006-stopped");
    // 기록 없음 — 미기동.

    await writeProject("sc006-running");
    writeRuntimeRecord("sc006-running", process.pid);

    await writeProject("sc006-stale");
    writeRuntimeRecord("sc006-stale", process.pid);
    const past = new Date(Date.now() - 200_000);
    fs.utimesSync(runtimeJsonPath("sc006-stale"), past, past);

    await writeProject("sc006-dead");
    writeRuntimeRecord("sc006-dead", deadPid);

    const stopped = await captureStatus(["sc006-stopped"]);
    const running = await captureStatus(["sc006-running"]);
    const stale = await captureStatus(["sc006-stale"]);
    const dead = await captureStatus(["sc006-dead"]);

    expect(stopped.out).toMatch(/미기동|not started/);
    expect(running.out).toMatch(/상주 중|running/);
    expect(stale.out).toMatch(/응답 없음|not responding/);
    expect(dead.out).toMatch(/비정상 종료|terminated abnormally/);

    const labels = [stopped.out, running.out, stale.out, dead.out];
    expect(new Set(labels).size).toBe(4); // 네 표기가 서로 다르다
  });

  it("Edge: 네 구성 모두 세션 표 헤더 컬럼 집합이 완전히 동일하다(추가·삭제 0)", async () => {
    const deadPid = await findDeadPid();
    const store = await import("../../src/core/session-store.js");

    const projs = [
      "sc006-edge-stopped",
      "sc006-edge-running",
      "sc006-edge-stale",
      "sc006-edge-dead",
    ];
    for (const proj of projs) {
      await writeProject(proj);
      // 헤더 행은 rows.length > 0 일 때만 렌더되므로(빈 프로젝트는 "(세션 없음)") 각 구성에
      // 세션 1건을 둔다 — 이 테스트의 관심사는 컬럼 집합이지 세션 유무가 아니다.
      await store.saveSession(base(), proj, makeSessionRecordFixture(`sid-${proj}`));
    }
    writeRuntimeRecord("sc006-edge-running", process.pid);
    writeRuntimeRecord("sc006-edge-stale", process.pid);
    const past = new Date(Date.now() - 200_000);
    fs.utimesSync(runtimeJsonPath("sc006-edge-stale"), past, past);
    writeRuntimeRecord("sc006-edge-dead", deadPid);

    for (const proj of projs) {
      const { out } = await captureStatus([proj]);
      const header = headerColumns(out);
      expect(new Set(header)).toEqual(new Set(EXPECTED_HEADER));
    }
  });

  it("Error: 세션 0개 프로젝트도 상태 줄이 누락되지 않는다", async () => {
    await writeProject("sc006-error-empty");
    const { out } = await captureStatus(["sc006-error-empty"]);
    expect(out).toContain("(세션 없음)");
    expect(out).toMatch(/미기동|not started/);
  });
});

describe("SC-007: 비정상 종료·응답 없음·크래시루프 자가정지에 조치 안내가 동반된다", () => {
  it("Happy: 비정상 종료 구성에 수행할 명령을 포함한 조치 안내가 출력된다", async () => {
    const deadPid = await findDeadPid();
    await writeProject("sc007-dead");
    writeRuntimeRecord("sc007-dead", deadPid);
    const { err } = await captureStatus(["sc007-dead"]);
    expect(err).toMatch(/adde down/);
    expect(err).toMatch(/adde up/);
  });

  it("Edge: 응답 없음 구성에 진단 명령을 포함한 조치 안내가 출력된다", async () => {
    await writeProject("sc007-stale");
    writeRuntimeRecord("sc007-stale", process.pid);
    const past = new Date(Date.now() - 200_000);
    fs.utimesSync(runtimeJsonPath("sc007-stale"), past, past);
    const { err } = await captureStatus(["sc007-stale"]);
    expect(err).toMatch(/adde logs.*--daemon/);
    expect(err).toMatch(/adde restart/);
  });

  it("Error: 크래시루프 자가정지 기록에 재기동 조치 안내가 출력된다", async () => {
    await writeProject("sc007-halt");
    const { daemonHaltPath } = await import("../../src/shared/paths.js");
    const haltPath = daemonHaltPath(base(), "sc007-halt");
    fs.mkdirSync(path.dirname(haltPath), { recursive: true });
    fs.writeFileSync(
      haltPath,
      JSON.stringify({
        reason: "test-halt",
        haltedAt: new Date().toISOString(),
        consecutiveShortLived: 5,
      }),
    );
    const { err } = await captureStatus(["sc007-halt"]);
    expect(err).toMatch(/adde restart/);
  });
});

describe("SC-012: 손상된 라이브니스 기록이 미기동으로 접히지 않는다", () => {
  it("Happy: 판독 불가 기록이 판정 불가로 표기된다", async () => {
    await writeProject("sc012-unreadable");
    writeRuntimeRecord("sc012-unreadable", 0, "not json");
    const { out } = await captureStatus(["sc012-unreadable"]);
    expect(out).toMatch(/판정 불가|undeterminable/);
    expect(out).not.toMatch(/미기동|not started/);
  });

  it("Edge: 스키마 불일치(pid 비수치)도 판정 불가로 표기되고 사유가 구분된다", async () => {
    await writeProject("sc012-schema");
    writeRuntimeRecord("sc012-schema", 0, JSON.stringify({ v: 1, pid: "x" }));
    const { out, err } = await captureStatus(["sc012-schema"]);
    expect(out).toMatch(/판정 불가|undeterminable/);
    expect(out + err).toMatch(/schema/);
  });

  it("Error: 사유는 출력되지만 파일 내용은 유출되지 않는다", async () => {
    await writeProject("sc012-leak");
    writeRuntimeRecord("sc012-leak", 0, "not json — LEAKCANARY-SECRET-TOKEN");
    const { out, err } = await captureStatus(["sc012-leak"]);
    expect(out + err).not.toContain("LEAKCANARY-SECRET-TOKEN");
    expect(out).toMatch(/판정 불가|undeterminable/);
  });
});
