/**
 * 공장 초기화(신규, L3) — 모든 프로젝트·세션을 제거해 처음 설치 상태로 되돌린다.
 * 명령 전용(노트·팔레트 진입점 없음, SC-075) — 표면은 `cli/factory-reset.ts` 가 담당한다.
 * 6단계 순서 제약(design.md §11·ADR-012): ① 설정에서 vault 해석 후 인벤토리 산출(설정을 먼저
 * 지우면 vault 를 찾을 수 없다) ② 확인(CLI 소관) ③ 데몬 정지 + 잔존 확인 ④ vault ADDE 서브트리
 * 삭제(vault 루트는 절대 비삭제) ⑤ 해석된 프로젝트의 설정 루트를 **프로젝트 단위**로 삭제하고
 * 컨테이너(`<base>/projects`)는 비었을 때만 정리(해석 불가·가드 거부분은 남는다) ⑥ stray 는 별도 확인.
 */
import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { errCode, errMsg } from "../shared/errors.js";
import {
  isPathInside,
  isSafeSegment,
  normCasePath,
  projectPaths,
  vaultPaths,
} from "../shared/paths.js";
import { parseProjectConf } from "../shared/conf.js";
import { detectLegacyLayout, detectProjectsNameCollision } from "./legacy-guard.js";

/** 초기화 확인 프롬프트에 노출되는 고정 문구(정확 일치 요구, FR-030) — 단일 상수에서 파생(CV-6). */
export const FACTORY_RESET_PHRASE = "FACTORY RESET";

/** 데몬 정지 후 잔존 확인 유계 대기(ms, design.md §11). */
const DAEMON_RESIDUE_WAIT_MS = 3_000;

export interface ResetProjectEntry {
  proj: string;
  vaultRoot: string;
  sessions: number;
  notePaths: string[];
  addeSubtree: string;
}

export interface ResetInventory {
  projects: ResetProjectEntry[];
  /** 설정이 가리키지 않는 vault ADDE 프로젝트 디렉터리(자동 삭제 대상 아님, SC-082). */
  strays: Array<{ vaultRoot: string; path: string }>;
  /** v0.2.x — 보존 대상(A-P002, 절대 건드리지 않는다). */
  legacy: Array<{ proj: string; path: string }>;
  /** 프로젝트 설정 루트들의 부모 — 삭제는 이 하위의 프로젝트 단위로 하고, 이 디렉터리 자체는
   * 비었을 때만 정리한다(`<base>` 자체·v0.2.x 는 어느 경우에도 제외, ADR-012). */
  configContainer: string;
  /** project.conf 파싱 실패로 해석 불가한 프로젝트 — 열거만 하고 삭제 대상에서 제외(1단계 실패 처리). */
  unresolvedProjects: string[];
  /**
   * conf 는 읽혔지만 `vault` 경로 자체를 해석할 수 없는 프로젝트(미마운트 볼륨·권한 거부·실제 삭제).
   * vault 서브트리는 손댈 수 없고(삭제 반경을 확정할 수 없다), 설정 루트만 지우면 vault 에 남은
   * 데이터의 위치 단서가 사라지므로 **별도 명시 동의**(stray 와 같은 취급)로만 설정을 삭제한다.
   */
  vaultUnresolvable: Array<{ proj: string; vaultRoot: string; reason: string }>;
}

/** vault 해석 실패 errno → 조치를 가늠할 수 있는 사용자 문구. 매핑 밖 코드는 errno 를 그대로
 * 노출한다(임의 가공은 원인 추적 단서를 잃는다). */
const VAULT_RESOLVE_FAIL_REASONS: Record<string, string> = {
  ENOENT: "경로 없음",
  EACCES: "권한 거부",
  EPERM: "권한 거부",
  ELOOP: "링크 루프",
  ENOTDIR: "경로 중간이 디렉터리가 아님",
};

function vaultResolveFailReason(err: unknown): string {
  const code = errCode(err);
  if (code === undefined) return errMsg(err);
  return VAULT_RESOLVE_FAIL_REASONS[code] ?? code;
}

export interface FactoryResetDeps {
  base: string;
  /** 기본 `unloadDaemon` — 프로젝트별 데몬 정지(멱등, 미등록도 성공 취급). */
  stopDaemon: (proj: string) => Promise<void>;
  /** 기본 `daemonRegState || control/daemon.json` 의 살아있는 pid — 정지 후 잔존 확인. */
  daemonResidue: (proj: string) => Promise<boolean>;
}

export interface ResetReport {
  removedProjects: string[];
  removedVaultSubtrees: string[];
  preservedLegacy: string[];
  preservedStrays: string[];
  /** vault 해석 불가로 설정 루트를 남긴 프로젝트 — 사용자가 동의하지 않은 결과이므로 실패가 아니다. */
  preservedUnresolvable: string[];
  failures: Array<{ path: string; reason: string }>;
}

/**
 * 1단계 — 설정 루트 기준으로 프로젝트를 열거하고 각 vault 를 해석해 인벤토리를 산출한다(순수 조회).
 * v0.2.x 프로젝트 이름이 `projects` 였던 이름 충돌(`detectProjectsNameCollision`, 부팅 거부와
 * 같은 판정 — `supervisor.ts` 동형)이면 즉시 거부한다(보안 검토 SEC — 5단계 컨테이너 삭제가
 * `<base>/projects/lanes.d` 의 v0.2.x 데이터까지 삼킬 수 있어 A-P002 위반 위험이 있다).
 */
export async function buildResetInventory(deps: FactoryResetDeps): Promise<ResetInventory> {
  const collision = await detectProjectsNameCollision(deps.base);
  if (collision) throw new Error(collision);

  const configContainer = join(deps.base, "projects");
  let projDirNames: string[] = [];
  try {
    projDirNames = await readdir(configContainer);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }

  const projects: ResetProjectEntry[] = [];
  const unresolvedProjects: string[] = [];
  const vaultUnresolvable: Array<{ proj: string; vaultRoot: string; reason: string }> = [];
  for (const proj of projDirNames) {
    // sid 필터(아래 :88, 기존)와 대칭으로 proj 이름도 안전 문자셋으로 거른다 — `projectPaths` 는
    // 불안전 이름에 throw 하므로(경로 탈출 차단, paths.ts SSOT), 걸러내지 않으면 이 루프 전체가
    // 죽어 인벤토리 산출 자체가 실패한다(보안 검토 — 우연히 안전한 상태였을 뿐, 걸러내는 것이
    // 올바른 처리다). 안전하지 않은 이름은 해석 불가로 열거만 하고 삭제 대상에서 제외한다.
    if (!isSafeSegment(proj)) {
      unresolvedProjects.push(proj);
      continue;
    }
    const pp = projectPaths(deps.base, proj);
    let confText: string;
    try {
      confText = await readFile(pp.projectConf, "utf8");
    } catch {
      unresolvedProjects.push(proj);
      continue;
    }
    let vaultRoot: string;
    try {
      vaultRoot = parseProjectConf(confText).vault;
    } catch {
      unresolvedProjects.push(proj);
      continue;
    }
    // vault 경로 해석은 인벤토리 단계에서 시도한다 — 여기서 실패하는 프로젝트는 vault 서브트리
    // 삭제가 애초에 불가능하므로(반경 미확정) 삭제 대상 목록에 넣지 않고 별도 동의 대상으로
    // 분류한다. 실행 단계까지 미루면 "설정만 삭제" 가 사용자 확인 없이 일어난다.
    try {
      await realpath(vaultRoot);
    } catch (err) {
      vaultUnresolvable.push({ proj, vaultRoot, reason: vaultResolveFailReason(err) });
      continue;
    }
    const vp = vaultPaths(vaultRoot, proj);
    let sids: string[] = [];
    try {
      sids = (await readdir(vp.sessionDir)).filter((s) => isSafeSegment(s));
    } catch {
      // 부재 등 — 세션 0건과 동치.
    }
    const notePaths = sids.map((sid) => vaultPaths(vaultRoot, proj, sid).inboxNote);
    projects.push({
      proj,
      vaultRoot,
      sessions: sids.length,
      notePaths,
      addeSubtree: vp.projectDir,
    });
  }

  // 설정이 가리키지 않는 vault ADDE 프로젝트 디렉터리(stray) — 이 탐색은 설정 삭제 전에만 가능하다
  // (설정이 vault 경로를 알려주는 유일한 근거).
  const strays: Array<{ vaultRoot: string; path: string }> = [];
  const vaultRootsSeen = new Set(projects.map((p) => p.vaultRoot));
  for (const vaultRoot of vaultRootsSeen) {
    const knownNames = new Set(
      projects.filter((p) => p.vaultRoot === vaultRoot).map((p) => p.proj),
    );
    const projectsDir = join(vaultRoot, "adde", "projects");
    let entries: string[] = [];
    try {
      entries = await readdir(projectsDir);
    } catch {
      // 부재 — stray 0건과 동치.
    }
    for (const name of entries) {
      if (!knownNames.has(name)) strays.push({ vaultRoot, path: join(projectsDir, name) });
    }
  }

  const legacy = await detectLegacyLayout(deps.base);
  return { projects, strays, legacy, configContainer, unresolvedProjects, vaultUnresolvable };
}

async function waitResidueGone(
  proj: string,
  deps: FactoryResetDeps,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    const residue = await deps.daemonResidue(proj);
    if (!residue) return false;
    if (Date.now() - start >= timeoutMs) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 부모가 비었을 때만 정리(vault 루트·`<base>` 자체는 인자로 절대 넘기지 않는다).
 * `recursive: true` 를 쓴다 — `entries.length===0` 으로 이미 빈 디렉터리임을 확인했으므로 실제
 * 삭제 범위는 그 디렉터리 자체뿐이다(`recursive: false` 는 대상이 파일이 아니라 **디렉터리**면
 * 비어 있어도 `EISDIR` 로 실패한다 — `force` 는 ENOENT 류만 흡수하고 이 오류는 흡수하지 않는다,
 * 실측 확인 — 이번 보안 수정에서 5단계를 컨테이너 단위 삭제 대신 이 함수를 재사용하려다 발견한
 * 선존 결함). */
async function rmdirIfEmpty(dir: string): Promise<void> {
  try {
    // 대상이 심볼릭 링크면 건너뛴다 — `readdir` 은 링크를 따라 들어가 **대상 디렉터리**를 열거하고
    // `rm` 은 링크 자신만 지우므로(실측), "비어 보인다" 는 이유로 지우면 링크 대상에 남은 데이터로
    // 되돌아갈 유일한 단서를 없앤다. 빈 링크가 남는 것은 무해하다.
    if ((await lstat(dir)).isSymbolicLink()) return;
    const entries = await readdir(dir);
    if (entries.length === 0) await rm(dir, { recursive: true, force: true });
  } catch {
    // 부재·읽기 실패 — 정리 대상 없음(치명적이지 않다, 잔존 빈 디렉터리는 무해).
  }
}

/**
 * 부재 대상의 **투영 실경로** — 대상 자체가 없어 `realpath` 가 ENOENT 인 정상 케이스에서도 "검사
 * 없는 통과" 를 만들지 않기 위해, 가장 가까운 **존재하는 조상**을 해석한 뒤 그 아래 남은 구간을
 * lexical 로 다시 붙여 "대상이 있었다면 어디였는가" 를 낸다. 남은 구간은 존재하지 않으므로 링크일
 * 수 없어 lexical 조립이 실제와 어긋나지 않는다. 조상 실경로를 그대로 쓰면 ADDE 네임스페이스 기준의
 * 엄격 내부 판정에서 정상 부재(`<vault>/adde` 자체가 아직 없는 프로젝트 등)가 거부되어 과차단이 된다.
 * ENOENT 가 아닌 해석 실패(ELOOP·권한 등)는 `null` 로 돌려 호출자가 안전 쪽으로 판정하게 한다.
 */
async function projectedRealPathOfAbsent(target: string): Promise<string | null> {
  let cur = dirname(target);
  for (;;) {
    try {
      const realAncestor = await realpath(cur);
      return join(realAncestor, relative(cur, target));
    } catch (err) {
      if (errCode(err) !== "ENOENT") return null;
      const parent = dirname(cur);
      if (parent === cur) return null; // 파일시스템 루트까지 올라갔다.
      cur = parent;
    }
  }
}

/** `child` 가 `parent` 의 **엄격 내부**인지(동일 경로는 false) — 대소문자·정규화 차이는
 * `normCasePath` 로 흡수하고 포함 판정 자체는 `isPathInside`(SSOT, `shared/paths.ts`)에 위임한다. */
function isStrictlyInside(child: string, parent: string): boolean {
  const c = normCasePath(child);
  const p = normCasePath(parent);
  return c !== p && isPathInside(c, p);
}

/**
 * vault 서브트리 파괴 직전 재확인 — **삭제 대상 경로 자신**을 `realpath` 로 해석해 그 실경로가
 * **ADDE 네임스페이스**(`<vault>/adde`) 의 엄격 내부인지 재검증한다(불변식). 대상 자신을 해석하는
 * 이유는 중간 경로 구성요소(`adde`·`projects`·`<proj>`) 중 어느 하나가 심볼릭 링크이더라도 그
 * 링크가 해석에 전부 반영되어 실제 파괴 반경이 드러나기 때문이다 — 상위 한 단계(`<vault>/adde`)만
 * 해석하면 그 아래 구성요소의 링크를 놓친다. 대소문자·정규화 차이는 `normCasePath` 로 흡수한다.
 *
 * 비교 기준을 vault 루트가 아니라 ADDE 네임스페이스로 두는 이유: vault 루트 기준이면 vault **안에서**
 * ADDE 밖을 가리키는 링크(`<vault>/adde/projects` → `<vault>/MyNotes`, `<vault>/adde` → `<vault>`)가
 * "내부" 로 통과해 사용자 문서가 재귀 삭제된다 — "vault 루트와 그 아래 ADDE 네임스페이스 밖 사용자
 * 파일은 남는다" 는 이 명령의 계약을 깬다. 기준 경로는 `realpath(vaultRoot)` 에 `adde` 를 **lexical 로** 붙여 만든다 —
 * `realpath(<vault>/adde)` 를 기준으로 쓰면 `adde` 자신이 링크일 때 기준이 링크 대상으로 따라가
 * 검사가 무력화된다. vault 루트 자체는 여전히 `realpath` 로 해석하므로 "vault 루트가 심볼릭 링크" 인
 * 정상 구성은 과차단되지 않는다.
 * - `"absent"`: 대상이 없다 — 지울 것이 없다(무해). 단 `realpath` 실패가 그대로 통과가 되지 않게,
 *   가장 가까운 존재하는 조상을 해석해 투영한 경로가 같은 내부 판정을 통과해야 이 값을 낸다.
 * - `"escape"`: 실경로가 ADDE 네임스페이스 밖이거나 해석 자체가 불가하다 — 삭제를 거부한다. 거부 사유가
 *   경로 탈출(`"outside"`)인지 vault 루트 자체의 해석 불가(`"unresolvable-root"`)인지를 `cause` 로
 *   구분해 실은다 — 호출자가 두 원인에 서로 다른 조치 문구를 낼 수 있어야 하는데, 호출자가 원인을
 *   되짚으려면 같은 `realpath` 를 다시 불러야 하기 때문이다. 판정 종류를 늘리는 대신 `escape`
 *   variant 안에 담아, `=== "escape"` 만 보는 기존 호출자가 신규 원인을 조용히 통과시키는 일을
 *   타입 차원에서 막는다.
 * - `"inside"`: 정상 — 삭제를 진행해도 안전하다.
 *
 * 한계: 정적인 링크 구성에는 완전하지만, 검사와 `rm` 사이에 경로가 링크로 교체되는 경합(TOCTOU)
 * 에는 불완전하다 — Node 의 fs API 에 디렉터리 핸들 기준 삭제(`unlinkat` 계열)가 없어 "검사한 바로
 * 그 대상" 을 원자적으로 지울 수단이 없다.
 */
type VaultEscapeCause = "outside" | "unresolvable-root";

type VaultGuardResult =
  { verdict: "absent" } | { verdict: "inside" } | { verdict: "escape"; cause: VaultEscapeCause };

async function checkVaultSubtreeGuard(
  vaultRoot: string,
  target: string,
): Promise<VaultGuardResult> {
  let realVaultRoot: string;
  try {
    realVaultRoot = await realpath(vaultRoot);
  } catch {
    // vault 루트를 해석할 수 없다 — "하위에 지울 것도 없다" 로 통과시키면(종전 동작) 4단계를
    // 건너뛴 채 5단계가 설정만 지워, vault 에 실제로 남은 데이터의 위치 단서가 사라진다.
    // 인벤토리 단계에서 해석됐던 경로가 실행 순간 해석 불가가 된 것은 사용자가 동의한 범위 밖이므로
    // fail-closed 로 거부한다.
    return { verdict: "escape", cause: "unresolvable-root" };
  }
  // 기준은 lexical 조립 — 위 doc 주석의 근거(`adde` 자신이 링크면 realpath 기준이 무력화된다).
  const addeRoot = join(realVaultRoot, "adde");
  let realTarget: string;
  let targetAbsent = false;
  try {
    realTarget = await realpath(target);
  } catch (err) {
    if (errCode(err) !== "ENOENT") return { verdict: "escape", cause: "outside" };
    const projected = await projectedRealPathOfAbsent(target);
    if (projected === null) return { verdict: "escape", cause: "outside" };
    realTarget = projected;
    targetAbsent = true;
  }
  // 엄격 내부 — 대상이 곧 `<vault>/adde` 인 경우(링크가 네임스페이스 루트 자신을 가리키는 자기상위
  // 재지향 등)도 거부한다: 4·6단계의 삭제 단위는 그 **하위** 프로젝트 디렉터리뿐이다.
  if (!isStrictlyInside(realTarget, addeRoot)) {
    return { verdict: "escape", cause: "outside" };
  }
  return { verdict: targetAbsent ? "absent" : "inside" };
}

/** 4단계 가드가 거부했을 때의 실패 사유 — vault 삭제와 **설정 삭제**를 함께 보류한다는 사실과
 * 조치를 담는다(설정이 vault 경로를 알려주는 유일한 근거이므로 설정만 지우면 남은 vault 데이터를
 * 다시 찾을 수 없다). `cause` 별로 조치가 다르므로 `Record` 로 두어 원인 추가 시 누락이 컴파일
 * 오류가 되게 한다. */
const VAULT_ESCAPE_REASON: Record<VaultEscapeCause, string> = {
  outside:
    "vault 서브트리 경로가 실제로는 vault 의 ADDE 폴더 밖을 가리킵니다(vault 밖 포함, 심볼릭 링크 " +
    "의심) — 안전을 위해 vault 삭제와 이 프로젝트의 설정 삭제를 모두 보류했습니다. 링크를 정리한 뒤 " +
    "다시 실행하세요.",
  "unresolvable-root":
    "vault 경로를 해석할 수 없습니다(마운트·권한 확인) — 안전을 위해 vault 삭제와 이 프로젝트의 " +
    "설정 삭제를 모두 보류했습니다. vault 에 접근할 수 있는 상태에서 다시 실행하세요.",
};

/** 6단계 stray 삭제에서 같은 가드가 거부했을 때의 실패 사유(설정 루트가 없는 잔존물이라 보류
 * 대상은 vault 삭제뿐이다). */
const STRAY_ESCAPE_REASON: Record<VaultEscapeCause, string> = {
  outside:
    "vault 잔존물 경로가 실제로는 vault 의 ADDE 폴더 밖을 가리킵니다(vault 밖 포함, 심볼릭 링크 " +
    "의심) — 안전을 위해 삭제를 거부했습니다. 링크를 정리한 뒤 다시 실행하세요.",
  "unresolvable-root":
    "vault 경로를 해석할 수 없습니다(마운트·권한 확인) — 안전을 위해 vault 잔존물 삭제를 " +
    "보류했습니다. vault 에 접근할 수 있는 상태에서 다시 실행하세요.",
};

/**
 * 3~6단계 실행 — 확인(2단계)은 호출자(CLI) 책임이다. 데몬 잔존이 하나라도 있으면 **삭제 0건**으로
 * 중단한다(반쯤 초기화된 상태 방지, SC-078). 부분 실패는 열거하고 성공으로 승격하지 않는다.
 * `opts` 의 두 플래그는 모두 2단계에서 받은 **별도 동의**다 — 동의 없이는 stray 도, vault 해석
 * 불가 프로젝트의 설정도 지우지 않는다.
 */
export async function executeFactoryReset(
  inv: ResetInventory,
  opts: { deleteStrays: boolean; deleteConfigOfUnresolvableVault: boolean },
  deps: FactoryResetDeps,
): Promise<ResetReport> {
  const failures: Array<{ path: string; reason: string }> = [];

  // 3단계 — 데몬 정지 → 잔존 확인(유계 3초). 해석 불가(unresolvedProjects) 프로젝트도 대상에
  // 포함한다 — vault/세션 정리는 못 해도 proj 이름 자체는 있어 데몬 정지는 시도할 수 있다(보안
  // 검토 — 살아있는 데몬 + 사라진 설정 조합을 침묵으로 만들지 않는다). 이름이 안전 문자셋 밖이면
  // `stopDaemon`/`daemonResidue` 내부(`projectPaths`/`plistPath`)가 throw 할 수 있어 각각
  // try/catch 로 감싸 실패로 흡수한다 — 확인 자체가 안 되면 안전 쪽(잔존함)으로 판정한다
  // (fail-closed, A-P006).
  const daemonTargets = [
    ...inv.projects.map((e) => e.proj),
    ...inv.unresolvedProjects,
    ...inv.vaultUnresolvable.map((e) => e.proj),
  ];
  for (const proj of daemonTargets) {
    await deps.stopDaemon(proj).catch((err: unknown) => {
      failures.push({ path: proj, reason: `데몬 정지 실패: ${errMsg(err)}` });
    });
  }
  let anyResidue = false;
  for (const proj of daemonTargets) {
    try {
      if (await waitResidueGone(proj, deps, DAEMON_RESIDUE_WAIT_MS)) anyResidue = true;
    } catch (err) {
      failures.push({ path: proj, reason: `데몬 잔존 확인 실패: ${errMsg(err)}` });
      anyResidue = true;
    }
  }
  if (anyResidue) {
    return {
      removedProjects: [],
      removedVaultSubtrees: [],
      preservedLegacy: inv.legacy.map((l) => l.path),
      preservedStrays: inv.strays.map((s) => s.path),
      preservedUnresolvable: inv.vaultUnresolvable.map((e) => e.proj),
      failures: [
        ...failures,
        {
          path: "(daemon)",
          reason: "데몬이 잔존해 삭제를 시작하지 않았습니다 — 정지를 확인한 뒤 다시 시도하세요.",
        },
      ],
    };
  }

  // 4단계 — vault ADDE 서브트리 삭제 + 빈 상위(<vault>/adde/projects·<vault>/adde)만 정리.
  // 파괴 직전 **삭제 대상 자신**을 `realpath` 로 해석해 ADDE 네임스페이스(`<vault>/adde`) 의 엄격
  // 내부인지 재검증한다 — 경로 구성요소(`adde`·`projects`·`<proj>`) 중 어느 하나가 심볼릭 링크면
  // 문자열상 경로는 vaultRoot 하위처럼 보여도 실제 삭제가 ADDE 폴더 밖(vault 안팎 모두)으로 나간다.
  const removedVaultSubtrees: string[] = [];
  const vaultRootsTouched = new Set<string>();
  // vault 삭제가 거부·실패한 프로젝트 — 5단계 설정 루트 삭제에서 제외한다(설정을 지우면 남은 vault
  // 데이터를 다시 찾을 근거가 사라져 stray 로조차 발견되지 않는다).
  const vaultBlockedProjects = new Set<string>();
  const vaultRootsBlocked = new Set<string>();
  for (const entry of inv.projects) {
    const guard = await checkVaultSubtreeGuard(entry.vaultRoot, entry.addeSubtree);
    if (guard.verdict === "escape") {
      failures.push({ path: entry.addeSubtree, reason: VAULT_ESCAPE_REASON[guard.cause] });
      vaultBlockedProjects.add(entry.proj);
      vaultRootsBlocked.add(entry.vaultRoot);
      continue;
    }
    if (guard.verdict === "absent") continue; // 삭제할 대상 자체가 없다(무해) — 실패로 세지 않는다.
    try {
      await rm(entry.addeSubtree, { recursive: true, force: true });
      removedVaultSubtrees.push(entry.addeSubtree);
      vaultRootsTouched.add(entry.vaultRoot);
    } catch (err) {
      failures.push({
        path: entry.addeSubtree,
        reason: `${errMsg(err)} — 이 프로젝트의 설정 삭제도 함께 보류했습니다(다시 실행하면 재시도).`,
      });
      vaultBlockedProjects.add(entry.proj);
      vaultRootsBlocked.add(entry.vaultRoot);
    }
  }
  for (const vaultRoot of vaultRootsTouched) {
    // 같은 vault 에 거부·실패한 프로젝트가 있으면 상위 정리를 건너뛴다 — `<vault>/adde/projects` 나
    // `<vault>/adde` 자체가 vault 밖을 가리키는 링크일 수 있고, 링크 경로에 대한 `rm` 은 링크만
    // 지워(실측 확인) 남은 데이터로 되돌아갈 유일한 단서를 없애기 때문이다.
    if (vaultRootsBlocked.has(vaultRoot)) continue;
    await rmdirIfEmpty(join(vaultRoot, "adde", "projects"));
    await rmdirIfEmpty(join(vaultRoot, "adde")); // vault 루트(그 부모)는 여기서 절대 대상이 아니다.
  }

  // 5단계 — 해석된 프로젝트 디렉터리 **단위** 삭제(컨테이너 통삭제 금지, 보안 검토 SEC — 종전엔
  // `<base>/projects` 전체를 한 번에 지워, "해석 불가(삭제 대상에서 제외)" 로 고지한 프로젝트까지
  // 함께 삭제되고도 성공만 보고했다). 해석 불가·미해석 이름은 그대로 남아 고지와 실제 삭제
  // 범위가 일치한다. 컨테이너 자체는 다 지운 뒤 비어 있을 때만 정리(부모 디렉터리, 비어있지
  // 않으면 그대로 둔다 — `rmdirIfEmpty` 동형 관행).
  const removedProjects: string[] = [];
  for (const entry of inv.projects) {
    if (vaultBlockedProjects.has(entry.proj)) continue; // 4단계에서 거부·실패 — 설정을 남겨 재시도 가능하게.
    const projRoot = projectPaths(deps.base, entry.proj).root;
    try {
      await rm(projRoot, { recursive: true, force: true });
      removedProjects.push(entry.proj);
    } catch (err) {
      failures.push({ path: projRoot, reason: errMsg(err) });
    }
  }
  // vault 해석 불가 프로젝트 — vault 쪽은 어느 경우에도 접근하지 않는다(해석이 안 되므로 삭제
  // 반경을 확정할 수 없다). 설정 루트를 지울지는 2단계에서 받은 **별도 동의**로만 갈린다: 동의가
  // 없으면 남겨 vault 위치 단서를 보존하고(사용자 선택이므로 실패가 아니다), 동의가 있으면 설정
  // 루트만 지운다. 컨테이너 정리보다 앞에 두어야 마지막 프로젝트를 지운 뒤 빈 컨테이너가 정리된다.
  const preservedUnresolvable: string[] = [];
  for (const entry of inv.vaultUnresolvable) {
    if (!opts.deleteConfigOfUnresolvableVault) {
      preservedUnresolvable.push(entry.proj);
      continue;
    }
    const projRoot = projectPaths(deps.base, entry.proj).root;
    try {
      await rm(projRoot, { recursive: true, force: true });
      removedProjects.push(entry.proj);
    } catch (err) {
      failures.push({ path: projRoot, reason: errMsg(err) });
    }
  }
  await rmdirIfEmpty(inv.configContainer);

  // 6단계 — stray 는 별도 확인(opts.deleteStrays)이 있을 때만 삭제. stray 는 `readdir` 열거 산출이라
  // 이름 제약이 없고 중간 구성요소가 링크면 열거 자체가 링크 대상 내부를 훑으므로, 4단계와 **같은**
  // 가드를 삭제 직전에 적용한다.
  const preservedStrays: string[] = [];
  for (const s of inv.strays) {
    if (opts.deleteStrays) {
      const guard = await checkVaultSubtreeGuard(s.vaultRoot, s.path);
      if (guard.verdict === "escape") {
        failures.push({ path: s.path, reason: STRAY_ESCAPE_REASON[guard.cause] });
        continue;
      }
      if (guard.verdict === "absent") continue; // 이미 없다(무해).
      try {
        await rm(s.path, { recursive: true, force: true });
        removedVaultSubtrees.push(s.path);
      } catch (err) {
        failures.push({ path: s.path, reason: errMsg(err) });
      }
    } else {
      preservedStrays.push(s.path);
    }
  }

  return {
    removedProjects,
    removedVaultSubtrees,
    preservedLegacy: inv.legacy.map((l) => l.path),
    preservedStrays,
    preservedUnresolvable,
    failures,
  };
}
