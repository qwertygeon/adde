/**
 * 레인 .conf 설정 관리(생성·조회·삭제) — `adde lane` 서브커맨드의 코어.
 * 파일 1개 = 레인 1개 (~/.config/adde/<proj>/lanes.d/<lane>.conf).
 * 모든 검증을 통과한 뒤에만 디스크에 쓴다(validate-then-commit). 쓰기는 tmp→rename 원자적.
 */
import { readdir, readFile, writeFile, rename, mkdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseLaneConf, serializeLaneConf } from "../shared/conf.js";
import type { LaneConf } from "../shared/conf.js";
import { lanePaths, defaultBase, expandTilde } from "../shared/paths.js";

/** proj/lane 식별자 — 디렉터리·파일명이 되므로 안전 문자만 허용. */
const NAME_RE = /^[A-Za-z0-9_-]+$/;
/** telegram chat id — 그룹은 음수일 수 있음. */
const CHAT_ID_RE = /^-?\d+$/;

const SUPPORTED_SOURCES = ["telegram", "markdown"] as const;
type SupportedSource = (typeof SUPPORTED_SOURCES)[number];

/** 검증 실패를 식별하기 위한 전용 에러(흡수 금지 — 호출자가 메시지를 사용자에게 전달). */
export class LaneConfigError extends Error {
  override name = "LaneConfigError";
}

export interface LaneCommandBaseOptions {
  /** 설정 base 경로(테스트 override). 미지정 시 $ADDE_HOME 또는 ~/.config/adde. */
  base?: string;
}

export interface LaneAddOptions extends LaneCommandBaseOptions {
  source?: string;
  backend?: string;
  engine?: string;
  channel?: string;
  perm_tier?: string;
  acp_version?: string;
  allowlist?: string[];
  cwd?: string;
  chat_id?: string;
  root?: string;
  inbox?: string;
  approvals?: string;
  outbox?: string;
  /** 봇 토큰(telegram). 주어지면 state/<lane>/.env 에 0600 으로 기록. */
  token?: string;
  /** 기존 conf(및 token 지정 시 .env) 를 덮어쓴다. */
  force?: boolean;
}

export interface LaneAddResult {
  lane: string;
  confPath: string;
  conf: LaneConf;
  /** token 을 .env 에 기록한 경우 그 경로. */
  envPath?: string;
  /** 생성을 막지 않는 사전 검증 경고(액션형). 기동 전 점검 항목. */
  warnings: string[];
}

/** 봇 토큰 대략 형식: <숫자id>:<영숫자/_-> (형식 오타 조기 발견용 휴리스틱). */
const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]+$/;

/**
 * 쓰기를 막지 않는 사전 검증 경고 수집 — cwd/markdown root 부재·telegram 토큰 형식.
 * 하드 오류(이름·source·chat_id 형식·중복)는 laneAdd 본문에서 throw 로 차단한다(여기 아님).
 */
async function collectAddWarnings(conf: LaneConf, token?: string): Promise<string[]> {
  const warnings: string[] = [];
  if (conf.cwd) {
    const p = expandTilde(conf.cwd);
    if (!(await exists(p))) {
      warnings.push(
        `[경고] cwd 경로가 없습니다: ${p}\n  ↳ 조치: 기동 전 폴더를 만들거나 conf 의 cwd 를 수정하세요.`,
      );
    }
  }
  if (conf.source === "markdown") {
    if (!conf.root) {
      warnings.push(
        "[경고] markdown 레인에 root 가 없습니다.\n  ↳ 조치: --root <vault 절대경로> 를 지정하세요(없으면 인바운드 감시 불가).",
      );
    } else if (!(await exists(expandTilde(conf.root)))) {
      warnings.push(
        `[경고] markdown root 경로가 없습니다: ${expandTilde(conf.root)}\n  ↳ 조치: 경로를 확인하거나 생성하세요.`,
      );
    }
  }
  if (conf.source === "telegram" && token !== undefined && !TELEGRAM_TOKEN_RE.test(token)) {
    warnings.push(
      "[경고] 봇 토큰 형식이 예상과 다릅니다(<숫자>:<영숫자> 아님).\n  ↳ 조치: BotFather 발급 토큰을 다시 확인하세요.",
    );
  }
  return warnings;
}

export interface LaneListResult {
  lanes: string[];
}

export interface LaneShowResult {
  lane: string;
  confPath: string;
  conf: LaneConf;
  text: string;
}

export interface LaneRemoveResult {
  lane: string;
  confPath: string;
}

function assertName(kind: "proj" | "lane", value: string): void {
  if (!value) throw new LaneConfigError(`${kind} 가 비어있습니다`);
  if (!NAME_RE.test(value)) {
    throw new LaneConfigError(
      `${kind} "${value}" 가 올바르지 않습니다 — 영문/숫자/_/- 만 허용`,
    );
  }
}

/** tmp 파일에 쓴 뒤 rename 으로 원자적 교체. */
async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`;
  await writeFile(tmp, content, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  await rename(tmp, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `adde lane add` — 레인 conf 생성. 검증 통과 후 원자적 기록.
 * 기존 conf 가 있으면 force 없이는 거부한다.
 */
export async function laneAdd(
  proj: string,
  lane: string,
  opts: LaneAddOptions = {},
): Promise<LaneAddResult> {
  assertName("proj", proj);
  assertName("lane", lane);

  const source = (opts.source ?? "telegram") as string;
  if (!(SUPPORTED_SOURCES as readonly string[]).includes(source)) {
    throw new LaneConfigError(
      `source "${source}" 미지원 — ${SUPPORTED_SOURCES.join(" | ")} 중 하나`,
    );
  }
  const src = source as SupportedSource;

  if (opts.chat_id !== undefined && opts.chat_id !== "" && !CHAT_ID_RE.test(opts.chat_id)) {
    throw new LaneConfigError(`chat_id "${opts.chat_id}" 가 숫자가 아닙니다`);
  }
  if (opts.token !== undefined && src !== "telegram") {
    throw new LaneConfigError("token 은 source=telegram 레인에서만 사용합니다");
  }

  const conf: LaneConf = {
    source: src,
    backend: opts.backend ?? "acp",
    engine: opts.engine ?? "claude-code-acp",
    channel: opts.channel ?? src,
    perm_tier: opts.perm_tier ?? "acp",
    acp_version: opts.acp_version ?? "v1",
    allowlist: opts.allowlist ?? [],
  };
  // exactOptionalPropertyTypes: undefined 대입 금지 — 값이 있을 때만 설정.
  if (opts.cwd) conf.cwd = opts.cwd;
  if (opts.chat_id) conf.chat_id = opts.chat_id;
  if (opts.root) conf.root = opts.root;
  if (opts.inbox) conf.inbox = opts.inbox;
  if (opts.approvals) conf.approvals = opts.approvals;
  if (opts.outbox) conf.outbox = opts.outbox;

  const base = opts.base ?? defaultBase();
  const paths = lanePaths(base, proj, lane);

  if (!opts.force && (await exists(paths.confFile))) {
    throw new LaneConfigError(
      `레인 "${lane}" 이 이미 존재합니다 (${paths.confFile}) — 덮어쓰려면 --force`,
    );
  }

  await mkdir(paths.lanesDir, { recursive: true });
  await writeAtomic(paths.confFile, serializeLaneConf(conf));

  const result: LaneAddResult = { lane, confPath: paths.confFile, conf, warnings: [] };

  if (opts.token !== undefined) {
    const token = opts.token.trim();
    if (!token) throw new LaneConfigError("token 이 비어있습니다");
    if (!opts.force && (await exists(paths.envFile))) {
      const existing = (await readFile(paths.envFile, "utf8")).trim();
      if (existing) {
        throw new LaneConfigError(
          `${paths.envFile} 에 이미 토큰이 있습니다 — 덮어쓰려면 --force`,
        );
      }
    }
    await mkdir(paths.stateDir, { recursive: true });
    await writeAtomic(paths.envFile, `TELEGRAM_BOT_TOKEN=${token}\n`, 0o600);
    result.envPath = paths.envFile;
  }

  result.warnings = await collectAddWarnings(conf, opts.token);

  return result;
}

/** `adde lane ls` — proj 의 레인 ID 목록(정렬). lanes.d 부재 시 빈 배열. */
export async function laneList(
  proj: string,
  opts: LaneCommandBaseOptions = {},
): Promise<LaneListResult> {
  assertName("proj", proj);
  const base = opts.base ?? defaultBase();
  const lanesDir = join(base, proj, "lanes.d");
  let files: string[];
  try {
    files = await readdir(lanesDir);
  } catch {
    return { lanes: [] };
  }
  const lanes = files
    .filter((f) => f.endsWith(".conf"))
    .map((f) => f.replace(/\.conf$/, ""))
    .sort();
  return { lanes };
}

/** `adde lane show` — 레인 conf 의 파싱 결과와 원본 텍스트. */
export async function laneShow(
  proj: string,
  lane: string,
  opts: LaneCommandBaseOptions = {},
): Promise<LaneShowResult> {
  assertName("proj", proj);
  assertName("lane", lane);
  const base = opts.base ?? defaultBase();
  const paths = lanePaths(base, proj, lane);
  let text: string;
  try {
    text = await readFile(paths.confFile, "utf8");
  } catch {
    throw new LaneConfigError(`레인 "${lane}" 을 찾을 수 없습니다 (${paths.confFile})`);
  }
  return { lane, confPath: paths.confFile, conf: parseLaneConf(text), text };
}

/** `adde lane rm` — 레인 conf 삭제. 부재 시 에러. state/queue 등 부수 데이터는 보존. */
export async function laneRemove(
  proj: string,
  lane: string,
  opts: LaneCommandBaseOptions = {},
): Promise<LaneRemoveResult> {
  assertName("proj", proj);
  assertName("lane", lane);
  const base = opts.base ?? defaultBase();
  const paths = lanePaths(base, proj, lane);
  try {
    await unlink(paths.confFile);
  } catch {
    throw new LaneConfigError(`레인 "${lane}" 을 찾을 수 없습니다 (${paths.confFile})`);
  }
  return { lane, confPath: paths.confFile };
}
