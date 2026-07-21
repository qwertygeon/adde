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
  parseKeyValues,
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
import { LANE_KEY_DESCRIPTORS, findDescriptor, suggestKeys } from "./lane-schema.js";
import type { LaneKeyDescriptor } from "./lane-schema.js";
import { lanePaths, defaultBase, expandTilde, normalizeUserPath } from "../shared/paths.js";
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
 * `adde lane set` 편집 가능 필드 — `lane add` 에서 정체성(source/backend/engine/acp_version)·
 * token·safe_defaults·force 를 제외한 부분집합.
 */
export interface LaneSetOptions extends LaneCommandBaseOptions {
  perm_tier?: string;
  allowlist?: string[];
  denylist?: string[];
  hard_deny?: string[];
  cwd?: string;
  engine_args?: string;
  lang?: string;
  file_mode?: string;
  chat_id?: string;
  allow_from?: string;
  root?: string;
  inbox?: string;
  approvals?: string;
  outbox?: string;
  /**
   * 점표기 canonical key → raw 문자열 값 편집(위치인자 CLI·프로그램적 일반화 경로).
   * 명명 플래그(위 typed 필드)와 병존 — 둘 다 스키마 confPath 기반 제네릭 적용으로 수렴한다.
   * 타입/enum/format 검증은 스키마(parseSchemaValue)가 set-시점에 하드 거부한다.
   */
  edits?: ReadonlyArray<{ key: string; value: string }>;
  /** 제거할 canonical key 목록(--unset) — 소비측 기본값 복원. 필수·identity 는 거부. */
  unset?: readonly string[];
}

/** 편집 적용 후 conf 필드에 담기는 값(리스트는 배열, 정수는 number, 나머지는 문자열). */
type EditValue = string | number | string[];

export interface LaneSetResult {
  lane: string;
  confPath: string;
  conf: LaneConf;
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
 * 편집된 전체 conf 재검증(laneAdd 인라인 검증 추출) — 실패 시 `LaneConfigError` throw,
 * 통과 시 무반환. `laneAdd`·`laneSet` 공유 — 검증 발산 방지.
 *
 * 검증 순서는 laneAdd baseline 특성화(동시 무효값 시 첫 throw 종류)를 그대로 재현한다(research.md 참조):
 * chat_id → token(telegram 전용) → allow_from(telegram 전용) → file_mode →
 * allowlist → denylist → hard_deny → engine_args → validateEngineWiring → descriptor.validate.
 * format 검증(chat_id·file_mode·allowlist·denylist·hard_deny)은 조립된 conf 필드를 읽는다(assembly 가
 * 무효값도 그대로 싣기 때문에 opts 읽기와 동치). 교차소스 가드(token·allow_from telegram 전용)만
 * `ctx.opts`+`conf.source` 로 판정한다(laneSet 은 병합 conf 로부터 opts-형 객체를 구성해 전달).
 */
export function validateLaneConf(
  conf: LaneConf,
  ctx?: { token?: string; opts?: LaneAddOptions },
): void {
  const chatId = conf.telegram?.chat_id;
  if (chatId !== undefined && chatId !== "" && !CHAT_ID_RE.test(chatId)) {
    throw new LaneConfigError(t("laneConfig.err.badChatId", { chatId }));
  }
  if (ctx?.token !== undefined && conf.source !== "telegram") {
    throw new LaneConfigError(t("laneConfig.err.tokenOnlyTelegram"));
  }
  const allowFrom = ctx?.opts?.allow_from;
  if (allowFrom !== undefined && allowFrom !== "" && conf.source !== "telegram") {
    throw new LaneConfigError(t("laneConfig.err.allowFromOnlyTelegram"));
  }
  if (
    conf.file_mode !== undefined &&
    !(KNOWN_FILE_MODES as readonly string[]).includes(conf.file_mode)
  ) {
    throw new LaneConfigError(
      t("laneConfig.err.badFileMode", {
        mode: conf.file_mode,
        known: KNOWN_FILE_MODES.join("|"),
      }),
    );
  }
  for (const tool of conf.allowlist) {
    if (!ALLOWLIST_ITEM_RE.test(tool)) {
      throw new LaneConfigError(t("laneConfig.err.badAllowTool", { tool }));
    }
  }
  for (const entry of conf.denylist) {
    if (entry.includes(",") || !parseDenyEntry(entry)) {
      throw new LaneConfigError(t("laneConfig.err.badDenyEntry", { entry }));
    }
  }
  for (const entry of conf.hard_deny) {
    if (entry.includes(",") || !parseDenyEntry(entry)) {
      throw new LaneConfigError(t("laneConfig.err.badDenyEntry", { entry }));
    }
  }
  if (conf.engine_args) {
    try {
      parseEngineArgs(conf.engine_args);
    } catch (err) {
      if (err instanceof EngineArgsParseError) {
        throw new LaneConfigError(t("laneConfig.err.invalidEngineArgs", { reason: err.message }));
      }
      throw err;
    }
  }
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
  const validated = SOURCE_REGISTRY[conf.source]?.validate?.({
    conf,
    token: ctx?.token,
    opts: ctx?.opts ?? {},
  }) ?? { errors: [], warnings: [] };
  if (validated.errors.length > 0) {
    throw new LaneConfigError(validated.errors[0]!);
  }
}

// ── 스키마 기반 제네릭 편집(점표기 confPath) ────────────────────────────────
// 명명 플래그(typed LaneSetOptions)와 점표기 위치인자 편집을 canonical key 로 통합해 conf 에 적용한다.
// 스키마가 단일 SoT — 두 경로가 같은 confPath 로 수렴하므로 드리프트가 없다(하위호환 동작 보존).
// telegram/markdown 전용 필드가 타 소스 레인에 지정되면 assertKeyApplicable 이 거부한다(FR-006).

/**
 * 편집 대상 key 를 해석한다 — 점표기 편집·unset 공용. identity 는 재생성 안내, 미노출/미지 키는
 * 유사키 제안과 함께 거부(FR-005). 통과하면 노출 편집 가능 서술자를 반환.
 */
function resolveSettableDescriptor(key: string): LaneKeyDescriptor {
  const d = findDescriptor(key);
  if (d?.identity) {
    throw new LaneConfigError(t("laneConfig.err.identityFieldImmutable", { field: key }));
  }
  if (!d || !d.exposed || !d.editable) {
    const suggestions = suggestKeys(key);
    throw new LaneConfigError(
      suggestions.length > 0
        ? t("laneConfig.err.unknownKeyDidYouMean", { key, suggestions: suggestions.join(", ") })
        : t("laneConfig.err.unknownKey", { key }),
    );
  }
  return d;
}

/** 점표기 raw 문자열 값을 스키마 타입으로 파싱·set-시점 검증(자기완결: 타입/enum/format). */
function parseSchemaValue(d: LaneKeyDescriptor, raw: string): EditValue {
  switch (d.type) {
    case "csv":
      return parseCsv(raw);
    case "int": {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) {
        throw new LaneConfigError(t("laneConfig.err.badIntValue", { key: d.key, value: raw }));
      }
      return n;
    }
    case "enum":
      if (!(d.enumValues ?? []).includes(raw)) {
        throw new LaneConfigError(
          t("laneConfig.err.badEnumValue", {
            key: d.key,
            value: raw,
            allowed: (d.enumValues ?? []).join("|"),
          }),
        );
      }
      return raw;
    case "path":
      return normalizeUserPath(raw);
    case "string":
      return raw;
  }
}

/** canonical key 가 conf.source 에 적용 가능한지 — 교차소스 편집 하드 거부(FR-006). */
function assertKeyApplicable(source: string, key: string): void {
  const d = findDescriptor(key);
  if (!d || d.appliesTo === "common") return;
  if (d.appliesTo !== source) {
    throw new LaneConfigError(t("laneConfig.err.sourceFieldMismatch", { field: key, source }));
  }
}

/** 편집 값(EditValue)을 서술자의 confPath(top-level | ns.field)에 제자리 적용. */
function applyConfValue(conf: LaneConf, d: LaneKeyDescriptor, value: EditValue): void {
  const target = conf as unknown as Record<string, unknown>;
  if (d.namespace) {
    const sub = { ...((target[d.namespace] as Record<string, unknown> | undefined) ?? {}) };
    sub[d.field] = value;
    target[d.namespace] = sub;
  } else {
    target[d.field] = value;
  }
}

/**
 * 서술자 키를 conf 에서 제거해 소비측 기본값을 복원한다. 리스트는 빈 배열(serialize 가 생략),
 * 비-optional top-level(perm_tier)은 파서 기본값으로 복원(직렬화가 항상 쓰므로 delete 불가),
 * 그 외 optional·네임스페이스 필드는 삭제(부재 = 기본값). 필수·identity 거부는 호출부 책임.
 */
function unsetConfValue(conf: LaneConf, d: LaneKeyDescriptor): void {
  const target = conf as unknown as Record<string, unknown>;
  if (d.namespace) {
    const sub = target[d.namespace] as Record<string, unknown> | undefined;
    if (sub && typeof sub === "object") {
      delete sub[d.field];
      if (Object.keys(sub).length === 0) delete target[d.namespace];
    }
    return;
  }
  if (d.type === "csv") {
    target[d.field] = [];
  } else if (d.field === "perm_tier") {
    // 파서가 항상 채우는 비-optional 필드 — 삭제하면 serialize 가 undefined 를 쓴다. 기본값 복원.
    conf.perm_tier = (d.default as string) ?? "acp";
  } else {
    delete target[d.field];
  }
}

/** conf 에서 서술자 키의 현재값을 읽는다(부재 = undefined) — lane show 메타용. */
function readConfValue(conf: LaneConf, d: LaneKeyDescriptor): EditValue | undefined {
  const src = conf as unknown as Record<string, unknown>;
  const raw = d.namespace
    ? (src[d.namespace] as Record<string, unknown> | undefined)?.[d.field]
    : src[d.field];
  return raw as EditValue | undefined;
}

/** `lane show <key>` 메타 — value·default·explicit·editable·identity(FR-004, SC-008). */
export interface LaneKeyMeta {
  key: string;
  value: EditValue | null;
  default: string | number | null;
  /** conf 에 명시 기록된 키인가(원시 텍스트 기준 — 파서 기본값 채움과 무관). */
  explicit: boolean;
  editable: boolean;
  identity: boolean;
}

/**
 * conf(파싱본) + 원시 텍스트로부터 키 메타를 구성한다. explicit 은 원시 conf 키 존재로 판정해
 * 파서가 항상 채우는 기본값(perm_tier 등)과 명시 설정을 구분한다. 미지 키는 undefined.
 */
export function laneKeyMeta(conf: LaneConf, rawText: string, key: string): LaneKeyMeta | undefined {
  const d = findDescriptor(key);
  if (!d) return undefined;
  const rawKv = parseKeyValues(rawText);
  const value = readConfValue(conf, d);
  return {
    key: d.key,
    value: value ?? null,
    default: d.default ?? null,
    explicit: rawKv[d.key] !== undefined,
    editable: d.editable,
    identity: d.identity,
  };
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
  if (opts.engine_args) conf.engine_args = opts.engine_args;
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

  // 검증 통과 후에만 디스크에 쓴다(validate-then-commit, 파일 상단 원칙) — 쓰기 이전에 호출.
  // laneSet 과 공유하는 단일 검증 경로 — 실패 시 throw, 통과 시 무반환.
  // exactOptionalPropertyTypes: token 이 undefined 면 키 자체를 생략(명시 undefined 대입 금지).
  validateLaneConf(conf, { opts, ...(opts.token !== undefined ? { token: opts.token } : {}) });
  // 검증 헬퍼는 warnings 를 반환하지 않으므로(순수 통과/거부), 사전 검증 경고 수집을 위해
  // descriptor.validate 를 재호출한다(입력 동일 → 결과 결정적, 재호출 비용은 conf 1회 편집 규모에서 무시 가능).
  const validated = SOURCE_REGISTRY[source]?.validate?.({ conf, token: opts.token, opts }) ?? {
    errors: [],
    warnings: [],
  };

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

/**
 * `adde lane set` — 기존 레인 conf 제자리 편집(삭제·재생성 없음). `laneAdd` 를 경유하지
 * 않는다 — `LaneAddOptions` 에 `gate_timeout_sec` 이 없고 `auto_relaunch` 를 항상 true 로 강제해
 * 경유 시 수기 설정을 드롭·되돌리기 때문. 흐름: 로딩 → no-op 가드 → 교차소스 거부 →
 * overlay(지정 필드만) → autopass denylist 자동충전 → 재검증 → validate-then-commit 원자 쓰기.
 */
export async function laneSet(
  proj: string,
  lane: string,
  edits: LaneSetOptions = {},
): Promise<LaneSetResult> {
  assertName("proj", proj);
  assertName("lane", lane);

  const base = edits.base ?? defaultBase();
  const paths = lanePaths(base, proj, lane);
  let text: string;
  try {
    text = await readFile(paths.confFile, "utf8");
  } catch {
    throw new LaneConfigError(t("laneConfig.err.laneNotFound", { lane, confFile: paths.confFile }));
  }
  const conf = parseLaneConf(text);

  // canonical key → 적용값 통합: typed 명명 플래그(하위호환) + 점표기 edits + unset.
  const setValues = new Map<string, EditValue>();
  const unsetKeys = new Set<string>();

  // typed 명명 플래그 → canonical. 값은 이미 타입 확정(리스트=배열/그 외=문자열).
  for (const d of LANE_KEY_DESCRIPTORS) {
    if (d.flag === undefined) continue;
    const v = (edits as Record<string, unknown>)[d.field];
    if (v !== undefined) setValues.set(d.key, v as EditValue);
  }
  // 점표기 위치인자 편집(raw 문자열) → 스키마 검증·파싱(set-시점 하드 거부).
  for (const e of edits.edits ?? []) {
    const d = resolveSettableDescriptor(e.key);
    setValues.set(d.key, parseSchemaValue(d, e.value));
  }
  // unset — identity/미노출/미지 거부(resolveSettableDescriptor) + 필수 거부.
  for (const key of edits.unset ?? []) {
    const d = resolveSettableDescriptor(key);
    if (d.required) throw new LaneConfigError(t("laneConfig.err.requiredUnset", { key: d.key }));
    unsetKeys.add(d.key);
  }

  if (setValues.size === 0 && unsetKeys.size === 0) {
    throw new LaneConfigError(t("laneConfig.err.noEdits"));
  }

  // 교차소스 하드 거부(FR-006) — 편집·제거 대상 전 키(공용 검증 밖 — laneAdd 동작 불변 유지).
  for (const key of [...setValues.keys(), ...unsetKeys]) assertKeyApplicable(conf.source, key);

  // file_mode private→shared 완화 인지 경고 대비 — 적용 전 이전 모드 캡처.
  const prevFileMode = resolveFileMode(conf.file_mode);
  // hard_deny 치환 footgun 경고 — 기존 값이 있는데 치환될 때만.
  const hardDenyReplaced = setValues.has("hard_deny") && conf.hard_deny.length > 0;

  // 제네릭 적용 — 스키마 confPath 기반. 네임스페이스는 미편집 서브필드(archive/backup 등) 보존 병합.
  for (const [key, value] of setValues) applyConfValue(conf, findDescriptor(key)!, value);
  for (const key of unsetKeys) unsetConfValue(conf, findDescriptor(key)!);

  const fileModeRelaxed =
    setValues.has("file_mode") &&
    prevFileMode === "private" &&
    resolveFileMode(conf.file_mode) === "shared";

  // perm_tier→autopass denylist 자동충전 — laneAdd 의 동일 로직과 일관. denylist 를 명시
  // 편집(set/unset)하지 않았고 기존이 비었을 때만.
  if (
    conf.perm_tier === "autopass" &&
    !setValues.has("denylist") &&
    !unsetKeys.has("denylist") &&
    conf.denylist.length === 0
  ) {
    conf.denylist = [...DEFAULT_AUTOPASS_DENYLIST];
  }

  // telegram descriptor 형식 검증 대비 opts-형 구성 — 병합 conf 의 telegram 값을 opts 로 매핑
  // (telegram descriptor 가 conf 가 아니라 input.opts.chat_id/allow_from 로 형식 검증하기 때문).
  const opts: LaneAddOptions = {
    ...(conf.telegram?.chat_id !== undefined ? { chat_id: conf.telegram.chat_id } : {}),
    ...(conf.telegram?.allow_from !== undefined ? { allow_from: conf.telegram.allow_from } : {}),
  };

  // 재검증 — 실패 시 throw, 디스크 미기록(validate-then-commit).
  validateLaneConf(conf, { opts });
  // 검증 헬퍼는 warnings 를 반환하지 않으므로(순수 통과/거부), 사전 검증 경고 수집을 위해
  // descriptor.validate 를 재호출한다(laneAdd 와 동일 패턴).
  const validated = SOURCE_REGISTRY[conf.source]?.validate?.({ conf, opts }) ?? {
    errors: [],
    warnings: [],
  };

  await writeAtomic(paths.confFile, serializeLaneConf(conf));

  const warnings = [...validated.warnings, ...(await collectAddWarnings(conf))];
  if (hardDenyReplaced) warnings.push(t("laneConfig.warn.hardDenyReplaced"));
  if (fileModeRelaxed) warnings.push(t("laneConfig.warn.fileModeRelaxNotice"));

  return { lane, confPath: paths.confFile, conf, warnings };
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
