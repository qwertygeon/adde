/**
 * 라이선스·네이티브 의존성 게이트 — `pnpm run licenses:check` (CI 게이트).
 * 순수 판정 코어(`evaluateLicensePolicy`)와 I/O 어댑터(`collectResolvedPackages`·
 * `writeAttributionInventory`)를 분리한다 — 코어는 픽스처 주입으로 실 저장소를 오염시키지 않고
 * 검증할 수 있고, 어댑터는 `pnpm licenses list`·패키지 디렉터리를 직접 판독한다.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 정책 데이터 타입 (policy/licenses.json · policy/native-dependencies.json 스키마)
// ---------------------------------------------------------------------------

export interface LicenseOverride {
  readonly name: string;
  readonly version: string;
  readonly reason: string;
  readonly licenseTextOrSource: string;
  readonly reviewer: string;
  readonly date: string;
  readonly distributionImpact: string;
  readonly expiresAt?: string;
  readonly reReviewTrigger?: string;
}
export interface DualLicenseSelection {
  readonly name: string;
  readonly versionRange: string;
  readonly selected: string;
}
export interface LicensePolicy {
  readonly v: number;
  readonly allow: readonly string[];
  readonly reviewRequired: readonly string[];
  readonly deny: readonly string[];
  readonly dualLicenseSelections: readonly DualLicenseSelection[];
  readonly overrides: readonly LicenseOverride[];
}

export interface NativeDependencyTarget {
  readonly os: string;
  readonly cpu: string;
}
/**
 * `policy/native-dependencies.json` 의 규정 필드(design.md §데이터 모델 — `name`·`versionRange`·
 * `kind`·`targets`·`nodeFloor`·`nodeFloorSource`·`optional`·`reviewedAt`·`reviewedResolvedVersion`).
 * 판정 코어가 실제로 읽는 필드는 `name`·`versionRange` 뿐이다(나머지는 인벤토리 파일 자체의
 * 스키마 완전성 검증 — 정적 검증 소관 — 을 위한 문서화 필드라 판정 코어의 입력 타입은 인덱스
 * 시그니처로 넓게 받아 픽스처 주입을 허용한다).
 */
export interface NativeDependencyEntry {
  readonly name: string;
  readonly versionRange: string;
  readonly [key: string]: unknown;
}
export interface NativeDependencyInventory {
  readonly v: number;
  readonly entries: readonly Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// 인터페이스 계약 (design.md §인터페이스 계약 — 확정 시그니처)
// ---------------------------------------------------------------------------

export type LicenseScope = "production" | "development";
export type LicenseFailureReason =
  | "denied"
  | "unknown"
  | "dual_unspecified"
  | "review_required"
  | "unlisted"
  | "native_uninventoried"
  | "native_version_uncovered";

export interface ResolvedPackage {
  readonly name: string;
  readonly version: string;
  readonly scope: LicenseScope;
  readonly declaredLicense: string | undefined;
  readonly licenseFileText: string | undefined;
  readonly installBuildsNatively: boolean;
  readonly shipsPrebuiltBinary: boolean;
  readonly os: readonly string[] | undefined;
  readonly cpu: readonly string[] | undefined;
  readonly optional: boolean;
}
export interface LicenseFinding {
  readonly name: string;
  readonly version: string;
  readonly scope: LicenseScope;
  readonly reason: LicenseFailureReason;
  readonly detail: string;
}
export interface AttributionEntry {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly noticeRequired: boolean;
}
export interface LicenseEvaluation {
  readonly failures: readonly LicenseFinding[];
  readonly warnings: readonly LicenseFinding[];
  readonly attribution: readonly AttributionEntry[];
}

// ---------------------------------------------------------------------------
// 판정 코어 — 순수 함수, 부작용 없음
// ---------------------------------------------------------------------------

/** `<label>-family` 형태의 정책 계열 라벨에서 접두를 뽑는다. 계열 라벨이 아니면 undefined. */
function familyPrefix(term: string): string | undefined {
  return term.endsWith("-family") ? term.slice(0, -"-family".length) : undefined;
}

/** 정확 일치 → 계열 접두 일치 순으로 해석한다. */
function matchesTerm(id: string, term: string): boolean {
  if (id === term) return true;
  const prefix = familyPrefix(term);
  return prefix !== undefined && id.startsWith(prefix);
}

function matchesAnyTerm(ids: readonly string[], terms: readonly string[]): boolean {
  return ids.some((id) => terms.some((term) => matchesTerm(id, term)));
}

/** SPDX 식별자로 인정할 관대한 형태 검사(공백·특수문자 없는 토큰). */
function isSpdxLikeToken(token: string): boolean {
  return token.length > 0 && /^[A-Za-z0-9.+-]+$/.test(token);
}

type ParsedLicense =
  | { readonly kind: "single"; readonly ids: readonly [string] }
  | { readonly kind: "dual"; readonly ids: readonly string[] }
  | { readonly kind: "unparseable" };

function parseLicenseExpression(raw: string): ParsedLicense {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "unparseable" };
  if (/\bOR\b/.test(trimmed)) {
    const parts = trimmed
      .split(/\s+OR\s+/)
      .map((p) => p.trim().replace(/^\(/, "").replace(/\)$/, ""));
    if (parts.length >= 2 && parts.every(isSpdxLikeToken)) {
      return { kind: "dual", ids: parts };
    }
    return { kind: "unparseable" };
  }
  return isSpdxLikeToken(trimmed) ? { kind: "single", ids: [trimmed] } : { kind: "unparseable" };
}

function findOverride(
  policy: LicensePolicy,
  name: string,
  version: string,
): LicenseOverride | undefined {
  return policy.overrides.find((o) => o.name === name && o.version === version);
}

function overrideValid(override: LicenseOverride, now: Date): boolean {
  if (override.expiresAt === undefined) return true;
  const expires = new Date(`${override.expiresAt}T23:59:59Z`);
  return !Number.isNaN(expires.getTime()) && now.getTime() <= expires.getTime();
}

/** 점으로 구분된 정수 버전 3파트 비교. */
function compareTriplet(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 관대한 버전 범위 판정 — 정확 일치·">=X.Y.Z"·"A.B.C - X.Y.Z"·"^X.Y.Z" 형태를 지원한다. */
function versionCoveredByRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (trimmed === version) return true;
  const gte = /^>=\s*(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (gte?.[1] !== undefined) return compareTriplet(version, gte[1]) >= 0;
  const between = /^(\d+\.\d+\.\d+)\s*-\s*(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (between?.[1] !== undefined && between[2] !== undefined) {
    return compareTriplet(version, between[1]) >= 0 && compareTriplet(version, between[2]) <= 0;
  }
  const caret = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (caret?.[1] !== undefined && caret[2] !== undefined && caret[3] !== undefined) {
    const vMajor = version.split(".")[0];
    return (
      vMajor === caret[1] && compareTriplet(version, `${caret[1]}.${caret[2]}.${caret[3]}`) >= 0
    );
  }
  return false;
}

const SEE_LICENSE_IN_RE = /^SEE LICENSE IN\s+(.+)$/i;

/** 한 패키지를 severity 순으로 판정한다. 실패 없으면 undefined(통과). */
function evaluatePackage(
  pkg: ResolvedPackage,
  policy: LicensePolicy,
  nativeInventory: NativeDependencyInventory,
  now: Date,
): { reason: LicenseFailureReason; detail: string } | undefined {
  const raw = pkg.declaredLicense;
  const seeLicenseMatch = raw !== undefined ? SEE_LICENSE_IN_RE.exec(raw.trim()) : null;
  let needsReview: boolean;

  if (seeLicenseMatch) {
    if (pkg.licenseFileText === undefined || pkg.licenseFileText.trim().length === 0) {
      return {
        reason: "unknown",
        detail: `라이선스 참조("${raw}") 대상 텍스트를 판독할 수 없습니다.`,
      };
    }
    needsReview = true;
  } else if (
    raw === undefined ||
    raw.trim().length === 0 ||
    raw.trim().toUpperCase() === "UNLICENSED"
  ) {
    return {
      reason: "unknown",
      detail: `라이선스 표현이 없거나 UNLICENSED 입니다("${String(raw)}").`,
    };
  } else {
    const parsed = parseLicenseExpression(raw);
    if (parsed.kind === "unparseable") {
      return { reason: "unknown", detail: `라이선스 표현을 해석할 수 없습니다: "${raw}"` };
    }
    if (parsed.kind === "dual") {
      const selection = policy.dualLicenseSelections.find((s) => s.name === pkg.name);
      if (selection === undefined) {
        return {
          reason: "dual_unspecified",
          detail: `듀얼 라이선스("${raw}")의 선택 옵션이 정책에 기록되지 않았습니다.`,
        };
      }
      if (matchesAnyTerm([selection.selected], policy.deny)) {
        return { reason: "denied", detail: `금지 라이선스로 선택됨: "${selection.selected}"` };
      }
      needsReview = matchesAnyTerm([selection.selected], policy.reviewRequired);
      if (!needsReview && !matchesAnyTerm([selection.selected], policy.allow)) {
        return { reason: "unlisted", detail: `정책 목록에 없는 라이선스: "${selection.selected}"` };
      }
    } else {
      if (matchesAnyTerm(parsed.ids, policy.deny)) {
        return { reason: "denied", detail: `금지 라이선스: "${raw}"` };
      }
      needsReview = matchesAnyTerm(parsed.ids, policy.reviewRequired);
      if (!needsReview && !matchesAnyTerm(parsed.ids, policy.allow)) {
        return { reason: "unlisted", detail: `정책 목록에 없는 라이선스: "${raw}"` };
      }
    }
  }

  if (needsReview) {
    const override = findOverride(policy, pkg.name, pkg.version);
    if (override === undefined || !overrideValid(override, now)) {
      return {
        reason: "review_required",
        detail: `검토 필요 라이선스이며 유효한 override 가 없습니다: "${String(raw)}"`,
      };
    }
  }

  if (pkg.scope === "production" && (pkg.installBuildsNatively || pkg.shipsPrebuiltBinary)) {
    const entry = nativeInventory.entries.find((e) => e["name"] === pkg.name);
    if (entry === undefined) {
      return { reason: "native_uninventoried", detail: "네이티브 패키지가 인벤토리에 없습니다." };
    }
    const versionRangeRaw = entry["versionRange"];
    const versionRange = typeof versionRangeRaw === "string" ? versionRangeRaw : undefined;
    if (versionRange === undefined || !versionCoveredByRange(pkg.version, versionRange)) {
      return {
        reason: "native_version_uncovered",
        detail: `인벤토리 versionRange("${String(versionRangeRaw)}")가 해석된 버전("${pkg.version}")을 덮지 않습니다.`,
      };
    }
  }

  return undefined;
}

/** 고지 요구가 있는 것으로 알려진 라이선스 계열(Apache-2.0·BSD 계열 등) — 관대한 부분 일치. */
const NOTICE_REQUIRED_HINTS = ["Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "PostgreSQL"];

function noticeRequiredFor(declaredLicense: string | undefined): boolean {
  if (declaredLicense === undefined) return false;
  return NOTICE_REQUIRED_HINTS.some((hint) => declaredLicense.includes(hint));
}

/** dev 스코프에서 review-required 계열 사유가 경고로 강등된다(design.md §2 스코프 규칙 —
 * "개발은 denied·unknown 만 실패"). */
const DEV_SCOPE_WARNING_REASONS: ReadonlySet<LicenseFailureReason> = new Set([
  "review_required",
  "unlisted",
  "dual_unspecified",
]);

/** 순수 판정 — 부작용 없음. 픽스처 주입으로 검증할 수 있다(실 저장소 상태 비의존). */
export function evaluateLicensePolicy(
  packages: readonly ResolvedPackage[],
  policy: LicensePolicy,
  nativeInventory: NativeDependencyInventory,
): LicenseEvaluation {
  const failures: LicenseFinding[] = [];
  const warnings: LicenseFinding[] = [];
  const attribution: AttributionEntry[] = [];
  const now = new Date();

  for (const pkg of packages) {
    const outcome = evaluatePackage(pkg, policy, nativeInventory, now);
    if (outcome === undefined) {
      if (pkg.scope === "production") {
        attribution.push({
          name: pkg.name,
          version: pkg.version,
          license: pkg.declaredLicense ?? "unknown",
          noticeRequired: noticeRequiredFor(pkg.declaredLicense),
        });
      }
      continue;
    }
    const finding: LicenseFinding = {
      name: pkg.name,
      version: pkg.version,
      scope: pkg.scope,
      reason: outcome.reason,
      detail: outcome.detail,
    };
    if (pkg.scope === "development" && DEV_SCOPE_WARNING_REASONS.has(outcome.reason)) {
      warnings.push(finding);
    } else {
      failures.push(finding);
    }
  }

  return { failures, warnings, attribution };
}

// ---------------------------------------------------------------------------
// I/O 어댑터 — pnpm CLI 출력 + 패키지 디렉터리 판독
// ---------------------------------------------------------------------------

interface PnpmLicenseEntry {
  readonly name: string;
  readonly versions: readonly string[];
  readonly paths: readonly string[];
  readonly license: string;
}
type PnpmLicensesOutput = Record<string, readonly PnpmLicenseEntry[]>;

function runPnpmLicenses(scopeFlag: "-P" | "-D", cwd: string): PnpmLicensesOutput {
  const out = execFileSync("pnpm", ["licenses", "list", "--json", scopeFlag], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed: unknown = JSON.parse(out);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(
      `collectResolvedPackages: "pnpm licenses list ${scopeFlag}" 출력이 객체가 아닙니다.`,
    );
  }
  return parsed as PnpmLicensesOutput;
}

interface PackageJsonShape {
  readonly license?: unknown;
  readonly os?: unknown;
  readonly cpu?: unknown;
  readonly gypfile?: unknown;
  readonly scripts?: Record<string, unknown>;
}

function readPackageJson(dir: string): PackageJsonShape {
  const path = join(dir, "package.json");
  if (!existsSync(path)) {
    throw new Error(`collectResolvedPackages: package.json 이 없습니다 — ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as PackageJsonShape;
}

function readLicenseFileText(dir: string): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const licenseFile = names.find((n) => /^licen[sc]e/i.test(n));
  if (licenseFile === undefined) return undefined;
  try {
    const text = readFileSync(join(dir, licenseFile), "utf8");
    return text.trim().length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

const NON_BINARY_BASENAMES = new Set([
  "package.json",
  "readme.md",
  "readme",
  "license",
  "license.md",
  "changelog.md",
]);

/** 실행 바이너리 동봉 여부의 관대한 근사 — 확장자 없는 비문서 파일 존재. */
function hasExecutableBinary(dir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((n) => {
    const lower = n.toLowerCase();
    if (lower.startsWith(".") || NON_BINARY_BASENAMES.has(lower)) return false;
    return !lower.includes(".");
  });
}

function stringArrayOrUndefined(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

/** I/O 어댑터 — pnpm CLI 출력 + 패키지 디렉터리 판독. */
export function collectResolvedPackages(cwd: string = process.cwd()): ResolvedPackage[] {
  const packages: ResolvedPackage[] = [];

  const prod = runPnpmLicenses("-P", cwd);
  for (const [licenseKey, entries] of Object.entries(prod)) {
    for (const entry of entries) {
      const dir = entry.paths[0];
      if (dir === undefined) {
        throw new Error(
          `collectResolvedPackages: "${entry.name}" 의 paths[0] 이 없습니다(프로덕션).`,
        );
      }
      const pkgJson = readPackageJson(dir);
      const declaredLicenseRaw = pkgJson.license;
      const declaredLicense =
        typeof declaredLicenseRaw === "string" && declaredLicenseRaw.length > 0
          ? declaredLicenseRaw
          : licenseKey.length > 0
            ? licenseKey
            : undefined;
      const licenseFileText = readLicenseFileText(dir);
      const scripts = pkgJson.scripts ?? {};
      const installBuildsNatively =
        Boolean(scripts["preinstall"]) ||
        Boolean(scripts["install"]) ||
        Boolean(scripts["postinstall"]) ||
        Boolean(pkgJson.gypfile) ||
        existsSync(join(dir, "binding.gyp"));
      const os = stringArrayOrUndefined(pkgJson.os);
      const cpu = stringArrayOrUndefined(pkgJson.cpu);
      const shipsPrebuiltBinary =
        (os !== undefined || cpu !== undefined) && hasExecutableBinary(dir);
      for (const version of entry.versions) {
        packages.push({
          name: entry.name,
          version,
          scope: "production",
          declaredLicense,
          licenseFileText,
          installBuildsNatively,
          shipsPrebuiltBinary,
          os,
          cpu,
          optional: os !== undefined || cpu !== undefined,
        });
      }
    }
  }

  const dev = runPnpmLicenses("-D", cwd);
  for (const [licenseKey, entries] of Object.entries(dev)) {
    for (const entry of entries) {
      const declaredLicense =
        entry.license.length > 0 ? entry.license : licenseKey.length > 0 ? licenseKey : undefined;
      for (const version of entry.versions) {
        packages.push({
          name: entry.name,
          version,
          scope: "development",
          declaredLicense,
          licenseFileText: undefined,
          installBuildsNatively: false,
          shipsPrebuiltBinary: false,
          os: undefined,
          cpu: undefined,
          optional: false,
        });
      }
    }
  }

  return packages;
}

function atomicWriteJsonSync(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" });
  renameSync(tmp, filePath);
}

function readOwnPackageIdentity(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    const name = typeof pkg.name === "string" ? pkg.name : "unknown";
    const version = typeof pkg.version === "string" ? pkg.version : "unknown";
    return `${name}@${version}`;
  } catch {
    return "unknown@unknown";
  }
}

/** 통과 시 귀속 인벤토리를 원자적으로 기록하고 경로를 반환한다. */
export function writeAttributionInventory(
  attribution: readonly AttributionEntry[],
  outPath: string = join(process.cwd(), ".artifacts", "attribution-inventory.json"),
): string {
  const payload = {
    v: 1,
    generatedFor: readOwnPackageIdentity(process.cwd()),
    entries: attribution,
  };
  atomicWriteJsonSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  return outPath;
}

function readJsonFile<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(`필수 정책 파일이 없습니다: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readLicensePolicy(cwd: string): LicensePolicy {
  return readJsonFile<LicensePolicy>(join(cwd, "policy", "licenses.json"));
}
function readNativeInventory(cwd: string): NativeDependencyInventory {
  return readJsonFile<NativeDependencyInventory>(join(cwd, "policy", "native-dependencies.json"));
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const cwd = process.cwd();
    const packages = collectResolvedPackages(cwd);
    const policy = readLicensePolicy(cwd);
    const nativeInventory = readNativeInventory(cwd);
    const evaluation = evaluateLicensePolicy(packages, policy, nativeInventory);

    for (const w of evaluation.warnings) {
      process.stderr.write(
        `[warn] ${w.name}@${w.version} (${w.scope}) — ${w.reason}: ${w.detail}\n`,
      );
    }

    if (evaluation.failures.length > 0) {
      for (const f of evaluation.failures) {
        process.stderr.write(`${f.name}@${f.version} (${f.scope}) — ${f.reason}: ${f.detail}\n`);
      }
      process.stderr.write(`licenses:check FAIL — ${evaluation.failures.length} violation(s)\n`);
      process.exitCode = 1;
    } else {
      const outPath = writeAttributionInventory(evaluation.attribution);
      process.stdout.write(
        `licenses:check OK — ${evaluation.attribution.length} production package(s), attribution → ${outPath}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `licenses:check FAIL — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}
