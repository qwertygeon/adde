/**
 * v2 코어 골격(001-v2-core-skeleton) 공용 tmp 픽스처 — 설정 루트(base)와 vault 루트를
 * 각각 별도 mkdtemp 로 만든다(FR-029 저장 위치 분리를 픽스처 단계에서부터 물리적으로 반영).
 * 이식 대상이 아닌 신규 모듈(session-store·record·engines·surfaces)을 계약으로 저술하는
 * test(AUTHORING) 산출물 — 모듈 부재 시 개별 테스트 단위로 지연 import 해 사용한다.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SessionManagerDeps, SessionManagerWithLoad } from "../../src/core/session-manager.js";
import type { EngineCaps, EngineDriverDescriptor } from "../../src/engines/types.js";
import type { ProjectConf } from "../../src/shared/conf.js";

/** `makeSessionManagerDeps` 의 override 계약 — `conf` 만 부분 오버라이드를 허용한다(개별 테스트가
 * 기본 conf 의 일부 키만 바꿔 끼우는 관행을 그대로 지원). 나머지 필드는 `SessionManagerDeps` 원형과
 * 동일 — 전체를 부분 타입으로 풀면 `onStopApplied` 등 필수 훅 누락이 다시 타입 단계에서 조용해진다. */
export type SessionManagerDepsOverrides = Omit<Partial<SessionManagerDeps>, "conf"> & {
  conf?: Partial<ProjectConf>;
};

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

/** `capsOf` 미조회(방어) 시 폴백 — `supervisor.ts` 의 동명 상수와 동일 값(코어가 엔진을 모르므로
 * "모든 능력 비활성" 을 안전 기본값으로 둔다, A-P007). */
const DEFAULT_ENGINE_CAPS_FALLBACK: EngineCaps = {
  resume: "none",
  permission: "none",
  streaming: false,
  usage: false,
  compact: "none",
  attachments: [],
};

/** 생성된 SessionManager 전부를 추적해 테스트 종료 시 일괄 정지한다(GAP-018 소관 — 개별 파일이
 * `shutdown()` 호출을 잊어도 이전 픽스처처럼 주기 강제 치환이 타이머를 죽여 무해해 보이던 은폐가
 * 없어진 이상, 실 인터벌이 다음 테스트로 새는 것을 구조적으로 막는다). `test/setup.ts` 의 전역
 * `afterEach` 가 매 테스트 뒤 이 레지스트리를 드레인한다 — 개별 테스트가 아무것도 하지 않아도
 * 누수가 나지 않는 것이 목표다(main 지시 — "구조로 막아라"). */
const liveSessionManagers = new Set<SessionManagerWithLoad>();

export function __registerSessionManagerForCleanup(sm: SessionManagerWithLoad): void {
  liveSessionManagers.add(sm);
}

export async function __drainLiveSessionManagers(): Promise<void> {
  const all = [...liveSessionManagers];
  liveSessionManagers.clear();
  await Promise.all(all.map((sm) => sm.shutdown().catch(() => {})));
}

/**
 * SessionManagerDeps(`src/core/session-manager.ts` 실측) 최소 구성 — vaultRoot·conf(필수)·
 * askPermission(필수)·clock.now():number·scheduler.setInterval/clearInterval 전부 채운다.
 * `onStopApplied`·`onResumeApplied`·`pendingSurfaceWork` 는 `supervisor.ts:160-173` 과 동형으로
 * (`surfaces/markdown/index.ts` 의 `writeStoppedNote`·`restoreActiveNote`·`hasUnconsumedSend` 를
 * 그대로 호출) 기본 배선한다 — production 조립을 관통하는 것을 기본값으로 삼고, 훅 부재·대체 동작을
 * 의도적으로 검증하는 케이스만 override 로 끈다(GAP-015/018). `onResumeApplied` 는 supervisor 와
 * 동형으로 caps·warnings·notices 를 조회해야 하는데 그 조회 대상(SessionManager 인스턴스)은
 * `createSessionManager()` 반환 **이후**에만 존재한다 — `holder` 로 그 순환을 깬다(생성 순서 문제
 * 없이 참조를 넘긴다, `askPermission` 자동 승인 배선과 동형 패턴). 실 surface 모듈은 훅이 실제로
 * 호출되는 시점에 지연 import 한다(모든 소비 테스트가 markdown surface 를 필요로 하지 않으므로
 * 무거운 모듈을 무조건 즉시 로드하지 않는다).
 * overrides 로 caps 조합·conf 값·콜백을 개별 테스트가 덮어쓴다.
 */
const wiringHolders = new WeakMap<SessionManagerDeps, { sm?: SessionManagerWithLoad }>();

/**
 * `createSessionManager(deps)` 로 만든 인스턴스를 그 `deps` 의 기본 훅(holder)에 결선하고
 * 전역 정리 레지스트리에 등록한다 — `makeSessionManagerDeps` 가 반환한 `deps` 로 SessionManager 를
 * 만든 **모든** 호출 지점이 이 함수를 호출해야 `onResumeApplied` 기본값(caps·warnings·notices
 * 조회)이 실제로 동작하고, 테스트 종료 시 `shutdown()` 이 자동으로 불린다(GAP-018).
 */
export function bindSessionManager(deps: SessionManagerDeps, sm: SessionManagerWithLoad): void {
  const holder = wiringHolders.get(deps);
  if (holder) holder.sm = sm;
  __registerSessionManagerForCleanup(sm);
}

export function makeSessionManagerDeps(
  roots: V2TmpRoots,
  proj: string,
  // fake-engine.ts 의 FakeEngineEvent(`turn_end` 변형)가 실 EngineEvent 계약과 구조적으로
  // 불일치한다(선존 — production 은 턴 종료를 이벤트가 아니라 iterable 종료로 신호한다). 제거를
  // 시도했으나(test-agent 최종 판정 라운드) `engine.send()` 를 직접 순회해 "turn_end" 문자열을
  // 기대하는 기존 테스트 5개가 깨져(hibernate·session-isolation·session-model×3·
  // engine-crash-relaunch) main 판단으로 되돌리고 gaps.md 에 등재했다 — registry 자체는 이
  // 픽스처가 검증할 대상이 아니므로 여기서는 넓은 타입으로 받아 내부에서만 단언한다(GAP-018 의
  // 목적과 무관한 경계까지 넓히지 않기 위한 국소 단언).
  registry: Record<string, unknown>,
  overrides: SessionManagerDepsOverrides = {},
): SessionManagerDeps {
  const { conf: confOverride, ...restOverrides } = overrides;
  const holder: { sm?: SessionManagerWithLoad } = {};
  const defaultConf = {
    v: 1 as const,
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
    // 006(FR-003·FR-014) — 무활동 자동 중지·안내 존 상한 신설 키. 기본값은 design.md §12·
    // conf.ts 의 DEFAULT_STOP_AFTER_MIN·DEFAULT_NOTICES_CAP 상수와 동일하게 맞춘다(기본값 갈림 방지).
    idle_stop: true,
    stop_after_min: 60,
    max_active_engines: 3,
    auto_relaunch: true,
    "markdown.palette": true,
    "markdown.notices_cap": 10,
    "vault.retention_days": 2,
    "vault.sync_provider": "local",
  };
  const deps: SessionManagerDeps = {
    base: roots.base,
    proj,
    vaultRoot: roots.vaultRoot,
    // 스프레드 병합 타입은 구조적으로 ProjectConf 와 동일하나 `exactOptionalPropertyTypes` 가
    // "선택 필드 부재" 와 "선택 필드가 undefined" 를 구분해 추론을 거부한다 — 병합 결과 자체는
    // 항상 완전한 ProjectConf 모양이므로 이 지점의 단언은 안전하다.
    conf: { ...defaultConf, ...(confOverride ?? {}) } as ProjectConf,
    registry: registry as Record<string, EngineDriverDescriptor>,
    clock: { now: () => Date.now() },
    // 006(rework1) — 요청된 간격(ms)을 그대로 전달한다. 이전에는 무조건 60_000 으로 등록해
    // control 드레인 tick(CONTROL_DRAIN_INTERVAL_MS=2000, control-queue.ts)이 이 픽스처를 쓰는
    // 모든 테스트에서 60초 주기가 되어(선존 결함, 4779aae 부터 존재) stopNotePending 재시도·
    // absorbExternalChanges·maybeCompletePendingStop 등 2초 주기 로직이 테스트 수명 내 돌지
    // 않았다(main 실측 — test(EXECUTION) 최우선 하네스 결함). 결정론이 필요한 테스트는
    // `manual-scheduler.ts`/개별 override 로 여전히 대체할 수 있다.
    scheduler: {
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (h: unknown) => clearInterval(h as never),
    },
    askPermission: async () => {},
    // 006(rework1) — supervisor.ts:160-173 과 동형 기본 배선(GAP-015/018). `holder.sm` 은
    // `bindSessionManager()` 가 createSessionManager() 반환 직후 채운다 — 그 전에 이 훅이
    // 호출될 일은 없다(SessionManager 생성이 끝나야 stop/resume 경로가 열린다).
    onStopApplied: async (sid, info) => {
      const surface = await import("../../src/surfaces/markdown/index.js");
      await surface.writeStoppedNote({ vaultRoot: roots.vaultRoot, proj, sid }, info);
    },
    onResumeApplied: async (sid) => {
      const surface = await import("../../src/surfaces/markdown/index.js");
      await surface.restoreActiveNote(
        { vaultRoot: roots.vaultRoot, proj, sid },
        {
          caps: holder.sm?.capsOf(sid) ?? DEFAULT_ENGINE_CAPS_FALLBACK,
          warnings: holder.sm?.get(sid)?.warnings ?? [],
          notices: holder.sm?.takeNotices(sid) ?? [],
        },
      );
    },
    pendingSurfaceWork: async (sid) => {
      const surface = await import("../../src/surfaces/markdown/index.js");
      return surface.hasUnconsumedSend({ vaultRoot: roots.vaultRoot, proj, sid });
    },
    ...restOverrides,
  };
  wiringHolders.set(deps, holder);
  return deps;
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
