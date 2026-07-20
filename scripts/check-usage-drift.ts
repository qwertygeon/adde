/**
 * 선언(spec.ts)↔usage 텍스트(locales) 정합 정적 검사 — `pnpm run usage:check` (CI 게이트).
 * `check-i18n.ts` 패턴(순수 함수 export + main 가드, exit 1 on issue)을 따른다.
 * 코드 생성이 아니다 — usage 설명 문구는 로케일이 계속 소유하고, 본 스크립트는 선언과의
 * 정합만(양방향) 검증한다: (a) 선언된 플래그가 대상 usage 문자열에 등장하는가,
 * (b) usage 에 등장하는 모든 플래그가 선언(또는 전역 플래그)에 존재하는가.
 */
import { pathToFileURL } from "node:url";
import { en } from "../src/shared/locales/en.js";
import { ko } from "../src/shared/locales/ko.js";
import { GLOBAL_FLAGS, findCommand, subFlagNames, flagNames } from "../src/cli/spec.js";
import { dotOnlyEditableKeys } from "../src/core/lane-schema.js";

export interface DriftIssue {
  usageKey: string;
  kind: "missing-in-usage" | "undeclared" | "missing-key";
  flag: string;
  locale: "en" | "ko";
}

/** 정합 검사 대상 — usage 카탈로그 키 + (a) 방향 대상 선언 플래그. 빈 배열이면 (a) 미적용(summary usage). */
export interface UsageCheck {
  usageKey: string;
  declaredFlags: readonly string[];
}

/** 한 로케일의 flatten 된 usage 문자열 맵. */
export interface UsageCatalog {
  locale: "en" | "ko";
  texts: Record<string, string>;
}

/** long 플래그 토큰(`--flag`) — 하이픈 포함 다단어 이름까지. */
const LONG_FLAG_RE = /--[a-z][a-z-]*/g;
/** short 플래그 토큰(`-x`) — 단어 경계(선행 word/hyphen 없음, 후행 word/hyphen 없음)만 매칭해
 * `non-interactive` 의 `-i` 같은 하이픈 복합어 내부를 오탐하지 않는다. */
const SHORT_FLAG_RE = /(?<![\w-])-[a-zA-Z](?![\w-])/g;

/**
 * 큰따옴표로 둘러싸인 예시 구간(예: `(e.g. "--model opus")`)을 제거한다 — 실제 선언된 플래그가
 * 아니라 설명문 안의 인용 예시이므로 (b) 판정에서 오탐(undeclared)을 유발하지 않게 배제한다.
 */
function stripQuotedExamples(text: string): string {
  return text.replace(/"[^"]*"/g, "");
}

/** usage 문자열에서 실제 플래그로 보이는 토큰 집합을 추출(인용 예시 배제, placeholder 는 정규식이 자연 배제). */
function extractFlagTokens(text: string): Set<string> {
  const cleaned = stripQuotedExamples(text);
  const out = new Set<string>();
  for (const m of cleaned.matchAll(LONG_FLAG_RE)) out.add(m[0]);
  for (const m of cleaned.matchAll(SHORT_FLAG_RE)) out.add(m[0]);
  return out;
}

/**
 * catalog(한 로케일의 usage 텍스트)와 checks(대상 키·선언 플래그)를 받아 양방향 위반을 반환한다.
 * (a) declaredFlags 의 각 플래그가 해당 usage 문자열의 추출 토큰 집합에 없으면 missing-in-usage.
 * (b) undeclared 판정 허용 집합은 check 종류에 따라 갈린다:
 *   - 나열식(per-command) usage(declaredFlags 비어있지 않음): `check.declaredFlags ∪ GLOBAL_FLAGS` 로
 *     좁혀 판정한다 — 전역 union 을 쓰면 이 명령에 선언되지 않고 **다른 명령에만 선언된 플래그**를
 *     usage 가 광고해도 놓친다(제거된 플래그를 타 명령 usage 가 계속 광고하는 cross-command drift 재발,
 *     016 계열). 그룹 help(usage.lane/usage.proj)도 declaredFlags 가 이미 하위 명령 union 이므로 동일
 *     좁힌 판정이 맞는다.
 *   - 요약/그룹 summary usage(declaredFlags=[] — usage.main 등 여러 명령 플래그를 한데 나열하는 문안):
 *     전역 union(모든 checks.declaredFlags 합집합 ∪ 전역 플래그) 유지 — 이 usage 는 특정 한 명령에
 *     귀속되지 않아 좁힐 기준 자체가 없다.
 * 순수 함수 — 합성 catalog/checks 주입으로 단위 검증 가능하다. main 가드는 실 카탈로그로 실행한다.
 */
export function usageDriftIssues(
  catalog: UsageCatalog,
  checks: readonly UsageCheck[],
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const globalUnion = new Set<string>(GLOBAL_FLAGS);
  for (const check of checks) {
    for (const flag of check.declaredFlags) globalUnion.add(flag);
  }

  for (const check of checks) {
    const text = catalog.texts[check.usageKey];
    if (text === undefined) continue; // 카탈로그 키 부재는 i18n:check 소관 — 본 검사 범위 아님.
    const tokens = extractFlagTokens(text);
    for (const flag of check.declaredFlags) {
      if (!tokens.has(flag)) {
        issues.push({
          usageKey: check.usageKey,
          kind: "missing-in-usage",
          flag,
          locale: catalog.locale,
        });
      }
    }
    const allowed =
      check.declaredFlags.length > 0
        ? new Set<string>([...check.declaredFlags, ...GLOBAL_FLAGS])
        : globalUnion;
    for (const token of tokens) {
      if (!allowed.has(token)) {
        issues.push({ usageKey: check.usageKey, kind: "undeclared", flag: token, locale: catalog.locale });
      }
    }
  }
  return issues;
}

/**
 * 위치 점표기 편집 키(플래그 없는 노출 편집 키 — markdown 그룹) 문서화 정합 체크(003).
 * 이 키들은 위치인자라 플래그 정규식(usageDriftIssues)이 닿지 않으므로, 그룹 help(usage.lane)에
 * canonical 이름이 문서화됐는지 별도로 대조한다 — 신규 노출 키가 add 되고도 문서에 안 뜨는 드리프트 차단.
 */
export function keyDocIssues(
  catalog: UsageCatalog,
  usageKey: string,
  keys: readonly string[],
): DriftIssue[] {
  const text = catalog.texts[usageKey];
  if (text === undefined) return [];
  return keys
    .filter((key) => !text.includes(key))
    .map((key) => ({ usageKey, kind: "missing-key" as const, flag: key, locale: catalog.locale }));
}

/** 중첩 카탈로그를 `a.b.c` 평탄 키 → 문자열 맵으로 변환(check-i18n.ts 와 동일 패턴). */
function flattenCatalog(obj: Record<string, unknown>, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out[path] = value;
    } else if (value !== null && typeof value === "object") {
      Object.assign(out, flattenCatalog(value as Record<string, unknown>, path));
    }
  }
  return out;
}

/** spec.ts 파생 curated 검사 목록 — usage 카탈로그 키 ↔ 대상 선언 플래그(그룹 help 는 하위 플래그 union). */
function buildChecks(): UsageCheck[] {
  const cmdFlags = (name: string): string[] => {
    const spec = findCommand(name);
    return spec ? flagNames(spec) : [];
  };
  return [
    // summary usage — (b) 전용(플래그 비열거, declaredFlags 는 (a) 미적용을 위해 빈 배열).
    { usageKey: "usage.main", declaredFlags: [] },
    { usageKey: "usage.laneAdd", declaredFlags: [] },
    { usageKey: "usage.laneSet", declaredFlags: [] },
    // enumerating usage — (a)+(b) 모두 적용.
    { usageKey: "usage.up", declaredFlags: cmdFlags("up") },
    { usageKey: "usage.down", declaredFlags: cmdFlags("down") },
    { usageKey: "usage.restart", declaredFlags: cmdFlags("restart") },
    { usageKey: "usage.status", declaredFlags: cmdFlags("status") },
    { usageKey: "usage.doctor", declaredFlags: cmdFlags("doctor") },
    { usageKey: "usage.logs", declaredFlags: cmdFlags("logs") },
    { usageKey: "usage.sessions", declaredFlags: cmdFlags("sessions") },
    { usageKey: "usage.laneLs", declaredFlags: subFlagNames("lane", "ls") },
    { usageKey: "usage.laneShow", declaredFlags: subFlagNames("lane", "show") },
    // 그룹 help — 하위 명령 플래그 union(그룹 help 가 전 플래그 열거처, research §E-3).
    // add/set/ls/show/rm 전체를 포함해야 한다 — 좁힌 undeclared 판정에서 ls/show 의
    // --json 을 undeclared 로 오탐하지 않도록.
    {
      usageKey: "usage.lane",
      declaredFlags: [
        ...new Set([
          ...subFlagNames("lane", "add"),
          ...subFlagNames("lane", "set"),
          ...subFlagNames("lane", "ls"),
          ...subFlagNames("lane", "show"),
          ...subFlagNames("lane", "rm"),
        ]),
      ],
    },
    {
      usageKey: "usage.proj",
      declaredFlags: [...new Set([...subFlagNames("proj", "ls"), ...subFlagNames("proj", "rm")])],
    },
  ];
}

export function runCheck(): DriftIssue[] {
  const checks = buildChecks();
  const enCatalog: UsageCatalog = { locale: "en", texts: flattenCatalog(en) };
  const koCatalog: UsageCatalog = { locale: "ko", texts: flattenCatalog(ko) };
  // 점표기 전용 편집 키(플래그 없음)는 그룹 help(usage.lane)에 canonical 이름 문서화를 강제한다.
  const dotKeys = dotOnlyEditableKeys();
  return [
    ...usageDriftIssues(enCatalog, checks),
    ...usageDriftIssues(koCatalog, checks),
    ...keyDocIssues(enCatalog, "usage.lane", dotKeys),
    ...keyDocIssues(koCatalog, "usage.lane", dotKeys),
  ];
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const issues = runCheck();
  if (issues.length === 0) {
    process.stdout.write("usage:check OK — declared flags and usage text agree\n");
  } else {
    for (const issue of issues) {
      process.stderr.write(
        `[${issue.kind}] ${issue.usageKey} (${issue.locale}) — ${issue.flag}\n`,
      );
    }
    process.stderr.write(`usage:check FAIL — ${issues.length} issue(s)\n`);
    process.exitCode = 1;
  }
}
