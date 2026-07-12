/**
 * 레인 .conf 설정 관리(생성·조회·삭제) — `adde lane` 서브커맨드의 코어.
 * 파일 1개 = 레인 1개 (~/.config/adde/<proj>/lanes.d/<lane>.conf).
 * 모든 검증을 통과한 뒤에만 디스크에 쓴다(validate-then-commit). 쓰기는 tmp→rename 원자적.
 */
import { t, SUPPORTED_LOCALES } from "../shared/i18n.js";
import { readdir, readFile, mkdir, unlink, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  parseLaneConf,
  serializeLaneConf,
  validateEngineWiring,
  parseEngineArgs,
  EngineArgsParseError,
  DEFAULT_ENGINE,
  DEFAULT_BACKEND,
  ACP_VERSION,
  KNOWN_ENGINES,
  KNOWN_BACKENDS,
} from "../shared/conf.js";
import type { LaneConf } from "../shared/conf.js";
import { lanePaths, defaultBase, expandTilde } from "../shared/paths.js";
import { parseDenyEntry, DEFAULT_AUTOPASS_DENYLIST } from "../shared/deny-match.js";
import { atomicWrite, secureLaneDirs } from "../shared/fs-atomic.js";
import { SOURCE_IDS, SOURCE_REGISTRY } from "../src-adapters/index.js";

/** proj/lane 식별자 — 디렉터리·파일명이 되므로 안전 문자만 허용. */
const NAME_RE = /^[A-Za-z0-9_-]+$/;
/** allowlist/denylist 도구명 — 도구 식별자 안전 문자셋(C). */
const ALLOWLIST_ITEM_RE = /^[A-Za-z0-9_.-]+$/;
/**
 * chat_id 형식(telegram chat id — 그룹은 음수일 수 있음). 리팩터 전과 동일하게 source 무관하게
 * 형식만 검사한다(GAP-002 — chat_id 는 token/allow_from 과 달리 "특정 소스 전용" 교차 가드가
 * 없었던 기존 동작이라 공통 본문에 유지. telegram descriptor.validate 도 동일 검사를 자체 보유해
 * descriptor 직접 호출(레지스트리 단위 테스트) 시에도 동작한다).
 */
const CHAT_ID_RE = /^-?\d+$/;

/** 파일 권한 모드 허용값. 미지정 시 private(secure-by-default). */
export const KNOWN_FILE_MODES = ["private", "shared"] as const;

/** 구현된 perm_tier 값. 오타 시 acp 처럼 동작(안전 방향)하지만 의도와 다르므로 생성 시 경고. */
export const KNOWN_PERM_TIERS = ["acp", "autopass"] as const;

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
  perm_tier?: string;
  acp_version?: string;
  allowlist?: string[];
  denylist?: string[];
  /** 방어심화 하드-거부 목록(티어 무관 즉시 거부). `Tool`/`Tool(글롭)` 형식. */
  hard_deny?: string[];
  /** true 면 hard_deny 에 내장 위험명령 기본 목록을 채운다(explicit hard_deny 와 합집합). */
  safe_defaults?: boolean;
  cwd?: string;
  chat_id?: string;
  root?: string;
  inbox?: string;
  approvals?: string;
  outbox?: string;
  /** 레인별 채널 메시지 로케일(en|ko). 미지정 시 전역 로케일. */
  lang?: string;
  /** telegram 인바운드 허용 발신자(CSV, 숫자 user/chat id). */
  allow_from?: string;
  /** 레인별 엔진 CLI 인자(raw 문자열, 공백 분리). CLI `--engine-args` 매핑. */
  engine_args?: string;
  /** 상태·출력·큐 디렉터리 권한(private|shared). 미지정 시 private. */
  file_mode?: string;
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

/**
 * 쓰기를 막지 않는 공통 사전 검증 경고 수집 — cwd 부재·lang·perm_tier·autopass.
 * 소스별 경고(markdown root/경로 중첩, telegram 토큰 형식/무인증)는 descriptor.validate 가
 * 담당한다(laneAdd 가 위임 호출). 하드 오류는 laneAdd 본문·descriptor.validate 가 throw 로 차단한다.
 */
async function collectAddWarnings(conf: LaneConf): Promise<string[]> {
  const warnings: string[] = [];
  if (conf.cwd) {
    const p = expandTilde(conf.cwd);
    if (!(await exists(p))) {
      warnings.push(t("laneConfig.warn.cwdMissing", { path: p }));
    }
  }
  if (conf.lang && !(SUPPORTED_LOCALES as readonly string[]).includes(conf.lang)) {
    warnings.push(
      t("laneConfig.warn.badLang", { lang: conf.lang, supported: SUPPORTED_LOCALES.join("|") }),
    );
  }
  if (!(KNOWN_PERM_TIERS as readonly string[]).includes(conf.perm_tier)) {
    warnings.push(
      t("laneConfig.warn.permTierUnknown", {
        tier: conf.perm_tier,
        known: KNOWN_PERM_TIERS.join("|"),
      }),
    );
  }
  if (conf.perm_tier === "autopass") {
    warnings.push(t("laneConfig.warn.autopassBanner"));
    if (conf.denylist.length === 0) {
      warnings.push(t("laneConfig.warn.autopassEmptyDeny"));
    }
    const overlap = conf.denylist.filter((t) => conf.allowlist.includes(t));
    if (overlap.length > 0) {
      warnings.push(t("laneConfig.warn.allowDenyOverlap", { tools: overlap.join(", ") }));
    }
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
  /** purge 로 state/queue/processing/out 부수 데이터까지 지웠는지. */
  purged: boolean;
}

export interface LaneRemoveOptions extends LaneCommandBaseOptions {
  /** conf 뿐 아니라 레인의 state/queue/processing/out 디렉터리까지 삭제. */
  purge?: boolean;
}

export interface ProjRemoveResult {
  proj: string;
  /** 삭제한 프로젝트 디렉터리 경로. */
  path: string;
}

/** CSV 를 트림·빈값 제거해 항목 배열로. allow_from 등 목록 문자열 파싱 공용. */
export function parseCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** conf.file_mode → 정규화된 권한 모드. 미지정/미지값은 private(secure-by-default). */
export function resolveFileMode(mode: string | undefined): "private" | "shared" {
  return mode === "shared" ? "shared" : "private";
}

function assertName(kind: "proj" | "lane", value: string): void {
  if (!value) throw new LaneConfigError(t("laneConfig.err.emptyIdent", { kind }));
  if (!NAME_RE.test(value)) {
    throw new LaneConfigError(t("laneConfig.err.badIdent", { kind, value }));
  }
}

/** tmp 파일에 쓴 뒤 rename 으로 원자적 교체(shared 위임 — mode 시그니처 유지). */
async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
  await atomicWrite(path, content, mode === undefined ? undefined : { mode });
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

  const source = (opts.source ?? "markdown") as string;
  if (!SOURCE_IDS.includes(source)) {
    throw new LaneConfigError(
      t("laneConfig.err.badSource", { source, supported: SOURCE_IDS.join(" | ") }),
    );
  }

  // chat_id 형식(공통) — source 무관하게 형식만 검사(기존 동작, token/allow_from 과 달리
  // "특정 소스 전용" 가드가 없었다). 나머지 telegram 고유 검증(무인증 경고 등)은 descriptor.validate 위임.
  if (opts.chat_id !== undefined && opts.chat_id !== "" && !CHAT_ID_RE.test(opts.chat_id)) {
    throw new LaneConfigError(t("laneConfig.err.badChatId", { chatId: opts.chat_id }));
  }
  // 교차-소스 옵션 가드(공통) — telegram 전용 옵션을 다른 소스에 지정하면 거부한다.
  // "옵션 X 는 소스 Y 전용" 지식은 여러 descriptor 에 흩어지면 중앙화 취지가 역행하므로 공통 본문에
  // 유지한다. allow_from 형식·telegram 무인증 경고 등 telegram 고유 검증은 descriptor.validate 로
  // 위임한다(아래).
  if (opts.token !== undefined && source !== "telegram") {
    throw new LaneConfigError(t("laneConfig.err.tokenOnlyTelegram"));
  }
  if (opts.allow_from !== undefined && opts.allow_from !== "" && source !== "telegram") {
    throw new LaneConfigError(t("laneConfig.err.allowFromOnlyTelegram"));
  }
  if (
    opts.file_mode !== undefined &&
    !(KNOWN_FILE_MODES as readonly string[]).includes(opts.file_mode)
  ) {
    throw new LaneConfigError(
      t("laneConfig.err.badFileMode", {
        mode: opts.file_mode,
        known: KNOWN_FILE_MODES.join("|"),
      }),
    );
  }
  for (const tool of opts.allowlist ?? []) {
    if (!ALLOWLIST_ITEM_RE.test(tool)) {
      throw new LaneConfigError(t("laneConfig.err.badAllowTool", { tool }));
    }
  }
  // denylist 는 `Tool` 또는 `Tool(글롭)` 형식. 콤마는 목록 구분자라 항목 내 금지.
  for (const entry of opts.denylist ?? []) {
    if (entry.includes(",") || !parseDenyEntry(entry)) {
      throw new LaneConfigError(t("laneConfig.err.badDenyEntry", { entry }));
    }
  }
  // hard_deny 도 denylist 와 동일한 항목 형식.
  for (const entry of opts.hard_deny ?? []) {
    if (entry.includes(",") || !parseDenyEntry(entry)) {
      throw new LaneConfigError(t("laneConfig.err.badDenyEntry", { entry }));
    }
  }

  const permTier = opts.perm_tier ?? "acp";
  const conf: LaneConf = {
    source,
    backend: opts.backend ?? DEFAULT_BACKEND,
    engine: opts.engine ?? DEFAULT_ENGINE,
    perm_tier: permTier,
    acp_version: opts.acp_version ?? ACP_VERSION,
    allowlist: opts.allowlist ?? [],
    // autopass 인데 denylist 미지정 → 내장 기본 denylist. conf 에 구체 목록을
    // 명시 기록한다(암묵 기본값이 파일에 안 보이는 상태 회피). 명시 지정(빈 배열 포함)이 우선.
    denylist: opts.denylist ?? (permTier === "autopass" ? [...DEFAULT_AUTOPASS_DENYLIST] : []),
    // 방어심화 하드-거부 — safe_defaults 면 내장 위험 목록에 explicit hard_deny 를 합집합(중복 제거).
    hard_deny: opts.safe_defaults
      ? [...new Set([...DEFAULT_AUTOPASS_DENYLIST, ...(opts.hard_deny ?? [])])]
      : (opts.hard_deny ?? []),
    // 노브 미노출(최소 표면) — CLI 는 항상 기본 ON 으로 생성(serialize 시 미출력).
    auto_relaunch: true,
  };
  // exactOptionalPropertyTypes: undefined 대입 금지 — 값이 있을 때만 설정.
  if (opts.cwd) conf.cwd = opts.cwd;
  if (opts.lang) conf.lang = opts.lang;
  if (opts.file_mode) conf.file_mode = opts.file_mode;
  if (opts.engine_args) {
    // 생성 시점 fail-closed 검증 — 잘못된 engine_args(개행·따옴표)를 conf 에 기록하지 않는다.
    // 개행이 든 값은 평면 conf 에 raw 로 직렬화되면 재파싱 시 별개 키(hard_deny 등)로 주입될 수 있다.
    try {
      parseEngineArgs(opts.engine_args);
    } catch (err) {
      if (err instanceof EngineArgsParseError) {
        throw new LaneConfigError(t("laneConfig.err.invalidEngineArgs", { reason: err.message }));
      }
      throw err;
    }
    conf.engine_args = opts.engine_args;
  }
  // 어댑터 전용 설정은 네임스페이스 서브객체로 — 관련 필드가 하나라도 있을 때만 생성.
  const markdown: NonNullable<LaneConf["markdown"]> = {};
  if (opts.root) markdown.root = opts.root;
  if (opts.inbox) markdown.inbox = opts.inbox;
  if (opts.approvals) markdown.approvals = opts.approvals;
  if (opts.outbox) markdown.outbox = opts.outbox;
  if (Object.keys(markdown).length > 0) conf.markdown = markdown;
  const telegram: NonNullable<LaneConf["telegram"]> = {};
  if (opts.chat_id) telegram.chat_id = opts.chat_id;
  if (opts.allow_from) telegram.allow_from = opts.allow_from;
  if (Object.keys(telegram).length > 0) conf.telegram = telegram;

  // 화이트리스트 검증(fail-fast, 방어) — CLI 는 항상 기본값을 기록하므로(플래그 노출 없음)
  // 실질 트리거는 laneAdd 를 직접 호출하는 프로그래밍 API/hand-edited override 경로다.
  const wiringViolation = validateEngineWiring(conf);
  if (wiringViolation) {
    throw new LaneConfigError(
      wiringViolation.code === "engine"
        ? t("laneConfig.err.unknownEngine", {
            value: wiringViolation.value,
            known: KNOWN_ENGINES.join("|"),
          })
        : t("laneConfig.err.unknownBackend", {
            value: wiringViolation.value,
            known: KNOWN_BACKENDS.join("|"),
          }),
    );
  }

  // 소스별 conf 검증 위임 — 훅 미제공 소스는 오류 없이 생략(공통 처리만).
  // 검증 통과 후에만 디스크에 쓴다(validate-then-commit, 파일 상단 원칙) — 쓰기 이전에 호출.
  const validated = SOURCE_REGISTRY[source]?.validate?.({ conf, token: opts.token, opts }) ?? {
    errors: [],
    warnings: [],
  };
  if (validated.errors.length > 0) {
    throw new LaneConfigError(validated.errors[0]!);
  }

  const base = opts.base ?? defaultBase();
  const paths = lanePaths(base, proj, lane);

  if (!opts.force && (await exists(paths.confFile))) {
    throw new LaneConfigError(t("laneConfig.err.laneExists", { lane, confFile: paths.confFile }));
  }

  await mkdir(paths.lanesDir, { recursive: true });
  await writeAtomic(paths.confFile, serializeLaneConf(conf));
  // conf 는 chat_id·allow_from·cwd 등 메타를 담는다 — private 모드에서 lanes.d 도 잠근다(0700).
  await secureLaneDirs([paths.lanesDir], resolveFileMode(conf.file_mode));

  const result: LaneAddResult = { lane, confPath: paths.confFile, conf, warnings: [] };

  let tokenOverwritten = false;
  if (opts.token !== undefined) {
    const token = opts.token.trim();
    if (!token) throw new LaneConfigError(t("laneConfig.err.tokenEmpty"));
    const envHadToken =
      (await exists(paths.envFile)) && (await readFile(paths.envFile, "utf8")).trim().length > 0;
    if (!opts.force && envHadToken) {
      throw new LaneConfigError(t("laneConfig.err.envHasToken", { envFile: paths.envFile }));
    }
    // --force 로 기존 토큰을 덮어쓰는 경우 조용히 지나가지 않도록 경고(시크릿 파괴는 되돌릴 수 없음).
    if (opts.force && envHadToken) tokenOverwritten = true;
    await mkdir(paths.stateDir, { recursive: true });
    // 토큰이 사는 state 디렉터리를 권한 모드대로 잠근다(private=0700). .env 자체도 0600.
    await secureLaneDirs([paths.stateDir], resolveFileMode(conf.file_mode));
    await writeAtomic(paths.envFile, `TELEGRAM_BOT_TOKEN=${token}\n`, 0o600);
    result.envPath = paths.envFile;
  }

  result.warnings = [...validated.warnings, ...(await collectAddWarnings(conf))];
  if (tokenOverwritten) {
    result.warnings.push(t("laneConfig.warn.tokenOverwritten", { envFile: paths.envFile }));
  }

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
    throw new LaneConfigError(t("laneConfig.err.laneNotFound", { lane, confFile: paths.confFile }));
  }
  return { lane, confPath: paths.confFile, conf: parseLaneConf(text), text };
}

/**
 * `adde lane rm` — 레인 conf 삭제. 부재 시 에러.
 * 기본은 conf 만 지우고 state/queue 등 부수 데이터는 보존한다.
 * purge 면 레인의 state/queue/processing/out 디렉터리까지 삭제한다(고아 데이터 정리).
 */
export async function laneRemove(
  proj: string,
  lane: string,
  opts: LaneRemoveOptions = {},
): Promise<LaneRemoveResult> {
  assertName("proj", proj);
  assertName("lane", lane);
  const base = opts.base ?? defaultBase();
  const paths = lanePaths(base, proj, lane);
  try {
    await unlink(paths.confFile);
  } catch {
    throw new LaneConfigError(t("laneConfig.err.laneNotFound", { lane, confFile: paths.confFile }));
  }
  const purged = opts.purge === true;
  if (purged) {
    // conf 제거 후 부수 데이터 정리 — 경로는 lanePaths(안전 세그먼트 검증 완료)에서 파생.
    for (const dir of [paths.stateDir, paths.queueDir, paths.processingDir, paths.outDir]) {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return { lane, confPath: paths.confFile, purged };
}

/**
 * `adde proj rm` — 프로젝트 디렉터리(<base>/<proj>) 전체 삭제(lanes.d + state + queue + processing + out).
 * 부재 시 에러. 파괴적이므로 CLI 계층이 실행 중 레인 확인·사용자 확인을 선행한다.
 */
export async function projRemove(
  proj: string,
  opts: LaneCommandBaseOptions = {},
): Promise<ProjRemoveResult> {
  assertName("proj", proj);
  const base = opts.base ?? defaultBase();
  const projDir = join(base, proj);
  if (!(await exists(projDir))) {
    throw new LaneConfigError(t("proj.notFound", { proj, path: projDir }));
  }
  await rm(projDir, { recursive: true, force: true });
  return { proj, path: projDir };
}
