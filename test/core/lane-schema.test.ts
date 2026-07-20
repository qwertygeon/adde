import { describe, expect, it } from "vitest";
import {
  LANE_KEY_DESCRIPTORS,
  findDescriptor,
  exposedEditableKeys,
  exposedEditFlags,
  dotOnlyEditableKeys,
  suggestKeys,
  NAMESPACE_FIELDS,
} from "../../src/core/lane-schema.js";

// 003-lane-settings-commands — 편집 표면 스키마 ↔ conf.ts 파서 정합 + 파생 헬퍼.

describe("스키마↔conf.ts 필드 정합", () => {
  it("모든 네임스페이스 서술자의 field 는 conf.ts NAMESPACE_FIELDS 에 존재한다(파서 지원)", () => {
    for (const d of LANE_KEY_DESCRIPTORS) {
      if (d.namespace === null) continue;
      const fields = NAMESPACE_FIELDS[d.namespace] as readonly string[];
      expect(fields, `${d.key} 네임스페이스 필드 목록`).toContain(d.field);
    }
  });

  it("canonical key = namespace 접두(있으면) + field", () => {
    for (const d of LANE_KEY_DESCRIPTORS) {
      expect(d.key).toBe(d.namespace ? `${d.namespace}.${d.field}` : d.field);
    }
  });
});

describe("노출 편집 표면", () => {
  it("현행 편집 키 + markdown 그룹이 모두 노출 편집 키에 포함된다", () => {
    const keys = new Set(exposedEditableKeys());
    for (const k of [
      "perm_tier",
      "allowlist",
      "denylist",
      "hard_deny",
      "cwd",
      "engine_args",
      "lang",
      "file_mode",
      "telegram.chat_id",
      "telegram.allow_from",
      "markdown.root",
      "markdown.inbox",
      "markdown.approvals",
      "markdown.outbox",
      "markdown.archive",
      "markdown.backup",
      "markdown.retention_days",
      "markdown.out_retention_days",
      "markdown.sync_provider",
    ]) {
      expect(keys.has(k), `${k} 노출 편집 키 누락`).toBe(true);
    }
  });

  it("내부 노브·정체성은 노출·편집되지 않는다(최소 표면)", () => {
    for (const k of ["source", "backend", "engine", "acp_version", "auto_relaunch", "gate_timeout_sec"]) {
      const d = findDescriptor(k);
      expect(d?.editable, `${k} editable`).toBe(false);
      expect(d?.exposed, `${k} exposed`).toBe(false);
    }
    expect(findDescriptor("acp_version")?.identity).toBe(true);
    expect(findDescriptor("source")?.identity).toBe(true);
  });

  it("dotOnlyEditableKeys 는 명명 플래그가 없는 markdown 그룹만(신규 노출 키)", () => {
    expect(new Set(dotOnlyEditableKeys())).toEqual(
      new Set([
        "markdown.archive",
        "markdown.backup",
        "markdown.retention_days",
        "markdown.out_retention_days",
        "markdown.sync_provider",
      ]),
    );
  });

  it("exposedEditFlags 는 14개 기존 명명 플래그", () => {
    expect(exposedEditFlags().length).toBe(14);
  });
});

describe("suggestKeys", () => {
  it("오타(markdown.retention_day)에 대해 근접 키를 제안한다", () => {
    expect(suggestKeys("markdown.retention_day")).toContain("markdown.retention_days");
  });
  it("근접하지 않은 입력은 제안 없음", () => {
    expect(suggestKeys("zzzzzzzzzzzz")).toEqual([]);
  });
});
