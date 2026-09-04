import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeSessionRecordFixture } from "../helpers/session-record-fixture.js";
import type { SessionRecord } from "../../src/core/session-store.js";

// SC-009(FR-009)·SC-010(FR-010)·SC-011(FR-011·NFR-004)·SC-020(NFR-004) — 판정(경고·종료코드·
// --json)이 표시 필터 이전 전체 집합에서 산출되고, 종료코드 계약(6구성)이 성립하며, 기계 판독
// 출력이 기존 필드·스키마 버전을 보존한 채 additive 로 확장된다. 격리 ADDE_HOME tmp(선례
// status-warnings.test.ts).

let tmpHome: string;
const origHome = process.env["ADDE_HOME"];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "adde-status-full-set-"));
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

async function writeSession(
  proj: string,
  sid: string,
  overrides: Partial<SessionRecord> = {},
): Promise<void> {
  const store = await import("../../src/core/session-store.js");
  await store.saveSession(base(), proj, makeSessionRecordFixture(sid, overrides));
}

interface Captured {
  out: string;
  err: string;
  code: number;
}

async function captureStatus(args: string[]): Promise<Captured> {
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
  const code = await ops.runStatus(args);
  return { out, err, code };
}

describe("SC-009: 프로젝트 미지정 조회에서 죽은 세션이 경고·기계 판독에 나타난다", () => {
  it("Happy: 죽은 세션 1건이 경고·기계 판독 출력에 나타난다", async () => {
    await writeProject("sc009-p1");
    await writeSession("sc009-p1", "sid-dead", { status: "detached" });

    const { err, out } = await captureStatus([]);
    expect(err).toContain("sid-dead");

    const jsonResult = await captureStatus(["--json"]);
    const parsed = JSON.parse(jsonResult.out) as { sessions: Array<{ sid: string }> };
    expect(parsed.sessions.some((s) => s.sid === "sid-dead")).toBe(true);
    void out;
  });

  it("Edge: 표 본문에는 필터가 적용되지만(허용) 경고에는 표시된다", async () => {
    await writeProject("sc009-p2");
    await writeSession("sc009-p2", "sid-dead2", { status: "detached" });
    const { out, err } = await captureStatus([]);
    // 표 본문에는 나타나지 않아도 되지만(허용), stderr 경고에는 반드시 나타난다.
    expect(err).toContain("sid-dead2");
    void out;
  });

  it("Error: --all 유무가 경고·종료코드·기계 판독을 바꾸지 않는다(표시에만 영향)", async () => {
    await writeProject("sc009-p3");
    await writeSession("sc009-p3", "sid-dead3", { status: "detached" });

    const withoutAll = await captureStatus(["--json"]);
    const withAll = await captureStatus(["--json", "--all"]);
    const parsedWithout = JSON.parse(withoutAll.out) as { sessions: unknown[] };
    const parsedWith = JSON.parse(withAll.out) as { sessions: unknown[] };
    expect(parsedWithout.sessions).toEqual(parsedWith.sessions);
    expect(withoutAll.code).toBe(withAll.code);
  });
});

describe("SC-010: 종료코드 계약(6구성)이 성립한다", () => {
  it("Happy: 죽은 세션·자가정지·비정상 종료·응답 없음 네 구성이 모두 실패 종료코드다", async () => {
    const deadPid = await findDeadPid();

    await writeProject("sc010-detached");
    await writeSession("sc010-detached", "sid-x", { status: "detached" });
    const detachedResult = await captureStatus(["sc010-detached"]);
    expect(detachedResult.code).toBe(1);

    await writeProject("sc010-halt");
    const { daemonHaltPath } = await import("../../src/shared/paths.js");
    fs.mkdirSync(path.dirname(daemonHaltPath(base(), "sc010-halt")), { recursive: true });
    fs.writeFileSync(
      daemonHaltPath(base(), "sc010-halt"),
      JSON.stringify({ reason: "x", haltedAt: new Date().toISOString(), consecutiveShortLived: 5 }),
    );
    const haltResult = await captureStatus(["sc010-halt"]);
    expect(haltResult.code).toBe(1);

    await writeProject("sc010-dead-daemon");
    writeRuntimeRecord("sc010-dead-daemon", deadPid);
    const deadDaemonResult = await captureStatus(["sc010-dead-daemon"]);
    expect(deadDaemonResult.code).toBe(1);

    await writeProject("sc010-stale-daemon");
    writeRuntimeRecord("sc010-stale-daemon", process.pid);
    const past = new Date(Date.now() - 200_000);
    fs.utimesSync(runtimeJsonPath("sc010-stale-daemon"), past, past);
    const staleDaemonResult = await captureStatus(["sc010-stale-daemon"]);
    expect(staleDaemonResult.code).toBe(1);
  });

  it("Edge: 미기동 + 죽은 세션·자가정지 없음(유일한 정상 구성) → exit 0", async () => {
    await writeProject("sc010-normal");
    await writeSession("sc010-normal", "sid-ok", { status: "active" });
    const result = await captureStatus(["sc010-normal"]);
    expect(result.code).toBe(0);
  });

  it("Error: 판독 불가(⑥)도 실패 종료코드이며 표면화가 동반된다(다른 구성 판정은 불변)", async () => {
    await writeProject("sc010-unreadable");
    writeRuntimeRecord("sc010-unreadable", 0, "not json");
    const result = await captureStatus(["sc010-unreadable"]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/판정 불가|undeterminable/);
    expect(result.err.length).toBeGreaterThan(0); // 조치 안내 1건 이상

    // ⑥ 이 추가돼도 다른 구성(정상 구성)의 판정은 달라지지 않는다.
    await writeProject("sc010-normal-2");
    await writeSession("sc010-normal-2", "sid-ok2", { status: "active" });
    const normalResult = await captureStatus(["sc010-normal-2"]);
    expect(normalResult.code).toBe(0);
  });

  // GAP-010 — 프로젝트 미지정(집계) 분기의 종료코드를 값으로 고정한다. 기존 케이스는 이 분기를
  // 두 출력(--all 유무)의 동치 비교로만 확인해, 판정 입력을 필터 이전 전체 집합(allRows)에서
  // 필터 결과(displayRows)로 되돌리는 회귀(=본 차수가 고친 원 결함)를 넣어도 양쪽이 함께
  // 0 이 되어 통과했다(판별력 0). 아래 3건은 집계 분기 하나만 놓고 종료코드 값을 직접 고정한다.
  it("집계 분기 값 고정: 죽은 세션 1건 존재 → 실패 종료코드", async () => {
    await writeProject("sc010-agg-dead");
    await writeSession("sc010-agg-dead", "sid-agg-dead", { status: "detached" });
    const result = await captureStatus([]);
    expect(result.code).toBe(1);
  });

  it("집계 분기 값 고정: 손상된 라이브니스 기록 존재(+ 죽은 세션·자가정지 없음) → 실패 종료코드", async () => {
    await writeProject("sc010-agg-unreadable");
    await writeSession("sc010-agg-unreadable", "sid-agg-ok", { status: "active" });
    writeRuntimeRecord("sc010-agg-unreadable", 0, "not json");
    const result = await captureStatus([]);
    expect(result.code).toBe(1);
  });

  it("집계 분기 값 고정: 정상 구성 → 정상 종료코드", async () => {
    await writeProject("sc010-agg-normal");
    await writeSession("sc010-agg-normal", "sid-agg-normal", { status: "active" });
    const result = await captureStatus([]);
    expect(result.code).toBe(0);
  });
});

const SESSION_FIELDS = [
  "sid",
  "status",
  "engine",
  "engineRef",
  "title",
  "lastActivityAt",
  "enginePresent",
  "warnings",
];
const TOP_LEVEL_FIELDS_BEFORE = ["v", "sessions", "halt"];

describe("SC-011: 기계 판독 출력이 additive 로 확장되며 기존 필드를 보존한다", () => {
  it("Happy: 스키마 버전이 같고 기존 세션 필드가 전건 보존되며 daemon 이 추가된다", async () => {
    await writeProject("sc011-p1");
    await writeSession("sc011-p1", "sid-warn", { warnings: ["x"] });
    const { out } = await captureStatus(["sc011-p1", "--json"]);
    const parsed = JSON.parse(out) as {
      v: number;
      sessions: Array<Record<string, unknown>>;
      daemon: unknown;
    };
    expect(parsed.v).toBe(1);
    const row = parsed.sessions.find((s) => s["sid"] === "sid-warn")!;
    for (const field of SESSION_FIELDS) expect(row).toHaveProperty(field);
    expect(parsed.daemon).toBeDefined();
  });

  it("Edge: 프로젝트 미지정 출력도 기존 필드를 보존하고 daemon 맵을 추가한다", async () => {
    await writeProject("sc011-p2");
    await writeSession("sc011-p2", "sid-any", {});
    const { out } = await captureStatus(["--json"]);
    const parsed = JSON.parse(out) as { sessions: unknown[]; halt: unknown; daemon: unknown };
    expect(parsed.sessions).toBeDefined();
    expect(parsed.halt).toBeDefined();
    expect(parsed.daemon).toBeDefined();
    expect(typeof parsed.daemon).toBe("object");
  });

  it("Error: 판독 불가 구성에서도 출력 스키마가 깨지지 않는다", async () => {
    await writeProject("sc011-p3");
    writeRuntimeRecord("sc011-p3", 0, "not json");
    const { out } = await captureStatus(["sc011-p3", "--json"]);
    const parsed = JSON.parse(out) as {
      daemon: {
        liveness: string;
        reason: string | null;
        pid: unknown;
        startedAt: unknown;
        heartbeatAt: unknown;
      };
    };
    expect(parsed.daemon.liveness).toBe("unreadable");
    expect(["malformed", "schema"]).toContain(parsed.daemon.reason);
    expect(parsed.daemon.pid).toBeNull();
    expect(parsed.daemon.startedAt).toBeNull();
    expect(parsed.daemon.heartbeatAt).toBeNull();
  });
});

// GAP-014 — 기존 소비자 계약(SC-011·SC-012·SC-020, FR-011·NFR-004)을 필드 "존재" 만이 아니라
// "형태" 로 고정한다. 존재만 확인하는 단언(`toHaveProperty`/`toBeDefined`)은 `halt` 필드가
// 기준 커밋의 `HaltRecord | null` 에서 판별 유니온(`{kind, record?, reason?}`)으로 바뀌어도
// 통과했다(GAP-014 원 결함 — 기존 소비자의 `if (data.halt)` 패턴을 깬다). 아래 케이스는 그
// 회귀를 직접 재현·검출한다.
const TOP_LEVEL_FIELDS_WITH_DAEMON = [...TOP_LEVEL_FIELDS_BEFORE, "daemon"];

describe("GAP-014: 기계 출력 halt 필드 형태 보존 + 판독 불가 신규 필드(SC-011·SC-020 보강)", () => {
  it("형태 고정: 자가정지 기록 없음 → 단일 프로젝트 halt 필드가 null 이다(존재 확인만으로는 불충분)", async () => {
    await writeProject("gap014-p1");
    await writeSession("gap014-p1", "sid-1", {});
    const { out } = await captureStatus(["gap014-p1", "--json"]);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    // 판별력: 기준 커밋 형태는 `null`. GAP-014 원 결함은 `{kind:"absent"}` 객체를 실어
    // `toBeDefined()`/`toHaveProperty("halt")` 는 통과하지만 `if (data.halt)` 소비자를 깬다.
    expect(parsed["halt"]).toBeNull();
  });

  it("형태 고정: 자가정지 기록 없음 → 집계(프로젝트 미지정) halt 맵의 각 값도 null 이다", async () => {
    await writeProject("gap014-agg1");
    await writeSession("gap014-agg1", "sid-agg-1", {});
    const { out } = await captureStatus(["--json"]);
    const parsed = JSON.parse(out) as { halt: Record<string, unknown> };
    expect(parsed.halt["gap014-agg1"]).toBeNull();
  });

  it("additive 불변 + 신규 필드: 자가정지 기록 판독 불가에도 기존 halt 필드 형태가 유지되고 판독 불가 사실은 신규 최상위 필드로만 나타난다", async () => {
    await writeProject("gap014-p2");
    await writeSession("gap014-p2", "sid-2", {});
    const { daemonHaltPath } = await import("../../src/shared/paths.js");
    fs.mkdirSync(path.dirname(daemonHaltPath(base(), "gap014-p2")), { recursive: true });
    fs.writeFileSync(daemonHaltPath(base(), "gap014-p2"), "not json");

    const { out } = await captureStatus(["gap014-p2", "--json"]);
    const parsed = JSON.parse(out) as Record<string, unknown>;

    // 기존 필드는 자가정지 판독 불가에도 이전 형태(HaltRecord | null)를 유지한다 — 판독 불가라는
    // 사실 자체는 이 필드에 싣지 않는다(GAP-014 결정).
    expect(parsed["halt"]).toBeNull();

    // 판독 불가 사실은 "추가만" 허용되는 신규 최상위 필드로 표면화되어야 한다(NFR-004 additive
    // 계약). 신규 필드의 정확한 이름은 저술 시점에 미확정이므로 이름을 하드코딩하지 않고
    // "이미 알려진 키(v·sessions·halt·daemon) 밖의 신규 키가 최소 1개 존재 + 그 값이 null 이
    // 아니다(무언가를 실제로 실어나른다)" 로 판정한다.
    const addedTop = Object.keys(parsed).filter((k) => !TOP_LEVEL_FIELDS_WITH_DAEMON.includes(k));
    expect(addedTop.length).toBeGreaterThanOrEqual(1);
    expect(addedTop.some((k) => parsed[k] !== null && parsed[k] !== undefined)).toBe(true);
  });
});

// GAP-014 재작업(run-015) — main 실행 확인: 기록 없음 구성 최상위 키는 daemon·halt·
// haltUnreadable·sessions·v(halt=null, v=1 불변). 사용자 결정(gaps.md GAP-014)으로 승인된
// 추가 집합은 정확히 이 2종(daemon·haltUnreadable) — 임의 신규 키를 허용하는 방향(키 검사
// 제거)이 아니라 허용 집합을 명시적으로 확장한다.
const TOP_LEVEL_FIELDS_ADDED = ["daemon", "haltUnreadable"];

describe("SC-020: 기계 판독 스키마가 비파괴로 진화한다", () => {
  it("Happy: 변경 전 최상위 필드가 모두 존재하고 스키마 버전이 같다", async () => {
    await writeProject("sc020-p1");
    await writeSession("sc020-p1", "sid-1", {});
    const { out } = await captureStatus(["sc020-p1", "--json"]);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    for (const field of TOP_LEVEL_FIELDS_BEFORE) expect(parsed).toHaveProperty(field);
    expect(parsed["v"]).toBe(1);
  });

  it("Edge: 변경 전후 차이가 승인된 추가 필드(daemon·haltUnreadable)뿐이다", async () => {
    await writeProject("sc020-p2");
    await writeSession("sc020-p2", "sid-2", {});
    const { out } = await captureStatus(["sc020-p2", "--json"]);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const topKeys = new Set(Object.keys(parsed));
    const addedTop = [...topKeys].filter((k) => !TOP_LEVEL_FIELDS_BEFORE.includes(k));
    expect(addedTop.slice().sort()).toEqual([...TOP_LEVEL_FIELDS_ADDED].sort());

    const sessions = parsed["sessions"] as Array<Record<string, unknown>>;
    const sessionKeys = new Set(Object.keys(sessions[0] ?? {}));
    const addedSession = [...sessionKeys].filter((k) => !SESSION_FIELDS.includes(k));
    expect(addedSession).toEqual([]);
  });

  it("Error: 제거된 필드가 0건이다(변경 전 − 변경 후 = 공집합)", async () => {
    await writeProject("sc020-p3");
    await writeSession("sc020-p3", "sid-3", {});
    const { out } = await captureStatus(["sc020-p3", "--json"]);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const topKeys = new Set(Object.keys(parsed));
    const removedTop = TOP_LEVEL_FIELDS_BEFORE.filter((k) => !topKeys.has(k));
    expect(removedTop).toEqual([]);

    const sessions = parsed["sessions"] as Array<Record<string, unknown>>;
    const sessionKeys = new Set(Object.keys(sessions[0] ?? {}));
    const removedSession = SESSION_FIELDS.filter((k) => !sessionKeys.has(k));
    expect(removedSession).toEqual([]);
  });
});
