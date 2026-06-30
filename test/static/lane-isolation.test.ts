import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { lanePaths as lanePathsFn } from "../../src/shared/paths.js";

// SC-025: 레인 교차 경로 접근 패턴 0건 — 정적 코드 분석
// ADR-009: lane 파라미터 동적 구성·하드코딩 금지

const srcDir = path.resolve(process.cwd(), "src");

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllTsFiles(fullPath));
    } else if (entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("정적 분석 — 레인 격리 (SC-025)", () => {
  it("소스 코드에 레인 이름이 하드코딩된 경로가 없다", () => {
    // 예: queue/telegram-claude/, state/lane-a/ 등 레인 이름 고정
    // 정상 패턴: lanePaths(base, proj, lane) 로 동적 구성
    const tsFiles = getAllTsFiles(srcDir);
    if (tsFiles.length === 0) {
      expect(true).toBe(true);
      return;
    }

    // 레인 이름 하드코딩 의심 패턴: queue/telegram-claude/ 등 고정 레인명 포함 경로 리터럴
    const hardcodedLanePath = /["'`](queue|processing|out|state)\/(telegram|lane-[ab]|[a-z]+-[a-z]+)\//;
    const violations: string[] = [];
    for (const file of tsFiles) {
      const content = fs.readFileSync(file, "utf8");
      if (hardcodedLanePath.test(content)) {
        violations.push(file);
      }
    }
    expect(violations).toHaveLength(0);
  });

  it("lanePaths 함수에서 lane 파라미터 없이 경로를 조합하는 코드가 없다", () => {
    const tsFiles = getAllTsFiles(srcDir);
    if (tsFiles.length === 0) {
      expect(true).toBe(true);
      return;
    }

    // paths.ts 를 제외한 나머지에서 경로를 직접 조합하지 않아야 함
    const directPathConcat = /path\.join\(\s*[^)]*(?:queue|processing|out|state)[^)]*\)/;
    const violations: string[] = [];
    for (const file of tsFiles) {
      // paths.ts 자체는 제외
      if (file.endsWith("paths.ts")) continue;
      const content = fs.readFileSync(file, "utf8");
      // 직접 path.join 으로 레인 경로 구성 (lanePaths 사용하지 않고)
      if (directPathConcat.test(content) && !content.includes("lanePaths")) {
        violations.push(file);
      }
    }
    // 이 체크는 informational — lanePaths 없이 직접 경로 조합이 있으면 경고
    // 경우에 따라 paths.ts 내부 구현은 허용이므로 violations 가 비어야 함
    expect(violations).toHaveLength(0);
  });

  it("레인 A 경로 객체가 레인 B 경로에 접근하지 않음을 런타임으로 확인", () => {
    // 동적 검증: 두 레인의 경로 객체를 생성하고 교차 접근이 구조적으로 불가능한지 확인
    // lanePaths 는 파라미터만으로 경로를 결정하므로 레인 B 경로를 알 방법이 없음
    const pathsA = lanePathsFn("/tmp/adde-test", "proj", "lane-a") as unknown as Record<string, string>;
    const pathsB = lanePathsFn("/tmp/adde-test", "proj", "lane-b") as unknown as Record<string, string>;

    // A 경로가 B 의 lane-b 를 포함하지 않음
    for (const key of Object.keys(pathsA)) {
      const val = pathsA[key];
      if (val) {
        expect(val).not.toContain("lane-b");
      }
    }

    // B 경로가 A 의 lane-a 를 포함하지 않음
    for (const key of Object.keys(pathsB)) {
      const val = pathsB[key];
      if (val) {
        expect(val).not.toContain("lane-a");
      }
    }
  });
});
