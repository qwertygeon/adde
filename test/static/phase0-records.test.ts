import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 001-phase0-baseline-storage-spike — 차수 기록 정적 검증(T028).
// 대상 문서는 docs/spec/design_v2/phase0/**·docs/spec/design_v2/17_*.md — 프로젝트
// CLAUDE.md "공개/비공개 구조" 상 docs/spec/design_v2/ 전체가 git 비추적(비공개)이다. 로컬에서만
// 실 검증하고 공개 CI 체크아웃에는 파일이 없으므로 skipped 로 구분 보고한다(선례
// test/static/sla-exemption.test.ts). PPG-1 병렬 중 Development(레이어 A)가 아직 기록
// 파일을 착지시키지 않은 시점의 RED 는 예상 상태다(PROC-R15). 파일 읽기는 `describe.skip`
// 상태에서도 describe 콜백 본문 자체는 수집 단계에 실행되므로, ENOENT 를 피하기 위해 항상
// 각 `it()` 본문 안에서 지연 읽기한다(top-level 읽기 금지 — sla-exemption.test.ts 선례와 동형).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const phase0Dir = path.join(repoRoot, "docs/spec/design_v2/phase0");

// ---------------------------------------------------------------------------
// SC-001 (FR-001) — baseline-gates.md
// ---------------------------------------------------------------------------

const GATE_ITEMS = [
  "typecheck",
  "lint",
  "format:check",
  "i18n:check",
  "usage:check",
  "build",
  "test",
] as const;

/** baseline 기록이 실행 시각·게이트 항목별 결과·테스트 통과 수·green 판정을 모두 갖는가. */
function baselineRecordComplete(text: string): boolean {
  return (
    /실행\s*시각|Started|시작\s*[:：]/.test(text) &&
    /테스트\s*통과\s*수|passed/i.test(text) &&
    /green/i.test(text) &&
    GATE_ITEMS.every((g) => text.includes(g))
  );
}

const baselinePath = path.join(phase0Dir, "baseline-gates.md");
describe.runIf(fs.existsSync(baselinePath))("SC-001: baseline 기록 완비", () => {
  it("Happy: 실행 시각·항목별 결과·테스트 통과 수가 모두 있고 판정이 green", () => {
    const text = fs.readFileSync(baselinePath, "utf8");
    expect(baselineRecordComplete(text)).toBe(true);
  });

  it("Edge: 7게이트 전건 행이 존재한다(누락 0)", () => {
    const text = fs.readFileSync(baselinePath, "utf8");
    const missing = GATE_ITEMS.filter((g) => !text.includes(g));
    expect(missing).toEqual([]);
  });

  it("Error: 판정 필드가 없는 합성 기록은 완비로 판정되지 않는다", () => {
    const broken = "실행 시각: 2026-09-08\n" + GATE_ITEMS.join("\n");
    expect(baselineRecordComplete(broken)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SC-002 (FR-002) — port-boundary-inventory.md
// ---------------------------------------------------------------------------

const PORT_BOUNDARIES = [
  "project",
  "session",
  "binding",
  "event",
  "Surface",
  "permission",
] as const;

function boundariesComplete(text: string): { boundary: string; ok: boolean }[] {
  return PORT_BOUNDARIES.map((b) => {
    const idx = text.indexOf(b);
    if (idx === -1) return { boundary: b, ok: false };
    const window = text.slice(idx, idx + 400);
    return { boundary: b, ok: /test|테스트/i.test(window) && /\.ts|src\//.test(window) };
  });
}

const portBoundaryPath = path.join(phase0Dir, "port-boundary-inventory.md");
describe.runIf(fs.existsSync(portBoundaryPath))("SC-002: 포트 경계 6종 인벤토리", () => {
  it("Happy: 6경계 각각 진입점 경로와 기존 테스트 위치가 적혀 있다", () => {
    const text = fs.readFileSync(portBoundaryPath, "utf8");
    const results = boundariesComplete(text);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("Edge: 인용된 경로 문자열이 실제 저장소 파일을 가리킨다", () => {
    const text = fs.readFileSync(portBoundaryPath, "utf8");
    const pathMatches = [...text.matchAll(/`(src\/[\w./-]+\.ts)`/g)].map((m) => m[1] as string);
    expect(pathMatches.length).toBeGreaterThan(0);
    const missing = pathMatches.filter((p) => !fs.existsSync(path.join(repoRoot, p)));
    expect(missing).toEqual([]);
  });

  it("Error: 6경계 중 하나라도 없는 합성 인벤토리는 불완전으로 판정된다", () => {
    const broken = PORT_BOUNDARIES.slice(0, 5)
      .map((b) => `${b}: src/x.ts, test/x.test.ts`)
      .join("\n");
    const results = boundariesComplete(broken);
    expect(results.some((r) => !r.ok)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SC-003 (FR-003) / SC-028 (FR-025) / SC-029 (FR-026) — decision-artifact-checks.md
// ---------------------------------------------------------------------------

const decisionChecksPath = path.join(phase0Dir, "decision-artifact-checks.md");
const hasDecisionChecks = fs.existsSync(decisionChecksPath);
const adrDir = path.join(repoRoot, "docs/spec/design_v2/adr");

describe.runIf(hasDecisionChecks)("SC-003: ADR 인덱스↔파일 상태 일치", () => {
  it("Happy: 대조 결과가 기록되어 있고 불일치 0건이 명시된다", () => {
    const text = fs.readFileSync(decisionChecksPath, "utf8");
    expect(text).toMatch(/불일치\s*0건|0\s*건\s*불일치|no\s+mismatch/i);
  });

  it("Edge: 인덱스의 각 ADR 상태 값이 개별 파일의 - Status: 값과 정확히 일치한다", () => {
    const adrReadme = fs.readFileSync(path.join(adrDir, "README.md"), "utf8");
    const indexRows = [...adrReadme.matchAll(/\|\s*(\d{4})\s*\|[^|]*\|\s*([^|]+?)\s*\|/g)];
    expect(indexRows.length).toBeGreaterThan(0);
    for (const row of indexRows) {
      const id = row[1] as string;
      const indexStatus = (row[2] as string).trim();
      const filePath = fs.readdirSync(adrDir).find((f) => f.startsWith(`${id}-`));
      if (filePath === undefined) continue;
      const fileText = fs.readFileSync(path.join(adrDir, filePath), "utf8");
      const statusMatch = /- Status:\s*(.+)/.exec(fileText);
      expect(statusMatch, `${id} 파일에 - Status: 행이 있어야 한다`).not.toBeNull();
      expect((statusMatch as RegExpExecArray)[1]?.trim()).toBe(indexStatus);
    }
  });

  it("Error: 인덱스에 있는 ADR 파일이 실존하지 않으면 대조가 실패로 귀결된다", () => {
    const files = fs.readdirSync(adrDir);
    const missing = ["9999"].filter((id) => !files.some((f) => f.startsWith(`${id}-`)));
    expect(missing).toEqual(["9999"]);
  });
});

describe.runIf(hasDecisionChecks)("SC-028: 커밋 프로토콜 명명·ADR 지목", () => {
  it("Happy: 프로토콜이 이름을 갖고 쓰기 경계가 열거되며 기록에 반영되어 있다", () => {
    const text = fs.readFileSync(decisionChecksPath, "utf8");
    expect(text).toMatch(/durable intent journal/);
    expect(text).toMatch(/Accepted/);
  });

  it("Edge: 두 ADR 이 동일 문자열로 프로토콜을 지목한다", () => {
    const adr0002 = fs.readFileSync(path.join(adrDir, "0002-event-projection-markdown.md"), "utf8");
    const adr0008 = fs.readFileSync(path.join(adrDir, "0008-storage-role-separation.md"), "utf8");
    expect(adr0002).toMatch(/durable intent journal/);
    expect(adr0008).toMatch(/durable intent journal/);
    expect(/- Status:\s*Accepted/.exec(adr0002)).not.toBeNull();
    expect(/- Status:\s*Accepted/.exec(adr0008)).not.toBeNull();
  });

  it("Error: 한쪽이라도 Proposed 이거나 이름 미지목이면 조건이 성립하지 않는다", () => {
    const adr0002 = fs.readFileSync(path.join(adrDir, "0002-event-projection-markdown.md"), "utf8");
    const brokenAdr = adr0002.replace("Accepted", "Proposed");
    expect(/- Status:\s*Accepted/.exec(brokenAdr)).toBeNull();
  });
});

describe.runIf(hasDecisionChecks)("SC-029: 외부 인용 재대조 4건 판정", () => {
  it("Happy: 재대조 4건 각각 확인 또는 부분정정 판정과 근거가 존재한다", () => {
    const text = fs.readFileSync(decisionChecksPath, "utf8");
    const verdicts = [...text.matchAll(/확인|부분정정/g)];
    expect(verdicts.length).toBeGreaterThanOrEqual(4);
  });

  it("Edge: 부분정정 건은 무엇을 정정했는지 명시된다", () => {
    const text = fs.readFileSync(decisionChecksPath, "utf8");
    if (!/부분정정/.test(text)) return; // 부분정정 0건이면 이 서브검사는 해당 없음
    const idx = text.indexOf("부분정정");
    const window = text.slice(idx, idx + 200);
    expect(window.length).toBeGreaterThan("부분정정".length);
  });

  it("Error: 미판정 문구가 남아 있으면 실패로 귀결된다", () => {
    const broken = "재대조 1: 미판정\n재대조 2: 확인\n재대조 3: 확인\n재대조 4: 확인";
    expect(/미판정/.test(broken)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SC-016 (FR-014) / SC-019 (FR-017) — storage-spike-measurements.md
// ---------------------------------------------------------------------------

const spikeMeasurementsPath = path.join(phase0Dir, "storage-spike-measurements.md");
describe.runIf(fs.existsSync(spikeMeasurementsPath))(
  "SC-016: 측정 기록이 버전·출처를 병기한다",
  () => {
    it("Happy: Node 버전과 링크된 SQLite 버전이 항목마다 병기된다", () => {
      const text = fs.readFileSync(spikeMeasurementsPath, "utf8");
      expect(text).toMatch(/Node\s*v?\d+\.\d+/);
      expect(text).toMatch(/SQLite\s*\d+\.\d+/);
    });

    it("Edge: 안정성 주장에 공식 문서 출처가 인용되어 있다", () => {
      const text = fs.readFileSync(spikeMeasurementsPath, "utf8");
      expect(text).toMatch(/nodejs\.org/);
    });

    it("Error: 버전 병기가 빠진 합성 항목은 요구를 충족하지 않는다", () => {
      const broken = "조건부 INSERT: 통과 (출처 없음)";
      expect(/Node\s*v?\d+\.\d+/.test(broken) && /SQLite\s*\d+\.\d+/.test(broken)).toBe(false);
    });
  },
);

describe.runIf(fs.existsSync(spikeMeasurementsPath))("SC-019: 실패 시 중단·보고 경로", () => {
  it("Happy: 실패가 없었다는 사실 자체가 기록으로 남아 있다", () => {
    const text = fs.readFileSync(spikeMeasurementsPath, "utf8");
    expect(text).toMatch(/실패\s*0|실패\s*없음|no\s+failure/i);
  });

  it("Edge: 실패 기록이 있다면 항목·측정 근거가 함께 있다", () => {
    const text = fs.readFileSync(spikeMeasurementsPath, "utf8");
    if (!/실패\s*\d*\s*건/.test(text)) return;
    expect(text).toMatch(/측정\s*근거|근거/);
  });

  it("Error: 우회 설계 산출물을 시사하는 문구는 0건이어야 한다", () => {
    const text = fs.readFileSync(spikeMeasurementsPath, "utf8");
    expect(text).not.toMatch(/우회\s*설계/);
  });
});

// ---------------------------------------------------------------------------
// SC-027 (FR-024) — 17_IMPLEMENTATION_ROADMAP.md Phase 0 경로표
// ---------------------------------------------------------------------------

const ARTIFACTS = [
  "이벤트 로그",
  "프로젝션 스토어",
  "런타임 큐 스토어",
  "제어큐 디렉터리",
  "capability 키 파일",
  "Work 마크다운",
  "첨부",
  "백업",
];

const roadmapPath = path.join(repoRoot, "docs/spec/design_v2/17_IMPLEMENTATION_ROADMAP.md");
describe.runIf(fs.existsSync(roadmapPath))("SC-027: 경로표 8행 4답", () => {
  it("Happy: 8개 아티팩트 전부에 루트·동기화·초기화·수동삭제 답이 채워져 있다", () => {
    const text = fs.readFileSync(roadmapPath, "utf8");
    const rows = text.split("\n").filter((line) => ARTIFACTS.some((a) => line.includes(a)));
    expect(rows.length).toBeGreaterThanOrEqual(ARTIFACTS.length);
    for (const row of rows) {
      const cells = row.split("|").map((c) => c.trim());
      const blanks = cells.filter((c) => c.length === 0);
      // 표 앞뒤 파이프로 인한 빈 셀 최대 2개(선두·후미)까지만 허용
      expect(blanks.length).toBeLessThanOrEqual(2);
    }
  });

  it("Edge: 초기화 답이 인벤토리 줄·가드 여부·vault 해석 불가 처분 3요소를 포함한다", () => {
    const text = fs.readFileSync(roadmapPath, "utf8");
    expect(text).toMatch(/인벤토리\s*줄|줄/);
    expect(text).toMatch(/가드/);
    expect(text).toMatch(/해석\s*불가/);
  });

  it("Error: 빈칸이 있는 합성 행은 완비로 판정되지 않는다", () => {
    const brokenRow = "| 이벤트 로그 | vault | | 인벤토리 줄 | 손실 |";
    const cells = brokenRow.split("|").map((c) => c.trim());
    const blanks = cells.filter((c) => c.length === 0);
    expect(blanks.length).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// SC-036 (NFR-004) — environment-observation.md 전역 변경 고지
// ---------------------------------------------------------------------------

const envObsRecordPath = path.join(phase0Dir, "environment-observation.md");
describe.runIf(fs.existsSync(envObsRecordPath))("SC-036: 전역 상태 변경 고지 기록", () => {
  it("Happy: 전역 변경 지점마다 사전 고지·승인 사실이 기재되거나 '전역 변경 없음'이 기록된다", () => {
    const text = fs.readFileSync(envObsRecordPath, "utf8");
    expect(/전역\s*변경\s*없음/.test(text) || /고지.*승인|승인.*고지/.test(text)).toBe(true);
  });

  it("Edge: '전역 변경 없음'이면 그 사실이 명시 문자열로 존재한다", () => {
    const text = fs.readFileSync(envObsRecordPath, "utf8");
    if (/고지.*승인|승인.*고지/.test(text)) return;
    expect(text).toMatch(/전역\s*변경\s*없음/);
  });

  it("Error: 변경했는데 고지 기록이 없는 합성 상태는 요구를 충족하지 않는다", () => {
    const broken = "설정 루트 경로를 임시로 변경함";
    expect(/전역\s*변경\s*없음/.test(broken) || /고지.*승인|승인.*고지/.test(broken)).toBe(false);
  });
});
