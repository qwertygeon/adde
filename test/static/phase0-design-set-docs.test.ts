import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 001-phase0-baseline-storage-spike — 설계 세트 문서 정적 검증(T030).
// docs/specs/design_v2/** 는 git 비추적(비공개) — existsSync + describe.runIf 가드.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// ---------------------------------------------------------------------------
// SC-012 (FR-010) — 13_LICENSE_AND_DEPENDENCY_POLICY.md §6 도입 체크리스트 5항목
// ---------------------------------------------------------------------------

const licensePolicyDocPath = path.join(
  repoRoot,
  "docs/specs/design_v2/13_LICENSE_AND_DEPENDENCY_POLICY.md",
);

const CHECKLIST_ITEMS: RegExp[] = [
  /compil|빌드|컴파일/i, // 설치 시 컴파일 유발 여부
  /prebuilt|사전\s*빌드/i, // 사전 빌드 대상과 미스매치 시 결과
  /node.{0,10}floor|engines\.node|자체\s*Node\s*하한/i, // 사전 빌드의 자체 Node 하한
  /fail (to install|at first run)|첫\s*실행\s*실패|설치.{0,10}실패/i, // 비사용자의 설치·첫 실행 실패
  /re-?classif|버전\s*올림|version bump/i, // 버전 올림마다 재분류
];

function readChecklistSection(): string {
  const text = fs.readFileSync(licensePolicyDocPath, "utf8");
  return text.slice(text.indexOf("Dependency introduction checklist"));
}

describe.runIf(fs.existsSync(licensePolicyDocPath))("SC-012: 도입 체크리스트 5항목", () => {
  it("Happy: 5항목(컴파일 유발·사전빌드 미스매치·자체 하한·설치 실패 가능성·재분류)이 모두 존재한다", () => {
    const section = readChecklistSection();
    const missing = CHECKLIST_ITEMS.filter((re) => !re.test(section));
    expect(missing).toEqual([]);
  });

  it("Edge: 표현이 정확 문구가 아니어도 의미 매치(정규식)로 통과한다", () => {
    expect(
      /compil|빌드|컴파일/i.test("Does installing this package trigger native compilation?"),
    ).toBe(true);
  });

  it("Error: 5항목 중 하나라도 빠지면 실패로 귀결된다", () => {
    const brokenSection = CHECKLIST_ITEMS.slice(0, 4)
      .map((re) => re.source)
      .join(" ");
    const missing = CHECKLIST_ITEMS.filter((re) => !re.test(brokenSection));
    expect(missing.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// SC-020 (FR-018) — 19_PLATFORM_AND_PACKAGE_BASELINE.md §9 쿼리 계층 결론
// ---------------------------------------------------------------------------

const platformBaselineDocPath = path.join(
  repoRoot,
  "docs/specs/design_v2/19_PLATFORM_AND_PACKAGE_BASELINE.md",
);
const storageSpecPath = path.join(
  repoRoot,
  "docs/specs/design_v2/07_STORAGE_EVENT_AND_PROJECTION_SPEC.md",
);

describe.runIf(fs.existsSync(platformBaselineDocPath) && fs.existsSync(storageSpecPath))(
  "SC-020: 쿼리 계층 결론 3요소",
  () => {
    it("Happy: 손 SQL·쿼리 빌더 양쪽 근거 + 채택 결론 + 도메인 타입 불변 진술이 모두 있다", () => {
      const text = fs.readFileSync(platformBaselineDocPath, "utf8");
      expect(text).toMatch(/Kysely|쿼리\s*빌더/i);
      expect(text).toMatch(/손으로\s*쓴\s*SQL|hand-written SQL/i);
      expect(text).toMatch(
        /도메인\s*타입.{0,20}(바뀌지 않|불변)|domain types? (do not|don't) change/i,
      );
    });

    it("Edge: 대표 테이블 이름이 프로젝션 스키마에 실재한다", () => {
      const text = fs.readFileSync(platformBaselineDocPath, "utf8");
      const storageSpecText = fs.readFileSync(storageSpecPath, "utf8");
      const tableMatch = /`(\w+)`\s*(?:테이블|table)/i.exec(text);
      expect(tableMatch).not.toBeNull();
      const tableName = (tableMatch as RegExpExecArray)[1];
      expect(storageSpecText).toMatch(new RegExp(`### \`${tableName}\``));
    });

    it("Error: 3요소 중 도메인 타입 불변 진술이 빠진 합성 텍스트는 요구를 충족하지 않는다", () => {
      const broken = "쿼리 빌더와 손으로 쓴 SQL 양쪽을 검토했고 손 SQL 을 채택한다.";
      expect(/도메인\s*타입.{0,20}(바뀌지 않|불변)/.test(broken)).toBe(false);
    });
  },
);
