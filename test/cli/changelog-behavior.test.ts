import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-008 (FR-007, [env:static]) · SC-017: 이 사이클의 사용자 관측 변경(전역 플래그 위치 무관 인식·
// 미지원 플래그 거부·신규 lane set 명령)이 CHANGELOG 에 문서화됐는지 확인한다.
// 섹션명에 결합하지 않도록 CHANGELOG 전체를 검색한다 — 개발 중엔 [Unreleased] 에 기재되고
// 릴리스 확정 시 [X.Y.Z] 로 스탬핑되므로, 문서화 사실이 스탬핑·차기 사이클 후에도 유지됨을 검증한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const changelogPath = path.join(repoRoot, "CHANGELOG.md");
const changelog = fs.readFileSync(changelogPath, "utf8");

describe("전역 플래그 위치 무관 인식 behavior change 기재 (SC-008 Happy)", () => {
  it("CHANGELOG 에 전역 플래그(-v/--version, -h/--help)가 위치 무관 인식된다는 변화가 기재된다", () => {
    const hasLine = changelog
      .split("\n")
      .some(
        (line) =>
          /위치\s*무관|position/i.test(line) &&
          /(--version|-v\b|--help|-h\b|전역)/i.test(line),
      );
    expect(hasLine, "CHANGELOG 에 전역 플래그 위치 무관 인식 변화 기재 항목을 찾을 수 없음").toBe(true);
  });
});

describe("미지원 플래그 거부 behavior change 기재 (SC-008 Happy)", () => {
  it("CHANGELOG 에 미지원 플래그가 오류+usage 로 거부된다는 변화가 기재된다", () => {
    const hasLine = changelog
      .split("\n")
      .some(
        (line) =>
          /(미지원|unsupported|unknown)\s*(플래그|option|flag)/i.test(line) &&
          /(거부|reject|오류|error)/i.test(line),
      );
    expect(hasLine, "CHANGELOG 에 미지원 플래그 거부 변화 기재 항목을 찾을 수 없음").toBe(true);
  });
});

describe("lane set 명령 CHANGELOG 기재 (SC-017)", () => {
  it("CHANGELOG 에 'lane set' 언급 항목이 존재한다", () => {
    const hasLine = changelog.split("\n").some((line) => /lane\s*set/i.test(line));
    expect(hasLine, "CHANGELOG 에 lane set 기재 항목을 찾을 수 없음").toBe(true);
  });
});
