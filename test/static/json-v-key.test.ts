import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// N16 (FR-2): src/cli 의 모든 stdout JSON 출력은 최상위 `v`(스키마 버전) 키를 가져야 한다 —
// 소비자가 구조 변경을 v 로 분기하기 때문. 신규 --json 사이트가 v 를 빠뜨리면 이 정적 가드가 잡는다
// (선언↔표면 드리프트 방지 — usage:check/i18n:check 계열).
//
// 스캔 대상 idiom = `process.stdout.write(JSON.stringify(<expr>...))`(리포지토리의 stdout-JSON 관용).
// 한계(no-silent-caps): 별도 변수로 문자열을 조립하거나 console.log 를 경유하는 출력은 이 정적 스캔이
// 못 잡는다 — 실제 출력 순도·v 보유의 행동 검증은 test/cli/json-no-human-text.test.ts 가 담당한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const cliDir = path.join(repoRoot, "src", "cli");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// stdout 으로 나가는 JSON.stringify 의 첫 인자(값 식)를 첫 `,` 또는 `)` 까지 캡처.
const EMIT_RE = /process\.stdout\.write\(\s*JSON\.stringify\(\s*([\s\S]*?)[,)]/g;

// 최상위 v 없이 허용되는 문서화된 예외(값 식을 공백 제거 후 매칭):
// - `null`   : run.ts 부팅 타임아웃/크래시 센티널(단일 null 값)
// - `report` : run.ts BootReport — report 객체가 자체 v 를 중첩 보유
const ALLOW = new Set(["null", "report"]);

describe("N16: src/cli 의 stdout JSON 출력은 최상위 v 를 보유한다", () => {
  it("모든 process.stdout.write(JSON.stringify(...)) 가 { v: ... } 또는 문서화된 예외다", () => {
    const violations: string[] = [];
    for (const file of listTsFiles(cliDir)) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(EMIT_RE)) {
        const expr = (m[1] ?? "").replace(/\s/g, "");
        if (/^\{v:/.test(expr) || ALLOW.has(expr)) continue;
        violations.push(
          `${path.relative(repoRoot, file)}: JSON.stringify(${(m[1] ?? "").trim()}…)`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  it("스캐너가 실제 사이트를 포착한다(정규식 고장 시 조용히 통과 방지)", () => {
    let count = 0;
    for (const file of listTsFiles(cliDir)) {
      count += [...fs.readFileSync(file, "utf8").matchAll(EMIT_RE)].length;
    }
    expect(count).toBeGreaterThan(5);
  });
});
