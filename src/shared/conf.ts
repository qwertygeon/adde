/**
 * 프로젝트 설정(project.conf) 파싱 (INI 형식, v2 — 레인 conf 폐기).
 * 최상위 평면 키만 사용한다(레인 3분해로 어댑터 네임스페이스 키가 사라짐 — `vault.*`/`markdown.*` 만 예외적
 * 네임스페이스로 남는다). 알 수 없는 키는 무시(forward-compat).
 */

import { readFile } from "node:fs/promises";
import { normalizeUserPath, projectPaths } from "./paths.js";
import { assertBackupNotOverlapping } from "../record/retention.js";

export const ACP_VERSION = "v1";

/** `perm_tier` 허용값(project-schema.ts 의 enumValues 와 동형 — 파서 자체는 순수하게 두고
 * 경로 상호참조 검증(validateProjectConf)에서 강제한다). */
export const PERM_TIERS = ["acp", "autopass"] as const;

/** project.conf 파싱·직렬화 결과(design.md §데이터 모델 표와 1:1). */
export interface ProjectConf {
  v: 1;
  /** 마크다운 저장소 루트(절대경로) — 필수. 파싱 단계에서 부재는 오류(FR-028). */
  vault: string;
  /** 프로젝트 실행 경로. 미지정 시 소비측이 `process.cwd()` 로 해석(파서는 미지정을 undefined 로 보존). */
  cwd?: string;
  /** 세션 생성 시 기본 엔진 id(`ENGINE_IDS` 검증은 소비측 — T008 이후 배선). */
  engine: string;
  /** 세션 생성 시 기본 엔진 CLI 인자(raw 문자열, 공백 분리는 소비측). */
  engine_args?: string;
  /** 권한 티어(`acp` 기본|`autopass`). */
  perm_tier: string;
  acp_version: string;
  allowlist: string[];
  denylist: string[];
  hard_deny: string[];
  gate_timeout_sec?: number;
  lang?: string;
  file_mode?: string;
  /** 무인 자동 재기동(launchd KeepAlive) — 기본 on. */
  auto_restart: boolean;
  /** 데몬(재)기동 시 `active` 세션 자동 재개 — 기본 on(FR-006·FR-011). */
  auto_resume: boolean;
  /** 유휴 세션 자동 내림 — 기본 on(FR-009·FR-011). */
  idle_hibernate: boolean;
  /** 유휴 내림 임계(분) — 기본 30(FR-009). */
  hibernate_after_min: number;
  /** 동시 상주 엔진 상한 — 기본 3(FR-010). */
  max_active_engines: number;
  /** 엔진 예기치 않은 종료 시 자가 재기동 — 기본 on(FR-044). */
  auto_relaunch: boolean;
  /** 입력 노트 팔레트 표시 — 기본 on(FR-024·FR-038). */
  "markdown.palette": boolean;
  /** 기록 존 자동 상한(옵트인 정수) — 미지정 시 끔(FR-039). */
  "markdown.records_cap"?: number;
  /** 보관 위치(옵트인 경로) — 미지정 시 보관 이관 비활성(FR-033·NFR-009). */
  "vault.backup"?: string;
  /** 보관 일수 — 기본 2(FR-033). */
  "vault.retention_days": number;
  /** 동기화 제공자 id(`local`|`icloud`) — 기본 local(FR-035). */
  "vault.sync_provider": string;
  /** 무효 값 폴백·미지원 키 감지 등 파싱 중 경고(SC-011 Edge·SC-043 Error — 침묵 처리 금지). 없으면 빈 배열. */
  warnings: string[];
}

/** 최상위 optional 키(부재 시 undefined 로 보존) — 순서 = 직렬화 순서. */
const OPTIONAL_KEYS = ["cwd", "engine_args", "lang", "file_mode"] as const;

/** raw .conf 텍스트를 key→value 맵으로(주석·공백 제외, 첫 `=` 기준 분할). */
export function parseKeyValues(text: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key) kv[key] = value;
  }
  return kv;
}

/** 값이 없는(undefined/빈문자) optional 키를 채우지 않는 헬퍼 — exactOptionalPropertyTypes 대응. */
function setIfPresent<T extends object, K extends keyof T>(
  obj: T,
  key: K,
  value: string | undefined,
  transform: (v: string) => T[K],
): void {
  if (value !== undefined && value.length > 0) obj[key] = transform(value);
}

/** 양의 정수만 채택(무효/0/음수는 무시 → 소비측 기본값 폴백). */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** `<base>/projects/<proj>/project.conf` 최상위 키 SoT — 미지 키 감지(SC-043 Error)에 쓰인다. */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  "v",
  "vault",
  "cwd",
  "engine",
  "engine_args",
  "perm_tier",
  "acp_version",
  "allowlist",
  "denylist",
  "hard_deny",
  "gate_timeout_sec",
  "lang",
  "file_mode",
  "auto_restart",
  "auto_resume",
  "idle_hibernate",
  "hibernate_after_min",
  "max_active_engines",
  "auto_relaunch",
  "markdown.palette",
  "markdown.records_cap",
  "vault.backup",
  "vault.retention_days",
  "vault.sync_provider",
]);

/** 값이 제공됐으나(존재+비어있지 않음) `parsePositiveInt` 가 거부한 경우에만 경고를 남긴다
 * (미지정은 정상 기본값 사용이라 경고 대상이 아니다 — SC-011 Happy 무경고 유지). */
function warnIfInvalidPositiveInt(warnings: string[], key: string, raw: string | undefined): void {
  if (raw === undefined || raw.length === 0) return;
  if (parsePositiveInt(raw) === undefined) {
    warnings.push(`"${key}"=${raw} 는 유효한 양의 정수가 아니어서 기본값으로 폴백했습니다.`);
  }
}

/** 명시 "false" 만 OFF — 부재·true·빈값·무효값은 전부 ON(default-on, forward-compat). */
function parseBoolDefaultOn(raw: string | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() !== "false";
}

/** 명시 "off"/"false" 만 OFF — 부재·on·true·빈값·무효값은 전부 ON(enum on|off 필드의 default-on). */
function parseOnOffDefaultOn(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v !== "off" && v !== "false";
}

export class ProjectConfParseError extends Error {
  override name = "ProjectConfParseError";
}

/**
 * project.conf 텍스트 파싱 → ProjectConf. `vault` 부재·빈값은 파싱 단계에서 오류(FR-028·SC-028 —
 * 프로젝트 생성 거부는 호출측이 이 오류를 그대로 표면화한다. 임의 기본 위치를 만들지 않는다).
 */
export function parseProjectConf(text: string): ProjectConf {
  const kv = parseKeyValues(text);

  const vaultRaw = kv["vault"];
  if (vaultRaw === undefined || vaultRaw.length === 0) {
    throw new ProjectConfParseError(
      "project.conf: vault 는 필수입니다(임의 기본 위치를 생성하지 않습니다).",
    );
  }

  const parseToolList = (raw: string): string[] =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const warnings: string[] = [];
  for (const key of Object.keys(kv)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`알 수 없는 키 "${key}" — 무시되었습니다(스펙 범위 외, 침묵 활성화 없음).`);
    }
  }
  warnIfInvalidPositiveInt(warnings, "hibernate_after_min", kv["hibernate_after_min"]);
  warnIfInvalidPositiveInt(warnings, "max_active_engines", kv["max_active_engines"]);
  warnIfInvalidPositiveInt(warnings, "gate_timeout_sec", kv["gate_timeout_sec"]);
  warnIfInvalidPositiveInt(warnings, "vault.retention_days", kv["vault.retention_days"]);
  warnIfInvalidPositiveInt(warnings, "markdown.records_cap", kv["markdown.records_cap"]);

  const result: ProjectConf = {
    v: 1,
    vault: normalizeUserPath(vaultRaw),
    engine: kv["engine"] ?? "",
    perm_tier: kv["perm_tier"] ?? "acp",
    acp_version: kv["acp_version"] ?? ACP_VERSION,
    allowlist: parseToolList(kv["allowlist"] ?? ""),
    denylist: parseToolList(kv["denylist"] ?? ""),
    hard_deny: parseToolList(kv["hard_deny"] ?? ""),
    auto_restart: parseBoolDefaultOn(kv["auto_restart"]),
    auto_resume: parseBoolDefaultOn(kv["auto_resume"]),
    idle_hibernate: parseBoolDefaultOn(kv["idle_hibernate"]),
    hibernate_after_min: parsePositiveInt(kv["hibernate_after_min"]) ?? 30,
    max_active_engines: parsePositiveInt(kv["max_active_engines"]) ?? 3,
    auto_relaunch: parseBoolDefaultOn(kv["auto_relaunch"]),
    "markdown.palette": parseOnOffDefaultOn(kv["markdown.palette"]),
    "vault.retention_days": parsePositiveInt(kv["vault.retention_days"]) ?? 2,
    "vault.sync_provider": kv["vault.sync_provider"] ?? "local",
    warnings,
  };

  for (const key of OPTIONAL_KEYS) {
    setIfPresent(result, key, kv[key], (v) => (key === "cwd" ? normalizeUserPath(v) : v));
  }
  const gateTimeoutSec = parsePositiveInt(kv["gate_timeout_sec"]);
  if (gateTimeoutSec !== undefined) result.gate_timeout_sec = gateTimeoutSec;
  const recordsCap = parsePositiveInt(kv["markdown.records_cap"]);
  if (recordsCap !== undefined) result["markdown.records_cap"] = recordsCap;
  setIfPresent(result, "vault.backup", kv["vault.backup"], (v) => normalizeUserPath(v));

  return result;
}

/**
 * ProjectConf → .conf INI 텍스트 직렬화. parseProjectConf 의 역연산(round-trip 안정).
 * 기본값과 같은 optional 은 미출력해 churn 을 0으로 유지한다.
 */
export function serializeProjectConf(conf: ProjectConf): string {
  const lines: string[] = [`v=${conf.v}`, `vault=${conf.vault}`];
  if (conf.cwd !== undefined && conf.cwd.length > 0) lines.push(`cwd=${conf.cwd}`);
  lines.push(`engine=${conf.engine}`);
  if (conf.engine_args !== undefined && conf.engine_args.length > 0) {
    lines.push(`engine_args=${conf.engine_args}`);
  }
  lines.push(`perm_tier=${conf.perm_tier}`, `acp_version=${conf.acp_version}`);
  if (conf.allowlist.length > 0) lines.push(`allowlist=${conf.allowlist.join(",")}`);
  if (conf.denylist.length > 0) lines.push(`denylist=${conf.denylist.join(",")}`);
  if (conf.hard_deny.length > 0) lines.push(`hard_deny=${conf.hard_deny.join(",")}`);
  if (conf.gate_timeout_sec !== undefined) lines.push(`gate_timeout_sec=${conf.gate_timeout_sec}`);
  if (conf.lang !== undefined && conf.lang.length > 0) lines.push(`lang=${conf.lang}`);
  if (conf.file_mode !== undefined && conf.file_mode.length > 0) {
    lines.push(`file_mode=${conf.file_mode}`);
  }
  if (conf.auto_restart === false) lines.push(`auto_restart=false`);
  if (conf.auto_resume === false) lines.push(`auto_resume=false`);
  if (conf.idle_hibernate === false) lines.push(`idle_hibernate=false`);
  if (conf.hibernate_after_min !== 30)
    lines.push(`hibernate_after_min=${conf.hibernate_after_min}`);
  if (conf.max_active_engines !== 3) lines.push(`max_active_engines=${conf.max_active_engines}`);
  if (conf.auto_relaunch === false) lines.push(`auto_relaunch=false`);
  if (conf["markdown.palette"] === false) lines.push(`markdown.palette=off`);
  if (conf["markdown.records_cap"] !== undefined) {
    lines.push(`markdown.records_cap=${conf["markdown.records_cap"]}`);
  }
  if (conf["vault.backup"] !== undefined && conf["vault.backup"].length > 0) {
    lines.push(`vault.backup=${conf["vault.backup"]}`);
  }
  if (conf["vault.retention_days"] !== 2) {
    lines.push(`vault.retention_days=${conf["vault.retention_days"]}`);
  }
  if (conf["vault.sync_provider"] !== "local") {
    lines.push(`vault.sync_provider=${conf["vault.sync_provider"]}`);
  }
  return lines.join("\n") + "\n";
}

/** `project.conf` 를 읽어 파싱. */
export async function readProjectConf(projectConfPath: string): Promise<ProjectConf> {
  const text = await readFile(projectConfPath, "utf8");
  return parseProjectConf(text);
}

/**
 * 경로 상호 참조가 필요한 검증(엔진 화이트리스트·보관 위치 겹침) — 파서 자체는 순수하게 두고
 * 이 함수를 CLI(`project add`/`project set`)가 호출한다. 위반 시 오류 메시지 배열(비면 통과).
 */
export function validateProjectConf(
  conf: ProjectConf,
  ctx: { base: string; proj: string; engineIds: readonly string[] },
): string[] {
  const errors: string[] = [];
  if (conf.engine.length > 0 && !ctx.engineIds.includes(conf.engine)) {
    errors.push(`알 수 없는 엔진 id "${conf.engine}" — 지원: ${ctx.engineIds.join(", ")}`);
  }
  if (!(PERM_TIERS as readonly string[]).includes(conf.perm_tier)) {
    errors.push(`알 수 없는 권한 티어 "${conf.perm_tier}" — 허용: ${PERM_TIERS.join(", ")}`);
  }
  if (conf["vault.backup"] !== undefined) {
    try {
      assertBackupNotOverlapping(
        conf["vault.backup"],
        conf.vault,
        projectPaths(ctx.base, ctx.proj).root,
        conf.cwd ?? process.cwd(),
      );
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return errors;
}
