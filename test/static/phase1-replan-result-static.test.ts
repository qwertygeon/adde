// SC-001, SC-003~SC-006, SC-054, SC-056~SC-058 — 워크플로 도메인 재계획·결과 결합 차수의 정적 검증과
// 이 차수 무수정 가드(기준 커밋 고정).
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const DOMAIN_DIR = path.join(repoRoot, "src/workflow/domain");
const BASE_COMMIT = "1af00b5";

function hasGit(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["cat-file", "-e", BASE_COMMIT], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const gitAvailable = hasGit();

function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function lines(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0);
}

function readAtBase(rel: string): string {
  return git(["show", `${BASE_COMMIT}:${rel}`]);
}

function existsAtBase(rel: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${BASE_COMMIT}:${rel}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

// 줄 전체 주석만 지운다 — 설정 문자열 속 이중 별표 glob 을 블록 주석으로 오인하지 않기 위해.
function stripLineComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, "");
}

function importSpecifiers(content: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import|export)(?:[^'"]*?)from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of content.matchAll(re)) {
    const spec = match[1] ?? match[2];
    if (spec !== undefined) specs.push(spec);
  }
  return specs;
}

interface PackageJson {
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

function parsePackageJson(text: string): PackageJson {
  return JSON.parse(text) as PackageJson;
}

// ---- SC-001 ---------------------------------------------------------------

interface StrykerConfig {
  readonly mutate?: readonly string[];
  readonly thresholds?: { readonly break?: unknown };
}

function strykerConfig(): StrykerConfig {
  return JSON.parse(readRepo("stryker.config.json")) as StrykerConfig;
}

const DOMAIN_PREFIX = "src/workflow/domain/";

/** 변이 대상 패턴 중 도메인 밖을 가리키는 것(제외 패턴은 `!` 를 뗀 경로로 판정). */
function mutatePatternsOutsideDomain(patterns: readonly string[]): string[] {
  return patterns.filter((p) => !(p.startsWith("!") ? p.slice(1) : p).startsWith(DOMAIN_PREFIX));
}

describe("SC-001: mutation 설정의 대상은 워크플로 도메인뿐이고 점수 하한이 없다", () => {
  it("Happy: mutation 스크립트가 있고 변이 대상이 전부 도메인 아래다 (test_SC001_mutation_script_and_domain_only_mutate_patterns)", () => {
    const pkg = parsePackageJson(readRepo("package.json"));
    expect(pkg.scripts?.["mutation"]).toMatch(/^stryker run\b/);
    const mutate = strykerConfig().mutate ?? [];
    const included = mutate.filter((p) => !p.startsWith("!"));
    expect(included.length).toBeGreaterThanOrEqual(1);
    expect(included).toContain("src/workflow/domain/**/*.ts");
    expect(mutatePatternsOutsideDomain(mutate)).toEqual([]);
  });

  it("Edge: 제외 패턴도 도메인 안 경로만 가리킨다 (test_SC001_mutate_exclusions_stay_inside_domain)", () => {
    const excluded = (strykerConfig().mutate ?? []).filter((p) => p.startsWith("!"));
    for (const pattern of excluded)
      expect(pattern.startsWith(`!${DOMAIN_PREFIX}`), pattern).toBe(true);
    // 판정 함수 자기 점검: 도메인 밖 포함·제외 패턴을 모두 잡고 도메인 안 패턴은 통과시킨다.
    expect(
      mutatePatternsOutsideDomain([
        "src/workflow/domain/**/*.ts",
        "!src/workflow/domain/timezone-names.ts",
        "src/cli/**/*.ts",
        "!src/core/x.ts",
      ]),
    ).toEqual(["src/cli/**/*.ts", "!src/core/x.ts"]);
  });

  it("Error: 하한 미달 시 실패 종료하는 설정(thresholds.break 수치)이 없다 (test_SC001_no_break_threshold)", () => {
    const thresholds = strykerConfig().thresholds;
    const breakValue = thresholds?.break;
    expect(breakValue === undefined || breakValue === null).toBe(true);
    expect(typeof breakValue).not.toBe("number");
  });
});

// ---- SC-003 ---------------------------------------------------------------

const MUTATION_TOKEN = /stryker|mutation/i;

function mutationMentions(text: string): string[] {
  return lines(text).filter((l) => MUTATION_TOKEN.test(l));
}

describe("SC-003: 게이트·훅·CI 에 mutation 이 없다", () => {
  it("Happy: gates 스크립트에 mutation 명령·도구 이름이 없다 (test_SC003_gates_script_has_no_mutation)", () => {
    const gates = parsePackageJson(readRepo("package.json")).scripts?.["gates"] ?? "";
    // 포착 하한: 실제 게이트 문자열을 읽었는지(빈 문자열이면 공허 통과).
    expect(gates).toContain("pnpm run test");
    expect(mutationMentions(gates)).toEqual([]);
    expect(mutationMentions("pnpm run typecheck && pnpm run mutation")).toHaveLength(1);
  });

  it("Edge: pre-push 훅에 mutation 이 없다 (test_SC003_pre_push_hook_has_no_mutation)", () => {
    const hook = readRepo(".githooks/pre-push");
    expect(hook).toMatch(/gates/);
    expect(mutationMentions(hook)).toEqual([]);
  });

  it("Error: CI 워크플로 파일에 mutation 이 없다 (test_SC003_ci_workflows_have_no_mutation)", () => {
    const dir = path.join(repoRoot, ".github/workflows");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const hits = files.flatMap((f) =>
      mutationMentions(fs.readFileSync(path.join(dir, f), "utf8")).map((l) => `${f}: ${l}`),
    );
    expect(hits).toEqual([]);
    expect(mutationMentions("      - run: npx stryker run")).toHaveLength(1);
  });
});

// ---- SC-004 ---------------------------------------------------------------

/** 설정 텍스트의 첫 `include: [...]` 배열 문자열 원소(주석 제거 뒤). */
function includeGlobs(configText: string): string[] | undefined {
  const match = stripLineComments(configText).match(/include:\s*\[([^\]]*)\]/);
  if (match === null) return undefined;
  return [...(match[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

/** 설정 텍스트의 첫 `setupFiles: [...]` 배열 문자열 원소(주석 제거 뒤). */
function setupFileList(configText: string): string[] | undefined {
  const match = stripLineComments(configText).match(/setupFiles:\s*\[([^\]]*)\]/);
  if (match === null) return undefined;
  return [...(match[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

describe("SC-004: mutation 전용 설정은 일반 테스트 실행을 바꾸지 않는다", () => {
  // 일반 설정의 실행 자원 옵션(maxWorkers 등)은 바뀔 수 있다 — 수집 대상·setup 이 기준과 같고
  // mutation 설정이 섞이지 않았는지만 본다(이전: 기준 커밋과 바이트 동일).
  it.runIf(gitAvailable)(
    "Happy: 일반 vitest 설정의 수집 대상·setup 이 기준 커밋과 같고 mutation 설정을 참조하지 않는다 (test_SC004_vitest_config_unchanged_since_base)",
    () => {
      expect(existsAtBase("vitest.config.ts")).toBe(true);
      const current = readRepo("vitest.config.ts");
      const base = readAtBase("vitest.config.ts");
      expect(includeGlobs(current)).toEqual(includeGlobs(base));
      expect(includeGlobs(current)).toEqual(["test/**/*.test.ts"]);
      expect(setupFileList(current)).toEqual(setupFileList(base));
      expect(stripLineComments(current)).not.toMatch(/vitest\.mutation\.config|stryker/i);
      // 판정 자기 점검: 수집 대상이 바뀐 설정을 잡는다.
      expect(includeGlobs('include: ["test/workflow/**/*.test.ts"]')).not.toEqual(
        includeGlobs(base),
      );
    },
  );

  it("Edge: 전용 설정의 수집 대상이 도메인 테스트 하나다 (test_SC004_mutation_config_includes_domain_tests_only)", () => {
    expect(includeGlobs(readRepo("vitest.mutation.config.ts"))).toEqual([
      "test/workflow/domain/**/*.test.ts",
    ]);
  });

  it("Error: 전용 설정이 정적 테스트를 수집하지 않는다 (test_SC004_mutation_config_excludes_static_tests)", () => {
    const text = readRepo("vitest.mutation.config.ts");
    const globs = includeGlobs(text) ?? [];
    expect(globs.length).toBeGreaterThanOrEqual(1);
    const reachesStatic = (glob: string) =>
      glob.includes("test/static") || /^test\/\*\*/.test(glob) || /^\*\*/.test(glob);
    expect(globs.filter(reachesStatic)).toEqual([]);
    expect(stripLineComments(text)).not.toContain("test/static");
    // 판정 자기 점검: 정적 테스트에 닿는 수집 패턴을 잡는다(주석 속 언급은 대상 아님).
    expect(
      includeGlobs('// test/static\ninclude: ["test/**/*.test.ts"]')?.filter(reachesStatic),
    ).toEqual(["test/**/*.test.ts"]);
  });
});

// ---- SC-005 ---------------------------------------------------------------

/** 기준 대비 추가·변경·삭제된 의존 이름. */
function dependencyDelta(
  base: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): string[] {
  const names = new Set([...Object.keys(base), ...Object.keys(current)]);
  return [...names].filter((n) => base[n] !== current[n]).sort();
}

/** 잠금 파일 루트 importer 의 첫 `dependencies:` 블록 항목(이름 → 하위 줄). */
function importerDependencyEntries(lock: string): Map<string, string> {
  const all = lock.split("\n");
  const importerIdx = all.findIndex((l) => l.trim() === "importers:");
  const startIdx = all.findIndex((l, i) => i > importerIdx && l.trim() === "dependencies:");
  const entries = new Map<string, string>();
  if (importerIdx === -1 || startIdx === -1) return entries;
  const blockIndent = all[startIdx]?.match(/^\s*/)?.[0].length ?? 0;
  let current: string | undefined;
  let entryIndent = -1;
  for (let i = startIdx + 1; i < all.length; i += 1) {
    const line = all[i] ?? "";
    if (line.trim().length === 0) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent <= blockIndent) break;
    if (entryIndent === -1 || indent <= entryIndent) {
      entryIndent = indent;
      current = line
        .trim()
        .replace(/:$/, "")
        .replace(/^'(.*)'$/, "$1");
      entries.set(current, "");
    } else if (current !== undefined) {
      const prev = entries.get(current) ?? "";
      entries.set(current, prev.length === 0 ? line.trim() : `${prev}\n${line.trim()}`);
    }
  }
  return entries;
}

const MUTATION_DEV_DEPENDENCIES = ["@stryker-mutator/core", "@stryker-mutator/vitest-runner"];

describe.runIf(gitAvailable)("SC-005: 개발 의존 2건만 늘고 프로덕션 의존은 같다", () => {
  it("Happy: devDependencies 추가가 mutation 도구 두 키·정확 버전 10.0.0 이다 (test_SC005_dev_dependencies_add_exactly_two_pinned)", () => {
    const base = parsePackageJson(readAtBase("package.json")).devDependencies ?? {};
    const current = parsePackageJson(readRepo("package.json")).devDependencies ?? {};
    expect(Object.keys(base).length).toBeGreaterThanOrEqual(3);
    expect(dependencyDelta(base, current)).toEqual(MUTATION_DEV_DEPENDENCIES);
    for (const name of MUTATION_DEV_DEPENDENCIES) {
      expect(base[name]).toBeUndefined();
      expect(current[name]).toBe("10.0.0");
    }
  });

  it("Edge: dependencies 와 잠금 파일 루트 importer dependencies 블록이 기준과 같다 (test_SC005_production_dependencies_and_lock_importer_unchanged)", () => {
    const baseDeps = parsePackageJson(readAtBase("package.json")).dependencies ?? {};
    const currentDeps = parsePackageJson(readRepo("package.json")).dependencies ?? {};
    expect(Object.keys(baseDeps)).toContain("zod");
    expect(currentDeps).toEqual(baseDeps);
    const baseLock = importerDependencyEntries(readAtBase("pnpm-lock.yaml"));
    const currentLock = importerDependencyEntries(readRepo("pnpm-lock.yaml"));
    expect(baseLock.size).toBeGreaterThanOrEqual(4);
    expect(baseLock.has("zod")).toBe(true);
    expect(currentLock).toEqual(baseLock);
  });

  it("Error: 합성 추가 의존·잠금 블록 변경을 검출한다(자기 점검) (test_SC005_detects_synthetic_extra_dependency)", () => {
    const pinned = Object.fromEntries(MUTATION_DEV_DEPENDENCIES.map((n) => [n, "10.0.0"]));
    expect(dependencyDelta({ a: "1.0.0" }, { a: "1.0.0", ...pinned, injected: "9.9.9" })).toEqual([
      ...MUTATION_DEV_DEPENDENCIES,
      "injected",
    ]);
    expect(dependencyDelta({ a: "1.0.0" }, { a: "^1.0.0" })).toEqual(["a"]);
    const synthetic = [
      "importers:",
      "  .:",
      "    dependencies:",
      "      a:",
      "        specifier: 1.0.0",
      "        version: 1.0.0",
      "    devDependencies:",
      "      b:",
      "        specifier: 2.0.0",
    ].join("\n");
    const entries = importerDependencyEntries(synthetic);
    expect([...entries.keys()]).toEqual(["a"]);
    expect(
      importerDependencyEntries(synthetic.replace("version: 1.0.0", "version: 1.0.1")),
    ).not.toEqual(entries);
  });
});

// ---- SC-006 ---------------------------------------------------------------

function isIgnored(rel: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** 설정 텍스트의 첫 `ignores: [...]` 배열 문자열 원소(주석 제거 뒤). */
function firstIgnoresArray(configText: string): string[] {
  const match = stripLineComments(configText).match(/ignores:\s*\[([^\]]*)\]/);
  if (match === null) return [];
  return [...(match[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

describe.runIf(gitAvailable)("SC-006: mutation 실행 산출물은 추적되지 않는다", () => {
  it("Happy: 샌드박스 작업 디렉터리와 보고서 경로가 git 무시 대상이다 (test_SC006_mutation_outputs_ignored_by_git)", () => {
    expect(isIgnored(".stryker-tmp/x")).toBe(true);
    expect(isIgnored(".artifacts/mutation/mutation.json")).toBe(true);
    expect(isIgnored(".artifacts/mutation/mutation.html")).toBe(true);
    // 판정 자기 점검: 추적 대상 파일은 무시 대상이 아니다.
    expect(isIgnored("package.json")).toBe(false);
  });

  it("Edge: ESLint 첫 무시 목록에 샌드박스 경로가 있다 (test_SC006_eslint_ignores_stryker_temp)", () => {
    const ignores = firstIgnoresArray(readRepo("eslint.config.js"));
    expect(ignores).toContain("dist/**");
    expect(ignores).toContain(".stryker-tmp/**");
  });

  it("Error: 추적 파일 목록에 두 경로가 없다 (test_SC006_mutation_outputs_not_tracked)", () => {
    expect(lines(git(["ls-files", "--", "package.json"]))).toEqual(["package.json"]);
    expect(lines(git(["ls-files", "--", ".stryker-tmp", ".artifacts"]))).toEqual([]);
    const status = lines(
      git(["status", "--porcelain", "--untracked-files=all", "--", ".stryker-tmp", ".artifacts"]),
    );
    expect(status).toEqual([]);
  });
});

// ---- SC-054 ---------------------------------------------------------------

const NEW_DOMAIN_MODULES = [
  "derivation/canonical-json.ts",
  "plan/proposal.ts",
  "plan/replan.ts",
  "task-result/data-schema.ts",
  "task-result/schema-shape.ts",
  "task-result/outputs.ts",
  "task-result/binding.ts",
  "policy/trigger-cause.ts",
];

/** 폴더 단위 새 모듈 밖에 있는 새 단일 파일. */
const NEW_SINGLE_FILES = ["derivation/canonical-json.ts", "policy/trigger-cause.ts"];

function newModuleFiles(): string[] {
  const roots = [path.join(DOMAIN_DIR, "plan"), path.join(DOMAIN_DIR, "task-result")];
  const singles = NEW_SINGLE_FILES.map((f) => path.join(DOMAIN_DIR, f));
  return [
    ...roots.flatMap((r) => listTsFiles(r)),
    ...singles.filter((f) => fs.existsSync(f)),
  ].sort();
}

const FORBIDDEN_TOKENS = [
  "Date.now(",
  "new Date()",
  "Math.random",
  "randomBytes",
  "randomUUID",
  "getRandomValues",
  "performance.now",
  "process.",
  "globalThis",
  "setTimeout",
  "setInterval",
  "require(",
];

function importViolations(filePath: string, content: string): string[] {
  const violations: string[] = [];
  for (const spec of importSpecifiers(content)) {
    if (spec === "zod") continue;
    if (spec === "node:crypto") {
      const named = content.match(/import\s*\{([^}]*)\}\s*from\s*["']node:crypto["']/);
      const names = (named?.[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (named === null || names.some((n) => n !== "createHash"))
        violations.push(`${filePath}: node:crypto beyond createHash`);
      continue;
    }
    if (!spec.startsWith(".")) {
      violations.push(`${filePath}: disallowed import "${spec}"`);
      continue;
    }
    const resolved = path.normalize(path.join(path.dirname(filePath), spec));
    if (!resolved.startsWith(DOMAIN_DIR)) violations.push(`${filePath}: escapes domain "${spec}"`);
  }
  return violations;
}

function tokenViolations(filePath: string, content: string): string[] {
  return FORBIDDEN_TOKENS.filter((t) => content.includes(t)).map((t) => `${filePath}: "${t}"`);
}

describe("SC-054: 새 도메인 모듈도 순수성 검사를 통과한다", () => {
  it("Happy: 새 모듈의 외부 import 가 node:crypto(createHash)·zod 뿐이다 (test_SC054_new_domain_modules_import_only_crypto_and_zod)", () => {
    const files = newModuleFiles();
    const rel = files.map((f) => path.relative(DOMAIN_DIR, f).split(path.sep).join("/"));
    // 포착 하한: 설계가 정한 새 모듈이 모두 실제로 스캔 대상에 들어 있어야 한다.
    for (const expected of NEW_DOMAIN_MODULES) expect(rel, expected).toContain(expected);
    const specs = files.flatMap((f) => importSpecifiers(fs.readFileSync(f, "utf8")));
    expect(specs.length).toBeGreaterThanOrEqual(files.length);
    const violations = files.flatMap((f) => importViolations(f, fs.readFileSync(f, "utf8")));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("Edge: 새 모듈에 시계·난수·전역 토큰이 없다(주석 포함) (test_SC054_new_domain_modules_have_no_clock_random_tokens)", () => {
    const files = newModuleFiles();
    expect(files.length).toBeGreaterThanOrEqual(NEW_DOMAIN_MODULES.length);
    const violations = files.flatMap((f) => tokenViolations(f, fs.readFileSync(f, "utf8")));
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("Error: 합성 위반을 검출한다(자기 점검) (test_SC054_new_module_scanner_detects_injected_violation)", () => {
    const file = path.join(DOMAIN_DIR, "task-result", "synthetic.ts");
    expect(importViolations(file, 'import * as z from "zod/v4";')).toHaveLength(1);
    expect(importViolations(file, 'import type { ZodType } from "zod/v4/core";')).toHaveLength(1);
    expect(importViolations(file, 'import { randomUUID } from "node:crypto";')).toHaveLength(1);
    expect(importViolations(file, 'import { readFileSync } from "node:fs";')).toHaveLength(1);
    expect(importViolations(file, 'import { x } from "../../../cli/spec.js";')).toHaveLength(1);
    expect(importViolations(file, 'import * as z from "zod";')).toEqual([]);
    expect(importViolations(file, 'import { createHash } from "node:crypto";')).toEqual([]);
    expect(importViolations(file, 'import { ok } from "../result.js";')).toEqual([]);
    expect(tokenViolations(file, "// 기록 시각은 Date.now( 로 얻지 않는다")).toHaveLength(1);
    expect(tokenViolations(file, "const t = globalThis.x;")).toHaveLength(1);
  });
});

// ---- SC-056 ---------------------------------------------------------------

function hasDomainImport(filePath: string, content: string): boolean {
  const inWorkflowRoot = path.dirname(filePath) === path.join(repoRoot, "src/workflow");
  return importSpecifiers(content).some(
    (spec) =>
      spec.includes("workflow/domain") ||
      (inWorkflowRoot && (spec === "./domain" || spec.startsWith("./domain/"))),
  );
}

describe("SC-056: 기존 동작·의존·표면이 바뀌지 않는다", () => {
  it.runIf(gitAvailable)(
    "Happy: 프로덕션 의존이 이 차수 기준과 같다 (test_SC056_production_dependencies_unchanged_since_005_base)",
    () => {
      const base = parsePackageJson(readAtBase("package.json")).dependencies ?? {};
      const current = parsePackageJson(readRepo("package.json")).dependencies ?? {};
      expect(Object.keys(base).length).toBeGreaterThanOrEqual(4);
      expect(dependencyDelta(base, current)).toEqual([]);
    },
  );

  it.runIf(gitAvailable)(
    "Edge: 명령 정의·로케일이 기준 대비 불변이고 도메인 밖 src 가 도메인을 import 하지 않는다 (test_SC056_command_spec_locales_unchanged_and_no_domain_import_outside)",
    () => {
      expect(existsAtBase("src/cli/spec.ts")).toBe(true);
      const diff = git([
        "diff",
        "--name-only",
        BASE_COMMIT,
        "--",
        "src/cli/spec.ts",
        "src/shared/locales/",
      ]);
      expect(diff.trim()).toBe("");
      const files = listTsFiles(path.join(repoRoot, "src")).filter(
        (f) => !f.startsWith(DOMAIN_DIR),
      );
      expect(files.length).toBeGreaterThan(0);
      expect(files.filter((f) => hasDomainImport(f, fs.readFileSync(f, "utf8")))).toEqual([]);
      expect(
        hasDomainImport(
          path.join(repoRoot, "src/workflow/foo.ts"),
          'import { x } from "./domain/index.js";',
        ),
      ).toBe(true);
    },
  );
});

// ---- SC-057 (이 차수 무수정 가드) -------------------------------------------

/** 기획 단계가 사용자 결정으로 승인한 도메인 테스트 폴더 밖 기존 테스트 수정 — 이 차수는 없다. */
const APPROVED_OUTSIDE_EXCEPTIONS: readonly string[] = [];

/** 바뀐 test 경로 중 기준 커밋에 있던 도메인 테스트 폴더 밖 파일(승인 예외 제외). */
function protectedChanges(changed: readonly string[], existed: (p: string) => boolean): string[] {
  return changed.filter(
    (p) =>
      !p.startsWith("test/workflow/domain/") &&
      !APPROVED_OUTSIDE_EXCEPTIONS.includes(p) &&
      existed(p),
  );
}

describe.runIf(gitAvailable)("SC-057: 기존 테스트 수정이 경계 안에 있다", () => {
  it("Happy: 기준 대비 바뀐 기존 테스트가 도메인 테스트 폴더 안뿐이다 (test_SC057_changed_existing_tests_within_domain)", () => {
    const changed = lines(git(["diff", "--name-only", "--no-renames", BASE_COMMIT, "--", "test/"]));
    // 포착 하한: 이 차수가 이전한 도메인 테스트 경로가 실제로 잡혀야 한다(diff 가 비면 공허 통과).
    expect(
      changed.filter((p) => p.startsWith("test/workflow/domain/")).length,
    ).toBeGreaterThanOrEqual(1);
    expect(protectedChanges(changed, existsAtBase)).toEqual([...APPROVED_OUTSIDE_EXCEPTIONS]);
  });

  it("Edge: 기준에 있던 test 파일이 삭제되지 않았고 보호 집합이 실제로 잡힌다 (test_SC057_no_base_test_deleted_and_capture_floor)", () => {
    const deleted = lines(
      git(["diff", "--name-only", "--no-renames", "--diff-filter=D", BASE_COMMIT, "--", "test/"]),
    );
    expect(deleted).toEqual([]);
    const protectedSet = lines(
      git(["ls-tree", "-r", "--name-only", BASE_COMMIT, "--", "test/"]),
    ).filter((p) => !p.startsWith("test/workflow/domain/"));
    expect(protectedSet.length).toBeGreaterThanOrEqual(186);
    expect(protectedSet).toContain("test/static/phase1-registries-static.test.ts");
    expect(protectedSet).toContain("test/static/phase1-domain-baseline.test.ts");
    expect(protectedSet).toContain("test/static/phase1-domain-purity.test.ts");
  });

  it("Error: 보호 집합의 합성 변경 경로를 판별한다(자기 점검) (test_SC057_detects_synthetic_outside_path)", () => {
    expect(existsAtBase("test/static/command-surface.test.ts")).toBe(true);
    expect(existsAtBase("test/workflow/domain/plan-graph.test.ts")).toBe(true);
    expect(
      protectedChanges(
        [
          "test/static/command-surface.test.ts",
          "test/static/phase1-registries-static.test.ts",
          "test/workflow/domain/plan-graph.test.ts",
          "test/workflow/domain/helpers/fixtures.ts",
          "test/static/brand-new.test.ts",
        ],
        existsAtBase,
      ),
    ).toEqual([
      "test/static/command-surface.test.ts",
      "test/static/phase1-registries-static.test.ts",
    ]);
  });
});

// ---- SC-058 ---------------------------------------------------------------

const PROPERTY_DIR = path.join(repoRoot, "test/workflow/domain/property");
const PROPERTY_FILES = [
  "plan-proposal.property.test.ts",
  "membership.property.test.ts",
  "task-result.property.test.ts",
];
const PROPERTY_TARGETS = [
  "digest_invariant",
  "plan_validation",
  "mandatory_approval",
  "membership_fold",
  "result_digest",
];

/** `it(` 블록 단위로 나눠, 제목에 대상 토큰이 있는 블록 중 fc.assert(fc.property( 를 가진 것이 없는 대상. */
function targetsWithoutProperty(contents: readonly string[], targets: readonly string[]): string[] {
  const blocks = contents.flatMap((content) =>
    stripComments(content)
      .split(/\bit\(/)
      .slice(1),
  );
  return targets.filter(
    (target) =>
      !blocks.some(
        (block) =>
          block.includes(`test_SC055_property_${target}`) &&
          /\bfc\.assert\(\s*fc\.property\(/.test(block),
      ),
  );
}

describe("SC-058: property 검증이 새 순수 함수에 있다", () => {
  it("Happy: 다섯 대상 property 제목이 fc.assert 와 함께 있다 (test_SC058_five_property_targets_have_fc_assert)", () => {
    const contents = PROPERTY_FILES.filter((f) => fs.existsSync(path.join(PROPERTY_DIR, f))).map(
      (f) => fs.readFileSync(path.join(PROPERTY_DIR, f), "utf8"),
    );
    expect(contents.length).toBe(PROPERTY_FILES.length);
    expect(targetsWithoutProperty(contents, PROPERTY_TARGETS)).toEqual([]);
  });

  it("Edge: property 파일 이름이 고정되어 있다 (test_SC058_property_file_names_fixed)", () => {
    for (const name of PROPERTY_FILES)
      expect(fs.existsSync(path.join(PROPERTY_DIR, name)), name).toBe(true);
  });

  it("Error: 대상 제목 누락·fc.assert 누락을 검출한다(자기 점검) (test_SC058_detects_missing_target)", () => {
    const withAssert = (token: string) =>
      `it("Happy: x (test_SC055_property_${token}_x)", () => { fc.assert(fc.property(fc.nat(), () => true)); });`;
    const withoutAssert = (token: string) =>
      `it("Happy: x (test_SC055_property_${token}_x)", () => { expect(1).toBe(1); });`;
    expect(
      targetsWithoutProperty(
        [withAssert("digest_invariant"), withoutAssert("plan_validation")],
        ["digest_invariant", "plan_validation", "result_digest"],
      ),
    ).toEqual(["plan_validation", "result_digest"]);
  });
});
