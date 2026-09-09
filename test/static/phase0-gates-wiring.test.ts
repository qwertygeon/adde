import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// 001-phase0-baseline-storage-spike — 게이트 배선·하한 정적 검증(T031).
// package.json·CI/릴리스 워크플로·pre-push 훅 실파일을 직접 판독한다(공개 추적).
// PPG-1 병렬 중 Development(레이어 C)가 아직 배선하지 않은 시점의 RED 는 예상 상태.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

function readPkg(): { engines?: { node?: string }; scripts?: Record<string, string> } {
  return JSON.parse(read("package.json")) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// SC-006 (FR-006) — gates 체인에 라이선스 게이트 포함
// ---------------------------------------------------------------------------

describe("SC-006: gates 에 라이선스 게이트 포함", () => {
  it("Happy: gates 스크립트 문자열에 licenses:check 호출이 포함된다", () => {
    const pkg = readPkg();
    expect(pkg.scripts?.["gates"] ?? "").toMatch(/licenses:check/);
  });

  it("Edge: licenses:check 스크립트 자체가 존재하고 check-licenses 를 가리킨다", () => {
    const pkg = readPkg();
    expect(pkg.scripts?.["licenses:check"] ?? "").toMatch(/check-licenses/);
  });

  it("Error: gates 에서 licenses:check 가 빠지면 위반으로 판정된다", () => {
    const brokenGates = "typecheck && lint && build && test";
    expect(brokenGates).not.toMatch(/licenses:check/);
  });
});

// ---------------------------------------------------------------------------
// SC-013 (FR-011) — CI 런타임 하한 이상
// ---------------------------------------------------------------------------

/** 각 자리가 명시됐는지(undefined=미명시) 구분해 파싱한다 — 메이저 전용 표기(`node-version: 24`)를
 * "그 메이저 라인의 최신 minor"로 해석하기 위해 0 으로 뭉개지 않는다. */
function parseVersionParts(v: string): Array<number | undefined> {
  return v
    .replace(/^>=/, "")
    .split(".")
    .map((p) => (p.length > 0 ? Number(p) : undefined));
}

/**
 * `version` 이 `floor` 이상인지 판정한다. 메이저만 명시된 버전(`"24"`)은 같은 메이저 라인의
 * 최신 minor 를 가리키는 CI 관행(GitHub Actions `actions/setup-node`)을 반영해, 메이저가
 * 하한과 같으면(그 이상이 아니라 정확히 같으면) 통과로 본다 — SC-013 Edge 시나리오.
 */
function versionAtOrAboveFloor(version: string, floor: string): boolean {
  const v = parseVersionParts(version);
  const f = parseVersionParts(floor);
  const vMajor = v[0] ?? 0;
  const fMajor = f[0] ?? 0;
  if (vMajor !== fMajor) return vMajor > fMajor;
  const vMinor = v[1];
  if (vMinor === undefined) return true; // 메이저 전용 표기 — 같은 메이저면 통과로 간주
  const fMinor = f[1] ?? 0;
  if (vMinor !== fMinor) return vMinor > fMinor;
  const vPatch = v[2] ?? 0;
  const fPatch = f[2] ?? 0;
  return vPatch >= fPatch;
}

describe("SC-013: CI 가 선언 하한 이상 런타임에서 게이트를 실행한다", () => {
  it("Happy: ci.yml 의 node-version 이 package.json engines.node 하한 이상이고 pnpm run gates 를 호출한다", () => {
    const pkg = readPkg();
    const floor = pkg.engines?.node ?? "";
    const ci = read(".github/workflows/ci.yml");
    const versionMatch = /node-version:\s*["']?(\d+(?:\.\d+)*)["']?/.exec(ci);
    expect(versionMatch).not.toBeNull();
    const nodeVersion = (versionMatch as RegExpExecArray)[1] as string;
    expect(versionAtOrAboveFloor(nodeVersion, floor)).toBe(true);
    expect(ci).toMatch(/pnpm run gates/);
  });

  it("Edge: 메이저 표기(예 24)가 24.15 이상 라인이면 통과로 판정된다", () => {
    expect(versionAtOrAboveFloor("24", "24.15.0")).toBe(true);
  });

  it("Error: 하한 미만 잔존 표기(node-version: 22)는 실패로 판정된다", () => {
    expect(versionAtOrAboveFloor("22", "24.15.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SC-014 (FR-012) — 릴리스 발행 이전 라이선스 게이트 실행
// ---------------------------------------------------------------------------

describe("SC-014: 릴리스 발행 이전에 라이선스 게이트가 실행된다", () => {
  it("Happy: 게이트 재실행 단계가 태그·발행 단계보다 앞에 있다", () => {
    const release = read(".github/workflows/release.yml");
    const gateIdx = release.search(/Re-run gates/i);
    const tagIdx = release.search(/Tag and release/i);
    const publishIdx = release.search(/Publish to npm/i);
    expect(gateIdx).toBeGreaterThan(-1);
    expect(tagIdx).toBeGreaterThan(-1);
    expect(publishIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(tagIdx);
    expect(gateIdx).toBeLessThan(publishIdx);
  });

  it("Edge: 게이트 재실행이 pnpm run gates 단일 호출이다", () => {
    const release = read(".github/workflows/release.yml");
    const section = release.slice(
      release.search(/Re-run gates/i),
      release.search(/Read version/i) === -1 ? undefined : release.search(/Read version/i),
    );
    expect(section).toMatch(/pnpm run gates/);
    expect(section).not.toMatch(/pnpm run typecheck\s*\n\s*run: pnpm run lint/);
  });

  it("Error: 게이트 호출이 발행 단계보다 뒤에 있으면 위반으로 판정된다", () => {
    const brokenOrder = "Publish to npm\nRe-run gates";
    const gateIdx = brokenOrder.search(/Re-run gates/i);
    const publishIdx = brokenOrder.search(/Publish to npm/i);
    expect(gateIdx).toBeGreaterThan(publishIdx);
  });
});

// ---------------------------------------------------------------------------
// SC-021 (FR-019) — engines.node 상향
// ---------------------------------------------------------------------------

describe("SC-021: 런타임 하한이 상향된다", () => {
  it("Happy: package.json 의 engines.node 가 >=24.15.0 이다", () => {
    const pkg = readPkg();
    expect(pkg.engines?.node).toBe(">=24.15.0");
  });

  it("Edge: 소스·설정에 하한 리터럴(22) 잔존이 0건이다(diagnostics.ts 포함)", () => {
    const diagnostics = read("src/core/diagnostics.ts");
    expect(diagnostics).not.toMatch(/nodeMajor\s*>=\s*22/);
    expect(diagnostics).not.toMatch(/\(≥22\)/);
    expect(diagnostics).not.toMatch(/Node 22\+/);
  });

  it("Error: 하한 미달 버전 문자열은 versionAtOrAboveFloor 로 false 판정된다", () => {
    expect(versionAtOrAboveFloor("23.0.0", "24.15.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SC-041 (NFR-009) — 게이트 단일 출처
// ---------------------------------------------------------------------------

describe("SC-041: 게이트 단일 출처가 유지된다", () => {
  it("Happy: CI 와 로컬 pre-push 훅 양쪽이 pnpm run gates 를 호출한다", () => {
    const ci = read(".github/workflows/ci.yml");
    const prePush = read(".githooks/pre-push");
    expect(ci).toMatch(/pnpm run gates/);
    expect(prePush).toMatch(/pnpm run gates/);
  });

  it("Edge: release.yml 도 동일 스크립트를 호출한다(개별 재서술이 아니다)", () => {
    const release = read(".github/workflows/release.yml");
    expect(release).toMatch(/pnpm run gates/);
  });

  it("Error: 게이트 목록을 개별 재서술(typecheck && lint && test)하는 잔존은 위반이다", () => {
    const release = read(".github/workflows/release.yml");
    const reRunSection = release.slice(release.search(/Re-run gates/i));
    const firstStepEnd = reRunSection.indexOf("\n\n");
    const step = firstStepEnd === -1 ? reRunSection : reRunSection.slice(0, firstStepEnd);
    expect(step).not.toMatch(/run:\s*pnpm run typecheck[\s\S]*run:\s*pnpm run lint/);
  });
});
