import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FLAG_VALUES, subFlagNames } from "../../src/cli/spec.js";

// SC-022 (NFR-005): telegram 기동 연결 확인 상한(10초, FR-011)은 고정 모듈 상수이며, 이를 위한
// 신규 CLI 플래그·conf 키를 추가하지 않는다(최소 명령 표면). 구조(static) 검증 — 명령·설정
// 표면(플래그 목록·conf 네임스페이스 필드)에 상한 관련 신규 키가 없음과, 상한 상수가 모듈
// 내부에만 존재(미export)함을 확인한다.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const SURFACE_SUSPECT_RE = /timeout|probe/i;

describe("SC-022: 기동 연결 확인 상한을 위한 신규 CLI 플래그가 없다", () => {
  it("lane add 플래그(subFlagNames 파생)에 상한(timeout/probe) 관련 플래그가 없다", () => {
    const suspects = subFlagNames("lane", "add").filter((f) => SURFACE_SUSPECT_RE.test(f));
    expect(suspects).toEqual([]);
  });

  it("FLAG_VALUES 에도 상한 관련 열거 플래그가 없다", () => {
    const suspects = Object.keys(FLAG_VALUES).filter((k) => SURFACE_SUSPECT_RE.test(k));
    expect(suspects).toEqual([]);
  });
});

describe("SC-022: 기동 연결 확인 상한을 위한 신규 conf 키가 없다", () => {
  it("shared/conf.ts NAMESPACE_FIELDS(telegram/markdown) 에 상한 관련 신규 키가 없다", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/shared/conf.ts"), "utf8");
    // `}\s*;` 만으로 종료를 판정하면 실제 종결자가 `} as const;`(공백+리터럴 포함)라 첫 매치를
    // 건너뛰고 그 뒤 아무 `{...};`(예: 무관 함수 본문의 빈 객체 리터럴)까지 과다 캡처해 버린다
    // (관련 무관 주석·코드에 우연히 timeout/probe 단어가 있으면 오탐 회귀). `as const` 트레일러까지
    // 명시해 객체 리터럴 자체로 매치를 정확히 경계 짓는다.
    const nsBlockMatch = /NAMESPACE_FIELDS\s*=\s*{([\s\S]*?)}\s*as const\s*;/.exec(src);
    expect(nsBlockMatch, "NAMESPACE_FIELDS 선언을 찾을 수 없음").not.toBeNull();
    expect(nsBlockMatch![1]).not.toMatch(SURFACE_SUSPECT_RE);
  });
});

describe("SC-022: 상한은 모듈 상수로만 존재하고 CLI/conf 로 노출되지 않는다", () => {
  it("TELEGRAM_STARTUP_PROBE_TIMEOUT_MS 는 telegram.ts 내부 상수로 존재하고 export 되지 않는다", () => {
    const src = fs.readFileSync(path.join(repoRoot, "src/src-adapters/telegram.ts"), "utf8");
    expect(src).toMatch(/\bTELEGRAM_STARTUP_PROBE_TIMEOUT_MS\b/); // 상수 존재(FR-011 구현)
    expect(src).not.toMatch(/export\s+(const|let)\s+TELEGRAM_STARTUP_PROBE_TIMEOUT_MS/); // 미export
  });
});
