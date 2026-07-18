import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMAND_SPECS } from "../../src/cli/spec.js";
import { DISPATCH } from "../../src/cli/run.js";

// 디스패치 테이블화(SC-001) — run.ts 의 명령별 if(first===) 수작업 사슬 제거 + COMMAND_SPECS 파생
// DISPATCH 핸들러 테이블 드리프트 가드.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const runSrcPath = path.join(repoRoot, "src", "cli", "run.ts");

function readRunSrc(): string {
  return fs.readFileSync(runSrcPath, "utf8");
}

// 소스 구조 가드 — 런타임 파리티가 잡지 못하는 별개의 회귀(테이블을 우회하는 최상위 if 분기
// 재도입)를 막는다. DISPATCH 에 키가 있어도 dispatch 이전 `if (first === "up")` 로 가로채면
// 파리티는 통과하므로, 이 anti-pattern 가드가 그 bypass 를 별도로 검출한다.
describe("SC-001 Happy: run.ts 최상위 명령별 if(first===) 분기 사슬이 부재한다(테이블 우회 가드)", () => {
  it('run() 본문에 `if (first === "<cmd>")` 형태의 최상위 디스패치 분기가 하나도 없다', () => {
    const src = readRunSrc();
    // 여는 괄호 직후 first === 로 시작하는 분기만 매치 — 전역 플래그/help 판정의
    // `g.help || first === "help"`(첫 피연산자가 first 가 아님)·`first !== "lane"`(부정 비교)은
    // 이 패턴에 해당하지 않아 오검출하지 않는다.
    const topLevelIfChain = /if\s*\(\s*first\s*===\s*["'][^"']+["']\s*\)/;
    expect(src).not.toMatch(topLevelIfChain);
  });
});

// 런타임 파리티 — 소스 텍스트가 아니라 실제 export 된 DISPATCH 객체를 검사한다. 명령 누락(드롭)과
// 초과 키(양방향)를 집합 동등성으로 강제하고, 각 엔트리가 실행 가능한 형태인지 확인한다.
// (특정 명령→엉뚱한 핸들러 오배선은 run-boot.test.ts 의 명령별 E2E 가 행동으로 커버한다.)
describe("SC-001 Edge: DISPATCH 키 집합이 COMMAND_SPECS 이름 집합과 정확히 일치한다(런타임 파리티)", () => {
  const specNames = COMMAND_SPECS.map((s) => s.name);
  const dispatchKeys = Object.keys(DISPATCH);

  it("드롭 가드 — COMMAND_SPECS 의 모든 명령이 DISPATCH 키로 존재한다", () => {
    const missing = specNames.filter((n) => !(n in DISPATCH));
    expect(missing, `DISPATCH 에 누락된 명령: ${missing.join(", ")}`).toEqual([]);
  });

  it("초과 가드 — DISPATCH 에 COMMAND_SPECS 밖의 키가 없다(역방향)", () => {
    const specSet = new Set(specNames);
    const extra = dispatchKeys.filter((k) => !specSet.has(k));
    expect(extra, `COMMAND_SPECS 에 없는 DISPATCH 키: ${extra.join(", ")}`).toEqual([]);
  });

  it("각 엔트리는 실행 가능한 핸들러(run: function)와 parse: boolean 을 가진다", () => {
    for (const [name, entry] of Object.entries(DISPATCH)) {
      expect(typeof entry.run, `${name}.run 이 함수가 아님`).toBe("function");
      expect(typeof entry.parse, `${name}.parse 가 boolean 이 아님`).toBe("boolean");
    }
  });
});
