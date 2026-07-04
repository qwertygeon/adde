/**
 * 짧은 별칭(`ad`·`add`) 설치 — 전역 설치된 `adde` 실행 파일 옆에 심볼릭 링크를 만든다.
 * npm 은 `npm i -g` 도중 대화형 프롬프트를 띄울 수 없으므로 별칭을 bin 에 굽지 않고,
 * 온보딩(`adde init`)·`adde alias` 에서 사용자가 옵트인으로 설치한다.
 * PATH 에 동명 명령이 이미 있으면(우리 것이 아닌) 그 별칭은 실패로 건너뛴다(사용자 요구).
 */
import { symlink, readlink, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

/** 설치 후보로 추천하는 짧은 별칭(순서 = 표시 순서). */
export const RECOMMENDED_ALIASES = ["ad", "add"] as const;

/** 별칭 설치에 필요한 주입 의존성(테스트 가능하게 분리). */
export interface AliasDeps {
  /** 별칭 심링크를 놓을 디렉터리(= adde 실행 파일이 있는 디렉터리). */
  binDir: string;
  /** 별칭이 가리킬 대상(adde 실행 파일 경로). */
  addeTarget: string;
  /** PATH 에 해당 이름의 실행 명령이 이미 존재하는지. */
  commandExists: (name: string) => Promise<boolean>;
}

export type AliasSkipReason = "exists" | "occupied";

export interface AliasSetupResult {
  /** 새로 만든 별칭. */
  created: string[];
  /** 이미 adde 를 가리키고 있어 그대로 둔 별칭. */
  alreadyLinked: string[];
  /** 건너뛴 별칭 — exists(PATH 에 동명 명령 존재) / occupied(자리 점유). */
  skipped: { name: string; reason: AliasSkipReason }[];
}

/** 심링크면 대상 경로, 아니면(부재·일반 파일) null. */
async function readlinkSafe(p: string): Promise<string | null> {
  try {
    return await readlink(p);
  } catch {
    return null;
  }
}

/**
 * PATH 를 스캔해 실행 가능한 파일 경로를 찾는다(첫 히트). 없으면 null.
 * `command -v` 셸 빌트인 대신 직접 스캔 — 자식 셸 스폰 없이 결정적.
 */
export async function findExecutableInPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const dirs = (env["PATH"] ?? "").split(":").filter((d) => d.length > 0);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      const st = await stat(candidate);
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
    } catch {
      // 이 디렉터리엔 없음 — 계속.
    }
  }
  return null;
}

/**
 * 별칭들을 설치한다. 각 이름에 대해:
 * - 이미 adde 를 가리키는 우리 심링크면 alreadyLinked(멱등).
 * - PATH 에 동명 명령이 있으면 skipped(exists) — 사용자 요구대로 실패 출력.
 * - 자리에 우리 것이 아닌 무언가가 있으면 skipped(occupied).
 * - 그 외엔 심링크 생성 → created.
 */
export async function setupAliases(
  names: readonly string[],
  deps: AliasDeps,
): Promise<AliasSetupResult> {
  const result: AliasSetupResult = { created: [], alreadyLinked: [], skipped: [] };
  const target = resolve(deps.addeTarget);
  for (const name of names) {
    const linkPath = join(deps.binDir, name);
    const existing = await readlinkSafe(linkPath);
    if (existing !== null && resolve(dirname(linkPath), existing) === target) {
      result.alreadyLinked.push(name);
      continue;
    }
    if (await deps.commandExists(name)) {
      result.skipped.push({ name, reason: "exists" });
      continue;
    }
    if (existing !== null) {
      result.skipped.push({ name, reason: "occupied" });
      continue;
    }
    await symlink(target, linkPath);
    result.created.push(name);
  }
  return result;
}

/**
 * 실 환경 의존성 해석 — PATH 에서 `adde` 실행 파일을 찾아 그 디렉터리에 별칭을 놓는다.
 * 전역 설치가 아니면(개발 tsx 등) adde 가 PATH 에 없어 null — 호출부가 안내 후 스킵.
 */
export async function resolveAliasDeps(): Promise<AliasDeps | null> {
  const addePath = await findExecutableInPath("adde");
  if (!addePath) return null;
  return {
    binDir: dirname(addePath),
    addeTarget: addePath,
    commandExists: (n) => findExecutableInPath(n).then((p) => p !== null),
  };
}
