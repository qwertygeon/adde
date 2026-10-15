// 도메인 공개 표면·진입 하드닝의 정적 판정. 파일 읽기와 TypeScript 컴파일러 API 만 쓰고 도메인 모듈을 불러오지 않는다.
// 검사 표본의 모듈 지정 문장과 도메인 경로는 이 파일 자신이 다른 정적 검사에 걸리지 않도록 이어 붙여 만든다.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DOMAIN_REL = ["src", "workflow", "domain"].join("/");
const DOMAIN_ABS = path.join(ROOT, DOMAIN_REL);
const PROPERTY_FILE_REL = [
  "test",
  "workflow",
  "domain",
  "property",
  "entry-exceptions.property.test.ts",
].join("/");

const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function readText(absolute: string): string {
  return fs.readFileSync(absolute, "utf8");
}

/** 디렉터리 아래 확장자가 맞는 파일의 절대 경로(정렬). 없으면 빈 목록. */
function listFiles(relativeDir: string, extensions: readonly string[]): string[] {
  const dir = path.join(ROOT, relativeDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

function scriptKindOf(fileName: string): ts.ScriptKind {
  return /\.(js|mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(fileName),
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

// ---- 모듈 지정자 수집·판정 ----------------------------------------------------

/** 지정자 — 문자열 리터럴·치환 없는 템플릿이 아니면 `undefined`(판정 불가). */
type Specifier = string | undefined;

function literalText(node: ts.Node | undefined): Specifier {
  if (node === undefined) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function collectSpecifiers(fileName: string, source: string): Specifier[] {
  const sf = parse(fileName, source);
  const requireLike = new Set<string>(["require"]);
  walk(sf, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "createRequire"
    ) {
      requireLike.add(node.name.text);
    }
  });
  const specs: Specifier[] = [];
  walk(sf, (node) => {
    if (ts.isImportDeclaration(node)) {
      specs.push(literalText(node.moduleSpecifier));
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) specs.push(literalText(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference))
        specs.push(literalText(node.moduleReference.expression));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireLike = ts.isIdentifier(callee) && requireLike.has(callee.text);
      const isCreateRequireCall =
        ts.isCallExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "createRequire";
      if (isDynamicImport || isRequireLike || isCreateRequireCall)
        specs.push(literalText(node.arguments[0]));
    }
  });
  return specs;
}

type ImportViolationKind = "non_literal" | "internal_entry" | "domain_module";

interface ImportViolation {
  readonly spec: string;
  readonly kind: ImportViolationKind;
}

const DOMAIN_FOLDED = DOMAIN_ABS.toLowerCase();
const PUBLIC_BARREL_FOLDED = new Set(["index.js", "index.ts"].map((f) => `${DOMAIN_FOLDED}/${f}`));
const INTERNAL_ENTRY_FOLDED = new Set(
  ["internal.js", "internal.ts"].map((f) => `${DOMAIN_FOLDED}/${f}`),
);

/** 한 파일의 도메인 import 위반 — 상대 지정자는 파일 위치로 풀고 대소문자를 접어 비교한다. */
function domainImportViolations(fileName: string, source: string): ImportViolation[] {
  const violations: ImportViolation[] = [];
  for (const spec of collectSpecifiers(fileName, source)) {
    if (spec === undefined) {
      violations.push({ spec: "<non-literal>", kind: "non_literal" });
      continue;
    }
    if (!spec.startsWith(".") && !spec.startsWith("/")) continue;
    const folded = path.resolve(path.dirname(fileName), spec).toLowerCase();
    if (folded !== DOMAIN_FOLDED && !folded.startsWith(`${DOMAIN_FOLDED}/`)) continue;
    if (PUBLIC_BARREL_FOLDED.has(folded)) continue;
    violations.push({
      spec,
      kind: INTERNAL_ENTRY_FOLDED.has(folded) ? "internal_entry" : "domain_module",
    });
  }
  return violations;
}

/** 도메인 밖 프로덕션 파일(`src/**` 중 도메인 폴더 제외, `scripts/**`). */
function productionFiles(): string[] {
  return [
    ...listFiles("src", SOURCE_EXTENSIONS),
    ...listFiles("scripts", SOURCE_EXTENSIONS),
  ].filter((abs) => {
    const folded = abs.toLowerCase();
    return folded !== DOMAIN_FOLDED && !folded.startsWith(`${DOMAIN_FOLDED}/`);
  });
}

function productionViolations(): { file: string; violation: ImportViolation }[] {
  return productionFiles().flatMap((file) =>
    domainImportViolations(file, readText(file)).map((violation) => ({
      file: path.relative(ROOT, file),
      violation,
    })),
  );
}

/** 이 파일이 걸리지 않도록 이어 붙여 만든 모듈 지정 문장 표본. */
function importLine(names: string, spec: string): string {
  return "im" + "port " + names + " fr" + "om " + JSON.stringify(spec) + ";";
}

const SAMPLE_FILE = path.join(ROOT, "src", "cli", "sample.ts");
const DOMAIN_FROM_CLI = "../" + "workflow/" + "domain";

// ---- 재생 API 신뢰 문서 ----------------------------------------------------------

const TRUST_SENTENCE = "입력 이벤트 열을 신뢰한다";

/** 함수 선언 바로 앞(공백만 사이에 둔) JSDoc 블록의 본문. 없으면 `undefined`. */
function adjacentDocOf(fileName: string, source: string, functionName: string): string | undefined {
  const sf = parse(fileName, source);
  let found: ts.FunctionDeclaration | undefined;
  walk(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName && found === undefined)
      found = node;
  });
  if (found === undefined) return undefined;
  const ranges = ts.getLeadingCommentRanges(source, found.getFullStart()) ?? [];
  const last = ranges[ranges.length - 1];
  if (last === undefined) return undefined;
  const between = source.slice(last.end, found.getStart(sf));
  if (between.trim() !== "") return undefined;
  const text = source.slice(last.pos, last.end);
  return text.startsWith("/**") ? text : undefined;
}

const REPLAY_FUNCTIONS: readonly { readonly file: string; readonly name: string }[] = [
  { file: "evolve.ts", name: "evolveCommit" },
  { file: "fold.ts", name: "foldEvents" },
  { file: "definition/commit.ts", name: "foldWorkflowEvents" },
];

// ---- 펼침 인자 ---------------------------------------------------------------------

/** 함수 호출·`new` 의 인자 자리 펼침 위치(줄 번호, 1부터). */
function argumentSpreads(fileName: string, source: string): number[] {
  const sf = parse(fileName, source);
  const lines: number[] = [];
  walk(sf, (node) => {
    if (
      ts.isSpreadElement(node) &&
      (ts.isCallExpression(node.parent) || ts.isNewExpression(node.parent))
    ) {
      lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
    }
  });
  return lines;
}

// ---- property seed ---------------------------------------------------------------

/** `fc.assert` 호출 수와, 둘째 인자 객체에 `seed`·`examples` 가 없는 호출의 줄 번호. */
function unseededAsserts(fileName: string, source: string): { calls: number; unseeded: number[] } {
  const sf = parse(fileName, source);
  let calls = 0;
  const unseeded: number[] = [];
  walk(sf, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      !ts.isIdentifier(node.expression.expression) ||
      node.expression.expression.text !== "fc" ||
      node.expression.name.text !== "assert"
    )
      return;
    calls += 1;
    const options = node.arguments[1];
    const seeded =
      options !== undefined &&
      ts.isObjectLiteralExpression(options) &&
      options.properties.some(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          ts.isIdentifier(p.name) &&
          (p.name.text === "seed" || p.name.text === "examples"),
      );
    if (!seeded) unseeded.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
  });
  return { calls, unseeded };
}

// ---- 공개 배럴 수출 인구조사 --------------------------------------------------------

/** 공개 배럴에서 빠져야 하는 함수 — (도메인 상대 선언 파일, 선언 지역 이름). */
const MOVED_PAIRS: readonly (readonly [string, string])[] = [
  ["events.ts", "mkEvent"],
  ["engine.ts", "assembleCommit"],
  ["task-decide.ts", "decideTaskCommand"],
  ["work-decide.ts", "decideCreateWork"],
  ["work-decide.ts", "decideWorkCommand"],
  ["cascade.ts", "decideWorkCancellationCascade"],
  ["cascade.ts", "decideReplanDroppedCancellations"],
  ["cascade.ts", "decidePendingProposalRevalidation"],
  ["cascade.ts", "decideDependencyCascadeRound"],
  ["cascade.ts", "decideDerivedWorkStateEvent"],
  ["policy/pre-execution-approval.ts", "preExecutionApprovalPark"],
  ["task-result/outputs.ts", "checkReportedOutputs"],
  ["plan/proposal.ts", "planPreconditionRejection"],
  ["plan/proposal.ts", "validatePlanProposal"],
];

const PUBLIC_ENTRIES = [
  "createWork",
  "executeCommand",
  "executeDefinitionCommand",
  "judgeDefinitionSignal",
  "judgeDelegationResponseStaleness",
  "judgeSignal",
  "judgeTaskExternalSignal",
];

const EVENT_OR_COMMIT_TYPE_NAMES = new Set(["DecidedEvent", "DomainEvent", "DomainCommit"]);

function compilerOptions(): ts.CompilerOptions {
  const configPath = path.join(ROOT, "tsconfig.json");
  const read = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
  return { ...parsed.options, noEmit: true };
}

/** 가상 파일을 덮어 읽는 컴파일러 호스트 — 실제 파일을 쓰지 않고 표본 배럴을 만든다. */
function hostWith(
  options: ts.CompilerOptions,
  virtual: ReadonlyMap<string, string>,
): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const content = virtual.get(path.resolve(fileName));
    if (content !== undefined) return ts.createSourceFile(fileName, content, languageVersion, true);
    return getSourceFile(fileName, languageVersion, onError, shouldCreate);
  };
  host.fileExists = (fileName) => virtual.has(path.resolve(fileName)) || fileExists(fileName);
  host.readFile = (fileName) => virtual.get(path.resolve(fileName)) ?? readFile(fileName);
  return host;
}

interface BarrelCensus {
  /** 수출 이름 → (도메인 상대 선언 파일, 선언 지역 이름). */
  readonly declarations: ReadonlyMap<string, readonly [string, string]>;
  /** 반환 타입 구조에 이벤트·커밋 타입이 나타나는 런타임 함수의 수출 이름(정렬). */
  readonly eventOrCommitProducers: readonly string[];
  readonly valueExports: number;
}

function returnsEventOrCommit(checker: ts.TypeChecker, root: ts.Type): boolean {
  const seen = new Set<ts.Type>();
  const visit = (type: ts.Type, depth: number): boolean => {
    if (depth > 8 || seen.has(type)) return false;
    seen.add(type);
    const named = type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
    if (named !== undefined && EVENT_OR_COMMIT_TYPE_NAMES.has(named)) return true;
    if (type.isUnionOrIntersection()) return type.types.some((t) => visit(t, depth + 1));
    if (checker.isArrayType(type) || checker.isTupleType(type))
      return checker.getTypeArguments(type as ts.TypeReference).some((t) => visit(t, depth + 1));
    if ((type.flags & ts.TypeFlags.Object) === 0) return false;
    return checker
      .getPropertiesOfType(type)
      .some((prop) => visit(checker.getTypeOfSymbol(prop), depth + 1));
  };
  return visit(root, 0);
}

/**
 * 파일이 값으로 내보내는 이름 — `export type`(선언·지정자·`export type *`)은 런타임 수출이 아니라 빼고,
 * 값 `export *` 는 대상 모듈을 따라간다. 이름은 내보낸 이름이다.
 */
function valueExportNames(
  program: ts.Program,
  file: string,
  visiting: ReadonlySet<string> = new Set(),
): Set<string> {
  const out = new Set<string>();
  const key = file.toLowerCase();
  const sf = program.getSourceFile(file);
  if (visiting.has(key) || sf === undefined) return out;
  const nextVisiting = new Set([...visiting, key]);
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause === undefined) {
        const spec =
          statement.moduleSpecifier !== undefined
            ? literalText(statement.moduleSpecifier)
            : undefined;
        if (spec === undefined || !spec.startsWith(".")) continue;
        const target = path.resolve(path.dirname(file), spec).replace(/\.js$/, ".ts");
        for (const name of valueExportNames(program, target, nextVisiting)) out.add(name);
      } else if (ts.isNamespaceExport(clause)) {
        out.add(clause.name.text);
      } else {
        for (const element of clause.elements) if (!element.isTypeOnly) out.add(element.name.text);
      }
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    )
      out.add(statement.name.text);
    else if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) out.add(declaration.name.text);
  }
  return out;
}

function barrelCensus(barrelPath: string, virtual: ReadonlyMap<string, string>): BarrelCensus {
  const options = compilerOptions();
  const program = ts.createProgram([barrelPath], options, hostWith(options, virtual));
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(barrelPath);
  if (source === undefined) throw new Error(`barrel not in program: ${barrelPath}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`barrel has no module symbol: ${barrelPath}`);
  const declarations = new Map<string, readonly [string, string]>();
  const producers: string[] = [];
  const runtimeNames = valueExportNames(program, barrelPath);
  let valueExports = 0;
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    if (!runtimeNames.has(exported.getName())) continue;
    const original =
      (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
    if ((original.flags & ts.SymbolFlags.Value) === 0) continue;
    const decl = original.declarations?.[0];
    if (decl === undefined) continue;
    valueExports += 1;
    const file = path.relative(DOMAIN_ABS, decl.getSourceFile().fileName).split(path.sep).join("/");
    declarations.set(exported.getName(), [file, original.getName()]);
    const type = checker.getTypeOfSymbolAtLocation(original, decl);
    const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    if (
      signatures.some((sig) => returnsEventOrCommit(checker, checker.getReturnTypeOfSignature(sig)))
    )
      producers.push(exported.getName());
  }
  return { declarations, eventOrCommitProducers: producers.sort(), valueExports };
}

function movedPairHits(census: BarrelCensus): string[] {
  const hits: string[] = [];
  for (const [exportedName, [file, local]] of census.declarations) {
    if (MOVED_PAIRS.some(([f, n]) => f === file && n === local))
      hits.push(`${exportedName} -> ${file}#${local}`);
  }
  return hits.sort();
}

const VIRTUAL_BARREL = path.join(DOMAIN_ABS, "virtual-sample-barrel.ts");

function exportLine(clause: string, spec: string): string {
  return "exp" + "ort " + clause + " fr" + "om " + JSON.stringify(spec) + ";";
}

// ---- 표식 함수 import 파일 ----------------------------------------------------------

const SEAL_WRAPPER_FILES = [
  "definition/engine.ts",
  "engine.ts",
  "external-signal.ts",
  "signals.ts",
];

/** `entry/seal` 모듈에서 `sealCommit`·`sealOutcome` 을 가져오는 도메인 파일(도메인 상대 경로, 정렬). */
function sealImporters(files: ReadonlyMap<string, string>): string[] {
  const sealTarget = path.join(DOMAIN_ABS, "entry", "seal").toLowerCase();
  const importers: string[] = [];
  for (const [abs, source] of files) {
    const sf = parse(abs, source);
    let imports = false;
    walk(sf, (node) => {
      if (!ts.isImportDeclaration(node)) return;
      const spec = literalText(node.moduleSpecifier);
      if (spec === undefined || !spec.startsWith(".")) return;
      const resolved = path
        .resolve(path.dirname(abs), spec)
        .toLowerCase()
        .replace(/\.(js|ts)$/, "");
      if (resolved !== sealTarget) return;
      const bindings = node.importClause?.namedBindings;
      if (bindings === undefined) return;
      if (ts.isNamespaceImport(bindings)) {
        imports = true;
        return;
      }
      if (
        bindings.elements.some((el) =>
          ["sealCommit", "sealOutcome"].includes((el.propertyName ?? el.name).text),
        )
      )
        imports = true;
    });
    if (imports) importers.push(path.relative(DOMAIN_ABS, abs).split(path.sep).join("/"));
  }
  return importers.sort();
}

function domainSources(): Map<string, string> {
  return new Map(listFiles(DOMAIN_REL, [".ts"]).map((abs) => [abs, readText(abs)]));
}

// ---- 시험 ---------------------------------------------------------------------------

describe("SC-017: 도메인 밖 프로덕션 코드는 내부 진입을 불러오지 않는다", () => {
  it("Happy: 실제 src(도메인 밖)·scripts 에 내부 진입 지정자가 0 개다 (test_SC017_production_imports_no_internal_entry)", () => {
    const internal = productionViolations().filter((v) => v.violation.kind === "internal_entry");
    expect(internal).toEqual([]);
  });

  it("Edge: 도메인 폴더 파일은 검사 대상 밖이고 대상 파일·지정자 포착 하한을 넘는다 (test_SC017_domain_files_outside_scope)", () => {
    const scanned = productionFiles();
    const domainFiles = listFiles(DOMAIN_REL, [".ts"]);
    expect(domainFiles.length).toBeGreaterThanOrEqual(50);
    expect(scanned.length).toBeGreaterThanOrEqual(50);
    const scannedSet = new Set(scanned);
    expect(domainFiles.filter((f) => scannedSet.has(f))).toEqual([]);
    const captured = scanned.reduce(
      (n, file) => n + collectSpecifiers(file, readText(file)).length,
      0,
    );
    expect(captured).toBeGreaterThanOrEqual(200);
  });

  it("Error: 이어 붙인 내부 진입 지정 표본을 모든 형태에서 검출한다 (test_SC017_internal_entry_import_sample_detected)", () => {
    const internal = `${DOMAIN_FROM_CLI}/internal.js`;
    const samples = [
      importLine("{ x }", internal),
      importLine("{ x }", "../workflow/" + "Domain/internal.js"),
      exportLine("*", internal),
      "const m = await im" + "port(" + JSON.stringify(internal) + ");",
      "const m = require(" + JSON.stringify(internal) + ");",
    ];
    for (const sample of samples) {
      expect(
        domainImportViolations(SAMPLE_FILE, sample).map((v) => v.kind),
        sample,
      ).toEqual(["internal_entry"]);
    }
  });
});

describe("SC-021: 재생 API 는 입력 이벤트 열 신뢰를 문서로 밝힌다", () => {
  it("Happy: 세 재생 함수의 문서 주석에 신뢰 문구가 있다 (test_SC021_replay_functions_document_trust)", () => {
    for (const { file, name } of REPLAY_FUNCTIONS) {
      const abs = path.join(DOMAIN_ABS, file);
      const doc = adjacentDocOf(abs, readText(abs), name);
      expect(doc, `${file}#${name}`).toBeDefined();
      expect(doc ?? "", `${file}#${name}`).toContain(TRUST_SENTENCE);
    }
  });

  it("Edge: 신뢰 문구는 해당 함수 선언 바로 앞 문서 주석에 있다 (test_SC021_trust_sentence_precedes_declaration)", () => {
    for (const { file, name } of REPLAY_FUNCTIONS) {
      const abs = path.join(DOMAIN_ABS, file);
      const source = readText(abs);
      const doc = adjacentDocOf(abs, source, name) ?? "";
      const sentenceAt = source.indexOf(doc) + doc.indexOf(TRUST_SENTENCE);
      const declarationAt = source.indexOf(`export function ${name}(`);
      expect(doc.includes(TRUST_SENTENCE), `${file}#${name}`).toBe(true);
      expect(sentenceAt).toBeLessThan(declarationAt);
      expect(source.slice(sentenceAt, declarationAt)).not.toContain("function ");
    }
    // 앞선 다른 선언의 주석에만 문구가 있으면 그 함수의 문서로 세지 않는다.
    const displaced = [
      `/** ${TRUST_SENTENCE} */`,
      "export function other(): void {}",
      "/** 커밋을 적용한다. */",
      "export function evolveCommit(): void {}",
    ].join("\n");
    expect(adjacentDocOf("sample.ts", displaced, "evolveCommit")).not.toContain(TRUST_SENTENCE);
  });

  it("Error: 문구가 없거나 블록 주석이 아닌 합성 소스를 검출한다 (test_SC021_missing_sentence_sample_detected)", () => {
    const missing = ["/** 커밋을 적용한다. */", "export function foldEvents(): void {}"].join("\n");
    expect(adjacentDocOf("sample.ts", missing, "foldEvents")).not.toContain(TRUST_SENTENCE);
    const lineComment = [`// ${TRUST_SENTENCE}`, "export function foldEvents(): void {}"].join(
      "\n",
    );
    expect(adjacentDocOf("sample.ts", lineComment, "foldEvents")).toBeUndefined();
    const absent = "export function foldEvents(): void {}";
    expect(adjacentDocOf("sample.ts", absent, "foldEvents")).toBeUndefined();
  });
});

describe("SC-024: 도메인 밖 코드는 도메인을 공개 배럴로만 불러온다", () => {
  it("Happy: 실제 src(도메인 밖)·scripts 의 도메인 import 위반이 0 개다 (test_SC024_production_sources_no_violation)", () => {
    expect(productionViolations()).toEqual([]);
  });

  it("Edge: 공개 배럴 지정 표본은 허용된다 (test_SC024_public_barrel_import_sample_allowed)", () => {
    const samples = [
      importLine("{ x }", `${DOMAIN_FROM_CLI}/index.js`),
      importLine("type { Y }", `${DOMAIN_FROM_CLI}/index.ts`),
      "const m = await im" + "port(" + JSON.stringify(`${DOMAIN_FROM_CLI}/index.js`) + ");",
      importLine("{ readFile }", "node:fs"),
      importLine("{ z }", "zod"),
    ];
    for (const sample of samples)
      expect(domainImportViolations(SAMPLE_FILE, sample), sample).toEqual([]);
  });

  it("Error: 개별 모듈·대소문자 변형·require 계열·비리터럴 지정 표본을 검출한다 (test_SC024_module_import_sample_detected)", () => {
    const engine = `${DOMAIN_FROM_CLI}/engine.js`;
    const samples: readonly (readonly [string, ImportViolationKind])[] = [
      [importLine("{ x }", engine), "domain_module"],
      [importLine("{ x }", "../workflow/" + "DOMAIN/engine.js"), "domain_module"],
      ["const m = require(" + JSON.stringify(engine) + ");", "domain_module"],
      [
        "im" +
          "port { createRequire } fr" +
          'om "node:module";\nconst r = createRequire(import.meta.url);\nconst m = r(' +
          JSON.stringify(engine) +
          ");",
        "domain_module",
      ],
      [
        "const m = createRequire(import.meta.url)(" + JSON.stringify(engine) + ");",
        "domain_module",
      ],
      ["im" + "port x = require(" + JSON.stringify(engine) + ");", "domain_module"],
      ["const name = 'x';\nconst m = await im" + "port(name);", "non_literal"],
      ["const m = require(`${'x'}`);", "non_literal"],
    ];
    for (const [sample, kind] of samples) {
      expect(
        domainImportViolations(SAMPLE_FILE, sample).map((v) => v.kind),
        sample,
      ).toEqual([kind]);
    }
  });
});

describe("SC-025: 공개 배럴은 옮긴 함수를 어떤 형태로도 다시 내보내지 않는다", () => {
  it("Happy: 실제 공개 배럴 수출에 옮긴 14 개가 없고 이벤트·커밋 반환 함수는 공개 진입 일곱뿐이며 표식 함수는 진입 래퍼만 쓴다 (test_SC025_public_barrel_exports_no_moved_names)", () => {
    const census = barrelCensus(path.join(DOMAIN_ABS, "index.ts"), new Map());
    expect(census.valueExports).toBeGreaterThanOrEqual(150);
    expect(movedPairHits(census)).toEqual([]);
    expect(census.eventOrCommitProducers).toEqual([...PUBLIC_ENTRIES].sort());
    expect(sealImporters(domainSources())).toEqual([...SEAL_WRAPPER_FILES].sort());
    const stray = new Map([
      [
        path.join(DOMAIN_ABS, "plan", "stray.ts"),
        importLine("{ sealCommit }", "../entry/" + "seal.js"),
      ],
    ]);
    expect(sealImporters(stray)).toEqual(["plan/stray.ts"]);
  }, 15_000);

  it("Edge: `export *` 연쇄로 대상 모듈을 다시 내보내는 가상 배럴을 검출한다 (test_SC025_export_star_reexport_sample_detected)", () => {
    const census = barrelCensus(
      VIRTUAL_BARREL,
      new Map([[VIRTUAL_BARREL, exportLine("*", "./events.js")]]),
    );
    expect(movedPairHits(census)).toEqual(["mkEvent -> events.ts#mkEvent"]);
    expect(census.eventOrCommitProducers).toContain("mkEvent");
    // 대조: 타입만 다시 내보내는 배럴은 런타임 수출이 없어 검출하지 않는다.
    const typeOnly = barrelCensus(
      VIRTUAL_BARREL,
      new Map([[VIRTUAL_BARREL, exportLine("type *", "./events.js")]]),
    );
    expect(movedPairHits(typeOnly)).toEqual([]);
  }, 15_000);

  it("Error: 이름·별칭으로 다시 내보내는 가상 배럴을 검출한다 (test_SC025_named_reexport_sample_detected)", () => {
    const content = [
      exportLine("{ mkEvent }", "./events.js"),
      exportLine("{ checkReportedOutputs as checkOutputs }", "./task-result/outputs.js"),
    ].join("\n");
    const census = barrelCensus(VIRTUAL_BARREL, new Map([[VIRTUAL_BARREL, content]]));
    expect(movedPairHits(census)).toEqual([
      "checkOutputs -> task-result/outputs.ts#checkReportedOutputs",
      "mkEvent -> events.ts#mkEvent",
    ]);
  }, 15_000);
});

describe("SC-035: 도메인 소스는 함수 호출·new 인자 자리에서 배열을 펼치지 않는다", () => {
  it("Happy: 실제 도메인 소스의 호출·new 인자 펼침이 0 개다 (test_SC035_domain_sources_no_argument_spread)", () => {
    const files = listFiles(DOMAIN_REL, [".ts"]);
    expect(files.length).toBeGreaterThanOrEqual(50);
    const hits = files.flatMap((abs) =>
      argumentSpreads(abs, readText(abs)).map((line) => `${path.relative(ROOT, abs)}:${line}`),
    );
    expect(hits).toEqual([]);
  });

  it("Edge: 나머지 매개변수·객체·배열 리터럴 펼침 표본은 검출하지 않는다 (test_SC035_rest_and_literal_spread_samples_ignored)", () => {
    const sample = [
      "function f(...xs: number[]): number[] { return xs; }",
      "const o = { a: 1 };",
      "const p = { ...o };",
      "const xs = [1, 2];",
      "const ys = [...xs];",
    ].join("\n");
    expect(argumentSpreads("sample.ts", sample)).toEqual([]);
  });

  it("Error: 호출·메서드 호출·new 인자 펼침 표본을 검출한다 (test_SC035_call_and_new_spread_samples_detected)", () => {
    const sample = [
      "const a: number[] = [];",
      "const b = [1];",
      "a.push(...b);",
      "f(...b);",
      "new X(...b);",
    ].join("\n");
    expect(argumentSpreads("sample.ts", sample)).toEqual([3, 4, 5]);
  });
});

describe("SC-063: 새 property 시험의 fc.assert 는 모두 seed 를 고정한다", () => {
  it("Happy: 새 property 파일의 fc.assert 호출마다 seed 또는 examples 가 있다 (test_SC063_new_property_asserts_seeded)", () => {
    const abs = path.join(ROOT, PROPERTY_FILE_REL);
    expect(fs.existsSync(abs)).toBe(true);
    const { calls, unseeded } = unseededAsserts(abs, readText(abs));
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(unseeded).toEqual([]);
  });

  it("Edge: 파일 안 여러 fc.assert 를 모두 본다 (test_SC063_every_assert_in_file_seeded)", () => {
    const abs = path.join(ROOT, PROPERTY_FILE_REL);
    expect(unseededAsserts(abs, readText(abs)).calls).toBeGreaterThanOrEqual(3);
    const sample = [
      "fc.assert(fc.property(fc.nat(), () => true), { seed: 1, numRuns: 10 });",
      "fc.assert(fc.property(fc.nat(), () => true), { examples: [[1]] });",
      "fc.assert(fc.property(fc.nat(), () => true), { numRuns: 10 });",
    ].join("\n");
    expect(unseededAsserts("sample.ts", sample)).toEqual({ calls: 3, unseeded: [3] });
  });

  it("Error: seed 없는 합성 소스를 검출한다 (test_SC063_unseeded_sample_detected)", () => {
    expect(unseededAsserts("sample.ts", "fc.assert(fc.property(fc.nat(), () => true));")).toEqual({
      calls: 1,
      unseeded: [1],
    });
    expect(
      unseededAsserts(
        "sample.ts",
        "const opts = { seed: 1 };\nfc.assert(fc.property(fc.nat(), () => true), opts);",
      ),
    ).toEqual({ calls: 1, unseeded: [2] });
  });
});
