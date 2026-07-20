/**
 * 레인 편집 표면 스키마(SoT) — `shared/conf.ts`(파서 SoT) 위에 덧입히는 레이어.
 * conf.ts 는 파서 관대성(forward-compat)을 유지하고, 스키마는 그 위에 "편집 표면" 차원만 얹는다:
 * editable/identity/required/exposed/type/enum/label/flag. config·편집 명령·위저드에서만 lazy import
 * 되어 CLI 기동(spec.ts eager) 비용을 늘리지 않는다.
 *
 * 노출 범위(exposed:true) = 현행 편집 키(perm_tier·allowlist·denylist·hard_deny·cwd·engine_args·
 * lang·file_mode·chat_id·allow_from·root·inbox·approvals·outbox) + markdown 그룹(archive·backup·
 * retention_days·out_retention_days·sync_provider). 정체성(source/backend/engine/acp_version)·내부
 * 노브(auto_relaunch·gate_timeout_sec)는 exposed:false(최소 표면·no-new-surface 정적테스트 존중).
 */
import { NAMESPACE_FIELDS } from "../shared/conf.js";

/** 편집 값 종류 — set-시점 자기완결 검증(타입/enum/format) 분기. */
export type LaneFieldType = "string" | "int" | "path" | "enum" | "csv";

/** 키가 적용되는 소스 — common(전 소스) 또는 특정 어댑터. 교차소스 거부의 근거. */
export type AppliesTo = "common" | "markdown" | "telegram";

/** 편집 표면 키 서술자. */
export interface LaneKeyDescriptor {
  /** 점표기 canonical key(예: "perm_tier" | "markdown.retention_days"). conf 원시 키와 동일. */
  key: string;
  /** 어댑터 네임스페이스(top-level 키는 null). */
  namespace: "markdown" | "telegram" | null;
  /** 네임스페이스(또는 top-level) 내 필드명. */
  field: string;
  type: LaneFieldType;
  appliesTo: AppliesTo;
  /** `lane set`/위저드로 편집 가능한가. */
  editable: boolean;
  /** 정체성 필드(source/backend/engine/acp_version) — 편집·unset 거부(재생성 필요). */
  identity: boolean;
  /** 필수 필드 — unset 거부(소비측 기본값이 없어 제거하면 동작 불가). */
  required: boolean;
  /** 편집 표면(위저드·점표기 편집·--defaults 열거·정적 게이트)에 노출되는가. */
  exposed: boolean;
  /** 소비측 기본값(있으면 show 메타의 default). */
  default?: string | number;
  /** enum 허용값(type=enum). */
  enumValues?: readonly string[];
  /** 기존 명명 플래그(하위호환 — LaneSetOptions 필드 = field). 없으면 점표기 전용(신규 markdown 그룹). */
  flag?: string;
  /** 위저드/show 라벨 i18n 키. */
  i18nLabel: string;
}

/** 편집 표면 스키마 — 단일 SoT. 명명 플래그·점표기·위저드·정적 게이트가 전부 여기서 파생된다. */
export const LANE_KEY_DESCRIPTORS: readonly LaneKeyDescriptor[] = [
  // ── 정체성(편집 불가) ─────────────────────────────────────────────
  { key: "source", namespace: null, field: "source", type: "enum", appliesTo: "common", editable: false, identity: true, required: true, exposed: false, enumValues: ["markdown", "telegram"], flag: "--source", i18nLabel: "lane.prompt.source" }, // prettier-ignore
  { key: "backend", namespace: null, field: "backend", type: "string", appliesTo: "common", editable: false, identity: true, required: true, exposed: false, flag: "--backend", i18nLabel: "lane.prompt.source" }, // prettier-ignore
  { key: "engine", namespace: null, field: "engine", type: "string", appliesTo: "common", editable: false, identity: true, required: true, exposed: false, flag: "--engine", i18nLabel: "lane.prompt.source" }, // prettier-ignore
  { key: "acp_version", namespace: null, field: "acp_version", type: "string", appliesTo: "common", editable: false, identity: true, required: true, exposed: false, flag: "--acp-version", i18nLabel: "lane.prompt.source" }, // prettier-ignore
  // ── 내부 노브(편집 불가·미노출) ──────────────────────────────────
  { key: "auto_relaunch", namespace: null, field: "auto_relaunch", type: "string", appliesTo: "common", editable: false, identity: false, required: true, exposed: false, i18nLabel: "lane.prompt.source" }, // prettier-ignore
  { key: "gate_timeout_sec", namespace: null, field: "gate_timeout_sec", type: "int", appliesTo: "common", editable: false, identity: false, required: false, exposed: false, i18nLabel: "lane.prompt.source" }, // prettier-ignore
  // ── 공통 편집 키 ─────────────────────────────────────────────────
  { key: "perm_tier", namespace: null, field: "perm_tier", type: "enum", appliesTo: "common", editable: true, identity: false, required: false, exposed: true, default: "acp", enumValues: ["acp", "autopass"], flag: "--perm-tier", i18nLabel: "lane.prompt.permTier" }, // prettier-ignore
  { key: "allowlist", namespace: null, field: "allowlist", type: "csv", appliesTo: "common", editable: true, identity: false, required: false, exposed: true, flag: "--allowlist", i18nLabel: "lane.prompt.allowlist" }, // prettier-ignore
  { key: "denylist", namespace: null, field: "denylist", type: "csv", appliesTo: "common", editable: true, identity: false, required: false, exposed: true, flag: "--denylist", i18nLabel: "lane.prompt.denylist" }, // prettier-ignore
  { key: "hard_deny", namespace: null, field: "hard_deny", type: "csv", appliesTo: "common", editable: true, identity: false, required: false, exposed: true, flag: "--hard-deny", i18nLabel: "lane.prompt.hardDeny" }, // prettier-ignore
  { key: "cwd", namespace: null, field: "cwd", type: "path", appliesTo: "common", editable: true, identity: false, required: false, exposed: true, flag: "--cwd", i18nLabel: "lane.prompt.cwd" }, // prettier-ignore
  { key: "engine_args", namespace: null, field: "engine_args", type: "string", appliesTo: "common", editable: true, identity: false, required: false, exposed: true, flag: "--engine-args", i18nLabel: "lane.prompt.engineArgs" }, // prettier-ignore
  { key: "lang", namespace: null, field: "lang", type: "enum", appliesTo: "common", editable: true, identity: false, required: false, exposed: true, enumValues: ["en", "ko"], flag: "--lang", i18nLabel: "lane.prompt.lang" }, // prettier-ignore
  { key: "file_mode", namespace: null, field: "file_mode", type: "enum", appliesTo: "common", editable: true, identity: false, required: false, exposed: true, default: "private", enumValues: ["private", "shared"], flag: "--file-mode", i18nLabel: "lane.prompt.fileMode" }, // prettier-ignore
  // ── telegram 전용 편집 키 ────────────────────────────────────────
  { key: "telegram.chat_id", namespace: "telegram", field: "chat_id", type: "string", appliesTo: "telegram", editable: true, identity: false, required: false, exposed: true, flag: "--chat-id", i18nLabel: "lane.prompt.chatId" }, // prettier-ignore
  { key: "telegram.allow_from", namespace: "telegram", field: "allow_from", type: "csv", appliesTo: "telegram", editable: true, identity: false, required: false, exposed: true, flag: "--allow-from", i18nLabel: "lane.prompt.allowFrom" }, // prettier-ignore
  // ── markdown 전용 편집 키 ────────────────────────────────────────
  { key: "markdown.root", namespace: "markdown", field: "root", type: "path", appliesTo: "markdown", editable: true, identity: false, required: true, exposed: true, flag: "--root", i18nLabel: "lane.prompt.root" }, // prettier-ignore
  { key: "markdown.inbox", namespace: "markdown", field: "inbox", type: "path", appliesTo: "markdown", editable: true, identity: false, required: true, exposed: true, flag: "--inbox", i18nLabel: "lane.prompt.inbox" }, // prettier-ignore
  { key: "markdown.approvals", namespace: "markdown", field: "approvals", type: "path", appliesTo: "markdown", editable: true, identity: false, required: false, exposed: true, flag: "--approvals", i18nLabel: "lane.prompt.approvals" }, // prettier-ignore
  { key: "markdown.outbox", namespace: "markdown", field: "outbox", type: "path", appliesTo: "markdown", editable: true, identity: false, required: false, exposed: true, flag: "--outbox", i18nLabel: "lane.prompt.outbox" }, // prettier-ignore
  { key: "markdown.archive", namespace: "markdown", field: "archive", type: "path", appliesTo: "markdown", editable: true, identity: false, required: false, exposed: true, i18nLabel: "lane.prompt.archive" }, // prettier-ignore
  { key: "markdown.backup", namespace: "markdown", field: "backup", type: "path", appliesTo: "markdown", editable: true, identity: false, required: false, exposed: true, i18nLabel: "lane.prompt.backup" }, // prettier-ignore
  { key: "markdown.retention_days", namespace: "markdown", field: "retention_days", type: "int", appliesTo: "markdown", editable: true, identity: false, required: false, exposed: true, default: 2, i18nLabel: "lane.prompt.retentionDays" }, // prettier-ignore
  { key: "markdown.out_retention_days", namespace: "markdown", field: "out_retention_days", type: "int", appliesTo: "markdown", editable: true, identity: false, required: false, exposed: true, i18nLabel: "lane.prompt.outRetentionDays" }, // prettier-ignore
  { key: "markdown.sync_provider", namespace: "markdown", field: "sync_provider", type: "enum", appliesTo: "markdown", editable: true, identity: false, required: false, exposed: true, default: "local", enumValues: ["local", "icloud"], i18nLabel: "lane.prompt.syncProvider" }, // prettier-ignore
];

/** canonical key → 서술자 조회. */
export function findDescriptor(key: string): LaneKeyDescriptor | undefined {
  return LANE_KEY_DESCRIPTORS.find((d) => d.key === key);
}

/** 편집 표면에 노출되는 편집 가능 키(canonical) — 위저드 순회·--defaults 열거·정적 게이트 SoT. */
export function exposedEditableKeys(): string[] {
  return LANE_KEY_DESCRIPTORS.filter((d) => d.exposed && d.editable).map((d) => d.key);
}

/**
 * 명명 플래그가 없는 노출 편집 키(점표기 전용 — markdown 그룹) — usage 문서화 정합 체크용.
 * 이 키들은 위치 점표기로만 편집되어 플래그 정규식 드리프트 검사가 닿지 않으므로, usage 텍스트에
 * canonical 이름이 문서화됐는지를 별도 정적 체크가 대조한다(check-usage-drift keyDocIssues).
 */
export function dotOnlyEditableKeys(): string[] {
  return LANE_KEY_DESCRIPTORS.filter(
    (d) => d.exposed && d.editable && d.flag === undefined,
  ).map((d) => d.key);
}

/** 노출 편집 키에 대응하는 기존 명명 플래그 목록(정적 게이트 파생 대조용). */
export function exposedEditFlags(): string[] {
  return LANE_KEY_DESCRIPTORS.filter((d) => d.exposed && d.editable && d.flag !== undefined).map(
    (d) => d.flag!,
  );
}

/**
 * 미지 키에 대한 유사 편집 키 제안(editDistance) — 노출 편집 키 중 임계 이하 근접 이름.
 * suggestCommands(spec.ts) 패턴 준용.
 */
export function suggestKeys(input: string, max = 2): string[] {
  return exposedEditableKeys()
    .map((key) => ({ key, d: editDistance(input, key) }))
    .filter(({ key, d }) => d <= Math.max(2, Math.floor(key.length / 2)))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((s) => s.key);
}

/** Levenshtein 편집거리(오타 제안용, 소규모 문자열 전용). spec.ts editDistance 와 동일 로직. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}

/** 스키마↔conf.ts 파서 정합 확인용 — 네임스페이스 필드 SoT 재노출(정적 테스트가 대조). */
export { NAMESPACE_FIELDS };
