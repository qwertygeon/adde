import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-021(NFR-005) — 라이브니스 기록·주기 갱신·정상 종료 제거·기동 창 종료 요청 4항목 각각에
// 실 프로세스로 기동해 관측하는 케이스가 1건 이상 존재해야 한다(함수 직접 호출·더블 단독 케이스만
// 으로 구성된 항목 0건). 판정 조건 = `test/integration/**/*.test.ts` 파일이 `spawn(process.execPath`
// 와 항목 키워드를 **함께** 보유. 스캔 로직은 파일명을 하드코딩하지 않으므로 신규 spawn 테스트가
// 추가돼도 자동 커버된다(선례 core-engine-agnostic.test.ts SC-066 자기점검 패턴).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const integrationDir = path.join(repoRoot, "test", "integration");

const SPAWN_MARKER = "spawn(process.execPath";

// 4항목 키워드 — 본 spec 이 저술한 spawn 테스트 파일의 describe 제목에 실제로 등장하는 문구.
const ITEM_KEYWORDS: ReadonlyArray<{ item: string; keyword: string }> = [
  { item: "기록", keyword: "라이브니스 기록" },
  { item: "주기 갱신", keyword: "주기 갱신" },
  { item: "정상 종료 제거", keyword: "정상 종료 시 기록 제거" },
  { item: "기동 창 종료 요청", keyword: "기동 창 종료 요청" },
];

// 존재하지 않아야 할 대조 키워드 — 스캔이 항상 통과하는 게 아니라 실제로 판별력을 갖는지 확인.
const ABSENT_KEYWORD = "존재하지-않는-다섯번째-항목-키워드-그룹-XYZZY";

function listTestFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTestFiles(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** keyword 와 spawn(process.execPath 를 함께 보유한 파일 수를 반환한다. */
function countFilesWithBoth(keyword: string): number {
  let count = 0;
  for (const file of listTestFiles(integrationDir)) {
    const content = fs.readFileSync(file, "utf8");
    if (content.includes(SPAWN_MARKER) && content.includes(keyword)) count++;
  }
  return count;
}

describe("SC-021: 실 프로세스 관통 4항목 각각에 spawn 케이스가 1건 이상 존재한다", () => {
  it("Happy: 4항목 각각이 spawn(process.execPath 를 포함한 파일에서 1건 이상 발견된다", () => {
    for (const { item, keyword } of ITEM_KEYWORDS) {
      const count = countFilesWithBoth(keyword);
      expect(
        count,
        `${item}(키워드: ${keyword}) 항목의 실 프로세스 spawn 케이스가 없다`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("Edge: 더블 단독으로만 구성된 항목이 0건이다(4항목 중 spawn 파일 매치가 없는 항목 없음)", () => {
    const zeroMatchItems = ITEM_KEYWORDS.filter(({ keyword }) => countFilesWithBoth(keyword) === 0);
    expect(zeroMatchItems).toEqual([]);
  });

  it("Error: 스캔이 실제로 판별력을 갖는다 — 존재하지 않는 5번째 키워드 그룹은 미발견으로 판정한다", () => {
    expect(countFilesWithBoth(ABSENT_KEYWORD)).toBe(0);
  });

  it("스캐너 자기점검: test/integration 스캔이 파일을 1건 이상 포착한다(경로 오류로 매칭 0 방지)", () => {
    expect(listTestFiles(integrationDir).length).toBeGreaterThan(0);
  });
});
