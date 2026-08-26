/**
 * 운영 가시성(v2) — status / doctor / logs 의 코어 로직(읽기 전용). 세션 상태·엔진 상주 여부·
 * 구 v0.2.x 데이터 안내(FR-031·FR-032)를 제공한다. CLI 계층(cli/ops.ts)이 표/JSON 으로 렌더한다.
 */
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadSessions } from "./session-store.js";
import type { SessionRecord } from "./session-store.js";
import { readRuntime, livenessOf } from "./runtime-state.js";
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
  const runtimeInfo = await readRuntime(pp);
  let mtimeMs: number | undefined;
  if (runtimeInfo) {
    try {
      mtimeMs = (await stat(pp.runtimeJson)).mtimeMs;
    } catch {
      mtimeMs = undefined;
    }
  }
  const daemonAlive = livenessOf(runtimeInfo, { mtimeMs }) === "running";
  return records.map((r) => ({
    sid: r.sid,
    status: r.status,
    engine: r.engine,
    engineRef: r.engineRef,
    title: r.title,
    lastActivityAt: r.lastActivityAt,
    enginePresent: daemonAlive && r.status === "active",
  }));
}

/** `<base>/projects/*` 중 `project.conf` 를 가진 디렉터리를 프로젝트로 열거한다. */
export async function listRegisteredProjects(opts: DiagBaseOptions = {}): Promise<string[]> {
  const base = opts.base ?? defaultBase();
  const projectsRoot = join(base, "projects");
  let names: string[];
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && isSafeSegment(e.name)).map((e) => e.name);
  } catch {
    return [];
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

export async function readHalt(base: string, proj: string): Promise<HaltRecord | null> {
  try {
    const text = await readFile(daemonHaltPath(base, proj), "utf8");
    return JSON.parse(text) as HaltRecord;
  } catch {
    return null;
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
  if (halt) {
    checks.push({
      name: `halt(${proj})`,
      level: "FAIL",
      detail: `크래시루프 자가 정지(연속 ${halt.consecutiveShortLived}회): ${halt.reason}`,
      hint: `adde up ${proj} 또는 adde restart ${proj} 로 초기화됩니다.`,
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
