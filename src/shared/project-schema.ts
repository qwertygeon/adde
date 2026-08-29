/**
 * 프로젝트 설정 편집 표면 스키마(SoT, ADR-028) — 현행 `core/lane-schema.ts` 의 서술자 구조를
 * 개명 이식. `project set/--unset`·증분 `--add-*`/`--rm-*`·`project show [--defaults]` 가 전부 이
 * 파생을 소비한다. 편집은 `applyEdits` 로 전건 검증 후에만 적용.
 */
import type { ProjectConf } from "./conf.js";

export type ProjectFieldType = "string" | "int" | "bool" | "path" | "enum" | "csv";

export interface ProjectKeyDescriptor {
  /** canonical key(ProjectConf 필드명과 동일). */
  key: string;
  type: ProjectFieldType;
  /** `project set`/`--unset` 로 편집 가능한가. */
  editable: boolean;
  /** 정체성 필드(vault 등) — 편집·unset 거부. */
  identity: boolean;
  required: boolean;
  /** 편집 표면(`project show --defaults`·정적 게이트)에 노출되는가. */
  exposed: boolean;
  default?: string | number | boolean;
  enumValues?: readonly string[];
  /** 목록형 키(allowlist 등) — `--add-*`/`--rm-*` 증분 편집 대상. */
  isList?: boolean;
}

export const PROJECT_KEY_DESCRIPTORS: readonly ProjectKeyDescriptor[] = [
  { key: "vault", type: "path", editable: false, identity: true, required: true, exposed: true },
  { key: "cwd", type: "path", editable: true, identity: false, required: false, exposed: true },
  {
    key: "engine",
    type: "string",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: "acp",
  },
  {
    key: "engine_args",
    type: "string",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
  },
  {
    key: "perm_tier",
    type: "enum",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: "acp",
    enumValues: ["acp", "autopass"],
  },
  {
    key: "allowlist",
    type: "csv",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    isList: true,
  },
  {
    key: "denylist",
    type: "csv",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    isList: true,
  },
  {
    key: "hard_deny",
    type: "csv",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    isList: true,
  },
  {
    key: "gate_timeout_sec",
    type: "int",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: 600,
  },
  {
    key: "lang",
    type: "enum",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    enumValues: ["en", "ko"],
  },
  {
    key: "file_mode",
    type: "enum",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: "private",
    enumValues: ["private", "shared"],
  },
  {
    key: "auto_restart",
    type: "bool",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: true,
  },
  {
    key: "auto_resume",
    type: "bool",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: true,
  },
  {
    key: "idle_hibernate",
    type: "bool",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: true,
  },
  {
    key: "hibernate_after_min",
    type: "int",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: 30,
  },
  {
    key: "idle_stop",
    type: "bool",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: true,
  },
  {
    key: "stop_after_min",
    type: "int",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: 60,
  },
  {
    key: "max_active_engines",
    type: "int",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: 3,
  },
  {
    key: "auto_relaunch",
    type: "bool",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: true,
  },
  {
    key: "markdown.palette",
    type: "bool",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: true,
  },
  {
    key: "markdown.records_cap",
    type: "int",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
  },
  {
    key: "markdown.notices_cap",
    type: "int",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: 10,
  },
  {
    key: "vault.backup",
    type: "path",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
  },
  {
    key: "vault.retention_days",
    type: "int",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: 2,
  },
  {
    key: "vault.sync_provider",
    type: "enum",
    editable: true,
    identity: false,
    required: false,
    exposed: true,
    default: "local",
    enumValues: ["local", "icloud"],
  },
];

export function findDescriptor(key: string): ProjectKeyDescriptor | undefined {
  return PROJECT_KEY_DESCRIPTORS.find((d) => d.key === key);
}

export function exposedEditableKeys(): string[] {
  return PROJECT_KEY_DESCRIPTORS.filter((d) => d.exposed && d.editable).map((d) => d.key);
}

/**
 * `project set` 은 명명 플래그가 아니라 위치 `<key> <value>` 로 임의 키를 편집한다(v1 의 lane-schema
 * 와 달리 per-key 플래그가 없음) — 노출 편집 키 전부가 "점표기 전용" 문서화 대조 대상이다
 * (check-usage-drift.ts 의 keyDocIssues 가 `usage.project` 본문에 canonical 이름 등장을 강제).
 */
export function dotOnlyEditableKeys(): string[] {
  return exposedEditableKeys();
}

export interface KeyEdit {
  key: string;
  /** set(값 지정) · unset(해제) · add(목록 항목 추가) · remove(목록 항목 제거). */
  op: "set" | "unset" | "add" | "remove";
  value?: string;
}

function parseTyped(descriptor: ProjectKeyDescriptor, raw: string): unknown {
  switch (descriptor.type) {
    case "int": {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n)) throw new Error(`값이 정수가 아닙니다: "${raw}"`);
      return n;
    }
    case "bool":
      if (raw !== "true" && raw !== "false")
        throw new Error(`값이 boolean(true|false)이 아닙니다: "${raw}"`);
      return raw === "true";
    case "enum":
      if (descriptor.enumValues && !descriptor.enumValues.includes(raw)) {
        throw new Error(`알 수 없는 값 "${raw}" — 허용: ${descriptor.enumValues.join(", ")}`);
      }
      return raw;
    case "csv":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    default:
      return raw;
  }
}

/**
 * 편집을 전건 검증 후 적용한다 — 미지 키·무효 값·정체성 필드 편집이 하나라도 있으면 **전체 거부**
 * 하고 원본 conf 를 그대로 반환한다(FR-042·SC-059, 부분 적용 없음).
 */
export function applyEdits(
  conf: ProjectConf,
  edits: readonly KeyEdit[],
): { conf: ProjectConf; errors: string[] } {
  const errors: string[] = [];
  const draft = { ...conf } as unknown as Record<string, unknown>;

  for (const edit of edits) {
    const descriptor = findDescriptor(edit.key);
    if (!descriptor) {
      errors.push(`알 수 없는 키 "${edit.key}"`);
      continue;
    }
    if (!descriptor.editable || descriptor.identity) {
      errors.push(`"${edit.key}" 는 편집할 수 없습니다(정체성 필드).`);
      continue;
    }
    if (edit.op === "unset") {
      if (descriptor.required) {
        errors.push(`"${edit.key}" 는 필수 필드라 해제할 수 없습니다.`);
        continue;
      }
      delete draft[edit.key];
      continue;
    }
    if (edit.op === "add" || edit.op === "remove") {
      if (!descriptor.isList) {
        errors.push(`"${edit.key}" 는 목록형이 아니라 --add-*/--rm-* 를 지원하지 않습니다.`);
        continue;
      }
      if (edit.value === undefined) {
        errors.push(`"${edit.key}" 증분 편집에는 값이 필요합니다.`);
        continue;
      }
      const current = Array.isArray(draft[edit.key]) ? [...(draft[edit.key] as string[])] : [];
      if (edit.op === "add") {
        if (!current.includes(edit.value)) current.push(edit.value);
      } else {
        const idx = current.indexOf(edit.value);
        if (idx >= 0) current.splice(idx, 1);
      }
      draft[edit.key] = current;
      continue;
    }
    // op === "set"
    if (edit.value === undefined) {
      errors.push(`"${edit.key}" 편집에는 값이 필요합니다.`);
      continue;
    }
    try {
      draft[edit.key] = parseTyped(descriptor, edit.value);
    } catch (err) {
      errors.push(`"${edit.key}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0) return { conf, errors };
  return { conf: draft as unknown as ProjectConf, errors: [] };
}
