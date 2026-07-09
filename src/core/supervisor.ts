/**
 * 레인 라이프사이클 수퍼바이저.
 * lanes.d conf 스캔 → 레인별 기동·헬스.
 * adde up → source/injector/backend/gate 인스턴스화 + 기동.
 * adde down → 레인 프로세스 종료.
 */
import { readdir, readFile, mkdir } from "node:fs/promises";
import { errMsg } from "../shared/errors.js";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseLaneConf, detectLegacyAdapterKeys } from "../shared/conf.js";
import { lanePaths, defaultBase, expandTilde } from "../shared/paths.js";
import { secureLaneDirs } from "../shared/fs-atomic.js";
import { resolveFileMode } from "./lane-config.js";
import { AcpBackendImpl } from "../backend/acp/client.js";
import type { AcpBackend } from "../backend/acp/client.js";
import { createInjector } from "./injector.js";
import { createLaneWatcher } from "./lane-watcher.js";
import { recordSession } from "./session-ledger.js";
import { SOURCE_REGISTRY } from "../src-adapters/index.js";
import type { Source } from "../src-adapters/index.js";
import { gateRequestDecision } from "../gate/gate.js";
import { formatWarnNote, formatException } from "../shared/notify.js";
import { maskSecrets } from "../shared/mask.js";
import { t, tFor } from "../shared/i18n.js";
import {
  writeRuntime,
  writeErrorRuntime,
  removeRuntime,
  touchRuntime,
  readRuntime,
  isPidAlive,
  HEARTBEAT_INTERVAL_MS,
} from "./runtime-state.js";
import type { LanePaths } from "../shared/paths.js";

/** 런타임 ACP 어댑터 바이너리 경로. package.json 의 bin 항목을 SoT 로 해석. */
export function resolveAdapterBin(): string {
  const require = createRequire(import.meta.url);
  try {
    const pkgPath = require.resolve("@agentclientprotocol/claude-agent-acp/package.json");
    const dir = pkgPath.slice(0, pkgPath.lastIndexOf("/package.json"));
    const pkg = require(pkgPath) as { bin?: string | Record<string, string> };
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["claude-agent-acp"];
    if (binRel) return resolve(dir, binRel);
  } catch {
    // 폴백(.bin shim)으로 진행
  }
  const thisDir = fileURLToPath(new URL(".", import.meta.url));
  return resolve(thisDir, "../../../node_modules/.bin/claude-agent-acp");
}

interface LaneHandle {
  lane: string;
  /** 하트비트가 mtime 을 touch 할 runtime.json 경로. */
  paths: LanePaths;
  /**
   * 레인 헬스(watcher 소유) — false 면 크래시-확정/재시도 구간. 미설정 시 항상 touch(기존 동작).
   */
  isHealthy?(): boolean;
  stop(): Promise<void>;
}

/** 레인 기동 상태 결과. */
export interface LaneStatus {
  lane: string;
  status: "running" | "error" | "stopped";
  /** status==="error" 일 때 실패 사유(사용자 안내·doctor 유도용). */
  error?: string;
}

/** supervisorUp 반환값. */
export interface SupervisorUpResult {
  lanes: LaneStatus[];
  message: string;
}

/** supervisorDown 반환값. */
export interface SupervisorDownResult {
  lanes: LaneStatus[];
  message: string;
}

/**
 * ACP 백엔드 팩토리 — 테스트에서 주입 가능하도록 의존을 분리.
 * (lane: string, adapterBin: string) → AcpBackend.
 * 기본값: new AcpBackendImpl(adapterBin).
 */
export type AcpFactory = (lane: string, adapterBin: string) => AcpBackend;

export interface SupervisorUpOptions {
  base?: string;
  acpFactory?: AcpFactory;
}

export interface SupervisorDownOptions {
  base?: string;
}

const activeLanes = new Map<string, LaneHandle[]>();
/** proj 별 하트비트 타이머 — up 이 등록, down 이 정리. */
const heartbeats = new Map<string, NodeJS.Timeout>();

/**
 * proj 의 하트비트 타이머를 (재)설정한다. 기존 타이머는 먼저 정리(re-up 대비).
 * 각 틱에 running 레인의 runtime.json mtime 만 touch(메타데이터 쓰기). `.unref()` 로
 * 타이머 단독으로 프로세스를 살려두지 않는다(상주는 호출부 never-resolve promise 담당).
 */
function armHeartbeat(proj: string, handles: LaneHandle[]): void {
  const existing = heartbeats.get(proj);
  if (existing) clearInterval(existing);
  if (handles.length === 0) {
    heartbeats.delete(proj);
    return;
  }
  const timer = setInterval(() => {
    for (const h of handles) {
      // 크래시-확정/재시도 구간(unhealthy) 은 touch 스킵 — mtime 이 stale 로 넘어가 "running" 오표기를
      // 막는다. isHealthy 미설정 handle 은 항상 touch(기존 동작 보존).
      if (h.isHealthy && !h.isHealthy()) continue;
      // 하트비트는 보조 신호 — touch 실패는 warn 후 흡수(레인 동작에 영향 없음).
      void touchRuntime(h.paths).catch((err: unknown) =>
        console.warn(t("log.supervisor.heartbeatFail", { lane: h.lane, error: errMsg(err) })),
      );
    }
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  heartbeats.set(proj, timer);
}

/** proj 하트비트 타이머 정리(down·셧다운). */
function disarmHeartbeat(proj: string): void {
  const timer = heartbeats.get(proj);
  if (timer) clearInterval(timer);
  heartbeats.delete(proj);
}

/**
 * `adde up <proj>` — lanes.d 의 conf 파일 스캔 → 레인별 기동.
 */
export async function supervisorUp(
  proj: string,
  opts?: SupervisorUpOptions,
): Promise<SupervisorUpResult> {
  const baseDir = opts?.base ?? defaultBase();
  const projDir = join(baseDir, proj);
  const lanesDir = join(projDir, "lanes.d");

  await mkdir(lanesDir, { recursive: true });

  let confFiles: string[];
  try {
    confFiles = (await readdir(lanesDir)).filter((f) => f.endsWith(".conf"));
  } catch {
    confFiles = [];
  }

  if (confFiles.length === 0) {
    console.log(t("log.supervisor.noConf", { proj }));
    return { lanes: [], message: t("supervisor.noLanesMsg", { proj }) };
  }

  const adapterBin = resolveAdapterBin();
  const handles: LaneHandle[] = [];
  const results: LaneStatus[] = [];

  for (const confFile of confFiles) {
    const lane = confFile.replace(/\.conf$/, "");
    const confPath = join(lanesDir, confFile);
    const confText = await readFile(confPath, "utf8");
    const conf = parseLaneConf(confText);

    // 구 평면 어댑터 키(root=·chat_id= 등) 감지 — 포맷이 `<source>.<key>` 로 변경됨. 파서가 구 키를
    // 무시하므로(값 미반영) 경고로 가시화한다(markdown 레인은 root 누락으로 error 가 되지만 원인을 명시).
    const legacyKeys = detectLegacyAdapterKeys(confText);
    if (legacyKeys.length > 0) {
      console.warn(t("log.supervisor.legacyKeys", { lane, keys: legacyKeys.join(", ") }));
    }

    // 사용자 입력 경로의 ~ 확장 (Node 는 자동 확장 안 함).
    if (conf.cwd) conf.cwd = expandTilde(conf.cwd);
    if (conf.markdown?.root) conf.markdown.root = expandTilde(conf.markdown.root);

    const paths = lanePaths(baseDir, proj, lane);

    // 상태·출력·큐 디렉터리 권한 잠금(private=0700 / shared=no-op). chmod 실패는 보조
    // 하드닝 신호 — warn 후 흡수(기동 자체는 진행, 권한 미적용은 로그로 가시화).
    await secureLaneDirs(
      [paths.stateDir, paths.outDir, paths.queueDir, paths.processingDir, paths.lanesDir],
      resolveFileMode(conf.file_mode),
    ).catch((err: unknown) =>
      console.warn(t("log.supervisor.securePermsFail", { lane, error: errMsg(err) })),
    );

    // 중복 기동 가드 — backend 생성 전 runtime.json + pid 생존 확인.
    // status:"error" 레코드는 이전 기동 실패 잔존(down 이 정리하지 않음) — pid 는 죽은 이전 데몬이거나
    // 재사용됐을 수 있으므로 신뢰하지 않고 항상 정리 후 재기동한다(pid 재사용 오탐 방지).
    const existingRuntime = await readRuntime(paths);
    if (existingRuntime !== null) {
      if (existingRuntime.status !== "error" && isPidAlive(existingRuntime.pid)) {
        // 이미 running — 경고+스킵.
        process.stderr.write(
          t("supervisor.alreadyRunning", { lane, pid: existingRuntime.pid, proj }) + "\n",
        );
        results.push({ lane, status: "running" });
        continue;
      } else {
        // dead 레인 또는 이전 error 잔존 — runtime.json 정리 후 정상 기동.
        // 자식 pid 는 runtime.json 에 미기록(스키마 한계) — removeRuntime 으로 파일만 정리.
        await removeRuntime(paths).catch((err: unknown) =>
          console.warn(t("log.supervisor.deadCleanupFail", { lane, error: errMsg(err) })),
        );
      }
    }

    // 채널 라벨 = 소스 id 그대로(권한 요청 표기용). 미지 소스를 telegram 으로 오분류하지 않는다.
    const channel: string = conf.source;

    // 권한 경고(perm-diff 등)를 채널로도 표면화 — source 는 아래에서 생성되므로 지연 참조.
    // 알림은 보조 신호: 전송 실패는 warn 후 흡수(레인 동작에 영향 없음).
    const channelWarn = (msg: string): void => {
      void source
        .notify(msg)
        .catch((err: unknown) =>
          console.warn(t("log.supervisor.channelWarnFail", { lane, error: errMsg(err) })),
        );
    };

    let backend: AcpBackend;
    if (opts?.acpFactory) {
      backend = opts.acpFactory(lane, adapterBin);
    } else {
      const impl = new AcpBackendImpl(adapterBin);
      impl.configureLane(lane, {
        paths,
        addePolicy: {
          perm_tier: conf.perm_tier,
          allowlist: conf.allowlist,
          denylist: conf.denylist,
          hard_deny: conf.hard_deny,
        },
        cwd: conf.cwd,
        channel,
        channelWarn,
        lang: conf.lang,
      });
      backend = impl;
    }

    const pendingDecisions = new Map<string, (decision: "allow" | "deny") => void>();

    const engine = conf.engine || "claude";
    let source: Source;

    // 자가 회복(self-recovery) watcher — 크래시 시 유계 백오프 재기동(ON) 또는 즉시 error 확정(OFF).
    // deps 는 전부 클로저 — arm()·backend.onExit 배선은 launch 성공 후(아래)에 이뤄진다.
    const watcher = createLaneWatcher({
      lane,
      autoRelaunch: conf.auto_relaunch,
      resumeSession: (sid) =>
        backend.resumeSession
          ? backend.resumeSession(lane, sid)
          : Promise.reject(new Error(`[lane-watcher] lane "${lane}" backend has no resumeSession`)),
      isAlive: () => backend.isAlive?.(lane) ?? false,
      lastSessionId: async () => {
        try {
          return (await readFile(paths.sessionIdFile, "utf8")).trim();
        } catch {
          return "";
        }
      },
      denyPending: () => {
        for (const resolveFn of [...pendingDecisions.values()]) resolveFn("deny");
      },
      // LaneHandle.isHealthy 는 watcher.isHealthy() 를 직접 참조(아래 handles.push) — 별도 상태 보관 불요.
      setHealth: () => {},
      writeError: () =>
        writeErrorRuntime(paths, {
          lane,
          source: conf.source || channel,
          backend: conf.backend || "acp",
          engine,
          error: "engine crashed; self-recovery did not keep the lane running",
        }).catch((err: unknown) =>
          console.warn(t("log.supervisor.runtimeWriteFail", { lane, error: errMsg(err) })),
        ),
      onSessionUpdated: async (sid) => {
        await writeRuntime(paths, {
          v: 1,
          pid: process.pid,
          lane,
          sessionId: sid,
          startedAt: new Date().toISOString(),
          source: conf.source || channel,
          backend: conf.backend || "acp",
          engine,
        }).catch((err: unknown) =>
          console.warn(t("log.supervisor.runtimeWriteFail", { lane, error: errMsg(err) })),
        );
      },
      notify: (kind, ctx) => {
        const tl = tFor(conf.lang);
        if (kind === "attempt") {
          channelWarn(tl("supervisor.selfRecovery.attempt", { lane }));
        } else if (kind === "disabled") {
          channelWarn(tl("supervisor.selfRecovery.disabled", { lane, proj }));
        } else {
          const attempts = typeof ctx?.["attempts"] === "number" ? ctx["attempts"] : 0;
          channelWarn(tl("supervisor.selfRecovery.abandoned", { lane, attempts, proj }));
        }
      },
    });

    // injector 를 source 보다 먼저 생성 — render 는 source 를 지연 참조(closure, turn 종료 시 호출).
    // in-process 배선: source.onInbound → injector.notify, injector.render → source.renderOut.
    // 주입 실패도 채널로 표면화(onFail → source.notify) — 채널 언어(레인 로케일)로 렌더.
    const laneT = tFor(conf.lang);
    const injector = createInjector(
      paths,
      lane,
      backend,
      (id, hint) => source.renderOut(id, hint),
      (id, detail) =>
        // 채널 egress 는 마스킹 일관 적용 — 엔진 예외 메시지에 시크릿이 섞일 수 있다
        // (.failed/콘솔 등 로컬 경로는 기존대로 원문 유지).
        source.notify(
          formatException(
            {
              situation: laneT("injector.failNote.situation", { id, detail: maskSecrets(detail) }),
              action: laneT("injector.failNote.action"),
            },
            laneT,
          ),
        ),
      laneT,
    );
    const onInbound = () => injector.notify();

    // backend.launch 이후 실패(예: source.start() reject — telegram getMe probe 실패)가 stop 핸들
    // 등록(정상 경로) 전에 발생하면, 이미 spawn 된 엔진 child·armed watcher 가 정리되지 않아 고아로 남는다.
    // 실패 경로에서 명시 정리하기 위해 launch 여부를 추적한다.
    let launched = false;
    // 실패 정리용 — factory 로 생성된 소스 핸들(catch 에서 stop). `source`(let, 확정할당)는 catch
    // 에서 미할당 가능성 때문에 직접 참조 불가 → 별도 nullable 핸들로 추적.
    let createdSource: Source | undefined;

    try {
      // 소스 생성을 try 안에서 — 팩토리가 오구성(markdown root/inbox 누락 등)에 던지면 이 레인만
      // status:"error" 로 격리하고 나머지 레인·up 은 계속한다(전체 크래시 방지).
      // 미등록 소스도 조용히 폴백하지 않고 여기서 던져 fail-closed 로 격리한다(telegram 오분류 없음).
      // 어댑터별 설정(telegram 인증셋 등)은 팩토리가 conf 에서 self-resolve 한다.
      const descriptor = SOURCE_REGISTRY[conf.source];
      if (!descriptor) {
        throw new Error(t("supervisor.source.unknown", { source: conf.source }));
      }
      source = descriptor.factory({ lane, proj, engine, paths, conf, onInbound });
      createdSource = source;

      source.onDecision((reqId, decision) => {
        const resolve = pendingDecisions.get(reqId);
        if (resolve) {
          pendingDecisions.delete(reqId);
          resolve(decision);
        }
      });

      // launch 가 레인 state 를 생성한다 — 구독·권한 핸들러 등록은 launch 이후라야 한다.
      const { sessionId } = await backend.launch(lane);
      launched = true;

      // 세션 장부 기록(보조 — /resume 목록·마지막 대화 시각). 실패는 로그 후 흡수.
      await recordSession(paths, sessionId).catch((err: unknown) =>
        console.warn(t("log.supervisor.ledgerFail", { lane, error: errMsg(err) })),
      );

      // 엔진 세션 이벤트 → injector(응답 누적). injector 가 turn 종료에 writeOut + renderOut(B).
      backend.subscribe(lane, (e) => injector.onSessionEvent(e));

      backend.onPermissionRequest(lane, async (req) => {
        // pendingDecisions 등록을 sendPermPrompt(비동기 채널 전송) 이전에 동기적으로 선행한다 —
        // 크래시가 전송 중(아직 waitForDecision 미호출) 구간에 발생해도 denyPending 이 이 요청을
        // 찾아 deny 종결할 수 있게 한다(그 반대 순서면 전송-대기 사이 창에서 크래시가 놓친다).
        let resolveDecision!: (decision: "allow" | "deny") => void;
        const decisionPromise = new Promise<"allow" | "deny">((resolveFn) => {
          resolveDecision = resolveFn;
        });
        pendingDecisions.set(req.id, resolveDecision);
        const waitForDecision = () => decisionPromise;

        const sendPermPrompt = async () => {
          await source.requestPermission(req);
        };

        try {
          return await gateRequestDecision(req, {
            sendPermPrompt,
            waitForDecision,
            // 옵트인 conf 재정의(초→ms). 미지정 시 게이트 기본(600초) 사용.
            ...(conf.gate_timeout_sec !== undefined
              ? { timeoutMs: conf.gate_timeout_sec * 1000 }
              : {}),
          });
        } finally {
          // 모든 종결 경로(timeout·전송오류·정상결정)에서 대기자 정리 — timeout 시 영구 잔존 누수 제거.
          // 늦게 도착한 콜백은 빈 맵에서 no-op(무해).
          pendingDecisions.delete(req.id);
        }
      });

      // 자가 회복 watcher 배선 — onExit 등록은 ON/OFF 공통(크래시 감지는 항상 수행).
      // arm() 은 ON 에서만(OFF 는 재기동 트리거 자체를 비활성 — 감지 후 즉시 error 확정).
      if (conf.auto_relaunch) watcher.arm();
      backend.onExit?.(lane, (_l, info) => watcher.onCrash(info));

      // 인젝터 기동은 비차단(첫 inject 가 turn 종료까지 블록될 수 있어 await 하지 않음).
      // fire-and-forget 이므로 rejection 은 unhandled 가 되지 않도록 로깅한다.
      void injector.start().catch((err: unknown) => {
        console.error(
          t("log.supervisor.injectorStartFail", {
            lane,
            error: errMsg(err),
          }),
        );
      });
      await source.start();

      // autopass 레인 기동 배너 — 자동 허용 모드임을 채널에 명시(no-silent).
      if (conf.perm_tier === "autopass") {
        const tl = tFor(conf.lang);
        const denyDesc =
          conf.denylist.length > 0
            ? tl("supervisor.autopassDenySome", { tools: conf.denylist.join(", ") })
            : tl("supervisor.autopassDenyEmpty");
        const banner = formatWarnNote(
          {
            situation: tl("supervisor.autopassBanner.situation", { denyDesc }),
            action: tl("supervisor.autopassBanner.action", { lane, proj }),
          },
          tl,
        );
        console.warn(`[supervisor] lane=${lane} ${banner}`);
        channelWarn(banner);
      }

      // 라이브니스 상태 파일 — status 가 교차 프로세스로 읽는다. 기동 성공 후 기록.
      // 기록 실패는 보조(가시성 저하일 뿐 기동 자체는 성공) → warn 후 흡수.
      await writeRuntime(paths, {
        v: 1,
        pid: process.pid,
        lane,
        sessionId,
        startedAt: new Date().toISOString(),
        source: conf.source || channel,
        backend: conf.backend || "acp",
        engine,
      }).catch((err: unknown) =>
        console.warn(t("log.supervisor.runtimeWriteFail", { lane, error: errMsg(err) })),
      );

      console.log(`[supervisor] lane=${lane} running`);

      handles.push({
        lane,
        paths,
        isHealthy: () => watcher.isHealthy(),
        // 정지 순서: watcher disarm(잔존 백오프 타이머 정리) → 소스(신규 인바운드·turn 차단) →
        // 백엔드 child 정리 → 상태 파일 제거.
        async stop() {
          watcher.disarm();
          await source.stop();
          await backend.close(lane);
          await removeRuntime(paths).catch((err: unknown) =>
            console.warn(t("log.supervisor.runtimeRemoveFail", { lane, error: errMsg(err) })),
          );
        },
      });

      results.push({ lane, status: "running" });
    } catch (err) {
      const reason = errMsg(err);
      console.error(t("log.supervisor.laneStartFail", { lane, reason }));
      // 실패 경로 정리(고아 방지): stop 핸들이 아직 등록되지 않았으므로 여기서 직접 정리한다.
      // 정상 stop 핸들과 동일 순서(watcher disarm → source stop → backend close)로, 생성/기동된
      // 자원을 남기지 않는다 — 안 하면 기동 실패한 레인의 소스 자원·ACP 엔진 자식이 데몬 수명 동안
      // 고아로 남는다(예: telegram 잘못된 토큰 → probe 실패). 각 정리 실패는 보조라 흡수(로그)한다.
      watcher.disarm();
      if (createdSource) {
        await createdSource
          .stop()
          .catch((e: unknown) =>
            console.warn(t("log.supervisor.laneCleanupFail", { lane, error: errMsg(e) })),
          );
      }
      if (launched) {
        await backend.close(lane).catch((e: unknown) =>
          console.warn(t("log.supervisor.laneCleanupFail", { lane, error: errMsg(e) })),
        );
      }
      // 실패 상태를 runtime.json 에 남겨 교차 프로세스(adde up·status)가 볼 수 있게 한다 —
      // 안 남기면 파일 부재라 status 가 stopped(미기동)와 구분 못 한다. 기록 실패는 흡수(보조).
      await writeErrorRuntime(paths, {
        lane,
        source: conf.source || channel,
        backend: conf.backend || "acp",
        engine,
        error: maskSecrets(reason),
      }).catch((e: unknown) =>
        console.warn(t("log.supervisor.runtimeWriteFail", { lane, error: errMsg(e) })),
      );
      results.push({ lane, status: "error", error: reason });
    }
  }

  const existing = activeLanes.get(proj) ?? [];
  const merged = [...existing, ...handles];
  activeLanes.set(proj, merged);
  // 하트비트는 기동된 레인이 있을 때만(merged 전체 대상 — re-up 시 기존+신규 함께 touch).
  armHeartbeat(proj, merged);

  const runningCount = results.filter((r) => r.status === "running").length;
  const newlyStarted = handles.length;
  const skipped = runningCount - newlyStarted;
  const messageParts: string[] = [t("supervisor.upStarted", { proj, count: newlyStarted })];
  if (skipped > 0) messageParts.push(t("supervisor.upSkipped", { count: skipped }));
  return {
    lanes: results,
    message: messageParts.join(", "),
  };
}

/**
 * `adde down <proj>` — 프로젝트의 모든 레인 종료.
 */
export async function supervisorDown(
  proj: string,
  _opts?: SupervisorDownOptions,
): Promise<SupervisorDownResult> {
  const handles = activeLanes.get(proj) ?? [];
  const results: LaneStatus[] = [];

  // 하트비트 먼저 정지 — 종료 중 runtime.json touch/제거 레이스 방지.
  disarmHeartbeat(proj);

  for (const handle of handles) {
    await handle.stop();
    console.log(`[supervisor] lane=${handle.lane} stopped`);
    results.push({ lane: handle.lane, status: "stopped" });
  }
  activeLanes.delete(proj);

  return {
    lanes: results,
    message: t("supervisor.downStopped", { proj, count: results.length }),
  };
}
