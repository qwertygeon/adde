import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-036 (NFR-002): 코어에는 엔진 종류를 비교해 갈라지는 분기가 존재하지 않는다. 엔진 종속 동작은
// engines/** 안에만 있다("코어" 정적 경계 = design.md §계층·모듈 구조: core·record·gate·surfaces).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const CORE_DIRS = ["core", "record", "gate", "surfaces"];
// 알려진 엔진 id 리터럴 — 등록된 엔진이 늘어나면 이 목록도 늘어난다(현재는 acp 1종).
const ENGINE_ID_LITERALS = ["acp", "claude-agent-acp"];

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

/** `=== "acp"` / `== 'acp'` 류 비교 분기만 판정한다 — 주석·문서 문자열 내 우연한 언급은 대상 아님. */
function hasEngineComparisonBranch(content: string, id: string): boolean {
  const re = new RegExp(`[=!]==?\\s*["'\`]${id}["'\`]|["'\`]${id}["'\`]\\s*[=!]==?`, "g");
  return re.test(content);
}

describe("SC-036: 코어 모듈에 엔진 id 비교 분기가 0건이다", () => {
  it("Happy: core·record·gate·surfaces 전수 검색 결과 엔진 id 리터럴 비교가 0건이다", () => {
    const hits: string[] = [];
    for (const dirName of CORE_DIRS) {
      const dir = path.join(repoRoot, "src", dirName);
      for (const file of listTsFiles(dir)) {
        const content = fs.readFileSync(file, "utf8");
        for (const id of ENGINE_ID_LITERALS) {
          if (hasEngineComparisonBranch(content, id)) hits.push(`${file}::${id}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("Edge: 엔진 id 문자열이 주석·문서 문자열에만 등장하는 경우는 위반으로 잡지 않는다", () => {
    const sample = `// acp 엔진 예시 문서화\nconst x = 1;`;
    expect(hasEngineComparisonBranch(sample, "acp")).toBe(false);
  });

  it('Error: 코어에 `=== "acp"` 형태를 도입하면 검출기가 위반을 잡는다(가드 자기점검)', () => {
    const injected = `if (engine === "acp") { doSomething(); }`;
    expect(hasEngineComparisonBranch(injected, "acp")).toBe(true);
  });
});
