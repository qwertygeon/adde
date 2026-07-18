import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_SPECS } from "../../src/cli/spec.js";

// 디스패치 테이블화(SC-001) — run.ts 의 명령별 if(first===) 수작업 사슬 제거 + COMMAND_SPECS 파생
// DISPATCH 핸들러 테이블 드리프트 가드. C-002/C-003(4단계) 착지 전에는 예상 RED(PPG-1 병렬).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const runSrcPath = path.join(repoRoot, "src", "cli", "run.ts");

function readRunSrc(): string {
  return fs.readFileSync(runSrcPath, "utf8");
}

describe("SC-001 Happy: run.ts 최상위 명령별 if(first===) 분기 사슬이 부재한다", () => {
  it('run() 본문에 `if (first === "<cmd>")` 형태의 최상위 디스패치 분기가 하나도 없다', () => {
    const src = readRunSrc();
    // 여는 괄호 직후 first === 로 시작하는 분기만 매치 — 전역 플래그/help 판정의
    // `g.help || first === "help"`(첫 피연산자가 first 가 아님)·`first !== "lane"`(부정 비교)은
    // 이 패턴에 해당하지 않아 오검출하지 않는다.
    const topLevelIfChain = /if\s*\(\s*first\s*===\s*["'][^"']+["']\s*\)/;
    expect(src).not.toMatch(topLevelIfChain);
  });
});

describe("SC-001 Edge: DISPATCH 테이블 키 집합이 COMMAND_SPECS 이름 집합과 정확히 일치한다", () => {
  it("run.ts 의 DISPATCH 정의 구간에 COMMAND_SPECS 의 모든 명령 이름이 키로 존재한다(드리프트 가드)", () => {
    const src = readRunSrc();
    const dispatchIdx = src.indexOf("DISPATCH");
    expect(
      dispatchIdx,
      "run.ts 에 DISPATCH 식별자가 아직 없음(디스패치 테이블화 미착지 — 4단계 C 레이어 대기)",
    ).toBeGreaterThanOrEqual(0);
    const runFnIdx = src.indexOf("export async function run(");
    const tableRegion =
      runFnIdx > dispatchIdx ? src.slice(dispatchIdx, runFnIdx) : src.slice(dispatchIdx);
    for (const { name } of COMMAND_SPECS) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const keyPattern = new RegExp(`(^|[{,\\s])${escaped}\\s*:`, "m");
      expect(keyPattern.test(tableRegion), `DISPATCH 정의 구간에 "${name}" 키가 없음`).toBe(true);
    }
  });
});
