import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// N-1 구조 개선 회귀 방지 — up/restart 의 결과 표면화(폴링·요약·exit code)가 단일 공유 경로
// (surfaceStartResult)로 정리되어 중복 블록이 없는지 정적으로 확인한다 (SC-110b).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const runSrcPath = path.join(repoRoot, "src", "cli", "run.ts");

describe("up/restart 결과 표면화 — 단일 공유 경로 (SC-110b Happy)", () => {
  it("surfaceStartResult 함수가 정확히 1회 정의되고 up·restart 양쪽에서 호출된다", () => {
    const src = fs.readFileSync(runSrcPath, "utf8");
    const defMatches = src.match(/function\s+surfaceStartResult\s*\(/g) ?? [];
    expect(defMatches).toHaveLength(1);

    // "surfaceStartResult(" 전체 매치(정의 1 + 호출부) — up/restart 양쪽에서 쓰이면 최소 3.
    const allMatches = src.match(/surfaceStartResult\s*\(/g) ?? [];
    expect(allMatches.length).toBeGreaterThanOrEqual(3);
  });

  it("pollUpResult 호출이 surfaceStartResult 내부 1곳에만 존재한다(중복 호출 부재)", () => {
    const src = fs.readFileSync(runSrcPath, "utf8");
    const defMatches = src.match(/function\s+pollUpResult\s*\(/g) ?? [];
    expect(defMatches).toHaveLength(1);
    const allMatches = src.match(/pollUpResult\(/g) ?? [];
    // 전체 출현(정의 포함) - 정의 수 = 실 호출 수. 단일 공유 경로면 정확히 1.
    expect(allMatches.length - defMatches.length).toBe(1);
  });

  it("실패 레인 안내(run.upFailed) 표면화가 중복 없이 1곳에서만 발화된다", () => {
    const src = fs.readFileSync(runSrcPath, "utf8");
    const matches = src.match(/t\(\s*"run\.upFailed"/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
