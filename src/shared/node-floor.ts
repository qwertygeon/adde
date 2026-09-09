/**
 * `package.json` 의 `engines.node` 를 런타임 하한의 단일 SoT 로 판독한다.
 * 여러 소비처(스토리지 기동 전제조건·`doctor` node 체크 등)가 하한 리터럴을 각자 복제하지 않고
 * 이 모듈을 통해 파생값을 읽는다 — 상향 시 `package.json` 한 곳만 고치면 전 소비처가 따라간다.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 모듈 위치에서 상위로 올라가며 `package.json` 을 찾는다(`src/core/version.ts` 의 상향 탐색
 * 관행과 동형 — src(tsx)·dist·전역 설치 모두에서 동작).
 */
function findPackageJson(): Record<string, unknown> | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** `package.json` 의 `engines.node` 원문(예 ">=24.15.0"). 미발견·파싱 실패 시 undefined. */
export function declaredNodeEngines(): string | undefined {
  const pkg = findPackageJson();
  if (pkg === undefined) return undefined;
  const engines = pkg["engines"];
  if (engines === null || typeof engines !== "object") return undefined;
  const node = (engines as Record<string, unknown>)["node"];
  return typeof node === "string" && node.length > 0 ? node : undefined;
}

/** `">=24.15.0"` 류에서 비교 연산자를 벗겨 `"24.15.0"` 을 얻는다. 형태가 다르면 undefined. */
function stripComparator(raw: string): string | undefined {
  const trimmed = raw.trim();
  const match = /^(?:>=)?\s*(\d+\.\d+\.\d+)$/.exec(trimmed);
  return match?.[1];
}

/** "1.2.3" → [1,2,3]. 정수 3파트가 아니면 undefined. */
function parseTriplet(v: string): [number, number, number] | undefined {
  const parts = v.trim().split(".");
  if (parts.length !== 3) return undefined;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return undefined;
  return [nums[0]!, nums[1]!, nums[2]!];
}

/** 선언 하한의 정규화 값(예 "24.15.0"). 판독 실패 시 undefined. */
export function declaredNodeFloor(): string | undefined {
  const engines = declaredNodeEngines();
  if (engines === undefined) return undefined;
  return stripComparator(engines);
}

/** a>=b 를 3파트 정수 비교로 판정. */
function tripletGte(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    if (av !== bv) return av > bv;
  }
  return true;
}

/** 주어진 버전이 선언 하한 이상인가. 하한·버전 판독 실패 시 false(fail-closed). */
export function satisfiesDeclaredNodeFloor(version: string): boolean {
  const floor = declaredNodeFloor();
  if (floor === undefined) return false;
  const floorTriplet = parseTriplet(floor);
  const versionTriplet = parseTriplet(version);
  if (floorTriplet === undefined || versionTriplet === undefined) return false;
  return tripletGte(versionTriplet, floorTriplet);
}
