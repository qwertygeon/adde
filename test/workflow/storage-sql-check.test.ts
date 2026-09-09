import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 001-phase0-baseline-storage-spike — 와일드카드 select 검사 단위 검증(T033).
// scripts/check-storage-sql.ts 를 픽스처 디렉터리(mkdtemp)로 주입해 판정한다.

async function importCheck() {
  return import("../../scripts/check-storage-sql.js");
}

function withTmpDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adde-sql-check-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("SC-026: 와일드카드 select 검사가 게이트에서 동작한다", () => {
  it("Happy: 스캔 루트에 select * 픽스처가 있으면 위반을 지목한다(파일·줄·스니펫)", async () => {
    const { scanStorageSql } = await importCheck();
    withTmpDir((dir) => {
      const wildcardDir = path.join(dir, "src", "workflow");
      fs.mkdirSync(wildcardDir, { recursive: true });
      const filePath = path.join(wildcardDir, "repo.ts");
      fs.writeFileSync(filePath, `export const q = "select * from tasks";\n`, "utf8");
      const violations = scanStorageSql(["src/workflow"], dir);
      expect(violations.length).toBeGreaterThan(0);
      const v = violations[0];
      expect(v?.file).toMatch(/repo\.ts$/);
      expect(v?.line).toBe(1);
      expect(v?.snippet).toMatch(/select \*/i);
    });
  });

  it("Edge: 컬럼 열거 select·count(*)·주석 내 select * 는 위반 0건이다", async () => {
    const { scanStorageSql } = await importCheck();
    withTmpDir((dir) => {
      const wildcardDir = path.join(dir, "src", "workflow");
      fs.mkdirSync(wildcardDir, { recursive: true });
      const filePath = path.join(wildcardDir, "clean.ts");
      fs.writeFileSync(
        filePath,
        [
          `export const q1 = "select id, name from tasks";`,
          `export const q2 = "select count(*) from tasks";`,
          `// select * from tasks -- 예시일 뿐`,
        ].join("\n"),
        "utf8",
      );
      const violations = scanStorageSql(["src/workflow"], dir);
      expect(violations).toEqual([]);
    });
  });

  it("Error: 스캔 루트가 존재하지 않으면 0건 통과가 아니라 실패다", async () => {
    const { scanStorageSql } = await importCheck();
    withTmpDir((dir) => {
      expect(() => scanStorageSql(["src/does-not-exist"], dir)).toThrow();
    });
  });
});

describe("findWildcardSelects — 순수 함수 단위 판정", () => {
  it("select t.* 대소문자 변형(같은 줄)도 검출한다", async () => {
    const { findWildcardSelects } = await importCheck();
    const violations = findWildcardSelects("x.ts", "SELECT t.* FROM tasks t");
    expect(violations.length).toBe(1);
  });
});
