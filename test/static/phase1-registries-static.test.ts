// SC-010, SC-011, SC-012, SC-025, SC-054, SC-056, SC-057 — 워크플로 도메인 등록부·정책 차수의 정적 검증.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_TASK_TYPES,
  BUILTIN_TRIGGERS,
  BUILTIN_REACTIONS,
  EXTENSION_REGISTERED_SETS,
} from "../../src/workflow/domain/index.js";
import { FIXTURE_TASK_TYPE_IDS } from "../workflow/domain/helpers/registry-fixtures.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const DOMAIN_DIR = path.join(repoRoot, "src/workflow/domain");
const BASE_COMMIT = "3376221";

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

// ---- SC-010 ---------------------------------------------------------------

// 의존 추가 승인으로 단언만 갱신한 정적 테스트(허용 import·프로덕션 의존 단언).
const DOMAIN_STATIC_TEST_FILES = [
  "test/static/phase1-domain-purity.test.ts",
  "test/static/phase1-domain-baseline.test.ts",
  "test/static/phase0-policy-files.test.ts",
];

/** 기준 커밋에 있던 테스트 중 도메인 테스트·단언 갱신 정적 테스트 밖에서 바뀐 경로. */
function outsideDomainChanges(
  changed: readonly string[],
  existed: (p: string) => boolean,
): string[] {
  return changed.filter(
    (p) =>
      !p.startsWith("test/workflow/domain/") && !DOMAIN_STATIC_TEST_FILES.includes(p) && existed(p),
  );
}

describe.runIf(gitAvailable)(
  "SC-010: 옛 계약 단언이 남아 있지 않고 도메인 밖 기존 테스트는 무수정이다",
  () => {
    it("Happy: 기준 대비 바뀐 테스트 경로가 도메인 테스트·단언 갱신 정적 테스트·신규뿐이다 (test_SC010_changed_test_paths_within_domain_or_new)", () => {
      const changed = git(["diff", "--name-only", BASE_COMMIT, "--", "test/"])
        .split("\n")
        .filter((l) => l.length > 0);
      // 포착 하한: diff 가 비면 공허 통과가 되므로 이전한 도메인 테스트 경로가 실제로 잡혀야 한다.
      expect(
        changed.filter((p) => p.startsWith("test/workflow/domain/")).length,
      ).toBeGreaterThanOrEqual(1);
      expect(outsideDomainChanges(changed, existsAtBase)).toEqual([]);
    });

    it("Error: 도메인 밖 기존 파일 변경을 검출한다(자기 점검) (test_SC010_detects_synthetic_outside_path)", () => {
      expect(existsAtBase("test/static/command-surface.test.ts")).toBe(true);
      expect(
        outsideDomainChanges(
          [
            "test/static/command-surface.test.ts",
            "test/workflow/domain/plan-graph.test.ts",
            DOMAIN_STATIC_TEST_FILES[0] ?? "",
            "test/static/brand-new.test.ts",
          ],
          existsAtBase,
        ),
      ).toEqual(["test/static/command-surface.test.ts"]);
    });
  },
);

// ---- SC-011 ---------------------------------------------------------------

describe("SC-011: 스키마 라이브러리 설치 계약", () => {
  it("Edge: 설치된 zod 에 install 계열 스크립트·gypfile·binding.gyp 가 없다 (test_SC011_installed_zod_has_no_install_scripts_or_gyp)", () => {
    const pkgDir = fs.realpathSync(path.join(repoRoot, "node_modules/zod"));
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
      version?: string;
      license?: string;
      scripts?: Record<string, string>;
      gypfile?: boolean;
      dependencies?: Record<string, string>;
    };
    expect(pkg.version).toBe("4.4.3");
    expect(pkg.license).toBe("MIT");
    const installScripts = ["preinstall", "install", "postinstall"].filter(
      (name) => pkg.scripts?.[name] !== undefined,
    );
    expect(installScripts).toEqual([]);
    expect(pkg.gypfile).toBeUndefined();
    expect(fs.existsSync(path.join(pkgDir, "binding.gyp"))).toBe(false);
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

// ---- SC-012 ---------------------------------------------------------------

function dependenciesOf(pkgJson: string): Record<string, string> {
  return (JSON.parse(pkgJson) as { dependencies?: Record<string, string> }).dependencies ?? {};
}

/** 기준 대비 추가·변경·삭제된 의존 이름. */
function dependencyDelta(
  base: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): string[] {
  const names = new Set([...Object.keys(base), ...Object.keys(current)]);
  return [...names].filter((n) => base[n] !== current[n]).sort();
}

function importerDependencyEntries(lock: string): Map<string, string> {
  const lines = lock.split("\n");
  const importerIdx = lines.findIndex((l) => l.trim() === "importers:");
  const startIdx = lines.findIndex((l, i) => i > importerIdx && l.trim() === "dependencies:");
  const entries = new Map<string, string>();
  if (importerIdx === -1 || startIdx === -1) return entries;
  const blockIndent = lines[startIdx]?.match(/^\s*/)?.[0].length ?? 0;
  let current: string | undefined;
  let entryIndent = -1;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
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

describe.runIf(gitAvailable)("SC-012: 프로덕션 의존성 변화는 1건이다", () => {
  it("Happy: dependencies 가 기준 + zod 정확 핀이다 (test_SC012_dependencies_equal_base_plus_zod)", () => {
    const base = dependenciesOf(readAtBase("package.json"));
    const current = dependenciesOf(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    expect(dependencyDelta(base, current)).toEqual(["zod"]);
    expect(current["zod"]).toBe("4.4.3");
  });

  it("Edge: 잠금 파일 루트 importer dependencies 가 기준 항목 + zod 항목이다 (test_SC012_lock_importer_dependencies_base_plus_zod)", () => {
    const base = importerDependencyEntries(readAtBase("pnpm-lock.yaml"));
    const current = importerDependencyEntries(
      fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8"),
    );
    expect(base.size).toBeGreaterThanOrEqual(3);
    expect(current.get("zod")?.split("\n")).toContain("specifier: 4.4.3");
    const withoutZod = new Map(current);
    withoutZod.delete("zod");
    expect(withoutZod).toEqual(base);
  });

  it("Error: 합성 의존 추가·변경을 검출한다(자기 점검) (test_SC012_detects_synthetic_added_dependency)", () => {
    expect(dependencyDelta({ a: "1.0.0" }, { a: "1.0.0", injected: "9.9.9" })).toEqual([
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
    expect([...importerDependencyEntries(synthetic).keys()]).toEqual(["a"]);
  });
});

// ---- SC-025 ---------------------------------------------------------------

function coreFiles(): string[] {
  return listTsFiles(DOMAIN_DIR).filter((f) => {
    const rel = path.relative(DOMAIN_DIR, f).split(path.sep);
    return rel[0] !== "builtins" && rel[0] !== "contract";
  });
}

function identifierList(): string[] {
  return [
    ...new Set([
      ...BUILTIN_TASK_TYPES.map((d) => d.id),
      ...BUILTIN_TRIGGERS.map((d) => d.kind),
      ...BUILTIN_REACTIONS.map((d) => d.kind),
      ...FIXTURE_TASK_TYPE_IDS,
    ]),
  ];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 식별자 리터럴 분기 형태 — 비교·case·멤버십·키 조회·식별자 switch. */
function identifierBranches(source: string, ids: readonly string[]): string[] {
  const code = stripComments(source);
  const lit = `["'\`](?:${ids.map(escape).join("|")})["'\`]`;
  const forms: readonly [string, RegExp][] = [
    ["compare", new RegExp(`(?:===|!==|==|!=)\\s*${lit}|${lit}\\s*(?:===|!==|==|!=)`, "g")],
    ["case", new RegExp(`case\\s+${lit}\\s*:`, "g")],
    ["membership", new RegExp(`\\.(?:includes|indexOf|has)\\(\\s*${lit}`, "g")],
    ["key", new RegExp(`\\[\\s*${lit}\\s*\\]`, "g")],
    [
      "switch",
      /switch\s*\(\s*[\w.?]*\b(?:trigger|type|reaction|taskType|descriptor)s?\??\.(?:kind|id)\s*\)/g,
    ],
  ];
  const hits: string[] = [];
  for (const [form, re] of forms) for (const m of code.matchAll(re)) hits.push(`${form}: ${m[0]}`);
  return hits;
}

/** 따옴표로 둘러싼 식별자 리터럴 출현 수(형태 무관) — 스캐너가 대상 텍스트를 실제로 읽는지 점검용. */
function identifierLiteralCount(source: string, ids: readonly string[]): number {
  const lit = new RegExp(`["'\`](?:${ids.map(escape).join("|")})["'\`]`, "g");
  return [...stripComments(source).matchAll(lit)].length;
}

describe("SC-025: 워크플로 코어 모듈에 유형 식별자 분기가 없다", () => {
  it("Happy: 코어 파일에 식별자 비교·case·멤버십·키 조회·식별자 switch 가 0 이다 (test_SC025_core_has_no_identifier_literal_branch)", () => {
    const files = coreFiles();
    const ids = identifierList();
    expect(files.length).toBeGreaterThanOrEqual(20);
    const hits = files.flatMap((f) =>
      identifierBranches(fs.readFileSync(f, "utf8"), ids).map(
        (h) => `${path.relative(DOMAIN_DIR, f)} ${h}`,
      ),
    );
    expect(hits, hits.join("\n")).toEqual([]);
    // 스캐너 자기 점검: TriggerSpec 판별 유니온 등 비분기 출현은 실제로 읽힌다.
    const literals = files.reduce(
      (n, f) => n + identifierLiteralCount(fs.readFileSync(f, "utf8"), ids),
      0,
    );
    expect(literals).toBeGreaterThanOrEqual(5);
  });

  it("Edge: 식별자 목록이 내장 15종과 시험 유형 전부를 포함한다 (test_SC025_identifier_list_covers_builtins_and_fixtures)", () => {
    const ids = new Set(identifierList());
    const contractIds = EXTENSION_REGISTERED_SETS.flatMap((row) =>
      row.registeredSet.map((ref) => ref.slice(0, ref.lastIndexOf("@"))),
    );
    expect(contractIds).toHaveLength(15);
    for (const id of [...contractIds, ...FIXTURE_TASK_TYPE_IDS]) expect(ids.has(id), id).toBe(true);
  });

  it("Error: 실측 위반 여섯 형태와 그 밖 형태를 합성 문자열에서 전부 검출한다 (test_SC025_scanner_detects_injected_forms)", () => {
    const ids = identifierList();
    const founding = [
      'if (task.trigger.kind === "dependencies_complete") {}',
      'if (p.cause === "dependencies_complete") {}',
      'if (draft.trigger.kind === "dependencies_complete") {}',
      'if (command.cause !== "signal") {}',
      'if (task.trigger.kind !== "immediate") {}',
      'switch (command.kind) { case "request_confirmation": break; }',
    ];
    for (const sample of founding) expect(identifierBranches(sample, ids), sample).not.toEqual([]);
    const others = [
      'if (["at", "after"].includes("at")) {}',
      "const x = handlers['notify'];",
      "switch (task.trigger.kind) { default: }",
      "if ('confirmation' == t) {}",
      'known.has("probe_extension");',
    ];
    for (const sample of others) expect(identifierBranches(sample, ids), sample).not.toEqual([]);
    const benign = [
      'if (descriptor.firing === "on_ready") {}',
      '// if (kind === "signal") — 주석은 제외',
      'type T = { readonly kind: "immediate" };',
      'nextEntityId(deps.ids, "signal");',
    ];
    for (const sample of benign) expect(identifierBranches(sample, ids), sample).toEqual([]);
  });
});

// ---- SC-054 ---------------------------------------------------------------

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

describe.runIf(fs.existsSync(DOMAIN_DIR))(
  "SC-054: 도메인 모듈의 import 가 허용 집합 안에 있다",
  () => {
    it("Happy: 외부 import 가 node:crypto(createHash)·zod 뿐이다 (test_SC054_domain_imports_only_crypto_and_zod)", () => {
      const files = listTsFiles(DOMAIN_DIR);
      const specs = files.flatMap((f) => importSpecifiers(fs.readFileSync(f, "utf8")));
      expect(specs.length).toBeGreaterThanOrEqual(files.length);
      expect(specs).toContain("zod");
      const violations = files.flatMap((f) => importViolations(f, fs.readFileSync(f, "utf8")));
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("Edge: 시계·난수·전역 토큰이 0 이다 (test_SC054_no_clock_random_tokens)", () => {
      const violations = listTsFiles(DOMAIN_DIR).flatMap((f) =>
        tokenViolations(f, fs.readFileSync(f, "utf8")),
      );
      expect(violations, violations.join("\n")).toEqual([]);
    });

    it("Error: 합성 위반을 검출한다(자기 점검) (test_SC054_scanner_detects_injected_violation)", () => {
      const file = path.join(DOMAIN_DIR, "synthetic.ts");
      expect(importViolations(file, 'import * as z from "zod/v4";')).toHaveLength(1);
      expect(importViolations(file, 'import { randomUUID } from "node:crypto";')).toHaveLength(1);
      expect(importViolations(file, 'import { readFileSync } from "node:fs";')).toHaveLength(1);
      expect(importViolations(file, 'import { x } from "../../cli/spec.js";')).toHaveLength(1);
      expect(importViolations(file, 'import * as z from "zod";')).toEqual([]);
      expect(importViolations(file, 'import { createHash } from "node:crypto";')).toEqual([]);
      expect(tokenViolations(file, "const n = Date.now();")).toHaveLength(1);
    });
  },
);

// ---- SC-056 ---------------------------------------------------------------

function hasDomainImport(filePath: string, content: string): boolean {
  const inWorkflowRoot = path.dirname(filePath) === path.join(repoRoot, "src/workflow");
  return importSpecifiers(content).some(
    (spec) =>
      spec.includes("workflow/domain") ||
      (inWorkflowRoot && (spec === "./domain" || spec.startsWith("./domain/"))),
  );
}

describe("SC-056: 기존 동작이 바뀌지 않는다", () => {
  it.runIf(gitAvailable)(
    "Happy: 명령 정의·로케일이 본 차수 기준 대비 불변이다 (test_SC056_command_spec_and_locales_unchanged_since_004_base)",
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
    },
  );

  it("Edge: 도메인 밖 src 가 도메인을 import 하지 않는다 (test_SC056_no_domain_import_outside_domain)", () => {
    const files = listTsFiles(path.join(repoRoot, "src")).filter((f) => !f.startsWith(DOMAIN_DIR));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => hasDomainImport(f, fs.readFileSync(f, "utf8")))).toEqual([]);
    expect(
      hasDomainImport(
        path.join(repoRoot, "src/workflow/foo.ts"),
        'import { x } from "./domain/index.js";',
      ),
    ).toBe(true);
  });
});

// ---- SC-057 ---------------------------------------------------------------

const PROPERTY_DIR = path.join(repoRoot, "test/workflow/domain/property");
const PROPERTY_BUNDLES = [
  "registries.property.test.ts",
  "approval-surface.property.test.ts",
  "fan-out.property.test.ts",
  "retry.property.test.ts",
  "task-validation.property.test.ts",
];

function fcAssertCount(content: string): number {
  return [...stripComments(content).matchAll(/\bfc\.assert\(\s*fc\.property\(/g)].length;
}

describe("SC-057: 새 순수 함수에 property 검증이 있다", () => {
  it("Happy: property 다섯 묶음이 각각 fc.assert 를 1개 이상 가진다 (test_SC057_five_property_files_have_fc_assert)", () => {
    for (const name of PROPERTY_BUNDLES) {
      const file = path.join(PROPERTY_DIR, name);
      expect(fs.existsSync(file), name).toBe(true);
      expect(fcAssertCount(fs.readFileSync(file, "utf8")), name).toBeGreaterThanOrEqual(1);
    }
  });

  it("Edge: 묶음 파일명이 고정되어 있다 (test_SC057_file_names_fixed)", () => {
    const present = fs.readdirSync(PROPERTY_DIR);
    expect(PROPERTY_BUNDLES.filter((name) => !present.includes(name))).toEqual([]);
  });

  it("Error: fc.assert 가 없는 내용은 미충족으로 판정한다(자기 점검) (test_SC057_detects_missing_fc_assert)", () => {
    expect(fcAssertCount('it("x", () => { expect(1).toBe(1); });')).toBe(0);
    expect(fcAssertCount("// fc.assert(fc.property(a, () => true))")).toBe(0);
    expect(fcAssertCount("fc.assert(\n  fc.property(fc.nat(), () => true),\n);")).toBe(1);
  });
});
