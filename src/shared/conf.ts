/**
 * 레인 .conf 파싱 (INI 형식).
 * 계약 03 §7: source/backend/engine/channel/perm_tier/acp_version/allowlist/denylist.
 * 누락 필드 기본값 적용, 알 수 없는 키 무시(forward-compat).
 * cwd: 레인별 엔진 작업 폴더(프로젝트 폴더 매핑). 미지정 시 슈퍼바이저 실행 cwd.
 * markdown 전용: root/inbox/approvals/outbox. chat_id: telegram 회신 대상.
 */

export interface LaneConf {
  source: string;
  backend: string;
  engine: string;
  channel: string;
  perm_tier: string;
  acp_version: string;
  allowlist: string[];
  /** perm_tier=autopass 에서 채널 승인으로 폴백할 도구명 목록(그 외 도구는 자동 허용). */
  denylist: string[];
  /** 레인별 엔진 작업 폴더(절대경로). 미지정 시 undefined → 슈퍼바이저 cwd. */
  cwd?: string;
  /** telegram 회신 대상 chat id (문자열 보존, 어댑터가 숫자 변환). */
  chat_id?: string;
  /** markdown 루트 디렉터리(절대경로, 예: Obsidian vault). */
  root?: string;
  /** markdown 입력 노트(root 상대). */
  inbox?: string;
  /** markdown 승인 노트(root 상대). 미지정 시 inbox 형제 approvals.md. */
  approvals?: string;
  /** markdown 출력 디렉터리(root 상대). 미지정 시 inbox 형제 out/. */
  outbox?: string;
  /** 레인별 채널 메시지 로케일(en|ko). 미지정 시 전역 로케일. */
  lang?: string;
  /**
   * telegram 인바운드 발신자 허용 목록(CSV, 숫자 user/chat id). chat_id 와 합쳐 authorizedIds 구성.
   * 그룹/멀티 발신자 확장용. 미지정+chat_id 부재 시 인바운드 fail-closed(전부 무시).
   */
  allow_from?: string;
  /**
   * 상태·출력·큐 디렉터리 권한 모드. private=0700(기본, 소유자 전용) / shared=0755(다중 사용자 열람 허용).
   * 미지정 시 private(secure-by-default).
   */
  file_mode?: string;
}

export function parseLaneConf(text: string): LaneConf {
  const conf: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1).trim();
    if (key) conf[key] = value;
  }

  const parseToolList = (raw: string): string[] =>
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const result: LaneConf = {
    source: conf["source"] ?? "",
    backend: conf["backend"] ?? "",
    engine: conf["engine"] ?? "",
    channel: conf["channel"] ?? "",
    perm_tier: conf["perm_tier"] ?? "acp",
    acp_version: conf["acp_version"] ?? "v1",
    allowlist: parseToolList(conf["allowlist"] ?? ""),
    denylist: parseToolList(conf["denylist"] ?? ""),
  };

  // optional 필드는 존재할 때만 채운다(부재 = undefined).
  for (const key of OPTIONAL_KEYS) {
    const value = conf[key];
    if (value !== undefined && value.length > 0) {
      result[key] = value;
    }
  }

  return result;
}

/** parse/serialize 가 공유하는 optional 키 목록(순서 = 직렬화 순서). */
const OPTIONAL_KEYS = [
  "cwd",
  "chat_id",
  "root",
  "inbox",
  "approvals",
  "outbox",
  "lang",
  "allow_from",
  "file_mode",
] as const;

/**
 * LaneConf → .conf INI 텍스트 직렬화. parseLaneConf 의 역연산.
 * 필수 키는 항상, optional 키는 값이 있을 때만, allowlist 는 비어있지 않을 때만 출력.
 * parseLaneConf(serializeLaneConf(c)) 는 c 와 동치(round-trip 안정).
 */
export function serializeLaneConf(conf: LaneConf): string {
  const lines: string[] = [
    `source=${conf.source}`,
    `backend=${conf.backend}`,
    `engine=${conf.engine}`,
    `channel=${conf.channel}`,
    `perm_tier=${conf.perm_tier}`,
    `acp_version=${conf.acp_version}`,
  ];
  if (conf.allowlist.length > 0) lines.push(`allowlist=${conf.allowlist.join(",")}`);
  if (conf.denylist.length > 0) lines.push(`denylist=${conf.denylist.join(",")}`);
  for (const key of OPTIONAL_KEYS) {
    const value = conf[key];
    if (value !== undefined && value.length > 0) lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}
