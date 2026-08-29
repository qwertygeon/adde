/**
 * SessionManager(L3) — 세션 수명·hibernate·LRU·admit(FR-003·FR-004·FR-005·FR-008·FR-009·FR-010·
 * FR-011·FR-023·NFR-005). `admit()` 는 상한 검사·LRU 내림·기동을 단일 비동기 체인으로 직렬화한다
 * (ADR-021 — Check-Then-Act 경합 제거). 중지·재개·control 흡수는 별도 `controlChain` 으로
 * 직렬화한다(design.md §3·§4 — 예약 소진 판정·control 드레인·CAS 반영이 서로 경합하지 않게 한다).
 */
import { gateRequestDecision } from "../gate/gate.js";
import type { PermRequest } from "../gate/gate.js";
import { engineLogPath, projectPaths, sessionPaths } from "../shared/paths.js";
import type { ProjectConf } from "../shared/conf.js";
import { sanitizeEngineText } from "../shared/mask.js";
import { appendEvent, readEvents } from "../record/events.js";
import { putBlob } from "../record/blobs.js";
import { dropSessionIndex } from "../record/dedup.js";
import { project, projectTurn } from "../record/projector.js";
import type { ProjectOpts } from "../record/projector.js";
import { rebuild } from "../record/rebuild.js";
import type { RebuildReport } from "../record/rebuild.js";
import type { AddeEvent, BlobRef, RecordCtx, TurnRef } from "../record/types.js";
import type { RetentionPolicy } from "../record/retention.js";
import {
  assertBackupNotOverlapping,
  runRetention,
  readRetentionLastRun,
  writeRetentionLastRun,
} from "../record/retention.js";
import { resolveSyncProvider } from "../record/sync-provider.js";
import type { EngineDriverDescriptor, EngineSession } from "../engines/types.js";
import { createTurnRunner } from "./turn-runner.js";
import type { TurnRunner } from "./turn-runner.js";
import { createSessionWatcher } from "./session-watcher.js";
import type { SessionWatcher } from "./session-watcher.js";
import { pendingWork } from "./queue.js";
import {
  CONTROL_DRAIN_INTERVAL_MS,
  clearDaemonMarker,
  drainControl,
  writeDaemonMarker,
} from "./control-queue.js";
import type { ControlRequest, ControlResult } from "./control-queue.js";
import {
  generateNoticeId,
  loadSession,
  loadSessions,
  planNoticeCap,
  reserveSessionId,
  saveSession,
} from "./session-store.js";
import type { NoticeEntry, SessionRecord, SessionStatus, StopSource } from "./session-store.js";
import type { Binding } from "../surfaces/types.js";
import { errMsg } from "../shared/errors.js";
import { tFor } from "../shared/i18n.js";

export interface CreateResult {
  sid: string;
  warnings: string[];
  activeSameCwd: number;
}

export interface BootResumeReport {
  resumed: string[];
  detached: Array<{ sid: string; reason: string }>;
  skipped: string[];
}

export interface StopOutcome {
  result: "stopped" | "scheduled" | "already" | "mismatch";
  reason: string;
}

export interface ResumeOutcome {
  result: "resumed" | "mismatch" | "failed";
  reason?: string;
}

/** 안내 존 신설 항목 입력(design.md §7) — `pushNotice` 인자. */
export interface NoticeInput {
  kind: string;
  text: string;
  mode?: "read" | "prompt";
  options?: Array<{ token: string; label: string }>;
  footer?: string;
  /** true 면 같은 kind 의 기존 안내를 최신 1건으로 대체한다 — 상태 불일치·이미 예약됨·재개 후보
   * 0건·취소 등 "현재 상태" 류 반복 알림 대상(ADR-010·SC-038 을 일반 규칙으로 승격, rework2 GAP-014
   * 인접 발견). 미지정(기본) 은 누적 — `compact-done` 등 매번 새 이벤트를 나타내는 kind 는 여러
   * 건이 공존해야 한다(SC-030). */
  replace?: boolean;
}

/** `surfaces/markdown/notices.ts` 의 `planNoticeSync` 반환 형태(design.md §7) — L3 는 이 형태만
 * 소비하고 파싱·렌더는 모른다(의존 방향 L4→L3 유지, L3 는 L4 를 import 하지 않는다). */
export interface NoticeSyncPlan {
  keep: NoticeEntry[];
  consumed: string[];
  chosen?: { id: string; token: string };
  cancelled?: string;
  /** 렌더 확정 전이라 부재를 취소/읽음으로 해석하지 못하고 유지한 항목 id 들. */
  notYetReflected: string[];
}

/** 중지·떨어짐 노트 교체 훅 인자 — `extras` 는 승계 등 세션 레코드만 아는 부가 안내. */
export interface StopNoteInfo {
  kind: "stopped" | "detached";
  reason: string;
  extras?: string[];
}

/**
 * L1 RecordStore 계약(design.md "RecordStore (L1)") — SessionManager 가 record/* 자유 함수를
 * 직접 호출하는 대신 선택적으로 주입받을 수 있는 최소 DI 표면. 세션 스코프 메서드는
 * `sid` 를 받고, base·vaultRoot·proj 는 어댑터가 구성 시점에 closure 로 스코프한다(design.md
 * 시그니처에서 매 호출 반복을 피함). `rebuild()` 는 이미 확정된 `record/rebuild.ts` 자유 함수
 * 시그니처(base·vaultRoot 선두 인자, GAP-011)를 그대로 승계해 opts 만 받는다.
 */
export interface RecordStore {
  appendEvent(sid: string, e: AddeEvent): Promise<void>;
  readEvents(sid: string): AsyncIterable<AddeEvent>;
  putBlob(sid: string, data: Buffer | string): Promise<BlobRef>;
  projectTurn(
    sid: string,
    turn: number,
    phase: "running" | "final",
    policy?: RetentionPolicy,
  ): Promise<void>;
  project(sid: string, opts?: ProjectOpts): Promise<void>;
  rebuild(opts?: { sid?: string; retention?: RetentionPolicy }): Promise<RebuildReport>;
}

export interface SessionManagerDeps {
  base: string;
  proj: string;
  vaultRoot: string;
  conf: ProjectConf;
  registry: Record<string, EngineDriverDescriptor>;
  clock: { now(): number };
  scheduler: { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void };
  askPermission: (
    sid: string,
    req: { reqId: string; tool: string; input: string },
  ) => Promise<void>;
  onDecisionRecorded?: (sid: string, reqId: string) => Promise<void>;
  onTurnAssigned?: (sid: string, envelopeId: string, turnRef: TurnRef) => Promise<void>;
  onTurnDelivered?: (sid: string, msg: { text: string; turnRef: TurnRef }) => Promise<void>;
  onSessionError?: (sid: string, reason: string) => Promise<void>;
  onStateChange?: (sid: string, status: SessionStatus, reason: string) => Promise<void>;
  /** 중지 노트 교체 필수 의존(L4 Surface 배선, FR-018·FR-019·NFR-002) — 배너 writer 는 이 함수
   * 하나뿐이다(rework2 §단일 소유자). 조립이 이를 빠뜨리면 타입 단계에서 막힌다 — 미배선을 조용히
   * 성공으로 삼키던 이전 optional 계약을 폐기했다(session-manager.ts §L3/L4 계층 규약 — L3 는
   * 렌더러를 직접 참조할 수 없어 기본 구현을 내장할 수 없다, 그래서 주입을 필수로 강제한다). */
  onStopApplied: (sid: string, info: StopNoteInfo) => Promise<void>;
  /** 재개 시 정상 스켈레톤 복구 필수 의존(L4 Surface 배선, FR-018) — 위와 동형 이유로 필수화. */
  onResumeApplied: (sid: string) => Promise<void>;
  /** 미소비 전송 체크박스 등 표면 잔여 작업 probe(L4 주입, FR-004) — 중지 잔여 판정 재료. */
  pendingSurfaceWork?: (sid: string) => Promise<boolean>;
  retentionPolicy?: RetentionPolicy;
  /** 미주입 시 base·vaultRoot·proj 로 스코프한 기본 어댑터(현 record/* 자유 함수 위임)를 쓴다.
   * 테스트가 이 필드를 주입하면 appendEvent·project 등 record 기록 호출을 가로챌 수 있다. */
  record?: RecordStore;
}

export interface SessionManager {
  list(): SessionRecord[];
  create(opts: { engine?: string; title?: string; engineArgs?: string }): Promise<CreateResult>;
  clear(sid: string): Promise<{ next: string }>;
  remove(sid: string, opts: { purge: boolean }): Promise<void>;
  admit(sid: string): Promise<EngineSession>;
  hibernate(sid: string, reason: "idle" | "lru" | "attach"): Promise<void>;
  resumeAllOnBoot(): Promise<BootResumeReport>;
  // --- 신설(중지·재개·안내·control, design.md §3·§4·§7) ---
  stop(
    sid: string,
    opts: { reason: string; source: StopSource; force?: boolean },
  ): Promise<StopOutcome>;
  resume(sid: string): Promise<ResumeOutcome>;
  resumeCandidates(limit?: number): SessionRecord[];
  pushNotice(sid: string, n: NoticeInput): Promise<void>;
  takeNotices(sid: string): readonly NoticeEntry[];
  applyNoticeSync(sid: string, plan: NoticeSyncPlan): Promise<void>;
  /** 재개 목록 prompt 항목 생성(design.md §7·§8) — 팔레트 `resume`(인자 없음) 처리가 호출한다. */
  pushResumeListNotice(requesterSid: string): Promise<void>;
  /** control 드레인 1회 수행(테스트가 타이머 없이 직접 호출 가능, ADR-011). */
  absorbControl(): Promise<void>;
  // --- 계약 외 보조 API(Router·Surface 조립부가 소비) ---
  get(sid: string): SessionRecord | undefined;
  turnRunner(sid: string): TurnRunner | undefined;
  registerBinding(sid: string, binding: Binding): Promise<void>;
  removeBinding(sid: string, binding: { surface: string; address: string }): Promise<void>;
  resolvePermissionDecision(sid: string, reqId: string, decision: "allow" | "deny"): void;
  denyPending(sid: string): Promise<void>;
  /**
   * 사용자에게 보여야 하는 실패를 세션 경고로 올린다 — 접두 `kind` 당 최신 1건만 남는다.
   * Surface(L4)·조립부가 레코드를 직접 만지지 않고 이 경로로만 경고를 올린다(의존 방향 L4→L3).
   */
  noteFailure(sid: string, kind: string, reason: string): Promise<void>;
  /** 같은 접두의 경고를 해소(제거)한다 — 성공 경로가 실패 흔적을 지운다. */
  clearFailure(sid: string, kind: string): Promise<void>;
  shutdown(): Promise<void>;
  /** 세션의 엔진 caps 조회(L4 Surface 가 코어 엔진 무지를 지키며 조건부 렌더에 쓴다, A-P007). */
  capsOf(sid: string): import("../engines/types.js").EngineCaps | undefined;
}

/** 부팅 조립부(daemon.ts)만 쓰는 확장 — 명시 `load()` 로 세션 레코드를 로드한다(암묵적 비동기 생성 지양). */
export interface SessionManagerWithLoad extends SessionManager {
  load(): Promise<void>;
  /**
   * 외부(CLI) 프로세스가 만든 세션 레코드를 상주 중에 흡수한다 — **미지 sid 만 추가**하고 이미 알고 있는
   * 세션은 손대지 않는다. `load()` 재호출은 디스크 값이 in-memory 를 덮어써 런타임 상태(status·engineRef·
   * lastActivityAt)를 되돌릴 수 있으므로 상주 중에는 쓰지 않는다(A-P002 세션 상태 비침해).
   */
  refresh(): Promise<{ added: string[] }>;
}

interface Runtime {
  engineSession: EngineSession | null;
  turnRunner: TurnRunner;
  watcher: SessionWatcher;
  pendingPermissions: Map<string, (d: "allow" | "deny") => void>;
}

/** 재개 목록 표시 상한(design.md §8). */
const RESUME_LIST_LIMIT = 10;
/** 중지 노트 교체 실패 시 유계 재시도 상한(design.md §안전망) — 초과 후에는 경고만 유지. */
const MAX_STOP_NOTE_RETRIES = 3;
/** 잔여 작업 조회(큐 probe) 연속 실패 상한 — 초과 시 보수적 가정(fail-closed)을 포기하고 강제
 * 진행한다(무성음 무한 재평가 방지, 사용자 탈출구 확보). */
const MAX_PENDING_PROBE_FAILURES = 3;

export function createSessionManager(deps: SessionManagerDeps): SessionManagerWithLoad {
  const records = new Map<string, SessionRecord>();
  /**
   * 레코드 타임스탬프는 **주입 시계**로 찍는다 — 유휴 판정(`runIdleSweep`)이 `deps.clock.now()` 와
   * `lastActivityAt` 을 비교하므로 둘이 다른 시계면 경과 시간이 뒤섞인다. 실 시계(`new Date()`)로
   * 찍으면 LRU 동률(tie) 상황을 결정론적으로 재현할 수도 없다. 프로덕션 주입값은
   * `() => Date.now()`(supervisor)이므로 동작은 동일하다.
   */
  const nowIso = (): string => new Date(deps.clock.now()).toISOString();
  const runtimes = new Map<string, Runtime>();
  let admitChain: Promise<unknown> = Promise.resolve();
  /** 중지·재개·control 드레인 전용 직렬화 체인(design.md §4 — Check-Then-Act 경합 제거). */
  let controlChain: Promise<unknown> = Promise.resolve();
  function enqueueControl<T>(fn: () => Promise<T>): Promise<T> {
    const result = controlChain.then(fn, fn);
    controlChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  /** 노트 교체 재시도 카운터(in-process) — 재기동 시 0 부터, `stopNotePending` 이 레코드에 남아 이어진다. */
  const stopNoteRetries = new Map<string, number>();
  /** 잔여 작업 조회(큐 probe) 연속 실패 카운터(in-process) — `probePendingWork` 가 관리. */
  const pendingProbeFailures = new Map<string, number>();
  // 유휴 스윕 타이머 핸들 — `api`(runIdleSweep 이 참조)가 완전히 초기화된 뒤에 등록해야 한다.
  // 테스트 스케줄러가 setInterval 콜백을 등록 즉시(동기) 호출하는 경우 TDZ("api" 미초기화 접근)를
  // 막기 위해 초기화(undefined)와 실제 등록(파일 하단, api 선언 이후)을 분리한다.
  let idleTimer: unknown = undefined;
  let controlTimer: unknown = undefined;
  // 보관 위치 겹침 경고를 방출한 UTC 날짜 — 스윕은 60초 타이머마다 재검사하므로(설정을 고치면
  // 곧바로 재시도되도록 last-run 을 기록하지 않는다) 경고만 날짜별 1회로 묶는다.
  let overlapWarnedDate: string | null = null;

  // deps.retentionPolicy 는 테스트 주입용 오버라이드(결정론적 now() 등). 미주입 시 실제 project.conf
  // (vault.backup·vault.retention_days)에서 파생한다 — 이전에는 항상 defaultRetentionPolicy()
  // (backupDir: null, 즉 비활성)로 폴백해 vault.backup 을 지정해도 보관 이관이 전혀 작동하지 않았다
  // (이 함수 결과가 project()/rebuild() 투영 판정과 runRetentionSweep() 양쪽의 근거다).
  function policy(): RetentionPolicy {
    if (deps.retentionPolicy) return deps.retentionPolicy;
    return {
      backupDir: deps.conf["vault.backup"] ?? null,
      retentionDays: deps.conf["vault.retention_days"],
      now: () => new Date(deps.clock.now()),
    };
  }

  function recordCtx(sid: string, turn?: number, turnStartIso?: string): RecordCtx {
    return {
      base: deps.base,
      vaultRoot: deps.vaultRoot,
      proj: deps.proj,
      sid,
      ...(turn !== undefined ? { turn } : {}),
      ...(turnStartIso !== undefined ? { turnStartIso } : {}),
    };
  }

  // 기본 RecordStore 어댑터 — base·vaultRoot·proj 를 closure 로 스코프해 record/* 자유 함수에
  // 위임한다. `deps.record` 미주입 시에만 쓰인다.
  const defaultRecordStore: RecordStore = {
    appendEvent: (sid, e) => appendEvent(recordCtx(sid), e),
    readEvents: (sid) => readEvents(recordCtx(sid)),
    putBlob: (sid, data) => putBlob(recordCtx(sid), data),
    projectTurn: (sid, turn, phase, policy) => projectTurn(recordCtx(sid), turn, phase, policy),
    project: (sid, opts) => project(recordCtx(sid), opts),
    rebuild: (opts) => rebuild(deps.base, deps.vaultRoot, deps.proj, opts),
  };
  const recordStore: RecordStore = deps.record ?? defaultRecordStore;

  /** 외부(CLI 직접 적용 등)가 채택 가능한 필드만 복사 — rev·CAS 흡수 공용(persist·absorbExternalChanges). */
  function absorbFields(rec: SessionRecord, disk: SessionRecord): void {
    rec.status = disk.status;
    rec.stopPending = disk.stopPending;
    rec.notices = disk.notices;
    rec.stopReason = disk.stopReason;
    rec.stoppedAt = disk.stoppedAt;
    rec.stopNotePending = disk.stopNotePending;
  }

  /**
   * `persist()` 는 쓰기 전에 디스크 레코드를 읽어 `diskRev > memRev` 면 **외부 변경을 흡수**
   * (status·stopPending·notices·stopReason 등 채택 + `reconcileExternal` 예약)한 뒤
   * `rev = max(disk,mem)+1` 로 쓴다(ADR-011 — 되쓰기 방어). 신규 레코드는 `rev:0` 으로 구성해
   * 첫 persist 에서 자연히 `1` 이 된다(design.md 데이터 모델 "rev — 부재 → 0").
   */
  async function persist(rec: SessionRecord): Promise<void> {
    const memRev = rec.rev;
    const disk = await loadSession(deps.base, deps.proj, rec.sid);
    const diskRev = disk?.rev ?? 0;
    if (disk && diskRev > memRev) {
      absorbFields(rec, disk);
      rec.rev = diskRev + 1;
      records.set(rec.sid, rec);
      await saveSession(deps.base, deps.proj, rec);
      await reconcileExternal(rec.sid).catch((err: unknown) => {
        console.error(`session-manager: 외부 변경 반영 실패(sid=${rec.sid}): ${errMsg(err)}`);
      });
      return;
    }
    rec.rev = Math.max(diskRev, memRev) + 1;
    records.set(rec.sid, rec);
    await saveSession(deps.base, deps.proj, rec);
  }

  /** 흡수된 상태에 맞는 행위(엔진 종료·노트 교체·런너 재기동)를 수행한다(design.md §4). */
  async function reconcileExternal(sid: string): Promise<void> {
    const rec = records.get(sid);
    if (!rec) return;
    const rt = runtimes.get(sid);
    if (rec.status === "stopped" || rec.status === "detached") {
      if (rt?.engineSession) {
        rt.watcher.disarm();
        await rt.engineSession.close().catch(() => {});
        rt.engineSession = null;
      }
      if (rec.stopNotePending) {
        await writeStoppedNoteOnce(sid);
      }
    } else if (rec.status === "active" || rec.status === "hibernated") {
      armRunner(sid);
    }
  }

  /** 2초 드레인 tick — 알려진 세션의 `rev` 를 디스크와 비교해 외부 변경(중지·재개)을 흡수한다.
   * 기존 additive-only `refresh()`(사실 5)의 역경로를 이것이 메운다(design.md §4). */
  async function absorbExternalChanges(): Promise<void> {
    for (const rec of [...records.values()]) {
      const disk = await loadSession(deps.base, deps.proj, rec.sid);
      if (!disk || disk.rev <= rec.rev) continue;
      absorbFields(rec, disk);
      rec.rev = disk.rev;
      records.set(rec.sid, rec);
      await reconcileExternal(rec.sid).catch((err: unknown) => {
        console.error(`session-manager: 외부 변경 반영 실패(sid=${rec.sid}): ${errMsg(err)}`);
      });
    }
  }

  async function refreshNotes(sid: string, turn: number): Promise<void> {
    const rec = records.get(sid);
    if (!rec) return;
    // 턴이 완결됐으므로 이제 엔진 전사가 존재한다 — 재개 핸들을 영속해도 안전하다(위 admit 주석).
    // TurnRunner 는 turn_end append 성공 후에만 이 콜백을 부른다(turn-runner.ts 최종 투영 구간).
    const liveRef = runtimes.get(sid)?.engineSession?.engineRef;
    if (liveRef !== undefined && rec.engineRef !== liveRef) {
      rec.engineRef = liveRef;
      await persist(rec);
    }
    await recordStore.project(sid, {
      turn,
      retention: policy(),
      sessionMeta: {
        engine: rec.engine,
        engineRef: rec.engineRef,
        status: rec.status,
        title: rec.title,
        createdAt: rec.createdAt,
        lastActivityAt: rec.lastActivityAt,
        warnings: rec.warnings,
      },
      projectSessions: [...records.values()].map((r) => ({
        sid: r.sid,
        status: r.status,
        title: r.title,
        lastActivityAt: r.lastActivityAt,
      })),
    });
    // 턴이 완결·저장됐으므로 이전 턴 중단·저장 실패는 해소됐다 — 남겨 두면 다음 실패를 가린다.
    // 성공 경로에 제거를 두어 별도 정리 명령 없이 자동으로 사라지게 한다.
    const resolvedPrefixes = ["storage-failed:", "turn-failed:", "runner-failed:"];
    if (rec.warnings.some((w) => resolvedPrefixes.some((p) => w.startsWith(p)))) {
      rec.warnings = rec.warnings.filter((w) => !resolvedPrefixes.some((p) => w.startsWith(p)));
      await persist(rec);
    }
    // 턴 완결 직후 예약 소진 평가(design.md §3 — 두 지점 중 하나, controlChain 안에서 수행).
    if (records.get(sid)?.stopPending) {
      await enqueueControl(() => maybeCompletePendingStop(sid)).catch((err: unknown) => {
        console.error(
          `session-manager: 턴 완결 후 중지 예약 평가 실패(sid=${sid}): ${errMsg(err)}`,
        );
      });
    }
  }

  function driverFor(engineId: string): EngineDriverDescriptor {
    const d = deps.registry[engineId];
    if (!d) throw new Error(`session-manager: 미등록 엔진 id "${engineId}"`);
    return d;
  }

  function ensureRuntime(sid: string): Runtime {
    let rt = runtimes.get(sid);
    if (rt) return rt;
    const rec = records.get(sid);
    if (!rec) throw new Error(`session-manager: 세션 없음 (${sid})`);
    const paths = sessionPaths(deps.base, deps.proj, sid);
    const tr = createTurnRunner({
      base: deps.base,
      vaultRoot: deps.vaultRoot,
      proj: deps.proj,
      sid,
      cwd: deps.conf.cwd ?? process.cwd(),
      sessionPaths: paths,
      admit: () => api.admit(sid),
      requestPermission: (req) => requestPermission(sid, req),
      ...(deps.onDecisionRecorded
        ? { onDecisionRecorded: (reqId: string) => deps.onDecisionRecorded!(sid, reqId) }
        : {}),
      ...(deps.onTurnAssigned
        ? { onTurnAssigned: (envId: string, ref: TurnRef) => deps.onTurnAssigned!(sid, envId, ref) }
        : {}),
      ...(deps.onTurnDelivered
        ? {
            onTurnDelivered: (msg: { text: string; turnRef: TurnRef }) =>
              deps.onTurnDelivered!(sid, msg),
          }
        : {}),
      onSessionError: (reason: string) => onTurnFailure(sid, reason),
      onStorageFailure: (reason: string) => noteStorageFailure(sid, reason),
      onQuarantine: (reason: string) => noteFailure(sid, "quarantined", reason),
      retentionPolicy: policy(),
      refreshNotes: (turn) => refreshNotes(sid, turn),
    });
    const watcher = createSessionWatcher({
      sid,
      autoRelaunch: deps.conf.auto_relaunch,
      relaunch: async () => {
        await api.admit(sid);
      },
      isAlive: () => runtimes.get(sid)?.engineSession?.isAlive() ?? false,
      denyPending: () => void api.denyPending(sid),
      setHealth: () => {},
      markDetached: (reason) => markDetached(sid, reason),
      notify: (kind) =>
        void deps.onStateChange?.(sid, "detached", `crash-relaunch:${kind}`).catch(() => {}),
    });
    rt = {
      engineSession: null,
      turnRunner: tr,
      watcher,
      pendingPermissions: new Map(),
    };
    runtimes.set(sid, rt);
    return rt;
  }

  /**
   * 세션의 TurnRunner 를 만들고 기동한다 — 엔진은 열지 않는다(`admit()` 은 턴이 실제로 돌 때 호출).
   * `router.dispatch()` 가 `turnRunner(sid)?.notify()` 로 큐를 깨우므로, 런타임이 없는 세션은 지시가
   * 큐에 적재된 채 영원히 소비되지 않는다 — 부팅 시 `active` 가 아니어서 `admit()` 을 거치지 않는
   * 세션(hibernated)과 상주 중 흡수된 세션이 그 상태였다. `start()` 는 중단된 processing 회수와
   * 최초 drain 도 수행한다.
   */
  function armRunner(sid: string): void {
    const rt = ensureRuntime(sid);
    void rt.turnRunner.start().catch((err: unknown) => {
      // 런너가 없으면 지시가 큐에 적재된 채 소비되지 않는다 — 로그만 남기면 사용자에겐 무응답으로만
      // 보이므로 경고 채널에 올린다(다음 턴 완결 시 해소).
      console.error(`session-manager: TurnRunner 기동 실패(sid=${sid}): ${errMsg(err)}`);
      void noteFailure(sid, "runner-failed", errMsg(err)).catch((e: unknown) => {
        console.error(`session-manager: 기동 실패 경고 기록 실패(sid=${sid}): ${errMsg(e)}`);
      });
    });
  }

  async function requestPermission(
    sid: string,
    req: { reqId: string; tool: string; input: string },
  ): Promise<{ decision: "allow" | "deny"; reason?: string }> {
    const rt = ensureRuntime(sid);
    let resolver: ((d: "allow" | "deny") => void) | undefined;
    const decisionPromise = new Promise<"allow" | "deny">((resolve) => {
      resolver = resolve;
    });
    // 등록을 전송보다 먼저(supervisor 패턴 계승) — resolver 를 맵에 넣은 뒤에만 표면화 콜백을 부른다.
    rt.pendingPermissions.set(req.reqId, resolver!);
    const permReq: PermRequest = {
      v: 1,
      id: req.reqId,
      sid,
      channel: "markdown",
      tool: req.tool,
      detail: req.input,
      cwd: deps.conf.cwd ?? process.cwd(),
      ts: new Date().toISOString(),
    };
    const gateTimeoutMs = deps.conf.gate_timeout_sec
      ? deps.conf.gate_timeout_sec * 1000
      : undefined;
    const response = await gateRequestDecision(permReq, {
      sendPermPrompt: (r) =>
        deps.askPermission(sid, { reqId: r.id, tool: r.tool, input: r.detail }),
      waitForDecision: () => decisionPromise,
      ...(gateTimeoutMs !== undefined ? { timeoutMs: gateTimeoutMs } : {}),
    });
    rt.pendingPermissions.delete(req.reqId);
    return { decision: response.decision, ...(response.reason ? { reason: response.reason } : {}) };
  }

  /**
   * 턴이 중단됐다는 사실을 사용자 대면 경로에 남긴다. 이전 구현은 in-memory 필드에만 써서 읽는 곳이
   * 없었고(죽은 필드) 종단이 launchd 로그였다 — 사용자에게는 "보낸 지시에 응답이 영원히 오지 않는"
   * 것으로만 보였다. 저장 실패 경고와 같은 채널(레코드 경고 → 상태 존 + status WARN)을 쓴다.
   */
  async function onTurnFailure(sid: string, reason: string): Promise<void> {
    await noteFailure(sid, "turn-failed", reason);
    await deps.onSessionError?.(sid, reason).catch(() => {});
  }

  /**
   * 경고를 접두 종류별로 1건만 유지하며 추가한다 — 같은 종류의 실패가 반복될 때 무한 누적되면
   * 노트·`status` 가 같은 문구로 가득 차고 최신 사유를 읽기 어렵다(데몬 재기동마다 1건씩 늘던 경로).
   */
  function addWarning(current: readonly string[], msg: string): string[] {
    const kind = msg.split(":")[0];
    return [...current.filter((w) => w.split(":")[0] !== kind), msg];
  }

  /**
   * 실패를 세션 레코드 경고로 남긴다. 레코드는 **설정 루트**에 있어 vault 권한·마운트 실패와
   * 독립적이다 — 저장이 실패한 그 위치에 경고를 쓰려 하면 같은 이유로 실패한다. 같은 접두의 중복
   * 누적은 막고(마지막 1건 유지) 실패 사실은 재기동 후에도 남는다.
   */
  async function noteFailure(sid: string, kind: string, reason: string): Promise<void> {
    const rec = records.get(sid);
    if (!rec) return;
    rec.warnings = addWarning(rec.warnings, `${kind}: ${reason}`);
    await persist(rec);
  }

  /** 접두가 같은 경고를 제거한다. 대상이 없으면 쓰기도 하지 않는다(무의미 재기록 회피). */
  async function clearFailure(sid: string, kind: string): Promise<void> {
    const rec = records.get(sid);
    if (!rec) return;
    const prefix = `${kind}:`;
    if (!rec.warnings.some((w) => w === kind || w.startsWith(prefix))) return;
    rec.warnings = rec.warnings.filter((w) => w !== kind && !w.startsWith(prefix));
    await persist(rec);
  }

  /** 노트 저장(투영) 실패 — 경고 채널에 올리고 조립부 알림도 함께 발화한다. */
  async function noteStorageFailure(sid: string, reason: string): Promise<void> {
    await noteFailure(sid, "storage-failed", reason);
    await deps.onSessionError?.(sid, `storage-failed: ${reason}`).catch(() => {});
  }

  function activeSameCwd(): number {
    return [...records.values()].filter((r) => r.status === "active").length;
  }

  // --- 안내 존(design.md §7) --------------------------------------------------

  /** 안내 항목을 레코드에 추가·상한 접기까지 반영(persist 는 호출자 책임 — 다른 변경과 묶어 1회로). */
  function addNoticeToRecord(rec: SessionRecord, n: NoticeInput): void {
    const entry: NoticeEntry = {
      id: generateNoticeId(),
      mode: n.mode ?? "read",
      kind: n.kind,
      text: sanitizeEngineText(n.text),
      at: nowIso(),
      ...(n.options ? { options: n.options } : {}),
      ...(n.footer ? { footer: n.footer } : {}),
    };
    // `replace: true` 인 kind 는 최신 1건으로 대체한다 — 그렇지 않으면 상태 불일치·이미 예약됨·
    // 후보 0건 등 "현재 상태" 반복 알림이 중복 요청마다 계속 append 된다. 미지정 kind(예:
    // compact-done)는 여러 건이 독립 이벤트로 공존해야 하므로 그대로 누적한다(SC-030).
    const base = n.replace
      ? rec.notices.filter((existing) => existing.kind !== n.kind)
      : rec.notices;
    const capped = planNoticeCap([...base, entry], deps.conf["markdown.notices_cap"]);
    rec.notices = capped.kept;
  }

  async function pushNoticeToSession(sid: string, n: NoticeInput): Promise<void> {
    const rec = records.get(sid);
    if (!rec) return;
    addNoticeToRecord(rec, n);
    await persist(rec);
  }

  /** `clear()` 가 승계 성공 시 `old.stopReason` 에 심어 둔 후속 sid 접두(SoT 재사용 — 별도 필드
   * 신설 없이 기존 문자열에서 파싱한다). 이 값이 있는 세션만 "노트 쓰기 실패의 사용자 경고를
   * 승계된 새 세션 쪽에 낸다" 경로에 해당한다. */
  const SUCCEEDED_BY_PREFIX = "succeeded-by:";
  function successorSidOf(rec: SessionRecord): string | null {
    return rec.stopReason?.startsWith(SUCCEEDED_BY_PREFIX)
      ? rec.stopReason.slice(SUCCEEDED_BY_PREFIX.length)
      : null;
  }

  /** 승계(clear) 노트 쓰기 실패의 사용자 표면 경고 — old 는 상태 필터로 폴 대상에서 제외돼 경고가
   * 보일 계기가 없으므로 승계된 새 세션(next) 쪽 `warnings` 에 낸다. `noteFailure` 를 그대로
   * 재사용(같은 `stop-note-failed:` 접두 — 기존 경고판 관행과 동일한 kind 단위 단일 슬롯 대체). */
  async function noteSuccessionFailure(successorSid: string, failedSid: string): Promise<void> {
    await noteFailure(
      successorSid,
      "stop-note-failed",
      tFor(deps.conf.lang)("notice.successionNoteFailed", { oldSid: failedSid }),
    );
  }

  function resumeCandidatesInternal(limit?: number): SessionRecord[] {
    const all = [...records.values()]
      .filter((r) => r.status === "stopped" || r.status === "detached")
      .sort(
        (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.sid.localeCompare(b.sid),
      );
    return limit !== undefined ? all.slice(0, limit) : all;
  }

  async function pushResumeListNotice(requesterSid: string): Promise<void> {
    const rec = records.get(requesterSid);
    if (!rec) return;
    // 중복 요청 시 최신 1개로 대체된다(ADR-010·SC-038 Edge) — `addNoticeToRecord` 의 kind 단위
    // 대체 규칙이 일반 처리한다(rework2 — 특례 아닌 공통 규칙으로 승격).
    const candidates = resumeCandidatesInternal(RESUME_LIST_LIMIT + 1);
    if (candidates.length === 0) {
      addNoticeToRecord(rec, {
        kind: "resume-none",
        text: "재개할 중지 세션이 없습니다.",
        replace: true,
      });
      await persist(rec);
      return;
    }
    const truncated = candidates.length > RESUME_LIST_LIMIT;
    const shown = candidates.slice(0, RESUME_LIST_LIMIT);
    const options = shown.map((r) => ({
      token: r.sid,
      label: `${r.sid} · ${r.title ?? "(제목 없음)"} · 최근 활동 ${r.lastActivityAt} · ${
        r.status === "detached" ? `떨어짐(사유: ${r.stopReason ?? "-"})` : "중지"
      }`,
    }));
    addNoticeToRecord(rec, {
      kind: "resume-list",
      mode: "prompt",
      text: "재개할 세션을 선택하세요.",
      options,
      replace: true,
      ...(truncated
        ? {
            footer: `최근 ${RESUME_LIST_LIMIT}건만 표시했습니다 — 전체는 \`adde session ls <proj>\``,
          }
        : {}),
    });
    await persist(rec);
  }

  async function applyNoticeSync(sid: string, plan: NoticeSyncPlan): Promise<void> {
    const rec = records.get(sid);
    if (!rec) return;
    rec.notices = plan.keep;
    if (plan.cancelled) {
      addNoticeToRecord(rec, {
        kind: "resume-cancelled",
        text: "재개 선택이 취소되었습니다.",
        replace: true,
      });
    }
    if (plan.notYetReflected.length > 0) {
      // 사용자가 항목을 지웠지만 노트에 아직 렌더 확정 전이라 취소·읽음으로 해석하지 못했다
      // (crash-consistency 계약 — 부재를 조용히 되살리지 않고 안내한다, 근본 수정은 이월·사용자
      // 결정으로 완화만 적용). 같은 kind 는 최신 1건으로 대체(replace) — 반복 발동 시 누적 방지.
      addNoticeToRecord(rec, {
        kind: "notice-not-yet-reflected",
        text: tFor(deps.conf.lang)("notice.notYetReflected"),
        replace: true,
      });
    }
    await persist(rec);
    if (plan.chosen) {
      const token = plan.chosen.token;
      await enqueueControl(() => applyResume(token)).catch((err: unknown) => {
        console.error(`session-manager: 안내 선택 재개 실패(sid=${token}): ${errMsg(err)}`);
      });
    }
  }

  // --- 중지·재개 단일 경로(design.md §3) ---------------------------------------

  /** 중지 안내형/떨어짐 노트를 1회 교체 — 실패 시 `stopNotePending` 유지 + 경고 존(유계 재시도 3회).
   * `kind`·`reason`·`extras` 는 모두 레코드(SoT)에서 재구성한다 — 원 호출자만 아는 부가 안내(승계
   * 등)도 `rec.stopNoteExtras` 에 영속돼 있어 재시도가 원 호출과 같은 내용을 쓴다(단일 writer 원칙,
   * 배너 writer 는 이 함수 하나 — 최초 시도(`applyStop`·`markDetached`·`clear`)와 재시도(control
   * 드레인 tick)가 같은 로직을 공유한다). */
  async function writeStoppedNoteOnce(sid: string): Promise<void> {
    const rec = records.get(sid);
    if (!rec) return;
    const info: StopNoteInfo = {
      kind: rec.status === "detached" ? "detached" : "stopped",
      reason: rec.stopReason ?? "",
      ...(rec.stopNoteExtras ? { extras: rec.stopNoteExtras } : {}),
    };
    // 승계(clear) 로 중지된 세션은 사용자 표면 경고를 자기 자신이 아니라 승계된 새 세션에 낸다
    // (old 는 상태 필터로 폴 대상에서 빠져 경고가 보일 계기가 없다). `stopNotePending`/재시도
    // 카운터는 그대로 old 자신이 진다 — 재시도 기전과 사용자 표면을 분리한다.
    const successorSid = successorSidOf(rec);
    try {
      await deps.onStopApplied(sid, info);
      // 플래그와 경고 갱신을 단일 persist 로 묶는다 — 분리하면(이전엔 `stopNotePending=false` 를
      // persist 한 뒤 `clearFailure` 가 경고 제거를 **별도로** persist 했다) 그 사이 I/O 양보
      // 구간에서 "플래그는 이미 false 인데 경고는 아직 잔존" 하는 과도 상태가 외부(5ms 간격 폴)에
      // 노출된다(GAP-019, test(EXECUTION) 실측 — SC-004 Edge 6회 재실행 중 3회 실패). 상태 필드와
      // 경고는 하나의 원자 갱신으로 함께 확정돼야 한다.
      const failurePrefix = "stop-note-failed:";
      const hadFailureWarning = rec.warnings.some(
        (w) => w === "stop-note-failed" || w.startsWith(failurePrefix),
      );
      if (rec.stopNotePending || hadFailureWarning) {
        rec.stopNotePending = false;
        if (hadFailureWarning) {
          rec.warnings = rec.warnings.filter(
            (w) => w !== "stop-note-failed" && !w.startsWith(failurePrefix),
          );
        }
        await persist(rec);
      }
      stopNoteRetries.delete(sid);
      if (successorSid) {
        await clearFailure(successorSid, "stop-note-failed");
      }
    } catch (err) {
      // 실패 분기도 같은 이유로 단일 persist — 플래그·경고가 따로 확정되면 그 사이 과도 상태가
      // 대칭적으로 노출된다(위 성공 분기와 동일 위험). 승계 케이스는 old 자신의 경고판에는
      // 쓰지 않는다(위 주석) — 대신 승계된 새 세션 쪽에 낸다.
      const retries = (stopNoteRetries.get(sid) ?? 0) + 1;
      stopNoteRetries.set(sid, retries);
      rec.stopNotePending = true;
      if (successorSid) {
        await persist(rec);
        await noteSuccessionFailure(successorSid, sid);
      } else {
        rec.warnings = addWarning(rec.warnings, `stop-note-failed: ${errMsg(err)}`);
        await persist(rec);
      }
    }
  }

  /** 잔여 작업 조회(큐 probe) — 실패는 보수적으로 잔여 있음으로 가정한다(fail-closed). 조회 자체가
   * 반복 실패하면(EACCES·EIO 등 — `queue.ts`가 이미 ENOENT 는 0 으로 흡수하므로 여기 도달하는
   * 실패는 진짜 오류다) 경고로 표면화하고, 연속 `MAX_PENDING_PROBE_FAILURES`회를 넘기면 무한
   * 재평가 대신 강제 진행으로 에스컬레이션한다(사용자 탈출구 확보 — force 없이도 막다른 길에
   * 갇히지 않는다). */
  async function probePendingWork(sid: string): Promise<number> {
    const paths = sessionPaths(deps.base, deps.proj, sid);
    try {
      const n = await pendingWork(paths);
      if (pendingProbeFailures.has(sid)) {
        pendingProbeFailures.delete(sid);
        await clearFailure(sid, "pending-probe-failed");
      }
      return n;
    } catch (err) {
      const failures = (pendingProbeFailures.get(sid) ?? 0) + 1;
      pendingProbeFailures.set(sid, failures);
      if (failures >= MAX_PENDING_PROBE_FAILURES) {
        await noteFailure(
          sid,
          "pending-probe-failed",
          `잔여 작업 조회가 ${failures}회 연속 실패해 강제 진행합니다: ${errMsg(err)}`,
        );
        return 0;
      }
      await noteFailure(sid, "pending-probe-failed", errMsg(err));
      return 1;
    }
  }

  async function applyStop(
    sid: string,
    opts: { reason: string; source: StopSource; force?: boolean },
  ): Promise<StopOutcome> {
    const rec = records.get(sid);
    if (!rec) return { result: "mismatch", reason: "session-not-found" };

    if (rec.status === "stopped" || rec.status === "detached") {
      addNoticeToRecord(rec, {
        kind: "state-mismatch",
        text: `이미 ${rec.status === "detached" ? "떨어진" : "중지된"} 세션입니다.`,
        replace: true,
      });
      await persist(rec);
      return { result: "already", reason: "state-mismatch" };
    }

    if (rec.stopPending && !opts.force) {
      addNoticeToRecord(rec, {
        kind: "stop-already-scheduled",
        text: "이미 중지가 예약되어 있습니다 — 진행 중인 작업이 끝나면 중지됩니다.",
        replace: true,
      });
      await persist(rec);
      return { result: "already", reason: "stop-already-scheduled" };
    }

    if (!opts.force) {
      const pending = await probePendingWork(sid);
      const turnActive = runtimes.get(sid)?.turnRunner.state() === "active";
      // 형제 probe 도 같은 방향(fail-closed)으로 통일한다 — 노트를 읽을 수 없는 상태에서 "잔여
      // 없음" 으로 즉시 중지되면 사용자가 체크해 둔 미소비 전송이 배너 교체로 소실된다.
      const surfacePending = deps.pendingSurfaceWork
        ? await deps.pendingSurfaceWork(sid).catch(() => true)
        : false;
      if (pending > 0 || turnActive || surfacePending) {
        rec.stopPending = { requestedAt: nowIso(), reason: opts.reason, source: opts.source };
        addNoticeToRecord(rec, {
          kind: "stop-scheduled",
          text: "중지가 예약되었습니다 — 진행 중인 작업이 끝나면 자동으로 중지됩니다.",
          replace: true,
        });
        await persist(rec);
        return { result: "scheduled", reason: "stop-scheduled" };
      }
    }

    const rt = runtimes.get(sid);
    if (rt?.engineSession) {
      rt.watcher.disarm(); // 의도적 종료 — 자가 재기동 대상 아님(ADR-031 관행 승계).
      await rt.engineSession.close().catch(async (err: unknown) => {
        await recordStore
          .appendEvent(sid, {
            v: 1,
            sid,
            turn: 0,
            seq: Date.now(),
            ts: new Date().toISOString(),
            t: "error",
            message: `stop: engineSession.close() 실패 — ${errMsg(err)}`,
            fatal: false,
          })
          .catch(() => {});
      });
      rt.engineSession = null;
    }

    // 노트 배너를 상태 가시화(persist)보다 **먼저** 시도한다 — `persist()` 내부의 `records.set()`
    // 이 rec.status 변경을 다른 호출자(`sm.get()`)에 즉시 노출하므로, 그 뒤에 노트를 쓰면 "상태는
    // 이미 stopped인데 노트는 아직 배너가 아닌" 과도 상태가 관측 가능한 창으로 남는다(실측 — 5ms
    // 간격 폴링에서 재현). 노트 결과(성공/실패)는 아래에서 `stopNotePending`/경고로 반영한다.
    let noteWriteError: string | null = null;
    try {
      await deps.onStopApplied(sid, {
        kind: "stopped",
        reason: opts.reason,
        ...(rec.stopNoteExtras ? { extras: rec.stopNoteExtras } : {}),
      });
    } catch (err) {
      noteWriteError = errMsg(err);
    }

    // 저장 실패 시 되돌릴 수 있게 이전 값을 남긴다 — `persist()` 는 실패해도 in-memory 뮤테이션을
    // 스스로 롤백하지 않으므로(뮤테이션은 호출자가 write 전에 미리 반영), 여기서 명시적으로 되돌려
    // "저장된 적 없음" 을 유지한다(관측자가 커밋되지 않은 전이를 보지 않게 — 팔레트 재시도 가능).
    const prevStatus = rec.status;
    const prevStopReason = rec.stopReason;
    const prevStoppedAt = rec.stoppedAt;
    const prevStopPending = rec.stopPending;
    const prevNotices = rec.notices;
    const prevStopNotePending = rec.stopNotePending;
    const prevWarnings = rec.warnings;
    rec.status = "stopped";
    rec.stopReason = opts.reason;
    rec.stoppedAt = nowIso();
    rec.stopPending = null;
    rec.stopNotePending = noteWriteError !== null;
    // 플래그와 경고를 같은 persist 로 묶는다 — 분리하면(이전엔 이 persist 뒤에 `noteFailure`/
    // `clearFailure` 가 경고만 **별도로** persist 했다) 그 사이 과도 상태가 노출된다
    // (`writeStoppedNoteOnce` 와 동일 클래스 결함).
    if (noteWriteError) {
      rec.warnings = addWarning(rec.warnings, `stop-note-failed: ${noteWriteError}`);
    } else {
      const prefix = "stop-note-failed:";
      rec.warnings = rec.warnings.filter((w) => w !== "stop-note-failed" && !w.startsWith(prefix));
    }
    addNoticeToRecord(rec, {
      kind: "stop-done",
      text: `세션이 중지되었습니다(사유: ${opts.reason}).`,
    });
    try {
      await persist(rec);
    } catch (err) {
      rec.status = prevStatus;
      rec.stopReason = prevStopReason;
      rec.stoppedAt = prevStoppedAt;
      rec.stopPending = prevStopPending;
      rec.notices = prevNotices;
      rec.stopNotePending = prevStopNotePending;
      rec.warnings = prevWarnings;
      // 엔진 close 는 이미 실행돼 되돌릴 수 없다(레코드는 active 로 되돌아가지만 엔진은 없는
      // zombie) — 별도 경고 시도가 실패해도 원 예외를 가리지 않게 흡수한다.
      await noteFailure(
        sid,
        "stop-persist-failed",
        `중지 저장 실패(엔진은 이미 종료됨 — 재시도 또는 재기동 필요): ${errMsg(err)}`,
      ).catch(() => {});
      throw err;
    }
    if (noteWriteError) {
      stopNoteRetries.set(sid, (stopNoteRetries.get(sid) ?? 0) + 1);
    } else {
      stopNoteRetries.delete(sid);
    }
    await recordStore
      .appendEvent(sid, {
        v: 1,
        sid,
        turn: 0,
        seq: Date.now(),
        ts: new Date().toISOString(),
        t: "state",
        status: "stopped",
        reason: opts.reason,
      })
      .catch(() => {});
    await deps.onStateChange?.(sid, "stopped", opts.reason).catch(() => {});
    return { result: "stopped", reason: opts.reason };
  }

  /** 중지 예약 소진 판정 — 잔여 작업이 모두 끝났으면 `applyStop(force)` 로 확정한다(design.md §3). */
  async function maybeCompletePendingStop(sid: string): Promise<void> {
    const rec = records.get(sid);
    if (!rec?.stopPending) return;
    const pending = await probePendingWork(sid);
    const turnActive = runtimes.get(sid)?.turnRunner.state() === "active";
    const surfacePending = deps.pendingSurfaceWork
      ? await deps.pendingSurfaceWork(sid).catch(() => true)
      : false;
    if (pending > 0 || turnActive || surfacePending) return;
    const { reason, source } = rec.stopPending;
    await applyStop(sid, { reason, source, force: true });
  }

  async function applyResume(sid: string): Promise<ResumeOutcome> {
    const rec = records.get(sid);
    if (!rec) return { result: "mismatch", reason: "session-not-found" };
    if (rec.status !== "stopped" && rec.status !== "detached") {
      addNoticeToRecord(rec, {
        kind: "state-mismatch",
        text: "이미 활성 계열 상태라 재개할 수 없습니다.",
        replace: true,
      });
      await persist(rec);
      return { result: "mismatch", reason: "state-mismatch" };
    }
    rec.status = "active";
    rec.stopReason = null;
    rec.stoppedAt = null;
    rec.lastActivityAt = nowIso();
    await persist(rec);
    await recordStore
      .appendEvent(sid, {
        v: 1,
        sid,
        turn: 0,
        seq: Date.now(),
        ts: new Date().toISOString(),
        t: "state",
        status: "active",
        reason: "resumed",
      })
      .catch(() => {});
    armRunner(sid);
    try {
      await api.admit(sid);
    } catch (err) {
      // admit() 내부에서 wasResume(engineRef 보유) 인 경우 이미 markDetached 를 호출했을 수 있다
      // (기존 admit catch 로직 승계) — 아직 detached 로 전이되지 않았을 때만(턴 0회 세션 등) 여기서
      // 직접 전이시켜 FR-019 를 재개 실패 전 경로에 공백 없이 적용한다.
      const current = records.get(sid);
      if (current && current.status !== "detached") {
        await markDetached(sid, `resume-failed: ${errMsg(err)}`);
      }
      return { result: "failed", reason: errMsg(err) };
    }
    try {
      // `.catch()` 체이닝이 아니라 try/catch 를 쓴다 — 훅이 아예 함수가 아니면(미배선 조립)
      // 호출 자체가 동기적으로 던져 `.catch()` 를 달 promise 가 생기지 않는다(rework2 보충
      // 필수화 검증에서 실측 — CLI resume 이 이 경로에서 미처리 예외로 실패했었다).
      await deps.onResumeApplied(sid);
    } catch (err) {
      console.error(`session-manager: 재개 노트 복구 실패(sid=${sid}): ${errMsg(err)}`);
    }
    const fresh = records.get(sid);
    if (fresh) {
      addNoticeToRecord(fresh, { kind: "resume-done-self", text: "세션이 재개되었습니다." });
      // 경고 해소도 같은 persist 로 묶는다(`writeStoppedNoteOnce` 등과 동일 클래스 결함) —
      // 분리하면 "재개 안내는 이미 떴는데 resume-failed 경고는 아직 잔존" 하는 과도 상태가
      // 노출된다.
      const prefix = "resume-failed:";
      fresh.warnings = fresh.warnings.filter((w) => w !== "resume-failed" && !w.startsWith(prefix));
      await persist(fresh);
    }
    return { result: "resumed" };
  }

  // --- control 큐(design.md §4) ------------------------------------------------

  async function handleControlRequest(req: ControlRequest): Promise<ControlResult> {
    try {
      if (req.op === "stop") {
        const r = await applyStop(req.sid, { reason: "cli", source: "cli" });
        // "already"(이미 중지·예약됨)도 state-mismatch 와 동일하게 실패로 보고한다(design.md §3
        // 안내 지점 18) — 오직 실제로 전이가 일어난 stopped·scheduled 만 성공이다(무동작 성공 금지).
        return {
          v: 1,
          id: req.id,
          ok: r.result === "stopped" || r.result === "scheduled",
          result: r.result,
          reason: r.reason,
        };
      }
      if (req.op === "resume") {
        const r = await applyResume(req.sid);
        return {
          v: 1,
          id: req.id,
          ok: r.result === "resumed",
          result: r.result,
          ...(r.reason ? { reason: r.reason } : {}),
        };
      }
      if (req.op === "remove") {
        // 중지 경로 재사용: applyStop(force) → turnRunner.stop() → remove().
        await applyStop(req.sid, { reason: "removed", source: "remove", force: true }).catch(
          () => {},
        );
        await runtimes
          .get(req.sid)
          ?.turnRunner.stop()
          .catch(() => {});
        await api.remove(req.sid, { purge: false });
        return { v: 1, id: req.id, ok: true, result: "removed" };
      }
      // 미인식 op — `drainControl` 의 스키마 검증(`isValidControlRequest`)을 통과했다면 도달할 수
      // 없지만, 폴백이 가장 파괴적인 분기(remove)로 향하던 종전 구조 자체가 결함이었다(보안 검토
      // SEC-002, A-P006) — exhaustive 하지 않은 값은 명시적으로 거부한다.
      return { v: 1, id: req.id, ok: false, reason: `알 수 없는 control op: ${String(req.op)}` };
    } catch (err) {
      return { v: 1, id: req.id, ok: false, reason: errMsg(err) };
    }
  }

  async function controlTickBody(): Promise<void> {
    await drainControl({ base: deps.base, proj: deps.proj, handle: handleControlRequest }).catch(
      (err: unknown) => console.error(`session-manager: control 드레인 실패: ${errMsg(err)}`),
    );
    await absorbExternalChanges().catch((err: unknown) =>
      console.error(`session-manager: 외부 변경 흡수 실패: ${errMsg(err)}`),
    );
    for (const rec of [...records.values()]) {
      if (rec.stopPending) await maybeCompletePendingStop(rec.sid).catch(() => {});
      if (rec.stopNotePending && (stopNoteRetries.get(rec.sid) ?? 0) < MAX_STOP_NOTE_RETRIES) {
        await writeStoppedNoteOnce(rec.sid).catch(() => {});
      }
    }
  }

  const api: SessionManager = {
    list(): SessionRecord[] {
      return [...records.values()];
    },

    get(sid: string): SessionRecord | undefined {
      return records.get(sid);
    },

    turnRunner(sid: string): TurnRunner | undefined {
      return runtimes.get(sid)?.turnRunner;
    },

    async create(opts): Promise<CreateResult> {
      const engineId = opts.engine && opts.engine.length > 0 ? opts.engine : deps.conf.engine;
      const driver = driverFor(engineId);
      const warnings: string[] = [];
      if (driver.caps.resume === "none") {
        warnings.push("engine-no-resume"); // FR-008 — 재기동 후 맥락 유지 안 됨을 생성 시점에 경고.
      }
      if (driver.caps.permission !== "callback") {
        throw new Error(
          `session-manager: 엔진 "${engineId}" 은 대화형 승인을 지원하지 않아 세션 생성을 거부합니다.`,
        );
      }
      const now = nowIso();
      const engineArgs = opts.engineArgs ? opts.engineArgs.split(/\s+/).filter(Boolean) : [];
      // 채번을 "관측" 이 아니라 "예약" 으로 한다 — `reserveSessionId` 가 후보 sid 의 레코드
      // 파일을 배타 생성해 실제로 선점하고, 다른 프로세스가 먼저 차지했으면(EEXIST) 다음 번호로
      // 재시도한다(관측만 하던 `nextSessionId` + 별도 `persist()` 는 동시 `create()` 두 건이
      // 같은 sid 를 관측해 레코드 파일 rename 이 충돌하는 결함이 있었다).
      const rec = await reserveSessionId({
        base: deps.base,
        proj: deps.proj,
        vaultRoot: deps.vaultRoot,
        now: new Date(deps.clock.now()),
        title: opts.title ?? null,
        buildRecord: (sid): SessionRecord => ({
          v: 1,
          sid,
          engine: engineId,
          engineRef: null,
          status: "active",
          title: opts.title ?? null,
          createdAt: now,
          lastActivityAt: now,
          successorOf: null,
          engineArgs,
          warnings,
          bindings: [],
          rev: 1, // 예약 성공 시점에 이미 디스크 반영됨 — persist() 의 "신규는 rev 1" 규칙과 동치.
          stopReason: null,
          stoppedAt: null,
          stopPending: null,
          stopNotePending: false,
          notices: [],
          storageLayout: "session",
        }),
      });
      records.set(rec.sid, rec);
      return { sid: rec.sid, warnings, activeSameCwd: activeSameCwd() };
    },

    async clear(sid: string): Promise<{ next: string }> {
      const old = records.get(sid);
      if (!old) throw new Error(`session-manager: 세션 없음 (${sid})`);
      if (old.status === "stopped" || old.status === "detached") {
        throw new Error(`session-manager: 이미 중지된 세션은 초기화할 수 없습니다 (${sid})`);
      }
      await api.hibernate(sid, "attach").catch(() => {});
      const now = nowIso();
      // 채번을 예약으로 한다(create() 와 동일 이유) — 예약이 실패하면(재시도 소진·EEXIST 아닌
      // 다른 I/O 오류) 승계 대상 자체가 없으므로 여기서 전파해 clear() 전체를 실패시킨다(old 는
      // 아직 손대지 않았다 — 이전의 "디스크 반영 실패해도 메모리에만 존재하는 next 로 부분 성공"
      // 개념은 예약이 all-or-nothing 이 되면서 성립하지 않는다: 예약 성공 = 디스크 반영까지 완료,
      // 실패 = next 자체가 없다).
      const next = await reserveSessionId({
        base: deps.base,
        proj: deps.proj,
        vaultRoot: deps.vaultRoot,
        now: new Date(deps.clock.now()),
        title: old.title,
        buildRecord: (newSidValue): SessionRecord => ({
          v: 1,
          sid: newSidValue,
          engine: old.engine,
          engineRef: null,
          status: "active",
          title: old.title,
          createdAt: now,
          lastActivityAt: now,
          successorOf: old.sid,
          engineArgs: old.engineArgs,
          warnings: [],
          // 새 세션은 자기 소유 노트를 새로 받는다(FR-011 — clear 는 이제 "새 세션 생성" 이지
          // 제자리 초기화가 아니다). 바인딩은 비워 두고 호출자(L4 팔레트 핸들러)가 신규 주소로
          // 등록한다.
          bindings: [],
          rev: 1,
          stopReason: null,
          stoppedAt: null,
          stopPending: null,
          stopNotePending: false,
          notices: [],
          storageLayout: "session",
        }),
      });
      // successor(B)를 먼저 확정한(예약 성공 = 디스크 반영까지 완료) 뒤에 old(A)를 중지로
      // 전이한다 — 순서를 반대로 하면 `old.status` 변경이 `records` 맵의 **같은 객체**를
      // 즉시(동기) 바꾸므로, 외부 관측자(`sm.get()`)가 "A 는 이미 stopped인데 B 는 아직
      // list 에 없다"는 과도기 상태를 관측할 수 있다(레이스 — 실측 재현됨).
      records.set(next.sid, next);
      const newSidValue = next.sid;
      const succeededByReason = `succeeded-by:${newSidValue}`;
      const extras = [`승계된 새 세션: ${newSidValue}`];
      // 이전 세션의 바인딩은 그대로 둔다 — 상태 필터(중지 제외)로 폴 대상에서 빠진다. 배너는 이
      // 함수가 직접 쓴다(단일 writer — `vaultPaths` 로 그 세션 고유 경로를 파생할 뿐, 바인딩을
      // 조회해 주소를 찾는 것이 아니다).
      old.stopNoteExtras = extras;
      // 노트 배너를 상태 가시화(persist)보다 먼저 시도한다(applyStop·markDetached 와 동형 —
      // 관측 가능한 과도 상태 제거 + writer 단일화, GAP-011 rework2).
      let noteWriteError: string | null = null;
      try {
        await deps.onStopApplied(old.sid, { kind: "stopped", reason: succeededByReason, extras });
      } catch (err) {
        noteWriteError = errMsg(err);
      }
      const prevStatus = old.status;
      const prevStopReason = old.stopReason;
      const prevStoppedAt = old.stoppedAt;
      const prevStopNotePending = old.stopNotePending;
      const prevStopNoteExtras = old.stopNoteExtras;
      const prevWarnings = old.warnings;
      old.status = "stopped";
      old.stopReason = succeededByReason;
      old.stoppedAt = now;
      old.stopNotePending = noteWriteError !== null;
      // 노트 쓰기 실패의 사용자 표면 경고는 old 자신의 warnings 에는 남기지 않는다 — old 는 상태
      // 필터로 폴 대상에서 빠져 경고가 보일 계기가 없다. old 는 `stopNotePending` 플래그만으로
      // 재시도를 진다(`writeStoppedNoteOnce`, control tick 이 소비) — 사용자 표면 경고는
      // persist(old) 확정 뒤 승계된 새 세션(next) 쪽에 낸다(아래).
      try {
        await persist(old);
      } catch (err) {
        old.status = prevStatus;
        old.stopReason = prevStopReason;
        old.stoppedAt = prevStoppedAt;
        old.stopNotePending = prevStopNotePending;
        old.stopNoteExtras = prevStopNoteExtras;
        old.warnings = prevWarnings;
        await noteFailure(
          old.sid,
          "stop-persist-failed",
          `초기화(clear) 중 이전 세션 저장 실패(엔진은 이미 종료됨): ${errMsg(err)}`,
        ).catch(() => {});
        throw err;
      }
      if (noteWriteError) {
        stopNoteRetries.set(old.sid, (stopNoteRetries.get(old.sid) ?? 0) + 1);
        await noteSuccessionFailure(newSidValue, old.sid);
      } else {
        stopNoteRetries.delete(old.sid);
      }
      await recordStore
        .appendEvent(old.sid, {
          v: 1,
          sid: old.sid,
          turn: 0,
          seq: Date.now(),
          ts: new Date().toISOString(),
          t: "state",
          status: "stopped",
          reason: succeededByReason,
        })
        .catch(() => {});
      await pushNoticeToSession(newSidValue, {
        kind: "succession-from",
        text: `이전 세션(${old.sid})을 승계했습니다.`,
      });
      return { next: newSidValue };
    },

    async remove(sid: string, opts: { purge: boolean }): Promise<void> {
      const rt = runtimes.get(sid);
      if (rt) {
        await rt.turnRunner.stop().catch(() => {});
        if (rt.engineSession) {
          rt.watcher.disarm();
          await rt.engineSession.close().catch(() => {});
        }
      }
      runtimes.delete(sid);
      records.delete(sid);
      // 이 sid 는 재생성될 수 없으므로(FR-007 순번 재사용 금지) 세션 소유 dedup 인덱스도 방어적으로
      // 청소한다(완전 제거·일반 제거 공통 — 어느 쪽도 이후 이 sid 로 classify() 가 호출되지 않는다).
      dropSessionIndex(recordCtx(sid));
      void opts.purge;
    },

    async admit(sid: string): Promise<EngineSession> {
      const step = async (): Promise<EngineSession> => {
        const rec = records.get(sid);
        if (!rec) throw new Error(`session-manager: 세션 없음 (${sid})`);
        const rt = ensureRuntime(sid);
        if (rt.engineSession && rt.engineSession.isAlive()) return rt.engineSession;

        // 상한 검사 → LRU 내림(턴 처리 중 세션 제외) → 기동. 전부 이 단일 체인 안에서 원자적으로 보인다.
        const activeSids = [...records.values()].filter(
          (r) => r.status === "active" && runtimes.get(r.sid)?.engineSession?.isAlive(),
        );
        if (activeSids.length >= deps.conf.max_active_engines) {
          const candidates = activeSids
            .filter((r) => runtimes.get(r.sid)?.turnRunner.state() !== "active")
            .sort(
              (a, b) =>
                a.lastActivityAt.localeCompare(b.lastActivityAt) || a.sid.localeCompare(b.sid),
            );
          const victim = candidates[0];
          if (victim) await api.hibernate(victim.sid, "lru");
        }

        const driver = driverFor(rec.engine);
        const wasResume = rec.engineRef !== null;
        let engineSession: EngineSession;
        try {
          engineSession = await driver.open({
            cwd: deps.conf.cwd ?? process.cwd(),
            ...(rec.engineRef ? { engineRef: rec.engineRef } : {}),
            args: rec.engineArgs,
            ...(deps.conf.lang ? { lang: deps.conf.lang } : {}),
            // 엔진 진단 로그 — `logs --engine` 이 읽는 경로와 같은 도출식을 쓴다(양쪽 합의).
            stderrLogPath: engineLogPath(deps.base, deps.proj, sid),
            policy: {
              perm_tier: deps.conf.perm_tier,
              allowlist: deps.conf.allowlist,
              denylist: deps.conf.denylist,
              hard_deny: deps.conf.hard_deny,
              ...(deps.conf.gate_timeout_sec !== undefined
                ? { gate_timeout_sec: deps.conf.gate_timeout_sec }
                : {}),
            },
            onWarn: (msg) => {
              // 권한 설정 차이 등 비차단 경고 — 접두 종류별 1건 유지 규약을 따르고(같은 종류의 다른
              // 문구가 누적되던 경로) 영속 실패를 조용히 삼키지 않는다.
              void noteFailure(sid, "perm-diff", msg).catch((err: unknown) => {
                console.error(`session-manager: 경고 영속 실패(sid=${sid}): ${errMsg(err)}`);
              });
            },
          });
        } catch (err) {
          // 재개(resumeSessionId 지정) 시도가 실패하면 새 세션 폴백 없이 detached 로 확정한다
          //. 신규 세션 최초 기동 실패는 상태를 건드리지 않고 그대로 전파한다.
          if (wasResume) await markDetached(sid, `resume-failed: ${errMsg(err)}`);
          throw err;
        }
        rt.engineSession = engineSession;
        // 기동에 성공했으므로 이전 재개 실패는 해소됐다 — 남겨 두면 노트·status 에 낡은 실패가
        // 영구히 표시된다(저장 실패와 같은 "성공이 실패를 지운다" 자세).
        //
        // 이 persist 와 아래(수십 줄 뒤) `status="active"` persist 는 의도적으로 분리한 채
        // 둔다 — 원자화 대상이 아니라고 판단했다. 이 사이 관측 가능한 값은 "hibernated(또는
        // 호출 경로에 따라 이미 active)+경고 없음" 뿐이고, 이는 그 자체로 모순 없는 유효한
        // 상태다(플래그는 해소인데 대응 경고는 잔존하는 것처럼 서로 모순되는 두 필드 조합이
        // 아니다 — status·warnings 는 이 구간에서 서로 독립적이다). 또한 `applyResume()` 경로
        // (가장 흔한 호출부)는 `admit()` 호출 **전에** 이미 `rec.status="active"` 를 persist
        // 하므로(위쪽 함수), 그 경로에서는 이 지점의 `rec.status` 가 이미 active 라 창 자체가
        // 없다. 직접 `admit()` 을 호출하는 다른 경로(예: compact)에서만 hibernated 상태가 잠깐
        // 보일 수 있으나 오보가 성립하지 않아 그대로 둔다.
        if (rec.warnings.some((w) => w.startsWith("resume-failed:"))) {
          rec.warnings = rec.warnings.filter((w) => !w.startsWith("resume-failed:"));
          await persist(rec);
        }
        rt.watcher.arm();
        engineSession.onExit((info) => {
          rt.watcher.onCrash(info);
        });
        // engineRef(재개 핸들)는 여기서 영속하지 않는다 — 엔진 전사는 **턴이 1회 이상 실행된 뒤에만**
        // 기록되므로, 턴 0회 세션의 핸들을 남기면 프로세스가 죽은 뒤의 재개가 "전사 없음" 으로 실패해
        // 세션이 detached 로 확정된다(실측: 생성→내림→첫 지시 순서에서 첫 지시가 죽었다).
        // 첫 턴이 완결되는 시점(refreshNotes)에 영속한다.
        rec.status = "active";
        rec.lastActivityAt = nowIso();
        await persist(rec);
        await recordStore
          .appendEvent(sid, {
            v: 1,
            sid,
            turn: 0,
            seq: Date.now(),
            ts: new Date().toISOString(),
            t: "session",
            engineRef: engineSession.engineRef,
            resumed: Boolean(rec.engineRef),
          })
          .catch(() => {});
        return engineSession;
      };
      const result = admitChain.then(step, step);
      admitChain = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },

    async hibernate(sid: string, reason: "idle" | "lru" | "attach"): Promise<void> {
      const rec = records.get(sid);
      const rt = runtimes.get(sid);
      if (!rec || !rt) return;
      if (rt.turnRunner.state() === "active") return; // 턴 처리 중 세션은 대상 아님.
      const driver = driverFor(rec.engine);
      if (driver.caps.resume === "none") return; // 재개 불가 엔진은 내리면 되살릴 수 없다.
      if (!rt.engineSession) return;
      rt.watcher.disarm(); // 의도적 종료 — 크래시 자가 재기동 트리거 아님.
      await rt.engineSession.close().catch(async (err: unknown) => {
        // close 실패해도 슬롯은 비운다(엔진 프로세스 참조를 더 들고 있을 이유가 없다) — 실패 자체는
        // error 이벤트로 가시화한다(안전망 설계표 "내림 대상 close 실패 → error 이벤트 + 다음 후보").
        await recordStore
          .appendEvent(sid, {
            v: 1,
            sid,
            turn: 0,
            seq: Date.now(),
            ts: new Date().toISOString(),
            t: "error",
            message: `hibernate: engineSession.close() 실패 — ${errMsg(err)}`,
            fatal: false,
          })
          .catch(() => {});
      });
      rt.engineSession = null;
      rec.status = "hibernated";
      await persist(rec);
      await recordStore
        .appendEvent(sid, {
          v: 1,
          sid,
          turn: 0,
          seq: Date.now(),
          ts: new Date().toISOString(),
          t: "state",
          status: "hibernated",
          reason,
        })
        .catch(() => {});
      await deps.onStateChange?.(sid, "hibernated", reason).catch(() => {});
    },

    async resumeAllOnBoot(): Promise<BootResumeReport> {
      const report: BootResumeReport = { resumed: [], detached: [], skipped: [] };
      // 재개 대상(active)이 아닌 세션도 런너는 필요하다 — hibernated 세션은 다음 지시에서 투명하게
      // 재개돼야 하는데, 런타임이 없으면 dispatch 의 notify() 가 no-op 이 되어 큐만 쌓인다.
      for (const rec of records.values()) {
        if (rec.status === "active" || rec.status === "hibernated") armRunner(rec.sid);
      }
      for (const rec of records.values()) {
        if (rec.status !== "active") continue;
        // 중지 예약이 재기동을 넘어 유지된 세션 — admit 하지 않고 런너만 arm 해 잔여 큐를
        // 소진시킨 뒤(위 루프에서 이미 armRunner 완료) control 드레인 tick 이 중지를 확정한다.
        if (rec.stopPending) {
          report.skipped.push(rec.sid);
          continue;
        }
        // driverFor()/admit() 실패를 세션 단위로 격리한다 — 세션 1개(예: 미등록 엔진 id)가
        // 예외를 던져도 나머지 세션 재개·boot report 작성이 계속되어야 한다(프로젝트 전체
        // 부팅 크래시 금지, FR-007 재개 실패 경로 재사용).
        try {
          const driver = driverFor(rec.engine);
          if (driver.caps.resume === "none") {
            rec.status = "hibernated";
            await persist(rec);
            await recordStore
              .appendEvent(rec.sid, {
                v: 1,
                sid: rec.sid,
                turn: 0,
                seq: Date.now(),
                ts: new Date().toISOString(),
                t: "note",
                kind: "info",
                message: "context_reset: 엔진이 재개를 지원하지 않아 재개를 생략했습니다.",
              })
              .catch(() => {});
            report.skipped.push(rec.sid);
            continue;
          }
          if (!deps.conf.auto_resume) {
            report.skipped.push(rec.sid);
            continue;
          }
          await api.admit(rec.sid);
          report.resumed.push(rec.sid);
        } catch (err) {
          const reason = errMsg(err);
          rec.status = "detached";
          rec.stopReason = reason;
          rec.stoppedAt = nowIso();
          rec.warnings = addWarning(rec.warnings, `resume-failed: ${reason}`);
          await persist(rec);
          await recordStore
            .appendEvent(rec.sid, {
              v: 1,
              sid: rec.sid,
              turn: 0,
              seq: Date.now(),
              ts: new Date().toISOString(),
              t: "state",
              status: "detached",
              reason,
            })
            .catch(() => {});
          await deps.onStateChange?.(rec.sid, "detached", reason).catch(() => {});
          report.detached.push({ sid: rec.sid, reason });
        }
      }
      return report;
    },

    stop(sid, opts): Promise<StopOutcome> {
      return enqueueControl(() => applyStop(sid, opts));
    },

    resume(sid): Promise<ResumeOutcome> {
      return enqueueControl(() => applyResume(sid));
    },

    resumeCandidates(limit?: number): SessionRecord[] {
      return resumeCandidatesInternal(limit);
    },

    pushNotice(sid: string, n: NoticeInput): Promise<void> {
      return pushNoticeToSession(sid, n);
    },

    takeNotices(sid: string): readonly NoticeEntry[] {
      return records.get(sid)?.notices ?? [];
    },

    applyNoticeSync(sid: string, plan: NoticeSyncPlan): Promise<void> {
      return applyNoticeSync(sid, plan);
    },

    pushResumeListNotice(requesterSid: string): Promise<void> {
      return pushResumeListNotice(requesterSid);
    },

    absorbControl(): Promise<void> {
      return enqueueControl(controlTickBody);
    },

    async registerBinding(sid: string, binding: Binding): Promise<void> {
      const rec = records.get(sid);
      if (!rec) throw new Error(`session-manager: 세션 없음 (${sid})`);
      if (
        !rec.bindings.some((b) => b.surface === binding.surface && b.address === binding.address)
      ) {
        rec.bindings = [...rec.bindings, binding];
        await persist(rec);
      }
    },

    async removeBinding(sid: string, binding: { surface: string; address: string }): Promise<void> {
      const rec = records.get(sid);
      if (!rec) throw new Error(`session-manager: 세션 없음 (${sid})`);
      const next = rec.bindings.filter(
        (b) => !(b.surface === binding.surface && b.address === binding.address),
      );
      if (next.length !== rec.bindings.length) {
        rec.bindings = next;
        await persist(rec);
      }
    },

    resolvePermissionDecision(sid: string, reqId: string, decision: "allow" | "deny"): void {
      const rt = runtimes.get(sid);
      const resolver = rt?.pendingPermissions.get(reqId);
      if (resolver) resolver(decision);
    },

    capsOf(sid: string) {
      const rec = records.get(sid);
      if (!rec) return undefined;
      return deps.registry[rec.engine]?.caps;
    },

    async denyPending(sid: string): Promise<void> {
      const rt = runtimes.get(sid);
      if (!rt) return;
      for (const [, resolver] of rt.pendingPermissions) resolver("deny");
    },

    noteFailure(sid: string, kind: string, reason: string): Promise<void> {
      return noteFailure(sid, kind, reason);
    },

    clearFailure(sid: string, kind: string): Promise<void> {
      return clearFailure(sid, kind);
    },

    async shutdown(): Promise<void> {
      if (idleTimer !== undefined) deps.scheduler.clearInterval(idleTimer);
      if (controlTimer !== undefined) deps.scheduler.clearInterval(controlTimer);
      await clearDaemonMarker(projectPaths(deps.base, deps.proj)).catch(() => {});
      for (const rt of runtimes.values()) {
        await rt.turnRunner.stop().catch(() => {});
        if (rt.engineSession) {
          rt.watcher.disarm(); // 데몬 종료 — 의도적, 자가 재기동 대상 아님.
          await rt.engineSession.close().catch(() => {});
        }
      }
    },
  };

  /**
   * 엔진 비정상 종료(크래시) 감지 시 세션을 `detached` 로 확정 + 사유 통지 —
   * `SessionWatcher`(재시도 소진·옵트아웃)가 호출한다. pending 권한은 watcher.onCrash 가 이미 deny 했다.
   * 재개 실패로 인한 `detached` 전이도 이 함수를 재사용한다(admit 의 catch·applyResume 참조).
   */
  async function markDetached(sid: string, reason: string): Promise<void> {
    const rt = runtimes.get(sid);
    const rec = records.get(sid);
    if (!rt || !rec) return;
    rt.engineSession = null;

    // 노트 배너를 상태 가시화보다 먼저 시도한다(applyStop 과 동형 — 관측 가능한 과도 상태 제거).
    let noteWriteError: string | null = null;
    try {
      await deps.onStopApplied(sid, {
        kind: "detached",
        reason,
        ...(rec.stopNoteExtras ? { extras: rec.stopNoteExtras } : {}),
      });
    } catch (err) {
      noteWriteError = errMsg(err);
    }

    const prevStatus = rec.status;
    const prevStopReason = rec.stopReason;
    const prevStoppedAt = rec.stoppedAt;
    const prevStopNotePending = rec.stopNotePending;
    const prevWarnings = rec.warnings;
    rec.status = "detached";
    rec.stopReason = reason;
    rec.stoppedAt = nowIso();
    rec.stopNotePending = noteWriteError !== null;
    rec.warnings = addWarning(rec.warnings, reason);
    // 노트 실패 플래그·경고도 같은 persist 로 묶는다(`writeStoppedNoteOnce`·`applyStop`·`clear`
    // 와 동일 클래스 결함 정리) — `addWarning` 이 위에서 이미 `reason` 을 추가했으므로 여기서는
    // `stop-note-failed` 접두만 추가·제거한다.
    if (noteWriteError) {
      rec.warnings = addWarning(rec.warnings, `stop-note-failed: ${noteWriteError}`);
    } else {
      const prefix = "stop-note-failed:";
      rec.warnings = rec.warnings.filter((w) => w !== "stop-note-failed" && !w.startsWith(prefix));
    }
    try {
      await persist(rec);
    } catch (err) {
      // applyStop 과 동형 — persist 실패 시 레코드 필드는 되돌리되(저장된 적 없음 유지), 엔진
      // 세션은 이미 종료돼 되돌릴 수 없다(레코드는 원 상태로 보이지만 엔진은 없는 zombie) —
      // 경고로 표면화한다(경고 기록 자체 실패는 원 예외를 가리지 않게 흡수).
      rec.status = prevStatus;
      rec.stopReason = prevStopReason;
      rec.stoppedAt = prevStoppedAt;
      rec.stopNotePending = prevStopNotePending;
      rec.warnings = prevWarnings;
      await noteFailure(
        sid,
        "stop-persist-failed",
        `떨어짐 저장 실패(엔진은 이미 종료됨 — 재시도 또는 재기동 필요): ${errMsg(err)}`,
      ).catch(() => {});
      return;
    }
    if (noteWriteError) {
      stopNoteRetries.set(sid, (stopNoteRetries.get(sid) ?? 0) + 1);
    } else {
      stopNoteRetries.delete(sid);
    }
    await recordStore
      .appendEvent(sid, {
        v: 1,
        sid,
        turn: 0,
        seq: Date.now(),
        ts: new Date().toISOString(),
        t: "state",
        status: "detached",
        reason,
      })
      .catch(() => {});
    await deps.onStateChange?.(sid, "detached", reason).catch(() => {});
  }

  // 초기 로드(부팅) — SessionManager 는 records 를 소유하되 로드는 조립부(daemon/supervisor) 가
  // await load() 를 명시 호출한다(비동기 팩토리 대신 명시 초기화 — 실패를 조용히 흡수하지 않는다).
  async function load(): Promise<void> {
    const loaded = await loadSessions(deps.base, deps.proj);
    for (const r of loaded) records.set(r.sid, r);
    for (const r of loaded) {
      if (r.stopPending) {
        await pushNoticeToSession(r.sid, {
          kind: "stop-reservation-carried",
          text: "중지 예약이 재기동을 넘어 유지되었습니다 — 잔여 작업 완료 후 중지됩니다.",
        });
      }
    }
    await writeDaemonMarker(projectPaths(deps.base, deps.proj)).catch((err: unknown) => {
      console.error(`session-manager: 데몬 마커 기록 실패: ${errMsg(err)}`);
    });
  }

  async function refresh(): Promise<{ added: string[] }> {
    const loaded = await loadSessions(deps.base, deps.proj);
    const added: string[] = [];
    for (const r of loaded) {
      if (records.has(r.sid)) continue; // 기존 세션은 덮어쓰지 않는다(런타임 상태 보존).
      records.set(r.sid, r);
      added.push(r.sid);
      if (r.status === "active" || r.status === "hibernated") armRunner(r.sid);
    }
    return { added };
  }

  /** 자동 전이 스윕 — 세션당 1회 평가에서 중지 조건을 먼저 판정하고 아니면 유휴를
   * 판정한다(같은 tick 에 2회 전이가 겹치지 않게, FR-003 유예 0 요구). */
  async function runIdleSweep(): Promise<void> {
    const now = deps.clock.now();
    for (const rec of [...records.values()]) {
      if (rec.status !== "active" && rec.status !== "hibernated") continue;
      const elapsedMs = now - new Date(rec.lastActivityAt).getTime();
      if (deps.conf.idle_stop) {
        const stopThresholdMs = deps.conf.stop_after_min * 60_000;
        if (elapsedMs >= stopThresholdMs) {
          await enqueueControl(() =>
            applyStop(rec.sid, { reason: "inactive", source: "auto" }),
          ).catch(() => {});
          continue;
        }
      }
      if (rec.status !== "active" || !deps.conf.idle_hibernate) continue;
      const hibernateThresholdMs = deps.conf.hibernate_after_min * 60_000;
      if (elapsedMs >= hibernateThresholdMs) {
        await api.hibernate(rec.sid, "idle").catch(() => {});
      }
    }
  }

  /** 일간 보관 이관 스윕 — `vault.backup` 지정 프로젝트만, 하루 1회
   * (`retentionLastRunPath` 게이트, UTC 날짜 비교). 세션별 `runRetention()` 실패는 그 세션만
   * 세션 노트 경고로 남기고 계속한다(fail-open — 대상은 파생물인 턴 노트뿐, 이벤트 원본은 무관).
   * idle sweep 과 같은 60초 타이머에 얹는다(ADR-020 패턴 — 매 tick 값싼 게이트 확인, 실제 이관은
   * 날짜가 바뀐 뒤 1회만). */
  async function runRetentionSweep(): Promise<void> {
    const p = policy();
    if (p.backupDir === null) return; // 옵트인 비활성
    const today = new Date(deps.clock.now()).toISOString().slice(0, 10);
    const last = await readRetentionLastRun(deps.base, deps.proj);
    if (last?.date === today) return; // 오늘 이미 실행됨

    // 겹침 검증을 실행 시점에 한 번 더 한다 — `project add`/`project set` 의 1회 검증만으로는
    // project.conf 직접 편집이나 검증 이후의 vault·설정 루트·cwd 재배치를 잡을 수 없고, 겹친
    // 경로로 스윕이 돌면 턴 노트가 저장소·설정·작업 경로 안으로 이동한다.
    try {
      assertBackupNotOverlapping(
        p.backupDir,
        deps.vaultRoot,
        projectPaths(deps.base, deps.proj).root,
        deps.conf.cwd ?? process.cwd(),
      );
    } catch (err) {
      if (overlapWarnedDate !== today) {
        overlapWarnedDate = today;
        const message = `retention: 보관 위치가 겹쳐 이관을 건너뜁니다 — ${errMsg(err)}`;
        for (const rec of records.values()) {
          await recordStore
            .appendEvent(rec.sid, {
              v: 1,
              sid: rec.sid,
              turn: 0,
              seq: Date.now(),
              ts: new Date().toISOString(),
              t: "note",
              kind: "warning",
              message,
            })
            .catch(() => {});
        }
      }
      return;
    }

    const materialize = resolveSyncProvider(deps.conf["vault.sync_provider"]).ensureLocal;
    let moved = 0;
    let skipped = 0;
    for (const rec of records.values()) {
      try {
        const report = await runRetention(
          { vaultRoot: deps.vaultRoot, proj: deps.proj, sid: rec.sid },
          p,
          materialize,
        );
        moved += report.moved.length;
        skipped += report.skipped.length;
      } catch (err) {
        await recordStore
          .appendEvent(rec.sid, {
            v: 1,
            sid: rec.sid,
            turn: 0,
            seq: Date.now(),
            ts: new Date().toISOString(),
            t: "note",
            kind: "warning",
            message: `retention: 보관 이관 실패 — ${errMsg(err)}`,
          })
          .catch(() => {});
      }
    }
    await writeRetentionLastRun(deps.base, deps.proj, { date: today, moved, skipped }).catch(
      () => {},
    );
  }

  // api 초기화 완료 후에 등록 — runIdleSweep 이 api.hibernate 를 참조하므로, 테스트 스케줄러가
  // setInterval 콜백을 등록 즉시(동기) 호출해도 TDZ("api" 미초기화 접근)가 발생하지 않는다.
  idleTimer = deps.scheduler.setInterval(() => {
    void runIdleSweep();
    void runRetentionSweep();
  }, 60_000);
  controlTimer = deps.scheduler.setInterval(() => {
    void enqueueControl(controlTickBody);
  }, CONTROL_DRAIN_INTERVAL_MS);

  return Object.assign(api, { load, refresh });
}
