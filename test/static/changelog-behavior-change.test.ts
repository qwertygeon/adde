import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-016·SC-021(불변, 이전 cycle 회귀 가드) + SC-023(env 개명 반영 마이그레이션) + SC-014(신규,
// NFR-005) — 정적([env:static]) CHANGELOG/문서 검증. SC-014·SC-023 은 산출 주체가 6단계 Docs
// Agent(CHANGELOG.md·docs/commands*.md)라 5b(6단계 이전) 시점에는 미산출로 RED 가 예상 상태다
// (PROC-R15/PROC-R17 — 순서 유예). main 이 6단계 완료 후 이 파일만 재확인한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const changelogPath = path.join(repoRoot, "CHANGELOG.md");
const changelog = fs.readFileSync(changelogPath, "utf8");

describe("restart exit code 변경 behavior-change 기재 (SC-016)", () => {
  it("CHANGELOG 에 restart 종료 코드 변경(항상 0 → 실패 시 1)이 기재되어 있다", () => {
    // "restart" 언급과 "종료 코드 변경" 언급이 서로 무관한 별개 문장에 각각 존재해도 우연히
    // 통과하지 않도록, 같은 줄(=같은 changelog 항목)에 restart·종료코드/exit code·숫자 1 이
    // 함께 있는지로 판정한다(전역 OR 매칭의 거짓양성 방지).
    const hasCombinedLine = changelog
      .split("\n")
      .some(
        (line) =>
          /restart/i.test(line) && /(종료\s*코드|exit\s*code)/i.test(line) && /\b1\b/.test(line),
      );
    expect(hasCombinedLine, "restart 종료 코드 변경 기재 항목을 찾을 수 없음").toBe(true);
  });
});

describe("status --json BREAKING + 마이그레이션 안내 (SC-021)", () => {
  it("CHANGELOG 에 status --json BREAKING 표기와 `.` → `.lanes` 마이그레이션 안내가 기재되어 있다", () => {
    // BREAKING 표기 자체는 다른 항목(예: conf 키 네임스페이스화)에도 이미 존재하므로, status·--json·
    // BREAKING·.lanes 가 같은 항목(줄)에 함께 있는지로 판정해 무관 항목의 거짓양성을 막는다.
    const hasCombinedLine = changelog
      .split("\n")
      .some(
        (line) =>
          /status/i.test(line) && /--json/.test(line) && /BREAKING/.test(line) && /\.lanes/.test(line),
      );
    expect(hasCombinedLine, "status --json BREAKING + .lanes 마이그레이션 기재 항목을 찾을 수 없음").toBe(
      true,
    );
  });
});

describe("ADDE_UP_WAIT_MS 문서화 (SC-023, env 개명 반영)", () => {
  it("도움말 또는 프로젝트 문서에 신 env 명·의미(대기 상한 ms·양수만 유효·기본 8000)가 기재되어 있다", () => {
    const docsDir = path.join(repoRoot, "docs");
    const candidates = ["commands.md", "commands.ko.md"].map((f) => path.join(docsDir, f));
    const hits = candidates.filter(
      (f) => fs.existsSync(f) && fs.readFileSync(f, "utf8").includes("ADDE_UP_WAIT_MS"),
    );
    expect(hits.length, "ADDE_UP_WAIT_MS 를 언급하는 문서가 없음").toBeGreaterThan(0);
    const combined = hits.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    expect(combined).toMatch(/8000/); // 기본값 명시
    expect(combined).toMatch(/양수|positive/i); // 양수만 유효 명시
  });
});

describe("usage/파싱 오류 종료 코드 1→2 변경 기재 (SC-016, NFR-003)", () => {
  it("CHANGELOG 에 usage/파싱 오류·필수 인자 누락의 종료 코드가 1에서 2로 바뀌었다는 항목이 기재되어 있다", () => {
    const hasCombinedLine = changelog
      .split("\n")
      .some(
        (line) =>
          /(usage|파싱\s*오류|미지원\s*플래그|unknown-flag|위치\s*인자)/i.test(line) &&
          /(exit|종료\s*코드)/i.test(line) &&
          /1.*2|2.*1/.test(line),
      );
    expect(hasCombinedLine, "usage/파싱 오류 exit 1→2 변경 기재 항목을 찾을 수 없음").toBe(true);
  });
});

describe("status/doctor 진단·경고 stdout→stderr 이동 기재 (SC-016, NFR-003)", () => {
  it("CHANGELOG 에 status/doctor 의 진단·경고 출력이 stdout 에서 stderr 로 이동했다는 항목이 기재되어 있다", () => {
    const hasCombinedLine = changelog
      .split("\n")
      .some(
        (line) =>
          /(status|doctor)/i.test(line) && /stdout/i.test(line) && /stderr/i.test(line),
      );
    expect(hasCombinedLine, "status/doctor stdout→stderr 이동 기재 항목을 찾을 수 없음").toBe(true);
  });
});

describe("env 개명·판정 대체 관측 변화 CHANGELOG 기재 (SC-014, NFR-005)", () => {
  it("CHANGELOG 에 ADDE_UP_POLL_MS → ADDE_UP_WAIT_MS 개명 항목이 기재되어 있다", () => {
    const hasCombinedLine = changelog
      .split("\n")
      .some((line) => /ADDE_UP_POLL_MS/.test(line) && /ADDE_UP_WAIT_MS/.test(line));
    expect(
      hasCombinedLine,
      "env 개명(ADDE_UP_POLL_MS→ADDE_UP_WAIT_MS) 기재 항목을 찾을 수 없음",
    ).toBe(true);
  });

  it("CHANGELOG 에 기동 판정을 데몬 부팅 리포트 대기로 대체했다는 항목이 기재되어 있다", () => {
    const hasCombinedLine = changelog
      .split("\n")
      .some((line) => /(부팅|boot)\s*(리포트|report)/i.test(line) && /(up|restart)/i.test(line));
    expect(hasCombinedLine, "부팅 리포트 대기 판정 대체 기재 항목을 찾을 수 없음").toBe(true);
  });
});
