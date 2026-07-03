/**
 * i18n 카탈로그 패리티 검사 — `pnpm run i18n:check` (CI 게이트).
 * 키 패리티 1차 방어는 타입(`ko satisfies typeof en`)이며, 본 스크립트는
 * 타입으로 못 잡는 축을 검출한다: 보간 플레이스홀더({{var}}) 불일치·빈 문자열.
 * 키 집합 비교도 함께 수행한다(CI 가시 리포트).
 */
import { pathToFileURL } from "node:url";
import { en } from "../src/shared/locales/en.js";
import { ko } from "../src/shared/locales/ko.js";

export interface ParityIssue {
  key: string;
  kind: "missing" | "extra" | "placeholder" | "empty";
  detail: string;
}

/** 중첩 카탈로그를 `a.b.c` 평탄 키 → 문자열 맵으로 변환. */
export function flattenCatalog(obj: Record<string, unknown>, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out.set(path, value);
    } else if (value !== null && typeof value === "object") {
      for (const [k, v] of flattenCatalog(value as Record<string, unknown>, path)) {
        out.set(k, v);
      }
    }
  }
  return out;
}

/** `{{ var }}` 플레이스홀더 이름 집합 추출. */
export function placeholders(message: string): Set<string> {
  const names = new Set<string>();
  for (const m of message.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
    if (m[1]) names.add(m[1]);
  }
  return names;
}

/** base(en) 기준으로 other 로케일의 키·플레이스홀더·빈 문자열 검사. */
export function checkParity(
  base: Map<string, string>,
  other: Map<string, string>,
  otherName: string,
): ParityIssue[] {
  const issues: ParityIssue[] = [];
  for (const [key, baseMsg] of base) {
    const otherMsg = other.get(key);
    if (otherMsg === undefined) {
      issues.push({ key, kind: "missing", detail: `${otherName} 에 키 없음` });
      continue;
    }
    if (otherMsg.trim() === "") {
      issues.push({ key, kind: "empty", detail: `${otherName} 값이 빈 문자열` });
    }
    const basePh = [...placeholders(baseMsg)].sort().join(",");
    const otherPh = [...placeholders(otherMsg)].sort().join(",");
    if (basePh !== otherPh) {
      issues.push({
        key,
        kind: "placeholder",
        detail: `플레이스홀더 불일치 — en:[${basePh}] ${otherName}:[${otherPh}]`,
      });
    }
  }
  for (const key of other.keys()) {
    if (!base.has(key)) {
      issues.push({ key, kind: "extra", detail: `${otherName} 에만 있는 키` });
    }
  }
  return issues;
}

export function runCheck(): ParityIssue[] {
  const enFlat = flattenCatalog(en);
  const koFlat = flattenCatalog(ko);
  const issues = checkParity(enFlat, koFlat, "ko");
  for (const [key, msg] of enFlat) {
    if (msg.trim() === "") issues.push({ key, kind: "empty", detail: "en 값이 빈 문자열" });
  }
  return issues;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const issues = runCheck();
  if (issues.length === 0) {
    const total = flattenCatalog(en).size;
    process.stdout.write(`i18n:check OK — ${total} keys, en/ko parity clean\n`);
  } else {
    for (const issue of issues) {
      process.stderr.write(`[${issue.kind}] ${issue.key} — ${issue.detail}\n`);
    }
    process.stderr.write(`i18n:check FAIL — ${issues.length} issue(s)\n`);
    process.exitCode = 1;
  }
}
