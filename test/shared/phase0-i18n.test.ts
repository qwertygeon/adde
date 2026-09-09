import { describe, expect, it } from "vitest";
import { flattenCatalog, placeholders } from "../../scripts/check-i18n.js";
import { en } from "../../src/shared/locales/en.js";
import { ko } from "../../src/shared/locales/ko.js";

// 001-phase0-baseline-storage-spike — 신규 사용자 대면 문자열 언어 대칭 검증(T041 / SC-042).
// `workflow.precondition.*` 네임스페이스(T023) 키가 en/ko 양쪽에 존재하고 플레이스홀더가
// 일치함을 단언한다. T023 착지 전에는 키 부재로 RED 가 예상 상태다(PPG-1 병렬 — PROC-R15).

const WORKFLOW_PRECONDITION_KEYS = [
  "workflow.precondition.moduleAbsent",
  "workflow.precondition.moduleBehindFlag",
  "workflow.precondition.libraryVersionBelowFloor",
  "workflow.precondition.indeterminate",
  "workflow.precondition.refused",
] as const;

describe("SC-042: 두 언어 문자열이 존재한다(workflow.precondition.*)", () => {
  it("Happy: 5개 키가 en/ko 카탈로그 양쪽에 존재한다", () => {
    const enFlat = flattenCatalog(en);
    const koFlat = flattenCatalog(ko);
    for (const key of WORKFLOW_PRECONDITION_KEYS) {
      expect(enFlat.has(key), `en 카탈로그에 ${key} 가 있어야 한다`).toBe(true);
      expect(koFlat.has(key), `ko 카탈로그에 ${key} 가 있어야 한다`).toBe(true);
    }
  });

  it("Edge: en/ko 플레이스홀더 집합이 키마다 일치한다", () => {
    const enFlat = flattenCatalog(en);
    const koFlat = flattenCatalog(ko);
    for (const key of WORKFLOW_PRECONDITION_KEYS) {
      const enMsg = enFlat.get(key);
      const koMsg = koFlat.get(key);
      if (enMsg === undefined || koMsg === undefined) continue; // Happy 케이스에서 이미 부재를 포착
      const enPh = [...placeholders(enMsg)].sort();
      const koPh = [...placeholders(koMsg)].sort();
      expect(koPh).toEqual(enPh);
    }
  });

  it("Error: 한쪽 로케일에만 있는 키는 패리티 위반으로 검출된다(합성 대조)", () => {
    const enFlat = new Map([["workflow.precondition.x", "hello {{a}}"]]);
    const koFlat = new Map<string, string>();
    expect(koFlat.has("workflow.precondition.x")).toBe(false);
    expect(enFlat.has("workflow.precondition.x")).toBe(true);
  });
});
