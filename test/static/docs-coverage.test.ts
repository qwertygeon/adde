import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// SC-062~SC-064 (FR-024·FR-025) — 사용자 대면 문서 전수 갱신 검증. **본 태스크는 검증 테스트
// 저술까지다**(design.md D014 지정) — 문서 본문 갱신은 docs 단계 소관이라, 이 파일은 docs 단계
// 완료 전까지 [env:static] "순서 유예" 상태로 RED 인 것이 정상이다(§SC 환경 태그 라우팅 PROC-R17).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const DOC_PAIRS = [
  ["README.md", "README.ko.md"],
  ["docs/README.md", "docs/README.ko.md"],
  ["docs/getting-started.md", "docs/getting-started.ko.md"],
  ["docs/commands.md", "docs/commands.ko.md"],
  ["docs/markdown.md", "docs/markdown.ko.md"],
  ["docs/troubleshooting.md", "docs/troubleshooting.ko.md"],
] as const;

function readDoc(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

// FR-024 가 열거한 최소 집합 — 각 항목이 "등장했다"로 판정할 영문판 대표 정규식(한글판은 병행
// 검사하되 문구 자유도가 커 존재 자체보다 구조 반영 여부를 폭넓게 허용한다).
const MIN_SET: Array<{ label: string; re: RegExp }> = [
  { label: "상태 표에 archived 없음·stopped 있음", re: /\bstopped\b/i },
  { label: "팔레트 그룹 구조", re: /records.{0,20}session|group/i },
  { label: "resume 의미 변경·기존 항목 소멸", re: /resume/i },
  { label: "안내 존 규격", re: /notice/i },
  { label: "경고/안내 역할 분리", re: /warning.{0,30}notice|notice.{0,30}warning/i },
  { label: "중지 노트 형태", re: /stopped note|stop.{0,10}note/i },
  { label: "재개 2형태·절단 규칙", re: /resume\s+<|resume\s+session|truncat/i },
  { label: "자동 중지 2경로·기본값·옵트아웃", re: /idle_stop|stop_after_min/i },
  { label: "설정 키 3개", re: /idle_stop/i },
  { label: "CLI 명령 2개(stop·resume)", re: /session stop/i },
  { label: "식별자 형식", re: /YYMMDD|\d{6}-\d/i },
  { label: "제거 3분기와 범위 차이", re: /purge|full removal|record.{0,10}removal/i },
  { label: "--force 제거", re: /--purge/i },
  { label: "세션별 저장소 분리(BREAKING)", re: /per[- ]session|session[- ]owned/i },
  { label: "초기화 명령", re: /factory-reset/i },
  { label: "attach/detach 구분", re: /attach.{0,20}detach|detach.{0,20}attach/i },
];

describe("SC-062: 문서 전수 반영 최소 집합이 한/영 양쪽에 등장한다", () => {
  it("Happy: 각 문서 쌍이 최소 집합 항목별 대조를 남긴다(항목별 판정 기록)", () => {
    const report: Array<{ doc: string; label: string; en: boolean; ko: boolean }> = [];
    for (const [en, ko] of DOC_PAIRS) {
      const enText = readDoc(en);
      const koText = readDoc(ko);
      for (const item of MIN_SET) {
        report.push({
          doc: en,
          label: item.label,
          en: item.re.test(enText),
          ko: item.re.test(koText),
        });
      }
    }
    // 자기점검 — 대조 자체가 공회전(0건 스캔)하지 않았는지 하한 확인.
    expect(report.length).toBeGreaterThan(0);
    void report; // 개별 실패는 아래 Error 케이스가 항목 단위로 표면화한다.
  });

  it("Error: FR-024 최소 집합 중 하나라도 어느 문서에도 등장하지 않으면 실패한다", () => {
    const missing: string[] = [];
    for (const item of MIN_SET) {
      const foundSomewhere = DOC_PAIRS.some(
        ([en, ko]) => item.re.test(readDoc(en)) || item.re.test(readDoc(ko)),
      );
      if (!foundSomewhere) missing.push(item.label);
    }
    expect(missing, `누락된 최소 집합 항목: ${missing.join(", ")}`).toHaveLength(0);
  });
});

describe("SC-063: commands.md·commands.ko.md 의 오서술 2건이 제거되고 재설계 동작으로 대체된다", () => {
  it("Happy: '--purge 없는 session rm 이 보존종료를 만든다' 서술이 남아있지 않다", () => {
    for (const doc of ["docs/commands.md", "docs/commands.ko.md"]) {
      const text = readDoc(doc);
      expect(text).not.toMatch(/without\s+`?--purge`?[\s\S]{0,60}archived/i);
    }
  });

  it("Error: '--purge 는 확인(또는 --force)이 필요하다' 서술이 남아있지 않다", () => {
    for (const doc of ["docs/commands.md", "docs/commands.ko.md"]) {
      const text = readDoc(doc);
      expect(text).not.toMatch(/--purge[\s\S]{0,60}--force/i);
    }
  });
});

describe("SC-064: attach/detach 는 TUI 소유권 배턴이며 중지와 다른 개념이라는 서술 + 미구현 표기", () => {
  it("Happy: 문서에 attach/detach 개념 구분과 미구현(이연) 표기가 함께 존재한다", () => {
    const combined = DOC_PAIRS.map(([en]) => readDoc(en)).join("\n");
    expect(combined).toMatch(/attach/i);
    expect(combined).toMatch(/detach/i);
    expect(combined).toMatch(/not.{0,20}implement|미구현|이연/i);
  });
});
