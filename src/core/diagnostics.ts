/**
 * 운영 가시성 — status / doctor / logs 의 코어 로직(읽기 전용, 부수효과 없음).
 * CLI 계층(cli/ops.ts)이 결과를 표/JSON/텍스트로 표면화한다.
 */
import { readFile, stat } from "node:fs/promises";
import { laneList } from "./lane-config.js";
import { resolveAdapterBin } from "./supervisor.js";
import { readRuntime, livenessOf } from "./runtime-state.js";
import type { Liveness } from "./runtime-state.js";
import { lanePaths, defaultBase, expandTilde } from "../shared/paths.js";
import { parseLaneConf } from "../shared/conf.js";

export interface DiagBaseOptions {
  /** 설정 base 경로(테스트 override). 미지정 시 $ADDE_HOME 또는 ~/.config/adde. */
  base?: string;
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
    const status = livenessOf(info);
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
    });
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
      ? { name: "Node 버전", level: "PASS", detail: `v${process.versions.node} (≥22)` }
      : {
          name: "Node 버전",
          level: "FAIL",
          detail: `v${process.versions.node} (<22)`,
          hint: "Node 22 이상으로 업그레이드하세요(nvm install 22 등).",
        },
  );

  // 어댑터 바이너리 해석
  const adapterBin = resolveAdapterBin();
  checks.push(
    (await pathExists(adapterBin))
      ? { name: "ACP 어댑터 바이너리", level: "PASS", detail: adapterBin }
      : {
          name: "ACP 어댑터 바이너리",
          level: "FAIL",
          detail: `해석된 경로에 파일 없음: ${adapterBin}`,
          hint: "의존성을 설치하세요(pnpm install) — @zed-industries/claude-code-acp 누락.",
        },
  );

  // base 디렉터리 가독
  checks.push(
    (await pathExists(base))
      ? { name: "설정 base 디렉터리", level: "PASS", detail: base }
      : {
          name: "설정 base 디렉터리",
          level: "WARN",
          detail: `없음: ${base}`,
          hint: "레인을 추가하면 생성됩니다(adde lane add <proj> <lane>).",
        },
  );

  if (proj === undefined) return checks;

  // 레인별 점검
  const { lanes } = await laneList(proj, { base });
  if (lanes.length === 0) {
    checks.push({
      name: `레인 (${proj})`,
      level: "WARN",
      detail: "lanes.d 에 conf 없음",
      hint: `레인을 추가하세요: adde lane add ${proj} <lane>`,
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
        detail: `읽기 실패: ${paths.confFile}`,
        hint: "conf 파일 권한/존재를 확인하세요.",
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
        detail: `미지원 source: "${conf.source}"`,
        hint: "conf 의 source 를 telegram 또는 markdown 으로 설정하세요.",
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
              detail: `없음: ${cwd}`,
              hint: "conf 의 cwd 를 존재하는 작업 폴더로 수정하세요.",
            },
      );
    }

    // 토큰(telegram 한정)
    if (conf.source === "telegram") {
      let hasToken = false;
      try {
        hasToken = (await readFile(paths.envFile, "utf8")).includes("TELEGRAM_BOT_TOKEN=");
      } catch {
        hasToken = false;
      }
      checks.push(
        hasToken
          ? { name: `${lane}: 토큰`, level: "PASS", detail: ".env 에 TELEGRAM_BOT_TOKEN 존재" }
          : {
              name: `${lane}: 토큰`,
              level: "FAIL",
              detail: `토큰 없음: ${paths.envFile}`,
              hint: `봇 토큰을 기록하세요: ${paths.envFile} 에 TELEGRAM_BOT_TOKEN=... (또는 lane add --token-stdin).`,
            },
      );
    }
  }

  return checks;
}

// ── logs ──────────────────────────────────────────────────────────────

export interface LogsResult {
  /** transcript.log 경로. */
  path: string;
  /** 파일이 존재했는가. false 면 lines 는 빈 배열. */
  exists: boolean;
  /** 최근 N줄(파일 끝 기준). */
  lines: string[];
}

/** 레인 transcript.log 의 최근 n줄을 반환한다. 파일 없으면 exists=false. */
export async function readLogs(
  proj: string,
  lane: string,
  n = 50,
  opts: DiagBaseOptions = {},
): Promise<LogsResult> {
  const base = opts.base ?? defaultBase();
  const paths = lanePaths(base, proj, lane);
  let text: string;
  try {
    text = await readFile(paths.transcriptLog, "utf8");
  } catch {
    return { path: paths.transcriptLog, exists: false, lines: [] };
  }
  const all = text.split("\n").filter((l) => l.length > 0);
  return { path: paths.transcriptLog, exists: true, lines: all.slice(-Math.max(1, n)) };
}
