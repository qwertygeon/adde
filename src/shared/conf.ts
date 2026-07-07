/**
 * 레인 .conf 파싱 (INI 형식).
 * 공통 키는 최상위 평면(source/backend/engine/perm_tier/acp_version/allow·deny·hard_deny/cwd/lang/file_mode).
 * 어댑터 전용 키는 `<source-id>.<field>` 네임스페이스 — markdown.root/inbox/approvals/outbox,
 * telegram.chat_id/allow_from. 새 어댑터는 서브타입 1개 + NAMESPACE_FIELDS 라우팅 1줄로 확장된다.
 * 알 수 없는 키 무시(forward-compat — 구 conf 의 channel= 등).
 */

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
   * 전송된(`✅ sent`) 세그먼트 본문을 이관할 아카이브 파일(root 상대, 옵트인).
   * 지정 시 전송 시점에 본문을 이 파일로 이관하고 inbox 에선 `✅ sent` 마커만 남긴다(24h 성장 억제).
   * 미지정 시 자동 아카이브 OFF(본문 잔존 — 현행 동작). 수동 `🗄️ archive` 라벨은 미지정 시 기본 파일로 동작.
   */
  archive?: string;
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
}

/** 공통 optional 키(최상위 평면) — 순서 = 직렬화 순서. */
const COMMON_OPTIONAL_KEYS = ["cwd", "lang", "file_mode"] as const;

/**
 * 어댑터 네임스페이스별 필드 목록(`<ns>.<field>`). 파서·직렬화 공용 SoT.
 * 새 어댑터 추가 = 여기에 한 줄 + LaneConf 서브타입 1개.
 */
const NAMESPACE_FIELDS = {
  markdown: ["root", "inbox", "approvals", "outbox", "archive"],
  telegram: ["chat_id", "allow_from"],
} as const;

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

/** raw .conf 텍스트를 key→value 맵으로(주석·공백 제외, 첫 `=` 기준 분할). */
function parseKeyValues(text: string): Record<string, string> {
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
    acp_version: conf["acp_version"] ?? "v1",
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
  for (const [ns, fields] of Object.entries(NAMESPACE_FIELDS)) {
    const sub: Record<string, string> = {};
    for (const field of fields) {
      const value = conf[`${ns}.${field}`];
      if (value !== undefined && value.length > 0) sub[field] = value;
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
      Record<string, string> | undefined;
    if (!sub) continue;
    for (const field of fields) {
      const value = sub[field];
      if (value !== undefined && value.length > 0) lines.push(`${ns}.${field}=${value}`);
    }
  }
  return lines.join("\n") + "\n";
}
