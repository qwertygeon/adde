// SC-045 (NFR-001), SC-049 (NFR-004) — 도메인 모듈 순수성(허용 import·금지 토큰)과 미배선 정적 검증.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const DOMAIN_DIR = path.join(repoRoot, "src/workflow/domain");

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

function violatesAllowlist(filePath: string, content: string): string[] {
  const violations: string[] = [];
  for (const spec of importSpecifiers(content)) {
    // 스키마 라이브러리는 패키지 루트 지정자만 허용한다(하위 경로 불허).
    if (spec === "node:crypto" || spec === "zod") continue;
    if (!spec.startsWith(".")) {
      violations.push(`${filePath}: disallowed import specifier "${spec}"`);
      continue;
    }
    const resolved = path.normalize(path.join(path.dirname(filePath), spec));
    if (!resolved.startsWith(DOMAIN_DIR)) {
      violations.push(`${filePath}: import escapes domain dir "${spec}"`);
    }
  }
  if (/from\s+["']node:crypto["']/.test(content)) {
    const cryptoImportMatch = content.match(/import\s*\{([^}]*)\}\s*from\s*["']node:crypto["']/);
    if (cryptoImportMatch !== null) {
      const names = cryptoImportMatch[1]?.split(",").map((s) => s.trim()) ?? [];
      for (const name of names) {
        if (name !== "createHash" && name.length > 0)
          violations.push(`${filePath}: node:crypto import "${name}" beyond createHash`);
      }
    }
  }
  for (const token of FORBIDDEN_TOKENS) {
    if (content.includes(token)) violations.push(`${filePath}: forbidden token "${token}"`);
  }
  return violations;
}

describe.runIf(fs.existsSync(DOMAIN_DIR))("SC-045: 도메인 모듈이 순수하다", () => {
  it("Happy: 도메인 import·호출 허용 목록 위반이 0건이다 (test_SC045_domain_imports_within_allowlist)", () => {
    const files = listTsFiles(DOMAIN_DIR);
    expect(files.length).toBeGreaterThan(0);
    const violations = files.flatMap((file) =>
      violatesAllowlist(file, fs.readFileSync(file, "utf8")),
    );
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("Edge: node:crypto 는 createHash 만 가져온다 (test_SC045_node_crypto_only_create_hash)", () => {
    const files = listTsFiles(DOMAIN_DIR);
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      const match = content.match(/import\s*\{([^}]*)\}\s*from\s*["']node:crypto["']/);
      if (match === null) continue;
      const names = (match[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      expect(names).toEqual(["createHash"]);
    }
  });

  it("Error: 주입 위반 코드를 스캐너가 검출한다 (test_SC045_scanner_detects_injected_clock_random_fs_import)", () => {
    const injected = `import { readFile } from "node:fs";\nconst n = Date.now();`;
    const violations = violatesAllowlist("synthetic.ts", injected);
    expect(violations.length).toBeGreaterThan(0);
  });
});

describe("SC-049: 도메인 모듈이 어디에도 연결되지 않는다", () => {
  function listSrcFiles(): string[] {
    return listTsFiles(path.join(repoRoot, "src"));
  }

  function hasDomainImport(filePath: string, content: string): boolean {
    for (const spec of importSpecifiers(content)) {
      if (spec.includes("workflow/domain")) return true;
      const inWorkflowRoot = path.dirname(filePath) === path.join(repoRoot, "src/workflow");
      if (inWorkflowRoot && (spec === "./domain" || spec.startsWith("./domain/"))) return true;
    }
    return false;
  }

  it("Happy: 도메인 밖 src/**의 도메인 import 가 0건이다 (test_SC049_no_domain_import_outside_domain)", () => {
    const files = listSrcFiles().filter((f) => !f.startsWith(DOMAIN_DIR));
    expect(files.length).toBeGreaterThan(0);
    const hits = files.filter((f) => hasDomainImport(f, fs.readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  it("Edge: 기존 src/workflow/index.ts 도 도메인을 import 하지 않는다 (test_SC049_existing_workflow_entry_does_not_import_domain)", () => {
    const entry = path.join(repoRoot, "src/workflow/index.ts");
    if (!fs.existsSync(entry)) return;
    expect(hasDomainImport(entry, fs.readFileSync(entry, "utf8"))).toBe(false);
  });

  it("Error: 주입 위반 import 를 검출한다(가드 자기점검) (test_SC049_scanner_detects_injected_import)", () => {
    expect(
      hasDomainImport("src/workflow/foo.ts", 'import { x } from "../workflow/domain/index.js";'),
    ).toBe(true);
  });
});
