import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Source, SourceContext, SourceDescriptor } from "../../src/src-adapters/source.js";

// SC-009 (FR-007): 훅(validate/doctorChecks/wizard) 을 전혀 제공하지 않는 최소 descriptor 라도
// per-source 검증/진단 단계가 오류 없이 생략되고(optional 체이닝) 공통 처리만 수행된다.
// SC-010 (FR-008): 새 소스는 레지스트리에 descriptor 1개(+필요한 훅)를 등록하는 것만으로 지원
// 목록·거부판정·doctor 소스 유효성 체크에 반영된다 — lane-config.ts·diagnostics.ts 코드 변경은
// 0건이어야 한다. 본 파일은 SOURCE_REGISTRY 모듈을 테스트 전용으로 확장(vi.mock)해 이를 증명한다
// (실 레지스트리를 런타임에 mutate 하면 SOURCE_IDS 파생 스냅숏이 갱신되지 않아 증명이 안 됨).

const TEST_SOURCE_ID = "test-source-sc009-010";

function makeMinimalSource(): Source {
  return {
    start: async () => {},
    stop: async () => {},
    requestPermission: async () => {},
    onDecision: () => {},
    renderOut: async () => {},
    notify: async () => {},
  };
}

/** 훅 전부 미제공 — factory 만 필수(FR-007). */
function makeMinimalDescriptor(): SourceDescriptor {
  return { factory: (_ctx: SourceContext) => makeMinimalSource() };
}

vi.mock("../../src/src-adapters/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/src-adapters/index.js")>();
  const registry = { ...actual.SOURCE_REGISTRY, [TEST_SOURCE_ID]: makeMinimalDescriptor() };
  return { ...actual, SOURCE_REGISTRY: registry, SOURCE_IDS: Object.keys(registry) };
});

const { laneAdd } = await import("../../src/core/lane-config.js");
const { runDoctor } = await import("../../src/core/diagnostics.js");
const { SOURCE_REGISTRY, SOURCE_IDS } = await import("../../src/src-adapters/index.js");

let base: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "adde-srcdesc-"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("mock 전제 — 테스트 소스가 코드 변경 없이 SOURCE_IDS 에 반영된다", () => {
  it("SOURCE_IDS·SOURCE_REGISTRY 가 테스트 소스를 포함한다(mock 확인)", () => {
    expect(SOURCE_IDS).toContain(TEST_SOURCE_ID);
    expect(SOURCE_REGISTRY[TEST_SOURCE_ID]).toBeDefined();
  });
});

describe("SC-010: 새 소스 등록만으로 지원목록·거부판정·doctor 에 반영된다", () => {
  it("lane add --source <신규소스> 는 거부되지 않고 생성된다(지원목록 인식, lane-config.ts 무변경)", async () => {
    const res = await laneAdd("proj", "lane1", { base, source: TEST_SOURCE_ID });
    expect(fs.existsSync(res.confPath)).toBe(true);
    expect(res.conf.source).toBe(TEST_SOURCE_ID);
  });

  it("doctor 의 source 유효성 체크가 신규 소스를 PASS 로 인식한다(diagnostics.ts 무변경, 동일 SOURCE_IDS 기준)", async () => {
    await laneAdd("doctorproj", "lane1", { base, source: TEST_SOURCE_ID });
    const checks = await runDoctor("doctorproj", { base });
    const sourceCheck = checks.find((c) => c.name === "lane1: source");
    expect(sourceCheck?.level).toBe("PASS");
    expect(sourceCheck?.detail).toBe(TEST_SOURCE_ID);
  });
});

describe("SC-009: 훅 미제공 소스는 per-source 단계가 오류 없이 생략된다(공통 처리만)", () => {
  it("validate 훅 미제공 — laneAdd 는 공통 검증만 수행하고 소스별 오류·경고 없이 생성된다", async () => {
    const res = await laneAdd("proj2", "lane2", { base, source: TEST_SOURCE_ID, cwd: base });
    expect(res.warnings).toEqual([]); // cwd 존재 + 소스별 경고 없음(validate 훅 미제공)
  });

  it("doctorChecks 훅 미제공 — runDoctor 는 소스별 FAIL/PASS 를 추가하지 않고 공통 항목만 보고한다", async () => {
    await laneAdd("proj3", "lane3", { base, source: TEST_SOURCE_ID });
    const checks = await runDoctor("proj3", { base });
    // source 유효성 체크(PASS) 외에 lane3 관련 FAIL 이 없다 — per-source 진단이 오류 없이 생략됨.
    const laneChecks = checks.filter((c) => c.name.startsWith("lane3:"));
    expect(laneChecks.every((c) => c.level !== "FAIL")).toBe(true);
  });

  it("wizard 훅 미제공 — SOURCE_REGISTRY 조회 시 wizard 는 undefined(옵션 훅, 접근 시 오류 없음)", () => {
    expect(SOURCE_REGISTRY[TEST_SOURCE_ID]?.wizard).toBeUndefined();
    expect(SOURCE_REGISTRY[TEST_SOURCE_ID]?.wizard?.collect).toBeUndefined();
  });
});
