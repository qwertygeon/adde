/**
 * 레인 .conf 파싱 (INI 형식).
 * 공통 키는 최상위 평면(source/backend/engine/perm_tier/acp_version/allow·deny·hard_deny/cwd/lang/file_mode).
 * 어댑터 전용 키는 `<source-id>.<field>` 네임스페이스 — markdown.root/inbox/approvals/outbox,
 * telegram.chat_id/allow_from. 새 어댑터는 서브타입 1개 + NAMESPACE_FIELDS 라우팅 1줄로 확장된다.
 * 알 수 없는 키 무시(forward-compat — 구 conf 의 channel= 등).
 */

import { readFile } from "node:fs/promises";
import { projConfPath } from "./paths.js";

/** markdown 어댑터 전용 설정(`markdown.*` 키). */
export interface MarkdownLaneConf {
  /** markdown 루트 디렉터리(절대경로, 예: Obsidian vault). */
  root?: string;
  /** 입력 노트(root 상대). */
  inbox?: string;
  /** 승인 노트 디렉터리(root 상대). 미지정 시 inbox 형제 approvals/. */
  approvals?: string;
  /** 출력 디렉터리(root 상대). 미지정 시 inbox 형제 out/. */
  outbox?: string;
  /**
   * 전송된(`✅ sent`) 세그먼트 본문을 이관할 아카이브 디렉터리(root 상대, 옵트인).
   * 지정 시 전송 시점에 본문을 이 디렉터리 하위 날짜 파일로 이관하고 inbox 에선 `✅ sent` 마커만
   * 남긴다(24h 성장 억제). 미지정 시 자동 아카이브 OFF(본문 잔존 — 현행 동작). 수동 `🗄️ archive`
   * 라벨은 미지정 시 기본 디렉터리로 동작. 기존(v0.1.4 이하) 단일 파일 해석에서 디렉터리 해석으로
   * 진화 — 기존 단일 파일은 최초 활성화 시 백업으로 통째 이관된다(마이그레이션 하이브리드).
   */
  archive?: string;
  /** 로컬 백업 폴더 경로(옵트인 — 미지정 시 일간 이관 기능 off). vault 밖·절대·타 볼륨 허용. */
  backup?: string;
  /** 이관 기준일(캘린더일, 옵트인). 미지정 시 소비측(resolvePaths) 기본값 2 적용 — 파서는 미지정을 undefined 로 보존. */
  retention_days?: number;
  /** state out/ prune 안전창(캘린더일, 옵트인 — 미지정 시 prune off). 활성 시 retention_days+1 이상이어야 한다(기동 검증). */
  out_retention_days?: number;
  /** 동기화 제공자 id(`local`|`icloud`). 미지정 시 소비측 기본 `local`. 미지원 값은 기동 검증에서 거부(fail-closed). */
  sync_provider?: string;
}

/** telegram 어댑터 전용 설정(`telegram.*` 키). */
export interface TelegramLaneConf {
  /** 회신 대상 chat id (문자열 보존, 어댑터가 숫자 변환). */
  chat_id?: string;
  /**
   * 인바운드 발신자 허용 목록(CSV, 숫자 user/chat id). chat_id 와 합쳐 authorizedIds 구성.
   * 그룹/멀티 발신자 확장용. 미지정+chat_id 부재 시 인바운드 fail-closed(전부 무시).
   */
  allow_from?: string;
}

export interface LaneConf {
  source: string;
  backend: string;
  engine: string;
  perm_tier: string;
  acp_version: string;
  allowlist: string[];
  /** perm_tier=autopass 에서 채널 승인으로 폴백할 도구명 목록(그 외 도구는 자동 허용). */
  denylist: string[];
  /**
   * 방어심화 하드-거부 목록 — 매칭 도구는 티어 무관하게 즉시 거부(채널 승인 프롬프트도 없음).
   * denylist(autopass 에서 "물어봄")보다 강함. acp 티어의 실수 승인 방지용. `Tool`/`Tool(글롭)` 형식.
   */
  hard_deny: string[];
  /** 레인별 엔진 작업 폴더(절대경로). 미지정 시 undefined → 슈퍼바이저 cwd. */
  cwd?: string;
  /** 레인별 채널 메시지 로케일(en|ko). 미지정 시 전역 로케일. */
  lang?: string;
  /**
   * 상태·출력·큐 디렉터리 권한 모드. private=0700(기본, 소유자 전용) / shared=0755(다중 사용자 열람 허용).
   * 미지정 시 private(secure-by-default).
   */
  file_mode?: string;
  /**
   * 게이트 승인 대기 타임아웃(초, 옵트인). 미지정 시 기본 600초(DEFAULT_GATE_TIMEOUT_MS).
   * 초과 시 fail-closed deny. 사람 승인 레인은 길게, 자동화 레인은 짧게 조정 가능.
   */
  gate_timeout_sec?: number;
  /** markdown 어댑터 전용 설정(`markdown.*` 키). 관련 키가 없으면 undefined. */
  markdown?: MarkdownLaneConf;
  /** telegram 어댑터 전용 설정(`telegram.*` 키). 관련 키가 없으면 undefined. */
  telegram?: TelegramLaneConf;
  /**
   * 자가 재기동(self-recovery) 활성 여부. 기본 true(ON) — 명시 `false` 일 때만 OFF.
   * 파서가 부재·무효값을 전부 true 로 해석해 상시 채우는 필수 필드(하위호환·forward-compat).
   */
  auto_relaunch: boolean;
  /**
   * 레인별 엔진 CLI 인자(raw 문자열, 공백 분리). 미지정 시 엔진 spawn 은 빈 인자.
   * 따옴표(`"`·`'`) 포함 값은 parseEngineArgs 가 파싱 실패로 거부한다.
   */
  engine_args?: string;
}

/** 공통 optional 키(최상위 평면) — 순서 = 직렬화 순서. engine_args 는 신규 추가라 말미. */
const COMMON_OPTIONAL_KEYS = ["cwd", "lang", "file_mode", "engine_args"] as const;

/**
 * 엔진/백엔드 배선 SoT — 값 검증·기본값 해석·acp_version 단일 소스.
 * 2번째 엔진 실착수 계획이 없어 KNOWN_* 는 현재 단일 값만 갖는다(레지스트리 추상화 미도입 — 미사용 확장 배제).
 */
export const DEFAULT_ENGINE = "claude-agent-acp";
export const DEFAULT_BACKEND = "acp";
export const KNOWN_ENGINES = ["claude-agent-acp"] as const;
export const KNOWN_BACKENDS = ["acp"] as const;
/** acp_version 표시 라벨 단일 소스 — `acp.PROTOCOL_VERSION` 파생값과 정적 단언 테스트로 drift 를 잡는다. */
export const ACP_VERSION = "v1";

/** engine 미지정·빈값 → 안전 기본값(DEFAULT_ENGINE). 생성 계층·기동 계층이 이 헬퍼를 공유해 기본값 모순을 없앤다. */
export function resolveEngine(engine: string | undefined): string {
  return engine && engine.length > 0 ? engine : DEFAULT_ENGINE;
}

/** backend 미지정·빈값 → 안전 기본값(DEFAULT_BACKEND). resolveEngine 과 동일 패턴. */
export function resolveBackend(backend: string | undefined): string {
  return backend && backend.length > 0 ? backend : DEFAULT_BACKEND;
}

/**
 * engine/backend 화이트리스트 검증(순수 함수, i18n 비의존) — resolveEngine/resolveBackend 적용 후
 * KNOWN_ENGINES/KNOWN_BACKENDS 에 없으면 위반 코드·값을 반환, 통과하면 null.
 * 호출자(supervisor·lane-config)가 결과 코드를 i18n 메시지로 포맷한다(기동 시 검증이 권위 지점 — 파서 내부 검증은 forward-compat 철학과 충돌).
 */
export function validateEngineWiring(
  conf: LaneConf,
): { code: "engine"; value: string } | { code: "backend"; value: string } | null {
  const engine = resolveEngine(conf.engine);
  if (!(KNOWN_ENGINES as readonly string[]).includes(engine)) {
    return { code: "engine", value: engine };
  }
  const backend = resolveBackend(conf.backend);
  if (!(KNOWN_BACKENDS as readonly string[]).includes(backend)) {
    return { code: "backend", value: backend };
  }
  return null;
}

/** engine_args 파싱 실패(따옴표 포함 등 미지원 형식) — 흡수 금지, 호출자가 spawn 전에 거부한다. */
export class EngineArgsParseError extends Error {
  override name = "EngineArgsParseError";
}

/**
 * engine_args raw 문자열 → argv 배열(공백 분리). 미지정/빈값/공백-only → `[]`.
 * 값에 따옴표(`"`·`'`)가 포함되면 조용한 오분할(`"a b"`→`["a`,`b"]`) 대신 거부한다(fail-closed).
 * 개행·NUL 도 거부한다: conf 는 줄 단위 평면 포맷(값 이스케이프 없음)이라, 개행이 든 값은
 * serialize→재파싱 시 뒷부분이 별개 conf 키(hard_deny/perm_tier 등)로 주입돼 권한 게이트를 우회한다.
 */
export function parseEngineArgs(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  if (/[\n\r\0]/.test(raw)) {
    // 값을 에러 메시지에 담지 않는다(주입 페이로드 로그 노출 방지).
    throw new EngineArgsParseError("engine_args contains unsupported control characters (newline/NUL)");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.includes('"') || trimmed.includes("'")) {
    throw new EngineArgsParseError(`engine_args contains unsupported quote characters: ${trimmed}`);
  }
  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * 어댑터 네임스페이스별 필드 목록(`<ns>.<field>`). 파서·직렬화 공용 SoT.
 * 새 어댑터 추가 = 여기에 한 줄 + LaneConf 서브타입 1개.
 */
const NAMESPACE_FIELDS = {
  markdown: [
    "root",
    "inbox",
    "approvals",
    "outbox",
    "archive",
    "backup",
    "retention_days",
    "out_retention_days",
    "sync_provider",
  ],
  telegram: ["chat_id", "allow_from"],
} as const;

/**
 * 네임스페이스 필드 중 정수로 파싱하는 필드(그 외는 문자열) — gate_timeout_sec 선례(conf.ts 상단
 * `Number.parseInt`+`isFinite&&>0`) 준용. retention_days 기본값 2 는 소비측(resolvePaths)에서
 * 적용하며 여기선 미지정을 undefined 로 보존한다.
 */
const NAMESPACE_INT_FIELDS = new Set(["retention_days", "out_retention_days"]);

/**
 * 구 평면 어댑터 키(네임스페이스 이전 포맷). 클린 브레이크로 값은 읽지 않으며(무시),
 * detectLegacyAdapterKeys 가 감지해 마이그레이션 경고에만 쓴다.
 */
const LEGACY_ADAPTER_KEYS = [
  "root",
  "inbox",
  "approvals",
  "outbox",
  "chat_id",
  "allow_from",
] as const;

/** raw .conf 텍스트를 key→value 맵으로(주석·공백 제외, 첫 `=` 기준 분할). proj.conf 파서(export)와 공유하는 SoT. */
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

export function parseLaneConf(text: string): LaneConf {
  const conf = parseKeyValues(text);

  const parseToolList = (raw: string): string[] =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const result: LaneConf = {
    source: conf["source"] ?? "",
    backend: conf["backend"] ?? "",
    engine: conf["engine"] ?? "",
    perm_tier: conf["perm_tier"] ?? "acp",
    acp_version: conf["acp_version"] ?? ACP_VERSION,
    allowlist: parseToolList(conf["allowlist"] ?? ""),
    denylist: parseToolList(conf["denylist"] ?? ""),
    hard_deny: parseToolList(conf["hard_deny"] ?? ""),
    // "false" 명시값만 OFF — 부재·true·빈값·무효값은 전부 ON(default-on, forward-compat).
    auto_relaunch: (conf["auto_relaunch"] ?? "").trim().toLowerCase() !== "false",
  };

  // 공통 optional 은 존재할 때만 채운다(부재 = undefined).
  for (const key of COMMON_OPTIONAL_KEYS) {
    const value = conf[key];
    if (value !== undefined && value.length > 0) {
      result[key] = value;
    }
  }

  // 수치 optional — 양의 정수만 채택(무효/0/음수는 무시 → 소비측 기본값).
  const gateTimeoutSec = conf["gate_timeout_sec"];
  if (gateTimeoutSec !== undefined && gateTimeoutSec.length > 0) {
    const n = Number.parseInt(gateTimeoutSec, 10);
    if (Number.isFinite(n) && n > 0) result.gate_timeout_sec = n;
  }

  // 어댑터 네임스페이스(`<ns>.<field>`) — 필드가 하나라도 있으면 서브객체 생성.
  // 정수 필드(NAMESPACE_INT_FIELDS)는 gate_timeout_sec 선례 준용(무효/0/음수는 무시).
  for (const [ns, fields] of Object.entries(NAMESPACE_FIELDS)) {
    const sub: Record<string, string | number> = {};
    for (const field of fields) {
      const value = conf[`${ns}.${field}`];
      if (value === undefined || value.length === 0) continue;
      if (NAMESPACE_INT_FIELDS.has(field)) {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) sub[field] = n;
      } else {
        sub[field] = value;
      }
    }
    if (Object.keys(sub).length > 0) {
      (result as unknown as Record<string, unknown>)[ns] = sub;
    }
  }

  return result;
}

/**
 * 구 평면 어댑터 키(root=·chat_id= 등, 네임스페이스 이전 포맷)를 감지해 반환(마이그레이션 경고용).
 * 없으면 빈 배열. 값은 파서가 무시하므로(클린 브레이크), 이 감지가 사용자에게 포맷 변경을 알리는 경로다.
 */
export function detectLegacyAdapterKeys(text: string): string[] {
  const kv = parseKeyValues(text);
  return (LEGACY_ADAPTER_KEYS as readonly string[]).filter((k) => kv[k] !== undefined);
}

/**
 * LaneConf → .conf INI 텍스트 직렬화. parseLaneConf 의 역연산.
 * 필수 키는 항상, optional 은 값이 있을 때만, 어댑터 키는 `<ns>.<field>` 로 출력.
 * parseLaneConf(serializeLaneConf(c)) 는 c 와 동치(round-trip 안정).
 */
export function serializeLaneConf(conf: LaneConf): string {
  const lines: string[] = [
    `source=${conf.source}`,
    `backend=${conf.backend}`,
    `engine=${conf.engine}`,
    `perm_tier=${conf.perm_tier}`,
    `acp_version=${conf.acp_version}`,
  ];
  if (conf.allowlist.length > 0) lines.push(`allowlist=${conf.allowlist.join(",")}`);
  if (conf.denylist.length > 0) lines.push(`denylist=${conf.denylist.join(",")}`);
  if (conf.hard_deny.length > 0) lines.push(`hard_deny=${conf.hard_deny.join(",")}`);
  // false 일 때만 출력 — true(기본)는 미출력해 round-trip·기존 conf churn 을 0으로 유지.
  if (conf.auto_relaunch === false) lines.push(`auto_relaunch=false`);
  for (const key of COMMON_OPTIONAL_KEYS) {
    const value = conf[key];
    if (value !== undefined && value.length > 0) lines.push(`${key}=${value}`);
  }
  if (conf.gate_timeout_sec !== undefined) lines.push(`gate_timeout_sec=${conf.gate_timeout_sec}`);
  for (const [ns, fields] of Object.entries(NAMESPACE_FIELDS)) {
    const sub = (conf as unknown as Record<string, unknown>)[ns] as
      Record<string, string | number> | undefined;
    if (!sub) continue;
    for (const field of fields) {
      const value = sub[field];
      if (value === undefined) continue;
      if (typeof value === "number") lines.push(`${ns}.${field}=${value}`);
      else if (value.length > 0) lines.push(`${ns}.${field}=${value}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ── proj.conf (프로젝트 수준 설정 최초 선례) ─────────────────────────────────
// 데몬은 proj 당 1개(레인이 아닌 proj 단위) — auto_restart 는 여기 둔다.

/** proj.conf 파싱 결과. */
export interface ProjConf {
  /** 무인 자동 재기동(launchd KeepAlive) 활성 여부. 기본 on — 명시 false 만 off. */
  auto_restart: boolean;
}

/**
 * proj.conf 텍스트 파싱 — `auto_relaunch` 파싱 선례 준용.
 * "false" 명시값만 OFF — 부재·true·빈값·무효값은 전부 ON(default-on, forward-compat).
 */
export function parseProjConf(text: string): ProjConf {
  const kv = parseKeyValues(text);
  return { auto_restart: (kv["auto_restart"] ?? "").trim().toLowerCase() !== "false" };
}

/** `<base>/<proj>/proj.conf` 읽어 파싱. 파일 부재 시 기본값(auto_restart=on, 하위호환). */
export async function readProjConf(base: string, proj: string): Promise<ProjConf> {
  try {
    const text = await readFile(projConfPath(base, proj), "utf8");
    return parseProjConf(text);
  } catch {
    return { auto_restart: true };
  }
}
