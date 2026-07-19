import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-010 (NFR-001) — 판정 로직이 시각 비교·stale 추론이 아니라 boot id 정수 비교 + 리포트
// 존재/내용만으로 구성됨을 정적으로 확인한다. 008-cycle 의 폴링 3중 술어 구조 테스트(surfaceStartResult
// 단일 공유 경로 검증)를 리포트 대기 구조로 마이그레이션한다 — pollUpResult 단언은 제거하고,
// waitForBootReport 단일 호출·시각비교 부재·bootId 비교 존재 단언으로 대체한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const runSrcPath = path.join(repoRoot, "src", "cli", "run.ts");

describe("up/restart 판정 구조 — 시각 비교·stale 추론 부재 (SC-010 정적)", () => {
  it("freshFail/unresolved/bootUnconfirmed 술어와 Date.parse 시각 비교가 부재한다", () => {
    const src = fs.readFileSync(runSrcPath, "utf8");
    expect(src).not.toMatch(/freshFail|unresolved|bootUnconfirmed/);
    expect(src).not.toMatch(/Date\.parse\(/);
    // 판정용 시각 파생 변수(이번 up 시작 시각과의 비교)도 판정 경로에서 제거됨.
    expect(src).not.toMatch(/\bsinceMs\b/);
  });

  it("pollUpResult(폴링 판정)가 완전히 제거되었다", () => {
    const src = fs.readFileSync(runSrcPath, "utf8");
    expect(src).not.toMatch(/pollUpResult/);
  });

  it("waitForBootReport 가 정확히 1회 정의되고 단일 호출부(surfaceStartResult 내부)에서만 쓰인다", () => {
    const src = fs.readFileSync(runSrcPath, "utf8");
    const defMatches = src.match(/function\s+waitForBootReport\s*\(/g) ?? [];
    expect(defMatches).toHaveLength(1);
    const allMatches = src.match(/waitForBootReport\s*\(/g) ?? [];
    // 전체 출현(정의 포함) — up/restart 는 waitForBootReport 를 직접 부르지 않고 공유 경로
    // surfaceStartResult 를 통해서만 호출한다(정의 1 + 그 내부 호출 1 = 2, 중복 호출부 없음).
    expect(allMatches).toHaveLength(2);
  });

  it("판정이 boot id 정수 비교(strict-greater)로 구성된다", () => {
    const src = fs.readFileSync(runSrcPath, "utf8");
    expect(src).toMatch(/bootId\s*>\s*/);
  });

  it("surfaceStartResult 함수가 정확히 1회 정의되고 up·restart 양쪽에서 호출된다(단일 공유 경로)", () => {
    const src = fs.readFileSync(runSrcPath, "utf8");
    const defMatches = src.match(/function\s+surfaceStartResult\s*\(/g) ?? [];
    expect(defMatches).toHaveLength(1);
    const allMatches = src.match(/surfaceStartResult\s*\(/g) ?? [];
    expect(allMatches.length).toBeGreaterThanOrEqual(3);
  });

  it("실패 레인 안내(run.upFailed) 표면화가 중복 없이 1곳에서만 발화된다", () => {
    const src = fs.readFileSync(runSrcPath, "utf8");
    const matches = src.match(/t\(\s*"run\.upFailed"/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
