import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-008 (FR-007, [env:static]): 파서 통합이 수반하는 사용자 관측 동작 변화 2건(전역 플래그
// 위치 무관 인식·미지원 플래그 거부)이 CHANGELOG [Unreleased] 에 명시되는지 확인한다.
// C-02(4단계) 산출 전에는 RED 가 예상 상태다(PPG-1 병렬 — PROC-R15).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const changelogPath = path.join(repoRoot, "CHANGELOG.md");
const changelog = fs.readFileSync(changelogPath, "utf8");

function unreleasedSection(text: string): string {
  const match = /## \[Unreleased\]([\s\S]*?)(\n## \[|$)/.exec(text);
  return match?.[1] ?? "";
}

const unreleased = unreleasedSection(changelog);

describe("전역 플래그 위치 무관 인식 behavior change 기재 (SC-008 Happy)", () => {
  it("[Unreleased] 에 전역 플래그(-v/--version, -h/--help)가 위치 무관 인식된다는 변화가 기재된다", () => {
    const hasLine = unreleased
      .split("\n")
      .some(
        (line) =>
          /위치\s*무관|position/i.test(line) &&
          /(--version|-v\b|--help|-h\b|전역)/i.test(line),
      );
    expect(hasLine, "전역 플래그 위치 무관 인식 변화 기재 항목을 찾을 수 없음").toBe(true);
  });
});

describe("미지원 플래그 거부 behavior change 기재 (SC-008 Happy)", () => {
  it("[Unreleased] 에 미지원 플래그가 오류+usage 로 거부된다는 변화가 기재된다", () => {
    const hasLine = unreleased
      .split("\n")
      .some(
        (line) =>
          /(미지원|unsupported|unknown)\s*(플래그|option|flag)/i.test(line) &&
          /(거부|reject|오류|error)/i.test(line),
      );
    expect(hasLine, "미지원 플래그 거부 변화 기재 항목을 찾을 수 없음").toBe(true);
  });
});
