// Phase 1 종료 정적 판정: 기준 커밋 사실 매니페스트와 프로세스 없이 대조한다.
// 파일 읽기와 해시만 쓰고 도메인 모듈을 import 하지 않는다. 검사 문자열은 이 파일 자신이 걸리지 않도록 연결식으로 만든다.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { createHash } from "node:crypto";

const ROOT = new URL("../../", import.meta.url);

interface FileFact {
  readonly path: string;
  readonly sha256: string;
}

interface Baseline {
  readonly baseCommit: string;
  readonly testFiles: readonly FileFact[];
  readonly protectedPrefixExcluded: string;
  readonly commandSurface: readonly FileFact[];
  readonly packageJson: {
    readonly dependencies: Record<string, string>;
    readonly devDependencies: Record<string, string>;
  };
  readonly domainImporters: {
    readonly production: readonly string[];
    readonly staticTests: readonly string[];
  };
}

const BASELINE = JSON.parse(
  fs.readFileSync(new URL("test/static/fixtures/phase1-exit-baseline.json", ROOT), "utf8"),
) as Baseline;

function readBytes(relative: string): Buffer {
  return fs.readFileSync(new URL(relative, ROOT));
}

function readText(relative: string): string {
  return fs.readFileSync(new URL(relative, ROOT), "utf8");
}

function exists(relative: string): boolean {
  return fs.existsSync(new URL(relative, ROOT));
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

const ROOT_PATH = decodeURIComponent(ROOT.pathname);

/** 디렉터리 아래 파일의 저장소 상대 경로(정렬). */
function listFiles(relativeDir: string): string[] {
  const dir = relativeDir.endsWith("/") ? relativeDir : `${relativeDir}/`;
  if (!exists(dir)) return [];
  return fs
    .readdirSync(new URL(dir, ROOT), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      `${entry.parentPath}/${entry.name}`.replace(/\/{2,}/g, "/").slice(ROOT_PATH.length),
    )
    .sort();
}

// ---- 검출기 ------------------------------------------------------------------

/** 비공개 문서 이름 — 이 파일에 리터럴로 두지 않는다. */
const PRIVATE_DOC_NAMES = [
  "test" + "-cases" + ".md",
  "SPEC" + "_ROOT",
  "docs/" + "spec/",
  "." + "claude/docs",
];

function privateDocNameHits(content: string): string[] {
  return PRIVATE_DOC_NAMES.filter((name) => content.includes(name));
}

/** 행 레시피 파일의 비공개 문서 이름 판정 — 기준 해시와 같으면 판정 대상이 아니다. */
function judgeChangedFile(
  currentSha: string,
  baseSha: string,
  content: string,
): "not_applicable" | readonly string[] {
  if (currentSha === baseSha) return "not_applicable";
  return privateDocNameHits(content);
}

function importSpecifiers(content: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import|export)(?:[^'"]*?)from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const spec = match[1] ?? match[2];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

function importsDomain(relativePath: string, content: string): boolean {
  const inWorkflowRoot = /^src\/workflow\/[^/]+$/.test(relativePath);
  return importSpecifiers(content).some(
    (spec) =>
      spec.includes("workflow/" + "domain") ||
      (inWorkflowRoot && (spec === "./" + "domain" || spec.startsWith("./" + "domain/"))),
  );
}

const DOMAIN_FORBIDDEN_TOKENS = [
  "Date" + ".now(",
  "new " + "Date()",
  "Math" + ".random",
  "random" + "Bytes",
  "random" + "UUID",
  "getRandom" + "Values",
  "performance" + ".now",
  "process" + ".",
  "global" + "This",
  "set" + "Timeout",
  "set" + "Interval",
  "require" + "(",
];

/** 도메인 순수성 규칙 — 외부 import 는 node:crypto·zod 만, 상대 import 는 도메인 디렉터리 안, 금지 토큰 0. */
function purityViolations(relativePath: string, content: string): string[] {
  const violations: string[] = [];
  const depth = relativePath.split("/").length - "src/workflow/domain/".split("/").length;
  for (const spec of importSpecifiers(content)) {
    if (spec === "node:crypto" || spec === "zod") continue;
    if (!spec.startsWith(".")) {
      violations.push(`import ${spec}`);
      continue;
    }
    const ups = spec.split("/").filter((s) => s === "..").length;
    if (ups > depth) violations.push(`escapes ${spec}`);
  }
  for (const token of DOMAIN_FORBIDDEN_TOKENS)
    if (content.includes(token)) violations.push(`token ${token}`);
  return violations;
}

const RUNTIME_FORBIDDEN_TOKENS = [
  "child" + "_process",
  "spawn" + "(",
  "set" + "Timeout",
  "sle" + "ep",
];

function runtimeTokenHits(content: string): string[] {
  return RUNTIME_FORBIDDEN_TOKENS.filter((token) => content.includes(token));
}

function isProtected(relativePath: string): boolean {
  return (
    relativePath.startsWith("test/") && !relativePath.startsWith(BASELINE.protectedPrefixExcluded)
  );
}

const BASE_PATHS: ReadonlySet<string> = new Set(BASELINE.testFiles.map((f) => f.path));
const BASE_SHA: ReadonlyMap<string, string> = new Map(
  BASELINE.testFiles.map((f) => [f.path, f.sha256]),
);

/** 기준에 없던 현재 test/** 파일. */
function newTestFiles(): string[] {
  return listFiles("test").filter((p) => !BASE_PATHS.has(p));
}

/** 이 차수가 더한 도메인 모듈(모듈 구조의 신규 파일). */
const NEW_DOMAIN_MODULES = [
  "src/workflow/domain/definition/commit.ts",
  "src/workflow/domain/definition/control.ts",
  "src/workflow/domain/definition/draft.ts",
  "src/workflow/domain/definition/engine.ts",
  "src/workflow/domain/definition/model.ts",
  "src/workflow/domain/definition/occurrence.ts",
  "src/workflow/domain/definition/resolution.ts",
  "src/workflow/domain/definition/schedule.ts",
  "src/workflow/domain/external-signal.ts",
  "src/workflow/domain/timezone-recompute.ts",
  "src/workflow/domain/contract/definition-transitions.ts",
  "src/workflow/domain/contract/occurrence-input.ts",
];

const PROPERTY_DIR = "test/workflow/domain/property/";
const PROPERTY_TARGETS = [
  "definition-bound.property.test.ts",
  "definition-revision.property.test.ts",
  "occurrence-derivation.property.test.ts",
  "timezone-recompute.property.test.ts",
];

function missingPropertyTargets(files: ReadonlyMap<string, string>): string[] {
  return PROPERTY_TARGETS.filter((name) => {
    const content = files.get(`${PROPERTY_DIR}${name}`);
    return content === undefined || !content.includes("fc" + ".assert");
  });
}

// ---- 시험 --------------------------------------------------------------------

describe("SC-061: 바뀐 행 레시피 파일에 비공개 문서 이름이 없다", () => {
  const ROW_CASES = "test/workflow/domain/helpers/row-cases.ts";

  it("Happy: 기준과 다른 row-cases.ts 에 비공개 문서 이름이 0 개다 (test_SC061_changed_row_cases_has_no_private_doc_name)", () => {
    const content = readText(ROW_CASES);
    const current = sha256(readBytes(ROW_CASES));
    const base = BASE_SHA.get(ROW_CASES);
    expect(base).toBeDefined();
    expect(current).not.toBe(base);
    expect(judgeChangedFile(current, base ?? "", content)).toEqual([]);
  });

  it("Edge: 검출기가 합성 문자열의 비공개 문서 이름을 검출한다 (test_SC061_detector_self_check)", () => {
    for (const name of PRIVATE_DOC_NAMES) {
      expect(judgeChangedFile("a", "b", `// see ${name} "미커버 항목"`), name).toEqual([name]);
    }
    expect(judgeChangedFile("a", "b", "// AUTHORING 공백 — 레시피를 이 파일에 더한다")).toEqual([]);
  });

  it("Error: 기준과 같은 해시면 판정 대상이 아니다 (test_SC061_unchanged_branch_not_applicable)", () => {
    expect(judgeChangedFile("same", "same", PRIVATE_DOC_NAMES.join(" "))).toBe("not_applicable");
  });
});

describe("SC-062: 새 도메인 모듈도 순수성 규칙을 지킨다", () => {
  it("Happy: 새 모듈마다 외부 import 가 node:crypto·zod 뿐이고 금지 토큰이 없다 (test_SC062_new_modules_captured_and_pure)", () => {
    const violations = NEW_DOMAIN_MODULES.flatMap((p) =>
      purityViolations(p, readText(p)).map((v) => `${p}: ${v}`),
    );
    expect(violations).toEqual([]);
  });

  it("Edge: 스캐너가 새 모듈 전부를 실제로 읽는다 (test_SC062_scanner_reads_new_modules)", () => {
    const domainFiles = listFiles("src/workflow/domain");
    const scanned = NEW_DOMAIN_MODULES.filter(
      (p) => domainFiles.includes(p) && readText(p).length > 0,
    );
    expect(scanned).toEqual(NEW_DOMAIN_MODULES);
    // 하한: 신규 모듈 목록이 도메인 디렉터리에서 찾은 정의 모듈 전부를 포함한다.
    const definitionDir = domainFiles.filter((p) =>
      p.startsWith("src/workflow/domain/definition/"),
    );
    expect(definitionDir.every((p) => NEW_DOMAIN_MODULES.includes(p))).toBe(true);
    expect(definitionDir.length).toBeGreaterThanOrEqual(8);
  });

  it("Error: 합성 위반 문자열을 검출한다 (test_SC062_synthetic_violation_detected)", () => {
    const file = "src/workflow/domain/definition/x.ts";
    for (const token of DOMAIN_FORBIDDEN_TOKENS) {
      expect(purityViolations(file, `const v = ${token}`), token).toContain(`token ${token}`);
    }
    expect(purityViolations(file, 'import { x } from "node:fs";')).toEqual(["import node:fs"]);
    expect(purityViolations(file, 'import { x } from "../../cli/spec.js";')).toEqual([
      "escapes ../../cli/spec.js",
    ]);
    expect(
      purityViolations(file, 'import * as z from "zod";\nimport { y } from "../model.js";'),
    ).toEqual([]);
  });
});

describe("SC-064: 사용자 대면 동작과 도메인 import 위치가 기준과 같다", () => {
  it("Happy: 명령 표면·로케일 해시와 package.json 의존이 기준과 같다 (test_SC064_command_surface_locales_dependencies_unchanged)", () => {
    expect(BASELINE.commandSurface.length).toBeGreaterThanOrEqual(2);
    for (const fact of BASELINE.commandSurface)
      expect(sha256(readBytes(fact.path)), fact.path).toBe(fact.sha256);
    const pkg = JSON.parse(readText("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual(BASELINE.packageJson.dependencies);
    expect(pkg.devDependencies ?? {}).toEqual(BASELINE.packageJson.devDependencies);
  });

  it("Edge: 도메인 밖 프로덕션 코드는 도메인을 import 하지 않고 정적 시험의 도메인 import 파일이 기준과 같다 (test_SC064_domain_import_sites_unchanged)", () => {
    const production = [...listFiles("src"), ...listFiles("scripts")]
      .filter((p) => !p.startsWith("src/workflow/domain/") && /\.(ts|mts|cts|js|mjs|cjs)$/.test(p))
      .filter((p) => importsDomain(p, readText(p)));
    expect(production).toEqual([...BASELINE.domainImporters.production]);
    const staticTests = listFiles("test/static")
      .filter((p) => p.endsWith(".ts"))
      .filter((p) => importsDomain(p, readText(p)));
    expect(staticTests).toEqual([...BASELINE.domainImporters.staticTests]);
  });

  it("Error: import 검출기가 합성 import 를 검출한다 (test_SC064_import_detector_self_check)", () => {
    expect(
      importsDomain("src/cli/x.ts", 'import { a } from "../workflow/' + 'domain/index.js";'),
    ).toBe(true);
    expect(importsDomain("src/workflow/x.ts", 'import { a } from "./' + 'domain/engine.js";')).toBe(
      true,
    );
    expect(
      importsDomain("src/cli/x.ts", 'const m = await import("../workflow/' + 'domain/index.js");'),
    ).toBe(true);
    expect(importsDomain("src/cli/x.ts", 'import { a } from "../workflow/index.js";')).toBe(false);
  });
});

describe("SC-065: 보호 시험 파일은 바뀌지 않는다", () => {
  it("Happy: 보호 파일 187 개의 현재 해시가 기준과 같다 (test_SC065_protected_tests_unchanged)", () => {
    const protectedFacts = BASELINE.testFiles.filter((f) => isProtected(f.path));
    expect(protectedFacts).toHaveLength(187);
    // 비공개 문서 홈 경로 변경(`.claude/docs` → `.agents/docs`)에 따른 경로 갱신과 그 가드 예외.
    const approvedExceptions: readonly string[] = [
      "test/static/sla-exemption.test.ts",
      "test/static/phase0-doc-notice.test.ts",
      "test/static/phase0-existing-tests-unmodified.test.ts",
      "test/static/phase1-domain-baseline.test.ts",
      "test/static/phase1-registries-static.test.ts",
      "test/static/phase1-replan-result-static.test.ts",
    ];
    const changed = protectedFacts
      .filter((f) => !approvedExceptions.includes(f.path))
      .filter((f) => !exists(f.path) || sha256(readBytes(f.path)) !== f.sha256)
      .map((f) => f.path);
    expect(changed).toEqual([]);
  });

  it("Edge: 기준 232 경로가 모두 있고 새로 생기거나 바뀐 도메인 시험이 하나 이상이다 (test_SC065_baseline_paths_present_and_capture_floor)", () => {
    expect(BASELINE.testFiles).toHaveLength(232);
    expect(BASELINE.testFiles.filter((f) => !exists(f.path)).map((f) => f.path)).toEqual([]);
    const domainTouched = listFiles(BASELINE.protectedPrefixExcluded).filter((p) => {
      const base = BASE_SHA.get(p);
      return base === undefined || sha256(readBytes(p)) !== base;
    });
    expect(domainTouched.length).toBeGreaterThanOrEqual(1);
  });

  it("Error: 분류기와 변경 검출이 합성 경로·내용에서 동작한다 (test_SC065_classifier_and_hash_self_check)", () => {
    expect(isProtected("test/static/x.test.ts")).toBe(true);
    expect(isProtected("test/workflow/domain/x.test.ts")).toBe(false);
    const original = sha256("const a = 1;\n");
    expect(sha256("const a = 1;\n")).toBe(original);
    expect(sha256("const a = 2;\n")).not.toBe(original);
  });
});

describe("SC-066: 네 대상 property 시험이 있다", () => {
  function propertyFiles(): Map<string, string> {
    return new Map(listFiles(PROPERTY_DIR).map((p) => [p, readText(p)]));
  }

  it("Happy: 네 대상 property 파일이 있고 각각 fc.assert 를 쓴다 (test_SC066_four_property_targets_present)", () => {
    expect(missingPropertyTargets(propertyFiles())).toEqual([]);
  });

  it("Edge: 기준의 property 파일 이름이 유지된다 (test_SC066_existing_property_files_kept)", () => {
    const base = BASELINE.testFiles.map((f) => f.path).filter((p) => p.startsWith(PROPERTY_DIR));
    expect(base.length).toBeGreaterThan(0);
    const current = new Set(listFiles(PROPERTY_DIR));
    expect(base.filter((p) => !current.has(p))).toEqual([]);
  });

  it("Error: 합성 목록에서 빠진 대상을 검출한다 (test_SC066_missing_target_detected)", () => {
    const files = propertyFiles();
    const [first, second] = PROPERTY_TARGETS;
    files.delete(`${PROPERTY_DIR}${first ?? ""}`);
    files.set(`${PROPERTY_DIR}${second ?? ""}`, "// no property assertion");
    expect(missingPropertyTargets(files)).toEqual([first, second]);
  });
});

describe("SC-067: 새 시험 파일은 프로세스·타이머를 쓰지 않는다", () => {
  it("Happy: 기준에 없던 test 파일에 프로세스·타이머 토큰이 0 개다 (test_SC067_new_tests_no_process_or_timer)", () => {
    const hits = newTestFiles().flatMap((p) =>
      runtimeTokenHits(readText(p)).map((t) => `${p}: ${t}`),
    );
    expect(hits).toEqual([]);
  });

  it("Edge: 새 시험 파일 포착 하한 — 이 파일과 매니페스트를 포함해 하나 이상이다 (test_SC067_new_test_capture_floor)", () => {
    const fresh = newTestFiles();
    expect(fresh.length).toBeGreaterThanOrEqual(1);
    expect(fresh).toContain("test/static/phase1-exit-static.test.ts");
  });

  it("Error: 토큰 검출기가 합성 문자열을 검출한다 (test_SC067_token_detector_self_check)", () => {
    for (const token of RUNTIME_FORBIDDEN_TOKENS) {
      expect(runtimeTokenHits(`const x = ${token}`), token).toEqual([token]);
    }
    expect(runtimeTokenHits("const x = 1;")).toEqual([]);
  });
});
