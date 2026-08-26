/**
 * SessionManager(L3) — 세션 수명·hibernate·LRU·admit(FR-003·FR-004·FR-005·FR-008·FR-009·FR-010·
 * FR-011·FR-023·NFR-005). `admit()` 는 상한 검사·LRU 내림·기동을 단일 비동기 체인으로 직렬화한다
 * (ADR-021 — Check-Then-Act 경합 제거).
 */
import { randomBytes } from "node:crypto";
import { gateRequestDecision } from "../gate/gate.js";
import type { PermRequest } from "../gate/gate.js";
import { projectPaths, sessionPaths } from "../shared/paths.js";
import type { ProjectConf } from "../shared/conf.js";
import { appendEvent, readEvents } from "../record/events.js";
import { putBlob } from "../record/blobs.js";
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
import { loadSessions, newSid, saveSession } from "./session-store.js";
import type { SessionRecord, SessionStatus } from "./session-store.js";
import type { Binding } from "../surfaces/types.js";
import { errMsg } from "../shared/errors.js";

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

/**
 * L1 RecordStore 계약(design.md "RecordStore (L1)") — SessionManager 가 record/* 자유 함수를
 * 직접 호출하는 대신 선택적으로 주입받을 수 있는 최소 DI 표면(GAP-019). 세션 스코프 메서드는
 * `sid` 를 받고, base·vaultRoot·proj 는 어댑터가 구성 시점에 closure 로 스코프한다(design.md
 * 시그니처에서 매 호출 반복을 피함). `rebuild()` 는 이미 확정된 `record/rebuild.ts` 자유 함수
 * 시그니처(base·vaultRoot 선두 인자, GAP-011)를 그대로 승계해 opts 만 받는다.
 */
export interface RecordStore {
  appendEvent(sid: string, e: AddeEvent): Promise<void>;
  readEvents(sid: string): AsyncIterable<AddeEvent>;
  putBlob(data: Buffer | string): Promise<BlobRef>;
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
  retentionPolicy?: RetentionPolicy;
  /** 미주입 시 base·vaultRoot·proj 로 스코프한 기본 어댑터(현 record/* 자유 함수 위임)를 쓴다.
   * 테스트가 이 필드를 주입하면 appendEvent·project 등 record 기록 호출을 가로챌 수 있다(GAP-019). */
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
  // --- 계약 외 보조 API(Router·Surface 조립부가 소비) ---
  get(sid: string): SessionRecord | undefined;
  turnRunner(sid: string): TurnRunner | undefined;
  registerBinding(sid: string, binding: Binding): Promise<void>;
  removeBinding(sid: string, binding: { surface: string; address: string }): Promise<void>;
  resolvePermissionDecision(sid: string, reqId: string, decision: "allow" | "deny"): void;
  denyPending(sid: string): Promise<void>;
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
  runtimeError: string | null;
}

function newSidGen(): string {
  return newSid(Date.now(), () => randomBytes(4).toString("hex"));
}

export function createSessionManager(deps: SessionManagerDeps): SessionManagerWithLoad {
  const records = new Map<string, SessionRecord>();
  const runtimes = new Map<string, Runtime>();
  let admitChain: Promise<unknown> = Promise.resolve();
  // 유휴 스윕 타이머 핸들 — `api`(runIdleSweep 이 참조)가 완전히 초기화된 뒤에 등록해야 한다.
  // 테스트 스케줄러가 setInterval 콜백을 등록 즉시(동기) 호출하는 경우 TDZ("api" 미초기화 접근)를
  // 막기 위해 초기화(undefined)와 실제 등록(파일 하단, api 선언 이후)을 분리한다.
  let idleTimer: unknown = undefined;
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
  // 위임한다(GAP-019). `deps.record` 미주입 시에만 쓰인다.
  const defaultRecordStore: RecordStore = {
    appendEvent: (sid, e) => appendEvent(recordCtx(sid), e),
    readEvents: (sid) => readEvents(recordCtx(sid)),
    // putBlob 은 project 스코프(vaultRoot·proj)만 쓰고 sid 는 쓰지 않는다(record/blobs.ts 실측).
    putBlob: (data) => putBlob(recordCtx(""), data),
    projectTurn: (sid, turn, phase, policy) => projectTurn(recordCtx(sid), turn, phase, policy),
    project: (sid, opts) => project(recordCtx(sid), opts),
    rebuild: (opts) => rebuild(deps.base, deps.vaultRoot, deps.proj, opts),
  };
  const recordStore: RecordStore = deps.record ?? defaultRecordStore;

  async function persist(rec: SessionRecord): Promise<void> {
    records.set(rec.sid, rec);
    await saveSession(deps.base, deps.proj, rec);
  }

  async function refreshNotes(sid: string, turn: number): Promise<void> {
    const rec = records.get(sid);
    if (!rec) return;
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
      runtimeError: null,
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
      console.error(`session-manager: TurnRunner 기동 실패(sid=${sid}): ${errMsg(err)}`);
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

  async function onTurnFailure(sid: string, reason: string): Promise<void> {
    const rt = runtimes.get(sid);
    if (rt) rt.runtimeError = reason;
    await deps.onSessionError?.(sid, reason).catch(() => {});
  }

  function activeSameCwd(): number {
    return [...records.values()].filter((r) => r.status === "active").length;
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
      const sid = newSidGen();
      const now = new Date().toISOString();
      const rec: SessionRecord = {
        v: 1,
        sid,
        engine: engineId,
        engineRef: null,
        status: "active",
        title: opts.title ?? null,
        createdAt: now,
        lastActivityAt: now,
        successorOf: null,
        engineArgs: opts.engineArgs ? opts.engineArgs.split(/\s+/).filter(Boolean) : [],
        warnings,
        bindings: [],
      };
      await persist(rec);
      return { sid, warnings, activeSameCwd: activeSameCwd() };
    },

    async clear(sid: string): Promise<{ next: string }> {
      const old = records.get(sid);
      if (!old) throw new Error(`session-manager: 세션 없음 (${sid})`);
      if (old.status === "archived")
        throw new Error(`session-manager: 이미 보존 종료된 세션은 초기화할 수 없습니다 (${sid})`);
      await api.hibernate(sid, "attach").catch(() => {});
      const now = new Date().toISOString();
      const newSidValue = newSidGen();
      const next: SessionRecord = {
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
        bindings: old.bindings.map((b) => ({ ...b, sid: newSidValue })),
      };
      old.bindings = [];
      old.status = "archived";
      await persist(old);
      await persist(next);
      return { next: newSidValue };
    },

    async remove(sid: string, opts: { purge: boolean }): Promise<void> {
      const rt = runtimes.get(sid);
      if (rt?.engineSession) {
        rt.watcher.disarm();
        await rt.engineSession.close().catch(() => {});
      }
      runtimes.delete(sid);
      records.delete(sid);
      // purge(이벤트·노트·큐 등 실제 삭제)는 명시 요청 시에만 — 여기서는 레코드 소멸까지만 담당하고
      // 파일시스템 정리는 CLI(session rm --purge)가 호출하는 별도 헬퍼가 수행한다(A-P002 신중한 삭제).
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
              rec.warnings = [...rec.warnings.filter((w) => w !== msg), msg];
              void persist(rec);
            },
          });
        } catch (err) {
          // 재개(resumeSessionId 지정) 시도가 실패하면 새 세션 폴백 없이 detached 로 확정한다
          // (FR-007·ADR-009). 신규 세션 최초 기동 실패는 상태를 건드리지 않고 그대로 전파한다.
          if (wasResume) await markDetached(sid, `resume-failed: ${errMsg(err)}`);
          throw err;
        }
        rt.engineSession = engineSession;
        rt.watcher.arm();
        engineSession.onExit((info) => {
          rt.watcher.onCrash(info);
        });
        rec.engineRef = engineSession.engineRef;
        rec.status = "active";
        rec.lastActivityAt = new Date().toISOString();
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
      if (rt.turnRunner.state() === "active") return; // 턴 처리 중 세션은 대상 아님(SC-033).
      const driver = driverFor(rec.engine);
      if (driver.caps.resume === "none") return; // 재개 불가 엔진은 내리면 되살릴 수 없다.
      if (!rt.engineSession) return;
      rt.watcher.disarm(); // 의도적 종료 — 크래시 자가 재기동 트리거 아님(ADR-031·SC-063).
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
          rec.warnings = [...rec.warnings, `resume-failed: ${reason}`];
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

    async shutdown(): Promise<void> {
      if (idleTimer !== undefined) deps.scheduler.clearInterval(idleTimer);
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
   * 엔진 비정상 종료(크래시) 감지 시 세션을 `detached` 로 확정 + 사유 통지(FR-044) —
   * `SessionWatcher`(재시도 소진·옵트아웃)가 호출한다. pending 권한은 watcher.onCrash 가 이미 deny 했다.
   */
  async function markDetached(sid: string, reason: string): Promise<void> {
    const rt = runtimes.get(sid);
    const rec = records.get(sid);
    if (!rt || !rec) return;
    rt.engineSession = null;
    rec.status = "detached";
    rec.warnings = [...rec.warnings, reason];
    await persist(rec);
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

  async function runIdleSweep(): Promise<void> {
    if (!deps.conf.idle_hibernate) return;
    const thresholdMs = deps.conf.hibernate_after_min * 60_000;
    const now = deps.clock.now();
    for (const rec of records.values()) {
      if (rec.status !== "active") continue;
      const lastActivity = new Date(rec.lastActivityAt).getTime();
      if (now - lastActivity >= thresholdMs) {
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
    if (p.backupDir === null) return; // 옵트인 비활성(NFR-009)
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

  return Object.assign(api, { load, refresh });
}
