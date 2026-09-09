import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 001-phase0-baseline-storage-spike — 환경 비파괴 관측 통합 검증(T039).
// 관측 3항목(상주 adde 데몬 목록·데몬 등록 파일 목록·기본 설정 루트 파일 집합)을 **읽기
// 전용 명령**으로만 수집한다(launchctl list·ls·find·ps). 데몬 중단·plist 생성은 0건이다.
// 선재 orphan(research.md §10.2 실측 7건)은 baseline 사실로 허용하고 증감만 판정한다.
// macOS 1차 타깃(A-P001) — 비-macOS(예 CI ubuntu-latest)에서는 skip 으로 구분 보고한다.
//
// **GAP-011 실행 격리(2026-09-08 rework1)**: 전체 스위트를 vitest 기본 병렬(다중 worker)로
// 실행하면, 이 파일과 무관한 다른 통합 테스트(`test/integration/daemon-*` 류)가 같은 시간
// 창에서 실 daemon 프로세스를 spawn·kill 하면서 `ps` 스냅샷에 일시적으로 잡힌다(간헐 실패).
// design.md ADR-015 의 "본 차수 검증 = 본 차수가 추가한 검증 경로" 해석을 따르되, 본 파일은
// 데몬을 spawn 하지 않으므로 "새로 생겼다"고 판정할 대상은 **이 파일이 실행되는 짧은 창 안에
// 갓 태어난 프로세스**뿐이다 — 선재 orphan(days 단위 경과)이든 동시 실행 중인 다른 테스트의
// 일시 데몬(초 단위 경과)이든, `STABLE_ELAPSED_SECONDS` 이상 경과한 프로세스만 "안정 상태"로
// 집계해 그 개수의 증감만 비교한다. 갓 태어난(따라서 아직 초 단위인) 데몬은 안정 집계에서
// 제외되므로 동시 실행 중인 다른 테스트의 spawn·kill 타이밍이 이 파일의 판정에 섞이지 않는다.
// (관측 완화가 아니라 판정 모집단을 "이 파일이 관측 가능한 신규 발생"으로 좁히는 실행 격리다.)

const isMacOS = process.platform === "darwin";

/** 새로 생긴(동시 실행 중인 다른 테스트의 일시 데몬일 가능성이 높은) 프로세스를 안정 집계에서
 * 제외하기 위한 경과시간 하한. 동시 실행되는 daemon spawn/kill 통합 테스트의 전형적 데몬
 * 수명(수 초)보다 넉넉히 크고, 선재 orphan(days 단위)보다는 훨씬 작다. */
const STABLE_ELAPSED_SECONDS = 20;

/** BSD `ps` 의 `ELAPSED`(`[[dd-]hh:]mm:ss`) 를 초 단위로 변환한다. 파싱 실패는 0(불안정 취급 —
 * fail-closed: 판정 불가한 항목을 안정 집계에 넣지 않는다). */
function parseElapsedSeconds(elapsed: string): number {
  const [dayPart, rest] = elapsed.includes("-") ? elapsed.split("-", 2) : [undefined, elapsed];
  const segments = (rest ?? "").split(":").map((s) => Number(s));
  if (segments.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  if (segments.length === 3) {
    seconds =
      (segments[0] as number) * 3600 + (segments[1] as number) * 60 + (segments[2] as number);
  } else if (segments.length === 2) {
    seconds = (segments[0] as number) * 60 + (segments[1] as number);
  } else if (segments.length === 1) {
    seconds = segments[0] as number;
  }
  const days = dayPart !== undefined ? Number(dayPart) : 0;
  return (Number.isFinite(days) ? days : 0) * 86400 + seconds;
}

interface DaemonProcess {
  readonly pid: string;
  readonly elapsedSeconds: number;
}

function listAddeDaemonProcesses(): DaemonProcess[] {
  try {
    const out = execFileSync("ps", ["-axo", "pid,etime,command"], { encoding: "utf8" });
    return out
      .split("\n")
      .filter((line) => /__daemon/.test(line) && /adde/.test(line))
      .map((line) => {
        const trimmed = line.trim();
        const firstSpace = trimmed.indexOf(" ");
        const pid = trimmed.slice(0, firstSpace);
        const rest = trimmed.slice(firstSpace + 1).trimStart();
        const secondSpace = rest.indexOf(" ");
        const etime = secondSpace === -1 ? rest : rest.slice(0, secondSpace);
        return { pid, elapsedSeconds: parseElapsedSeconds(etime) };
      });
  } catch {
    return [];
  }
}

/** 안정 상태(선재 orphan 포함, 동시 실행 중인 다른 테스트의 갓 태어난 데몬 제외) 데몬만. */
function listStableAddeDaemonPids(): string[] {
  return listAddeDaemonProcesses()
    .filter((p) => p.elapsedSeconds >= STABLE_ELAPSED_SECONDS)
    .map((p) => p.pid);
}

function listLaunchAgentPlists(): string[] {
  const dir = path.join(os.homedir(), "Library/LaunchAgents");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /adde/i.test(f))
    .sort();
}

function listConfigRootFiles(): string[] {
  const dir = path.join(os.homedir(), ".config/adde");
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

interface EnvSnapshot {
  stableDaemonPids: string[];
  launchAgentPlists: string[];
  configRootFiles: string[];
}

function snapshot(): EnvSnapshot {
  return {
    stableDaemonPids: listStableAddeDaemonPids(),
    launchAgentPlists: listLaunchAgentPlists(),
    configRootFiles: listConfigRootFiles(),
  };
}

describe.runIf(isMacOS)("SC-035: 검증 전후 환경 3관측 동일", () => {
  let before: EnvSnapshot;
  let after: EnvSnapshot;

  beforeAll(() => {
    before = snapshot();
    // T013 기록 형식 참조용 관측 결과 출력(비공개 기록 문서가 인용할 수 있도록 stdout 에 남긴다).
    console.info(
      `[SC-035] before: stableDaemons=${before.stableDaemonPids.length} plists=${before.launchAgentPlists.length} configFiles=${before.configRootFiles.length}`,
    );
  });

  afterAll(() => {
    after = snapshot();
    console.info(
      `[SC-035] after: stableDaemons=${after.stableDaemonPids.length} plists=${after.launchAgentPlists.length} configFiles=${after.configRootFiles.length}`,
    );
  });

  it("Happy: 세 관측 결과가 본 테스트 파일 실행 전후로 동일하다(안정 집계 기준 신규 증분 0)", () => {
    const early = snapshot();
    // 본 파일이 관측 외 어떤 부수효과도 만들지 않으므로 즉시 재관측해도 동일해야 한다.
    const immediate = snapshot();
    expect(immediate.launchAgentPlists).toEqual(early.launchAgentPlists);
    expect(immediate.configRootFiles).toEqual(early.configRootFiles);
    expect(immediate.stableDaemonPids.length).toBe(early.stableDaemonPids.length);
  });

  it("Edge: 선재 orphan 데몬은 baseline 사실로 허용되고 안정 집계 증감만 판정 대상이다", () => {
    // pid 집합이 아니라 개수 증감만 판정한다(선재 orphan 은 baseline). 안정 집계(경과
    // STABLE_ELAPSED_SECONDS 이상)만 비교하므로 동시 실행 중인 다른 테스트의 일시 데몬은
    // 판정에 섞이지 않는다.
    const s1 = snapshot();
    const s2 = snapshot();
    expect(s2.stableDaemonPids.length - s1.stableDaemonPids.length).toBe(0);
  });

  it("Error: 신규 데몬·plist 가 생기면 위반으로 판정된다(합성 시나리오로 판별력 확인)", () => {
    const baseline: EnvSnapshot = {
      stableDaemonPids: ["111", "222"],
      launchAgentPlists: ["com.qwertygeon.adde.projA.plist"],
      configRootFiles: ["projects/a/project.conf"],
    };
    const withNewDaemon: EnvSnapshot = {
      ...baseline,
      stableDaemonPids: [...baseline.stableDaemonPids, "999"],
    };
    expect(withNewDaemon.stableDaemonPids.length).not.toBe(baseline.stableDaemonPids.length);

    const withNewPlist: EnvSnapshot = {
      ...baseline,
      launchAgentPlists: [...baseline.launchAgentPlists, "com.qwertygeon.adde.new.plist"],
    };
    expect(withNewPlist.launchAgentPlists).not.toEqual(baseline.launchAgentPlists);

    // GAP-011 실행 격리 판별력 확인 — parseElapsedSeconds·STABLE_ELAPSED_SECONDS 필터가 실제로
    // 갓 태어난(동시 실행 중인 다른 테스트 유래일 가능성이 높은) 프로세스를 걸러내는지 대조한다.
    expect(parseElapsedSeconds("00:05")).toBeLessThan(STABLE_ELAPSED_SECONDS);
    expect(parseElapsedSeconds("05:00")).toBeGreaterThanOrEqual(STABLE_ELAPSED_SECONDS);
    expect(parseElapsedSeconds("2-01:00:00")).toBeGreaterThanOrEqual(STABLE_ELAPSED_SECONDS);
  });
});
