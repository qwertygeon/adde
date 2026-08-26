/**
 * v2 코어 골격(001-v2-core-skeleton) 공용 tmp 픽스처 — 설정 루트(base)와 vault 루트를
 * 각각 별도 mkdtemp 로 만든다(FR-029 저장 위치 분리를 픽스처 단계에서부터 물리적으로 반영).
 * 이식 대상이 아닌 신규 모듈(session-store·record·engines·surfaces)을 계약으로 저술하는
 * test(AUTHORING) 산출물 — 모듈 부재 시 개별 테스트 단위로 지연 import 해 사용한다.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface V2TmpRoots {
  /** 설정 루트(project.conf·sessions.d·runtime) — 현행 ADDE_HOME 과 동일 개념. */
  base: string;
  /** vault 루트(이벤트·노트·첨부·중복판정) — 대화 데이터 전용. */
  vaultRoot: string;
}

/** 설정 루트·vault 루트를 각각 별도 mkdtemp 로 생성한다(둘이 겹치면 안 되는 계약을 픽스처가 보증). */
export function makeV2TmpRoots(prefix = "adde-v2-"): V2TmpRoots {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}base-`));
  const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}vault-`));
  return { base, vaultRoot };
}

export function cleanupV2TmpRoots(roots: V2TmpRoots): void {
  fs.rmSync(roots.base, { recursive: true, force: true });
  fs.rmSync(roots.vaultRoot, { recursive: true, force: true });
}

/** 프로젝트 하나의 project.conf 를 최소 필드로 직접 써 준다(파서 왕복이 아닌, 하류 모듈 픽스처용). */
export function writeMinimalProjectConf(
  base: string,
  proj: string,
  extra: Record<string, string> = {},
): string {
  const projDir = path.join(base, "projects", proj);
  fs.mkdirSync(projDir, { recursive: true });
  const confPath = path.join(projDir, "project.conf");
  const lines = ["v=1", `vault=${extra["vault"] ?? path.join(os.tmpdir(), "unused-vault")}`];
  for (const [k, v] of Object.entries(extra)) {
    if (k === "vault") continue;
    lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(confPath, lines.join("\n") + "\n");
  return confPath;
}

/**
 * record/* 함수 공통 컨텍스트(RecordCtx, `src/record/types.ts` 실측) — `{base, vaultRoot, proj, sid}`.
 * vaultPaths 스프레드 대신 이 형태를 직접 구성한다(실측 확인 — 2026-08-26 PPG-1 동기화).
 */
export function makeRecordCtx(
  roots: V2TmpRoots,
  proj: string,
  sid: string,
): { base: string; vaultRoot: string; proj: string; sid: string } {
  return { base: roots.base, vaultRoot: roots.vaultRoot, proj, sid };
}

/**
 * SessionManagerDeps(`src/core/session-manager.ts` 실측) 최소 구성 — vaultRoot·conf(필수)·
 * askPermission(필수)·clock.now():number·scheduler.setInterval/clearInterval 전부 채운다.
 * overrides 로 caps 조합·conf 값·콜백을 개별 테스트가 덮어쓴다.
 */
export function makeSessionManagerDeps(
  roots: V2TmpRoots,
  proj: string,
  registry: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const defaultConf = {
    v: 1,
    vault: roots.vaultRoot,
    engine: "acp",
    perm_tier: "acp",
    acp_version: "v1",
    allowlist: [],
    denylist: [],
    hard_deny: [],
    auto_restart: true,
    auto_resume: true,
    idle_hibernate: true,
    hibernate_after_min: 30,
    max_active_engines: 3,
    auto_relaunch: true,
    "markdown.palette": true,
    "vault.retention_days": 2,
    "vault.sync_provider": "local",
  };
  return {
    base: roots.base,
    proj,
    vaultRoot: roots.vaultRoot,
    conf: { ...defaultConf, ...((overrides["conf"] as object) ?? {}) },
    registry,
    clock: { now: () => Date.now() },
    scheduler: {
      setInterval: (fn: () => void) => setInterval(fn, 60_000),
      clearInterval: (h: unknown) => clearInterval(h as never),
    },
    askPermission: async () => {},
    ...overrides,
  };
}

/** 재귀적으로 디렉터리의 파일 목록(상대경로)을 반환 — 저장 위치 분리 단언(SC-029)에 사용. */
export function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}
