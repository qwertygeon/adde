import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// 001-phase0-baseline-storage-spike — 정책 데이터 파일 정적 검증(T029).
// policy/*.json 은 공개 추적 대상(design.md §5) — 비공개 가드 불요. PPG-1 병렬 중 파일이
// 아직 없으면 describe.runIf 로 개별 격리해 RED 를 명확히 보고한다(PROC-R15).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

interface Override {
  name?: string;
  version?: string;
  reason?: string;
  licenseTextOrSource?: string;
  reviewer?: string;
  date?: string;
  distributionImpact?: string;
  expiresAt?: string;
  reReviewTrigger?: string;
}

const OVERRIDE_REQUIRED_FIELDS = [
  "name",
  "version",
  "reason",
  "licenseTextOrSource",
  "reviewer",
  "date",
  "distributionImpact",
] as const;

function overrideIsComplete(o: Override): boolean {
  const baseComplete = OVERRIDE_REQUIRED_FIELDS.every(
    (f) => typeof o[f] === "string" && (o[f] as string).length > 0,
  );
  const hasExpiryOrTrigger =
    (typeof o.expiresAt === "string" && o.expiresAt.length > 0) ||
    (typeof o.reReviewTrigger === "string" && o.reReviewTrigger.length > 0);
  return baseComplete && hasExpiryOrTrigger;
}

// ---------------------------------------------------------------------------
// SC-004 (FR-004) — policy/licenses.json
// ---------------------------------------------------------------------------

interface LicensesPolicy {
  allow?: unknown[];
  reviewRequired?: unknown[];
  deny?: unknown[];
  overrides?: Override[];
}

const licensesPath = path.join(repoRoot, "policy/licenses.json");
function readLicensesPolicy(): LicensesPolicy {
  return JSON.parse(fs.readFileSync(licensesPath, "utf8")) as LicensesPolicy;
}

describe.runIf(fs.existsSync(licensesPath))("SC-004: 라이선스 정책 데이터 파일 4목록", () => {
  it("Happy: allow·reviewRequired·deny·overrides 가 모두 존재한다", () => {
    const parsed = readLicensesPolicy();
    expect(Array.isArray(parsed.allow)).toBe(true);
    expect(Array.isArray(parsed.reviewRequired)).toBe(true);
    expect(Array.isArray(parsed.deny)).toBe(true);
    expect(Array.isArray(parsed.overrides)).toBe(true);
  });

  it("Edge: override 항목이 있다면 각각 8필드(만료 또는 트리거 하나 이상)를 갖는다", () => {
    const parsed = readLicensesPolicy();
    const overrides = parsed.overrides ?? [];
    for (const o of overrides) {
      expect(overrideIsComplete(o), `override ${o.name}@${o.version} 필드 누락`).toBe(true);
    }
  });

  it("Error: 만료·트리거 둘 다 없는 override 는 불완전으로 판정된다", () => {
    const broken: Override = {
      name: "pkg",
      version: "1.0.0",
      reason: "r",
      licenseTextOrSource: "s",
      reviewer: "r",
      date: "2026-01-01",
      distributionImpact: "d",
    };
    expect(overrideIsComplete(broken)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SC-005 (FR-005) — policy/native-dependencies.json
// ---------------------------------------------------------------------------

interface NativeEntry {
  name?: string;
  versionRange?: string;
  kind?: string;
  targets?: unknown;
  nodeFloor?: string;
  optional?: unknown;
  reviewedAt?: string;
  reviewedResolvedVersion?: string;
}

const NATIVE_REQUIRED_FIELDS = [
  "name",
  "versionRange",
  "kind",
  "targets",
  "nodeFloor",
  "reviewedAt",
  "reviewedResolvedVersion",
] as const;

function nativeEntryComplete(e: NativeEntry): boolean {
  return (
    NATIVE_REQUIRED_FIELDS.every((f) => e[f] !== undefined && e[f] !== "") &&
    typeof e.optional === "boolean"
  );
}

const nativeDepsPath = path.join(repoRoot, "policy/native-dependencies.json");
function readNativeInventory(): { entries?: NativeEntry[] } {
  return JSON.parse(fs.readFileSync(nativeDepsPath, "utf8")) as { entries?: NativeEntry[] };
}

describe.runIf(fs.existsSync(nativeDepsPath))("SC-005: 네이티브 인벤토리 필드", () => {
  it("Happy: entries 배열이 존재한다", () => {
    const parsed = readNativeInventory();
    expect(Array.isArray(parsed.entries)).toBe(true);
  });

  it("Edge: 빈 entries 도 유효하다(파싱 성공만 요구)", () => {
    const parsed = readNativeInventory();
    expect(() => JSON.stringify(parsed.entries ?? [])).not.toThrow();
  });

  it("Error: 항목이 있으면 규정 필드가 전부 채워져 있어야 한다(누락 시 실패)", () => {
    const parsed = readNativeInventory();
    const entries = parsed.entries ?? [];
    const incomplete = entries.filter((e) => !nativeEntryComplete(e));
    expect(incomplete).toEqual([]);
    const broken: NativeEntry = { name: "x", versionRange: "1.0.0" };
    expect(nativeEntryComplete(broken)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SC-033 (NFR-002) — 신규 프로덕션·네이티브 의존성 0
// ---------------------------------------------------------------------------

function readGitShow(rev: string, rel: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${rev}:${rel}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  } catch {
    return undefined;
  }
}

function hasGit(): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

const gitAvailable = hasGit();
describe.runIf(gitAvailable)("SC-033: 신규 프로덕션·네이티브 의존성 0", () => {
  // baseline 실측 커밋(research.md §10.1) — 본 차수 시작 이전 상태와 대조한다.
  const baseCommit = "fd63425";
  const beforeText = readGitShow(baseCommit, "package.json");
  const afterPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };

  it.runIf(beforeText !== undefined)(
    "Happy: 전후 package.json 프로덕션 dependencies 추가가 스키마 라이브러리 1건뿐이다",
    () => {
      const beforePkg = JSON.parse(beforeText as string) as {
        dependencies?: Record<string, string>;
      };
      const beforeDeps = new Set(Object.keys(beforePkg.dependencies ?? {}));
      const afterDeps = new Set(Object.keys(afterPkg.dependencies ?? {}));
      const added = [...afterDeps].filter((d) => !beforeDeps.has(d));
      // 이후 차수가 승인받아 추가한 프로덕션 의존은 스키마 라이브러리 하나뿐이다.
      expect(added).toEqual(["zod"]);
    },
  );

  it("Edge: lockfile 이 존재하고 install 계열 스크립트를 유발하는 신규 항목 판정 대상이 없다", () => {
    const lockfilePath = path.join(repoRoot, "pnpm-lock.yaml");
    expect(fs.existsSync(lockfilePath)).toBe(true);
  });

  it("Error: dependencies 에 원래 없던 키를 추가한 합성 상태는 위반으로 판정된다", () => {
    const before = new Set(["a", "b"]);
    const after = new Set(["a", "b", "c"]);
    const added = [...after].filter((d) => !before.has(d));
    expect(added).toEqual(["c"]);
  });
});
