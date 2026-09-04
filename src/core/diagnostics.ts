/**
 * 운영 가시성(v2) — status / doctor / logs 의 코어 로직(읽기 전용). 세션 상태·엔진 상주 여부·
 * 구 v0.2.x 데이터 안내(FR-031·FR-032)를 제공한다. CLI 계층(cli/ops.ts)이 표/JSON 으로 렌더한다.
 */
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadSessions } from "./session-store.js";
import type { SessionRecord } from "./session-store.js";
import { readRuntime, livenessOf } from "./runtime-state.js";
import type { Liveness } from "./runtime-state.js";
import {
  defaultBase,
  projectPaths,
  isSafeSegment,
  daemonHaltPath,
  daemonBootsPath,
} from "../shared/paths.js";
import { parseProjectConf } from "../shared/conf.js";
import { daemonRegState, daemonEntryPath } from "./launchd.js";
import type { LaunchctlExec } from "./launchd.js";
import { ENGINE_IDS, ENGINE_REGISTRY } from "../engines/index.js";
import { SURFACE_IDS, SURFACE_REGISTRY } from "../surfaces/index.js";
import { detectLegacyLayout, detectProjectsNameCollision } from "./legacy-guard.js";
import type { HaltRecord } from "./crash-loop.js";
import { errCode } from "../shared/errors.js";
import { readRetentionLastRun } from "../record/retention.js";

export interface DiagBaseOptions {
  base?: string;
  launchctlExec?: LaunchctlExec;
}

export interface SessionStatusRow {
  sid: string;
  status: SessionRecord["status"];
  engine: string;
  engineRef: string | null;
  title: string | null;
  lastActivityAt: string;
  /** 데몬이 상주 중이고 이 세션이 active 인가(엔진 프로세스 상주 여부의 근사, FR-031). */
  enginePresent: boolean;
  /** 세션 레코드의 경고 — 저장 실패·재개 실패 등. `status` 가 유무를, `session show` 가 본문을 보인다. */
  warnings: string[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** proj 의 전 세션 상태를 수집한다(FR-003·FR-031). */
export async function collectStatus(
  proj: string,
  opts: DiagBaseOptions = {},
): Promise<SessionStatusRow[]> {
  const base = opts.base ?? defaultBase();
  const records = await loadSessions(base, proj);
  const pp = projectPaths(base, proj);
  const read = await readRuntime(pp);
  const daemonAlive = livenessOf(read) === "running";
  return records.map((r) => ({
    sid: r.sid,
    status: r.status,
    engine: r.engine,
    engineRef: r.engineRef,
    title: r.title,
    lastActivityAt: r.lastActivityAt,
    enginePresent: daemonAlive && r.status === "active",
    warnings: r.warnings,
  }));
}

export interface DaemonStatus {
  proj: string;
  liveness: Liveness;
  /** ok 일 때만. 생존 확인 외 용도 금지(ADR-012). */
  pid: number | null;
  /** ADR-011 정규화 통과분만. */
  startedAt: string | null;
  /** mtimeMs → ISO. ok 일 때만. */
  heartbeatAt: string | null;
  /** unreadable 일 때만. */
  reason: string | null;
}

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/;

function normalizeStartedAt(raw: unknown): string | null {
  return typeof raw === "string" && raw.length <= 64 && ISO_8601_RE.test(raw) ? raw : null;
}

/** 데몬 라이브니스 상태를 수집한다(additive — FR-006·FR-008·FR-011·FR-012). */
export async function collectDaemonStatus(
  proj: string,
  opts: DiagBaseOptions = {},
): Promise<DaemonStatus> {
  const base = opts.base ?? defaultBase();
  const pp = projectPaths(base, proj);
  const read = await readRuntime(pp);
  const liveness = livenessOf(read);
  if (read.kind === "ok") {
    return {
      proj,
      liveness,
      pid: read.info.pid,
      startedAt: normalizeStartedAt(read.info.startedAt),
      heartbeatAt: new Date(read.mtimeMs).toISOString(),
      reason: null,
    };
  }
  if (read.kind === "unreadable") {
    return { proj, liveness, pid: null, startedAt: null, heartbeatAt: null, reason: read.reason };
  }
  return { proj, liveness, pid: null, startedAt: null, heartbeatAt: null, reason: null };
}

/** `<base>/projects/*` 중 `project.conf` 를 가진 디렉터리를 프로젝트로 열거한다. */
export async function listRegisteredProjects(opts: DiagBaseOptions = {}): Promise<string[]> {
  const base = opts.base ?? defaultBase();
  const projectsRoot = join(base, "projects");
  let names: string[];
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && isSafeSegment(e.name)).map((e) => e.name);
  } catch (err) {
    // 부재(ENOENT, 최초 설치 등 정상 상태)만 빈 목록으로 접는다. 권한 오류 등 그 밖의 errno 를
    // 흡수하면 열거 자체가 실패했는데도 "등록된 프로젝트 없음"으로 위장되어 US-003(장애를 놓치지
    // 않는다)이 깨진다 — 호출측이 전파받아 표면화·실패 종료코드로 올린다.
    if (errCode(err) === "ENOENT") return [];
    throw err;
  }
  const projs: string[] = [];
  for (const name of names) {
    if (await pathExists(projectPaths(base, name).projectConf)) projs.push(name);
  }
  return projs.sort();
}

export type AggregatedSessionStatusRow = SessionStatusRow & { proj: string };

export async function collectAllStatus(
  opts: DiagBaseOptions = {},
): Promise<AggregatedSessionStatusRow[]> {
  const base = opts.base ?? defaultBase();
  const projs = await listRegisteredProjects({ ...opts, base });
  const rows: AggregatedSessionStatusRow[] = [];
  for (const proj of projs) {
    const projRows = await collectStatus(proj, { ...opts, base });
    for (const r of projRows) rows.push({ ...r, proj });
  }
  return rows;
}

/** 판독 계약 — 부재/정상/판독 불가(+사유)를 판별 유니온으로 분리한다(runtime-state.ts 의
 * `RuntimeRead` 와 동형). 읽기·파싱 실패를 "기록 없음"으로 접으면 크래시루프 자가정지가
 * 존재하는데도 못 읽는 상황이 무음으로 정상 취급된다. */
export type HaltRead =
  { kind: "absent" } | { kind: "ok"; record: HaltRecord } | { kind: "unreadable"; reason: string };

export async function readHalt(base: string, proj: string): Promise<HaltRead> {
  let text: string;
  try {
    text = await readFile(daemonHaltPath(base, proj), "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: errCode(err) ?? "read-error" };
  }
  try {
    return { kind: "ok", record: JSON.parse(text) as HaltRecord };
  } catch {
    return { kind: "unreadable", reason: "malformed" };
  }
}

export async function clearHalt(base: string, proj: string): Promise<void> {
  for (const p of [daemonHaltPath(base, proj), daemonBootsPath(base, proj)]) {
    try {
      await unlink(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

export type CheckLevel = "PASS" | "WARN" | "FAIL" | "INFO";

export interface DoctorCheck {
  name: string;
  level: CheckLevel;
  detail: string;
  hint?: string;
}

/** 상태 비의존 정적 점검(FR-020·FR-027·FR-032). proj 미지정 시 전역 점검만. */
export async function runDoctor(proj?: string, opts: DiagBaseOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const base = opts.base ?? defaultBase();

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 22
      ? { name: "node", level: "PASS", detail: `v${process.versions.node} (≥22)` }
      : {
          name: "node",
          level: "FAIL",
          detail: `v${process.versions.node} (<22)`,
          hint: "Node 22+ 를 설치하세요.",
        },
  );

  // 엔진 레지스트리 파생(FR-020) — 하드코딩 목록 없음.
  checks.push({ name: "engines", level: "PASS", detail: `등록: ${ENGINE_IDS.join(", ")}` });
  // 채널 레지스트리(FR-027) — 구현/미구현 노출.
  const surfaceInfo = SURFACE_IDS.map((id) => `${id}(${SURFACE_REGISTRY[id]!.status})`).join(", ");
  checks.push({ name: "surfaces", level: "PASS", detail: surfaceInfo });

  if (process.platform === "darwin") {
    const daemonEntry = daemonEntryPath();
    checks.push(
      (await pathExists(daemonEntry))
        ? { name: "daemon-entry", level: "PASS", detail: daemonEntry }
        : {
            name: "daemon-entry",
            level: "WARN",
            detail: `부재: ${daemonEntry}`,
            hint: "pnpm run build 를 실행하세요.",
          },
    );
  } else {
    checks.push({
      name: "os",
      level: "FAIL",
      detail: `${process.platform} — 데몬 상주는 macOS 전용입니다(NFR-008).`,
    });
  }

  // v0.2.x 구 데이터 안내(FR-032) — 무접촉, 위치만.
  const legacy = await detectLegacyLayout(base);
  if (legacy.length > 0) {
    checks.push({
      name: "legacy-data",
      level: "INFO",
      detail: `v0.2.x 데이터 발견(무접촉 보존): ${legacy.map((l) => l.path).join(", ")}`,
    });
  }
  const collision = await detectProjectsNameCollision(base);
  if (collision) checks.push({ name: "legacy-collision", level: "FAIL", detail: collision });

  if (proj === undefined) return checks;

  const halt = await readHalt(base, proj);
  if (halt.kind === "ok") {
    checks.push({
      name: `halt(${proj})`,
      level: "FAIL",
      detail: `크래시루프 자가 정지(연속 ${halt.record.consecutiveShortLived}회): ${halt.record.reason}`,
      hint: `adde up ${proj} 또는 adde restart ${proj} 로 초기화됩니다.`,
    });
  } else if (halt.kind === "unreadable") {
    checks.push({
      name: `halt(${proj})`,
      level: "FAIL",
      detail: `크래시루프 자가 정지 기록을 판정할 수 없습니다(${halt.reason})`,
      hint: `adde down ${proj} 로 정리한 뒤 adde up ${proj} 로 재기동하면 상태 기록이 다시 생성됩니다.`,
    });
  }

  if (process.platform === "darwin") {
    try {
      const launchdDeps = opts.launchctlExec ? { exec: opts.launchctlExec } : undefined;
      const regState = await daemonRegState(proj, launchdDeps);
      checks.push({
        name: `daemon(${proj})`,
        level: "PASS",
        detail: regState.plistExists && regState.launchctlRegistered ? "등록됨" : "미등록",
      });
    } catch {
      checks.push({ name: `daemon(${proj})`, level: "WARN", detail: "등록 상태 조회 실패" });
    }
  }

  const pp = projectPaths(base, proj);
  let confText: string;
  try {
    confText = await readFile(pp.projectConf, "utf8");
  } catch {
    checks.push({ name: "project.conf", level: "FAIL", detail: `읽기 실패: ${pp.projectConf}` });
    return checks;
  }
  const conf = parseProjectConf(confText);
  checks.push(
    ENGINE_IDS.includes(conf.engine)
      ? { name: "project.engine", level: "PASS", detail: conf.engine }
      : { name: "project.engine", level: "FAIL", detail: `알 수 없는 엔진: ${conf.engine}` },
  );
  checks.push(
    (await pathExists(conf.vault))
      ? { name: "project.vault", level: "PASS", detail: conf.vault }
      : { name: "project.vault", level: "WARN", detail: `부재(첫 사용 시 생성됨): ${conf.vault}` },
  );

  // 보관 이관 결과 표면화 — 전용 이벤트 스트림을 신설하지 않고 doctor 출력으로만 노출한다.
  if (conf["vault.backup"] !== undefined) {
    const lastRun = await readRetentionLastRun(base, proj);
    checks.push(
      lastRun
        ? {
            name: `retention(${proj})`,
            level: "INFO",
            detail: `마지막 이관 ${lastRun.date} — 이관 ${lastRun.moved}건, 건너뜀 ${lastRun.skipped}건`,
          }
        : {
            name: `retention(${proj})`,
            level: "INFO",
            detail:
              "보관 이관 아직 실행되지 않음(데몬이 상주하는 동안 다음 일간 스윕에서 실행됩니다)",
          },
    );
  }

  const engineDoctor = ENGINE_REGISTRY[conf.engine]?.doctorChecks;
  if (engineDoctor) {
    const results = await engineDoctor({ cwd: conf.cwd ?? process.cwd() });
    for (const r of results)
      checks.push({ name: r.name, level: r.ok ? "PASS" : "WARN", detail: r.detail ?? "" });
  }

  return checks;
}
