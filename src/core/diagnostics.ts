/**
 * 운영 가시성 — status / doctor / logs 의 코어 로직(읽기 전용, 부수효과 없음).
 * CLI 계층(cli/ops.ts)이 결과를 표/JSON/텍스트로 표면화한다.
 */
import { t } from "../shared/i18n.js";
import { readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { laneList, resolveFileMode } from "./lane-config.js";
import { resolveAdapterBin } from "./supervisor.js";
import { readRuntime, livenessOf } from "./runtime-state.js";
import type { Liveness } from "./runtime-state.js";
import { lanePaths, defaultBase, expandTilde, isSafeSegment } from "../shared/paths.js";
import { parseLaneConf } from "../shared/conf.js";
import { daemonRegState, daemonEntryPath } from "./launchd.js";
import type { LaunchctlExec } from "./launchd.js";

export interface DiagBaseOptions {
  /** 설정 base 경로(테스트 override). 미지정 시 $ADDE_HOME 또는 ~/.config/adde. */
  base?: string;
  /**
   * launchctl 실행자 주입(테스트용 fake). 미주입 시 실 launchctl 호출.
   * doctor daemon 점검이 CI에서 실 launchctl 을 때리지 않도록 주입 가능 구조로.
   */
  launchctlExec?: LaunchctlExec;
}

// ── status ──────────────────────────────────────────────────────────────

/** 레인 1개의 상태 행. */
export interface LaneStatusRow {
  lane: string;
  status: Liveness;
  pid: number | null;
  sessionId: string | null;
  source: string | null;
  backend: string | null;
  engine: string | null;
  startedAt: string | null;
  /** running 일 때 startedAt 기준 경과 ms(그 외 null). */
  uptimeMs: number | null;
  /** 마지막 하트비트 시각(runtime.json mtime) ISO. 파일 없거나 stat 실패 시 null. */
  lastSeenAt: string | null;
}

/**
 * proj 의 lanes.d 를 스캔해 각 레인의 라이브니스를 수집한다.
 * running(파일 있고 pid 생존)·dead(파일 있으나 pid 없음=크래시)·stopped(파일 없음).
 */
export async function collectStatus(
  proj: string,
  opts: DiagBaseOptions = {},
): Promise<LaneStatusRow[]> {
  const base = opts.base ?? defaultBase();
  const { lanes } = await laneList(proj, { base });
  const rows: LaneStatusRow[] = [];
  for (const lane of lanes) {
    const paths = lanePaths(base, proj, lane);
    const info = await readRuntime(paths);
    // 하트비트 신선도 — runtime.json mtime 을 stat. 실패(부재 등)면 미주입(pid-only 판정).
    let mtimeMs: number | undefined;
    if (info) {
      try {
        mtimeMs = (await stat(paths.runtimeJson)).mtimeMs;
      } catch {
        mtimeMs = undefined;
      }
    }
    const status = livenessOf(info, { mtimeMs });
    rows.push({
      lane,
      status,
      pid: info?.pid ?? null,
      sessionId: info?.sessionId ?? null,
      source: info?.source ?? null,
      backend: info?.backend ?? null,
      engine: info?.engine ?? null,
      startedAt: info?.startedAt ?? null,
      uptimeMs:
        status === "running" && info?.startedAt
          ? Math.max(0, Date.now() - Date.parse(info.startedAt))
          : null,
      lastSeenAt: mtimeMs !== undefined ? new Date(mtimeMs).toISOString() : null,
    });
  }
  return rows;
}

/** 집계 status 행 — 레인 상태에 소속 프로젝트를 부기(다중 프로젝트 뷰). */
export type AggregatedLaneStatusRow = LaneStatusRow & { proj: string };

/**
 * base 하위에서 lanes.d 를 가진 프로젝트 디렉터리를 열거한다(정렬).
 * 안전 세그먼트(경로 위생) 통과분만 — 비안전 이름은 조용히 제외(열거는 진단성 조회라 흡수).
 * base 부재 시 빈 배열.
 */
export async function listRegisteredProjects(opts: DiagBaseOptions = {}): Promise<string[]> {
  const base = opts.base ?? defaultBase();
  let names: string[];
  try {
    const entries = await readdir(base, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && isSafeSegment(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const projs: string[] = [];
  for (const name of names) {
    // lanes.d 를 가진 디렉터리만 프로젝트로 간주(state·queue 등 부속 디렉터리 제외).
    if (await pathExists(join(base, name, "lanes.d"))) projs.push(name);
  }
  return projs.sort();
}

/**
 * 전 프로젝트의 레인 상태를 집계한다(각 행에 proj 부기).
 * 인자 없는 `adde status` 의 다중 프로젝트 뷰용. 실행 중/전체 필터는 표면 계층(cli/ops)이 결정한다.
 */
export async function collectAllStatus(
  opts: DiagBaseOptions = {},
): Promise<AggregatedLaneStatusRow[]> {
  const base = opts.base ?? defaultBase();
  const projs = await listRegisteredProjects({ ...opts, base });
  const rows: AggregatedLaneStatusRow[] = [];
  for (const proj of projs) {
    const projRows = await collectStatus(proj, { ...opts, base });
    for (const r of projRows) rows.push({ ...r, proj });
  }
  return rows;
}

// ── doctor ──────────────────────────────────────────────────────────────

export type CheckLevel = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  name: string;
  level: CheckLevel;
  detail: string;
  /** 실패·경고 시 조치 힌트(액션형). PASS 에는 없음. */
  hint?: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 파일/디렉터리 권한 비트(mode & 0o777). 부재·stat 실패 시 null. */
async function modeOf(p: string): Promise<number | null> {
  try {
    return (await stat(p)).mode & 0o777;
  } catch {
    return null;
  }
}

/** 권한 비트 → 3자리 8진 문자열(예: 0o640 → "640"). */
function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * 상태 비의존 정적 점검. proj 미지정 시 전역 점검만, 지정 시 레인별 점검 추가.
 * 각 항목 PASS/WARN/FAIL + 실패·경고에 조치 힌트.
 */
export async function runDoctor(proj?: string, opts: DiagBaseOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const base = opts.base ?? defaultBase();

  // Node 버전 ≥ 22
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 22
      ? { name: t("doctor.node.name"), level: "PASS", detail: `v${process.versions.node} (≥22)` }
      : {
          name: t("doctor.node.name"),
          level: "FAIL",
          detail: `v${process.versions.node} (<22)`,
          hint: t("doctor.node.hint"),
        },
  );

  // 어댑터 바이너리 해석
  const adapterBin = resolveAdapterBin();
  checks.push(
    (await pathExists(adapterBin))
      ? { name: t("doctor.adapter.name"), level: "PASS", detail: adapterBin }
      : {
          name: t("doctor.adapter.name"),
          level: "FAIL",
          detail: t("doctor.adapter.missing", { path: adapterBin }),
          hint: t("doctor.adapter.hint"),
        },
  );

  // base 디렉터리 가독
  checks.push(
    (await pathExists(base))
      ? { name: t("doctor.base.name"), level: "PASS", detail: base }
      : {
          name: t("doctor.base.name"),
          level: "WARN",
          detail: t("doctor.missingPath", { path: base }),
          hint: t("doctor.base.hint"),
        },
  );

  // 데몬 진입 파일 — launchd 워커가 실행할 실재 .js. tsx dev(빌드 전)면 부재라 데몬 기동 불가.
  // 데몬은 macOS 전용(비-darwin 은 loadDaemon 이 assertMacOS 로 거부)이므로 darwin 에서만 점검.
  if (process.platform === "darwin") {
    const daemonEntry = daemonEntryPath();
    checks.push(
      (await pathExists(daemonEntry))
        ? { name: t("doctor.daemonEntry.name"), level: "PASS", detail: daemonEntry }
        : {
            name: t("doctor.daemonEntry.name"),
            level: "WARN",
            detail: t("doctor.daemonEntry.missing", { path: daemonEntry }),
            hint: t("doctor.daemonEntry.hint"),
          },
    );
  }

  if (proj === undefined) return checks;

  // daemon 등록 상태 점검 (macOS 전용 — 비-darwin 은 항목 스킵).
  if (process.platform === "darwin") {
    try {
      const launchdDeps = opts.launchctlExec ? { exec: opts.launchctlExec } : undefined;
      const regState = await daemonRegState(proj, launchdDeps);
      const { plistExists, launchctlRegistered } = regState;

      if (plistExists && launchctlRegistered) {
        // 둘 다 true — 정상 등록.
        checks.push({
          name: t("doctor.daemon.name", { proj }),
          level: "PASS",
          detail: t("doctor.daemon.registered"),
        });
      } else if (!plistExists && !launchctlRegistered) {
        // 둘 다 false — 데몬 미기동 상태(정상 — 기동 전 또는 down 후).
        checks.push({
          name: t("doctor.daemon.name", { proj }),
          level: "PASS",
          detail: t("doctor.daemon.notRunning", { proj }),
        });
      } else {
        // 불일치(plist XOR launchctl) — 복구 가능 경고.
        const mismatch = plistExists
          ? t("doctor.daemon.plistOnly")
          : t("doctor.daemon.launchctlOnly");
        checks.push({
          name: t("doctor.daemon.name", { proj }),
          level: "WARN",
          detail: mismatch,
          hint: t("doctor.daemon.mismatchHint", { proj }),
        });
      }
    } catch {
      // daemonRegState 오류 — 정보 부재로 WARN 처리(진단이므로 throw 대신 흡수).
      checks.push({
        name: t("doctor.daemon.name", { proj }),
        level: "WARN",
        detail: t("doctor.daemon.queryFailed"),
        hint: t("doctor.daemon.queryFailedHint", { proj }),
      });
    }
  }

  // 레인별 점검
  const { lanes } = await laneList(proj, { base });
  if (lanes.length === 0) {
    checks.push({
      name: t("doctor.lanes.name", { proj }),
      level: "WARN",
      detail: t("doctor.lanes.none"),
      hint: t("doctor.lanes.addHint", { proj }),
    });
    return checks;
  }

  for (const lane of lanes) {
    const paths = lanePaths(base, proj, lane);
    let confText: string;
    try {
      confText = await readFile(paths.confFile, "utf8");
    } catch {
      checks.push({
        name: `${lane}: conf`,
        level: "FAIL",
        detail: t("doctor.conf.readFailed", { path: paths.confFile }),
        hint: t("doctor.conf.readFailedHint"),
      });
      continue;
    }
    const conf = parseLaneConf(confText);

    // source 유효성
    if (conf.source === "telegram" || conf.source === "markdown") {
      checks.push({ name: `${lane}: source`, level: "PASS", detail: conf.source });
    } else {
      checks.push({
        name: `${lane}: source`,
        level: "FAIL",
        detail: t("doctor.source.unsupported", { source: conf.source }),
        hint: t("doctor.source.hint"),
      });
    }

    // cwd 존재(지정된 경우)
    if (conf.cwd) {
      const cwd = expandTilde(conf.cwd);
      checks.push(
        (await pathExists(cwd))
          ? { name: `${lane}: cwd`, level: "PASS", detail: cwd }
          : {
              name: `${lane}: cwd`,
              level: "FAIL",
              detail: t("doctor.missingPath", { path: cwd }),
              hint: t("doctor.cwd.hint"),
            },
      );
    }

    // 토큰(telegram 한정)
    if (conf.source === "telegram") {
      let hasToken = false;
      try {
        hasToken = (await readFile(paths.envFile, "utf8")).includes("TELEGRAM_BOT_TOKEN=");
      } catch {
        // env 파일 부재/읽기 실패 = 토큰 없음(초기값 유지)
      }
      checks.push(
        hasToken
          ? {
              name: t("doctor.token.name", { lane }),
              level: "PASS",
              detail: t("doctor.token.present"),
            }
          : {
              name: t("doctor.token.name", { lane }),
              level: "FAIL",
              detail: t("doctor.token.missing", { path: paths.envFile }),
              hint: t("doctor.token.hint", { path: paths.envFile }),
            },
      );
    }

    // 파일 권한 감사 — 시크릿(.env)·private 모드 상태 디렉터리가 그룹/기타에 노출됐는지.
    // .env 는 토큰을 담으므로 모드와 무관하게 그룹/기타 접근을 경고한다. state 디렉터리는
    // file_mode=private 일 때만 0700 을 기대(shared 는 느슨한 권한이 의도된 선택이라 통과).
    const envMode = await modeOf(paths.envFile);
    const stateMode = await modeOf(paths.stateDir);
    const looseEnv = envMode !== null && (envMode & 0o077) !== 0;
    const looseState =
      stateMode !== null &&
      resolveFileMode(conf.file_mode) === "private" &&
      (stateMode & 0o077) !== 0;
    // env·state 는 독립 관심사 — 둘 다 느슨하면 둘 다 경고한다(하나가 다른 하나를 가리지 않도록).
    if (looseEnv) {
      checks.push({
        name: t("doctor.perms.name", { lane }),
        level: "WARN",
        detail: t("doctor.perms.envLoose", { mode: octal(envMode) }),
        hint: t("doctor.perms.envHint", { path: paths.envFile }),
      });
    }
    if (looseState) {
      checks.push({
        name: t("doctor.perms.name", { lane }),
        level: "WARN",
        detail: t("doctor.perms.stateLoose", { mode: octal(stateMode) }),
        hint: t("doctor.perms.stateHint", { path: paths.stateDir, proj }),
      });
    }
    if (!looseEnv && !looseState && (envMode !== null || stateMode !== null)) {
      checks.push({
        name: t("doctor.perms.name", { lane }),
        level: "PASS",
        detail: t("doctor.perms.ok"),
      });
    }
  }

  return checks;
}

// ── logs ──────────────────────────────────────────────────────────────

export interface LogsResult {
  /** 읽은 로그 파일 경로. */
  path: string;
  /** 파일이 존재했는가. false 면 lines 는 빈 배열. */
  exists: boolean;
  /** 최근 N줄(파일 끝 기준). */
  lines: string[];
}

export interface ReadLogsOptions extends DiagBaseOptions {
  /** true 면 transcript.log 대신 engine.log(엔진 stderr 캡처)를 읽는다. */
  engine?: boolean;
}

/** 레인 로그(transcript.log 기본, engine 옵션 시 engine.log)의 최근 n줄을 반환한다. 파일 없으면 exists=false. */
export async function readLogs(
  proj: string,
  lane: string,
  n = 50,
  opts: ReadLogsOptions = {},
): Promise<LogsResult> {
  const base = opts.base ?? defaultBase();
  const paths = lanePaths(base, proj, lane);
  const target = opts.engine ? paths.engineLog : paths.transcriptLog;
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch {
    return { path: target, exists: false, lines: [] };
  }
  const all = text.split("\n").filter((l) => l.length > 0);
  return { path: target, exists: true, lines: all.slice(-Math.max(1, n)) };
}
