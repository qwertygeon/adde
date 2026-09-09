import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 001-phase0-baseline-storage-spike — 라이선스 게이트 단위 검증(T032).
// design.md §인터페이스 계약의 evaluateLicensePolicy() 확정 시그니처를 픽스처로만 판정한다
// (실 저장소 상태 비의존 — ADR-002). scripts/check-licenses.ts 는 PPG-1 병렬 중 아직 착지
// 안 했을 수 있어(레이어 B) 각 테스트 진입 시 개별 동적 import 로 격리한다(PROC-R15).

type LicenseScope = "production" | "development";

interface ResolvedPackage {
  name: string;
  version: string;
  scope: LicenseScope;
  declaredLicense: string | undefined;
  licenseFileText: string | undefined;
  installBuildsNatively: boolean;
  shipsPrebuiltBinary: boolean;
  os: readonly string[] | undefined;
  cpu: readonly string[] | undefined;
  optional: boolean;
}

function pkg(
  overrides: Partial<ResolvedPackage> & { name: string; version: string },
): ResolvedPackage {
  return {
    scope: "production",
    declaredLicense: "MIT",
    licenseFileText: undefined,
    installBuildsNatively: false,
    shipsPrebuiltBinary: false,
    os: undefined,
    cpu: undefined,
    optional: false,
    ...overrides,
  };
}

const basePolicy = {
  v: 1,
  allow: ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD"],
  reviewRequired: ["GPL-family", "LGPL-family", "Unlicense", "dual-license-unspecified"],
  deny: ["AGPL-family", "SSPL", "UNLICENSED"],
  dualLicenseSelections: [],
  overrides: [] as Array<{
    name: string;
    version: string;
    reason: string;
    licenseTextOrSource: string;
    reviewer: string;
    date: string;
    distributionImpact: string;
    expiresAt?: string;
    reReviewTrigger?: string;
  }>,
};

const emptyNativeInventory = { v: 1, entries: [] as Array<Record<string, unknown>> };

async function importGate() {
  return import("../../scripts/check-licenses.js");
}

// ---------------------------------------------------------------------------
// SC-007 (FR-007) — 금지 라이선스 실패
// ---------------------------------------------------------------------------

describe("SC-007: 금지 라이선스 픽스처가 게이트를 실패시킨다", () => {
  it("Happy: 프로덕션 스코프의 deny 목록 라이선스는 denied 사유로 failures 에 들어간다", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const packages = [pkg({ name: "evil-pkg", version: "1.0.0", declaredLicense: "AGPL-family" })];
    const result = evaluateLicensePolicy(packages, basePolicy, emptyNativeInventory);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ name: "evil-pkg", version: "1.0.0", reason: "denied" }),
    );
  });

  it("Edge: override 가 있어도 denied 는 admit 되지 않는다", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const policy = {
      ...basePolicy,
      overrides: [
        {
          name: "evil-pkg",
          version: "1.0.0",
          reason: "we like it",
          licenseTextOrSource: "n/a",
          reviewer: "someone",
          date: "2026-01-01",
          distributionImpact: "n/a",
          reReviewTrigger: "never",
        },
      ],
    };
    const packages = [pkg({ name: "evil-pkg", version: "1.0.0", declaredLicense: "AGPL-family" })];
    const result = evaluateLicensePolicy(packages, policy, emptyNativeInventory);
    expect(result.failures.some((f) => f.name === "evil-pkg" && f.reason === "denied")).toBe(true);
  });

  it("Error: 사유 코드 없는 실패 항목은 계약 위반이다(전건에 reason 존재를 요구)", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const packages = [pkg({ name: "evil-pkg", version: "1.0.0", declaredLicense: "AGPL-family" })];
    const result = evaluateLicensePolicy(packages, basePolicy, emptyNativeInventory);
    for (const f of result.failures) {
      expect(f.reason, `${f.name}@${f.version} 에 사유 코드가 있어야 한다`).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// SC-008 (FR-007) — 불명 라이선스 실패
// ---------------------------------------------------------------------------

describe("SC-008: 라이선스 불명 픽스처가 게이트를 실패시킨다", () => {
  it("Happy: 라이선스 표현이 없는 프로덕션 패키지는 unknown 사유로 실패한다", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const packages = [
      pkg({ name: "no-license-pkg", version: "1.0.0", declaredLicense: undefined }),
    ];
    const result = evaluateLicensePolicy(packages, basePolicy, emptyNativeInventory);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ name: "no-license-pkg", reason: "unknown" }),
    );
  });

  it("Edge: UNLICENSED 와 (SEE LICENSE IN 참조인데 배포 텍스트를 판독할 수 없는) 모순도 unknown 으로 판정된다", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const unlicensed = [pkg({ name: "u-pkg", version: "1.0.0", declaredLicense: "UNLICENSED" })];
    const result1 = evaluateLicensePolicy(unlicensed, basePolicy, emptyNativeInventory);
    expect(result1.failures.some((f) => f.name === "u-pkg" && f.reason === "unknown")).toBe(true);

    // ADR-003(DEC-001) 경계: SEE LICENSE IN 참조인데 배포 LICENSE 텍스트를 판독할 수 없으면
    // (표현은 있으나 텍스트와 모순되게 실재하지 않으므로) review_required 가 아니라 unknown 이다.
    const unreadableReference = [
      pkg({
        name: "c-pkg",
        version: "1.0.0",
        declaredLicense: "SEE LICENSE IN LICENSE.md",
        licenseFileText: undefined,
      }),
    ];
    const result2 = evaluateLicensePolicy(unreadableReference, basePolicy, emptyNativeInventory);
    expect(result2.failures.some((f) => f.name === "c-pkg" && f.reason === "unknown")).toBe(true);
  });

  it("Error: unknown 이 경고로 강등되면 안 된다(프로덕션 스코프는 항상 실패)", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const packages = [
      pkg({ name: "no-license-pkg", version: "1.0.0", declaredLicense: undefined }),
    ];
    const result = evaluateLicensePolicy(packages, basePolicy, emptyNativeInventory);
    expect(result.warnings.some((w) => w.name === "no-license-pkg")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SC-009 (FR-007) — 개발 스코프 검토필요 경고
// ---------------------------------------------------------------------------

describe("SC-009: 개발 스코프의 검토필요 판정은 경고로만 보고된다", () => {
  it("Happy: 개발 스코프 전용 reviewRequired 픽스처는 warnings 로만 기재된다(실패 0)", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const packages = [
      pkg({
        name: "gpl-dev-tool",
        version: "1.0.0",
        scope: "development",
        declaredLicense: "GPL-family",
      }),
    ];
    const result = evaluateLicensePolicy(packages, basePolicy, emptyNativeInventory);
    expect(result.failures).toEqual([]);
    expect(result.warnings.some((w) => w.name === "gpl-dev-tool")).toBe(true);
  });

  it("Edge: 같은 라이선스가 프로덕션에도 있으면 실패로 승격된다", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const packages = [
      pkg({
        name: "gpl-dev-tool",
        version: "1.0.0",
        scope: "development",
        declaredLicense: "GPL-family",
      }),
      pkg({
        name: "gpl-prod-tool",
        version: "1.0.0",
        scope: "production",
        declaredLicense: "GPL-family",
      }),
    ];
    const result = evaluateLicensePolicy(packages, basePolicy, emptyNativeInventory);
    expect(result.failures.some((f) => f.name === "gpl-prod-tool")).toBe(true);
  });

  it("Error: 개발 스코프의 denied·unknown 은 여전히 실패다(경고 아님)", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const packages = [
      pkg({
        name: "d-agpl",
        version: "1.0.0",
        scope: "development",
        declaredLicense: "AGPL-family",
      }),
      pkg({
        name: "d-unknown",
        version: "1.0.0",
        scope: "development",
        declaredLicense: undefined,
      }),
    ];
    const result = evaluateLicensePolicy(packages, basePolicy, emptyNativeInventory);
    expect(result.failures.some((f) => f.name === "d-agpl")).toBe(true);
    expect(result.failures.some((f) => f.name === "d-unknown")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SC-010 (FR-008) — 미기록 네이티브 실패
// ---------------------------------------------------------------------------

describe("SC-010: 미기록 네이티브 픽스처가 게이트를 실패시킨다", () => {
  it("Happy: 사전 빌드 바이너리 동봉 + 인벤토리 부재는 native_uninventoried 로 실패한다", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const packages = [
      pkg({
        name: "native-darwin-arm64",
        version: "1.0.0",
        shipsPrebuiltBinary: true,
        os: ["darwin"],
        cpu: ["arm64"],
      }),
    ];
    const result = evaluateLicensePolicy(packages, basePolicy, emptyNativeInventory);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ name: "native-darwin-arm64", reason: "native_uninventoried" }),
    );
  });

  it("Edge: 엔트리는 있으나 versionRange 가 해석된 버전을 덮지 못하면 native_version_uncovered", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const inventory = {
      v: 1,
      entries: [{ name: "native-darwin-arm64", versionRange: "0.9.0", kind: "ships_prebuilt" }],
    };
    const packages = [
      pkg({
        name: "native-darwin-arm64",
        version: "1.0.0",
        shipsPrebuiltBinary: true,
        os: ["darwin"],
        cpu: ["arm64"],
      }),
    ];
    const result = evaluateLicensePolicy(packages, basePolicy, inventory);
    expect(result.failures).toContainEqual(
      expect.objectContaining({ name: "native-darwin-arm64", reason: "native_version_uncovered" }),
    );
  });

  it("Error: 인벤토리 파일 자체 부재(엔트리 0)는 존재하되 매칭 없는 상태와 구분된다", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const packages = [
      pkg({
        name: "native-x",
        version: "1.0.0",
        shipsPrebuiltBinary: true,
        os: ["linux"],
        cpu: ["x64"],
      }),
    ];
    const resultEmptyInventory = evaluateLicensePolicy(packages, basePolicy, emptyNativeInventory);
    expect(resultEmptyInventory.failures.some((f) => f.name === "native-x")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SC-011 (FR-009) — 통과 시 귀속 인벤토리 산출
// ---------------------------------------------------------------------------

describe("SC-011: 통과 시 귀속 인벤토리가 산출된다", () => {
  it("Happy: 위반 0 픽스처는 실패 0 + attribution 에 프로덕션 전건이 담긴다", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const packages = [pkg({ name: "clean-pkg", version: "1.0.0", declaredLicense: "MIT" })];
    const result = evaluateLicensePolicy(packages, basePolicy, emptyNativeInventory);
    expect(result.failures).toEqual([]);
    expect(result.attribution).toContainEqual(
      expect.objectContaining({ name: "clean-pkg", version: "1.0.0", license: "MIT" }),
    );
  });

  it("Edge: writeAttributionInventory 는 mkdtemp 출력 경로에 원자적으로 파일을 쓴다", async () => {
    const { evaluateLicensePolicy, writeAttributionInventory } = await importGate();
    const packages = [pkg({ name: "clean-pkg", version: "1.0.0", declaredLicense: "MIT" })];
    const result = evaluateLicensePolicy(packages, basePolicy, emptyNativeInventory);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "adde-license-gate-"));
    const outPath = path.join(tmpDir, "attribution-inventory.json");
    const written = writeAttributionInventory(result.attribution, outPath);
    expect(written).toBe(outPath);
    const parsed = JSON.parse(fs.readFileSync(outPath, "utf8")) as { entries: unknown[] };
    expect(parsed.entries.length).toBe(result.attribution.length);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Error: 실패가 있는 평가는 attribution 이 비어 있거나 그 값을 인벤토리로 쓰지 않아야 한다", async () => {
    const { evaluateLicensePolicy } = await importGate();
    const packages = [pkg({ name: "evil-pkg", version: "1.0.0", declaredLicense: "AGPL-family" })];
    const result = evaluateLicensePolicy(packages, basePolicy, emptyNativeInventory);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.attribution.some((a) => a.name === "evil-pkg")).toBe(false);
  });
});
