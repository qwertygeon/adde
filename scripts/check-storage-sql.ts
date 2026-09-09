/**
 * 와일드카드 select 금지 검사 — `pnpm run sql:check` (CI 게이트).
 * 저장 어댑터 경로(기본 `src/workflow`)에서 컬럼을 열거하지 않는 select(`select *`·`select t.*`)를
 * 찾는다. 대상이 문자열 리터럴 안의 SQL 이라 AST 규칙의 이점이 없어 정적 텍스트 스캔으로 둔다
 * (동적으로 조립된 SQL 은 정적 스캔으로 잡히지 않는다 — 인정된 한계).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface WildcardSelectViolation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/** `select *` · `select <alias>.*` (대소문자·개행 무관). `count(*)`·`sum(*)` 등 집계는 매치하지 않는다
 * ("select" 바로 뒤에 공백 다음이 `*` 또는 `식별자.*` 여야 하므로 `count(*)` 는 걸리지 않는다). */
const WILDCARD_SELECT_RE = /select\s+(?:\w+\.)?\*/i;

/** 순수 함수 — 주어진 소스 텍스트에서 컬럼을 열거하지 않는 select 를 찾는다. */
export function findWildcardSelects(file: string, source: string): WildcardSelectViolation[] {
  const violations: WildcardSelectViolation[] = [];
  const lines = source.split(/\r?\n/);
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    let codePart = lines[i] ?? "";
    if (inBlockComment) {
      const end = codePart.indexOf("*/");
      if (end === -1) continue;
      codePart = codePart.slice(end + 2);
      inBlockComment = false;
    }
    const lineCommentIdx = codePart.indexOf("//");
    if (lineCommentIdx !== -1) codePart = codePart.slice(0, lineCommentIdx);
    let blockStart = codePart.indexOf("/*");
    while (blockStart !== -1) {
      const blockEnd = codePart.indexOf("*/", blockStart + 2);
      if (blockEnd === -1) {
        codePart = codePart.slice(0, blockStart);
        inBlockComment = true;
        break;
      }
      codePart = codePart.slice(0, blockStart) + codePart.slice(blockEnd + 2);
      blockStart = codePart.indexOf("/*");
    }
    if (WILDCARD_SELECT_RE.test(codePart)) {
      violations.push({ file, line: i + 1, snippet: (lines[i] ?? "").trim() });
    }
  }
  return violations;
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.isFile() && extname(full) === ".ts") {
      out.push(full);
    }
  }
  return out;
}

/** 스캔 루트(기본 ["src/workflow"]) 아래 .ts 를 전수 검사한다. 스캔 루트가 존재하지 않으면
 * 0건 통과가 아니라 실패(throw)한다(조용한 통과 금지). */
export function scanStorageSql(
  roots: readonly string[],
  cwd: string = process.cwd(),
): WildcardSelectViolation[] {
  const violations: WildcardSelectViolation[] = [];
  for (const root of roots) {
    const absRoot = join(cwd, root);
    if (!existsSync(absRoot)) {
      throw new Error(`scanStorageSql: 스캔 루트가 존재하지 않습니다 — ${absRoot}`);
    }
    for (const file of walkTsFiles(absRoot)) {
      violations.push(...findWildcardSelects(file, readFileSync(file, "utf8")));
    }
  }
  return violations;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const argRoots = process.argv.slice(2);
  const roots = argRoots.length > 0 ? argRoots : ["src/workflow"];
  try {
    const violations = scanStorageSql(roots);
    if (violations.length === 0) {
      process.stdout.write(`sql:check OK — no wildcard select in ${roots.join(", ")}\n`);
    } else {
      for (const v of violations) {
        process.stderr.write(`[wildcard-select] ${v.file}:${v.line} — ${v.snippet}\n`);
      }
      process.stderr.write(`sql:check FAIL — ${violations.length} violation(s)\n`);
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`sql:check FAIL — ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
