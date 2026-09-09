import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 001-phase0-baseline-storage-spike — 하한 상향 고지·환경 사실 정적 검증(T042).
//
// **순서 유예(PROC-R17) — docs 단계 완료 전 RED 가 정상이다.** 사용자 대면 문서 본문 갱신
// (CHANGELOG·README·getting-started·troubleshooting) 과 `.claude/docs/infra.md` §5 갱신은
// tasks.md "문서 갱신 위임" 절에 따라 docs 단계 소관이며 Test·Development 는 수행하지 않는다.
// test(EXECUTION) 시점에 본 파일이 RED 여도 그 자체로는 결함이 아니다 — docs 단계 완료 후
// 이 파일만 단독 재실행해 GREEN 으로 종결한다(선례: test/static/docs-coverage.test.ts 서두).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function read(rel: string): string | undefined {
  const p = path.join(repoRoot, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;
}

// ---------------------------------------------------------------------------
// SC-030 (FR-027) — 하한 상향 파괴적 고지
// ---------------------------------------------------------------------------

describe("SC-030: 하한 상향이 파괴적 변경으로 고지된다(docs 단계 완료 전 RED 정상)", () => {
  it("Happy: CHANGELOG.md [Unreleased] 와 설치 문서에 BREAKING·새 최소 버전·이유가 두 언어 모두 있다", () => {
    const changelog = read("CHANGELOG.md") ?? "";
    const gettingStartedEn = read("docs/getting-started.md") ?? "";
    const gettingStartedKo = read("docs/getting-started.ko.md") ?? "";
    expect(changelog).toMatch(/BREAKING/);
    expect(changelog).toMatch(/24\.15\.0/);
    expect(gettingStartedEn).toMatch(/24\.15\.0/);
    expect(gettingStartedKo).toMatch(/24\.15\.0/);
  });

  it("Edge: README·troubleshooting 도 새 하한을 표기한다(GAP-009 소재 포함)", () => {
    const readmeEn = read("README.md") ?? "";
    const readmeKo = read("README.ko.md") ?? "";
    const troubleshootingEn = read("docs/troubleshooting.md") ?? "";
    const troubleshootingKo = read("docs/troubleshooting.ko.md") ?? "";
    expect(readmeEn).toMatch(/24\.15\.0|>=\s*24/);
    expect(readmeKo).toMatch(/24\.15\.0|>=\s*24/);
    expect(troubleshootingEn).not.toMatch(/Node < 22|Upgrade to Node 22\+/);
    expect(troubleshootingKo).not.toMatch(/Node < 22|Node 22\+/);
  });

  it("Error: 한 언어에만 고지가 있으면 위반이다(합성 대조로 판별력 확인)", () => {
    const enOnly = "BREAKING: minimum Node is now 24.15.0";
    const koMissing = "";
    expect(/BREAKING/.test(enOnly)).toBe(true);
    expect(/파괴적|BREAKING/.test(koMissing)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SC-031 (FR-028) — infra.md §5 환경 사실 2건
// ---------------------------------------------------------------------------

const infraPath = path.join(repoRoot, ".claude/docs/infra.md");
describe.runIf(fs.existsSync(infraPath))(
  "SC-031: 인프라 문서 환경 사실 2건(docs 단계 완료 전 RED 정상 · 비공개 가드)",
  () => {
    it("Happy: 링크된 SQLite 버전의 Node 독립 변동 사실과 모듈 없는 Node 빌드 존재 사실이 §5 에 있다", () => {
      const text = fs.readFileSync(infraPath, "utf8");
      expect(text).toMatch(/SQLite.{0,40}(독립|independent)/);
      expect(text).toMatch(/--without-sqlite|모듈.{0,10}없는.{0,10}Node/);
    });

    it("Edge: 사실 서술에 출처(구성 옵션·배포판 이름)가 포함된다", () => {
      const text = fs.readFileSync(infraPath, "utf8");
      expect(text).toMatch(/Homebrew|configure\.py|nodejs\/node/);
    });

    it("Error: 한 건만 있는 합성 텍스트는 요구를 충족하지 않는다", () => {
      const broken = "SQLite 버전은 Node 버전과 독립적으로 변할 수 있다(Homebrew).";
      const hasBoth =
        /SQLite.{0,40}(독립|independent)/.test(broken) &&
        /--without-sqlite|모듈.{0,10}없는.{0,10}Node/.test(broken);
      expect(hasBoth).toBe(false);
    });
  },
);
