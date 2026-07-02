/**
 * 레인 라이프사이클 수퍼바이저.
 * FR-001/021/022/ADR-010: lanes.d conf 스캔 → 레인별 기동·헬스.
 * adde up → source/injector/backend/gate 인스턴스화 + 기동.
 * adde down → 레인 프로세스 종료.
 */
import { readdir, readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseLaneConf } from "../shared/conf.js";
import { lanePaths, defaultBase, expandTilde } from "../shared/paths.js";
import { AcpBackendImpl } from "../backend/acp/client.js";
import type { AcpBackend } from "../backend/acp/client.js";
import { createInjector } from "./injector.js";
import { createTelegramSource, createMarkdownSource } from "../src-adapters/index.js";
import type { Source } from "../src-adapters/index.js";
import { gateRequestDecision } from "../gate/gate.js";
import { formatWarnNote } from "../shared/notify.js";
import {
  writeRuntime,
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
    const pkgPath = require.resolve("@zed-industries/claude-code-acp/package.json");
    const dir = pkgPath.slice(0, pkgPath.lastIndexOf("/package.json"));
    const pkg = require(pkgPath) as { bin?: string | Record<string, string> };
    const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["claude-code-acp"];
    if (binRel) return resolve(dir, binRel);
  } catch {
    // 폴백(.bin shim)으로 진행
  }
  const thisDir = fileURLToPath(new URL(".", import.meta.url));
  return resolve(thisDir, "../../../node_modules/.bin/claude-code-acp");
}

/** unknown 오류를 사람이 읽을 수 있는 문자열로 — ACP 오류는 Error 가 아닌 객체일 수 있다. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

interface LaneHandle {
  lane: string;
  /** 하트비트가 mtime 을 touch 할 runtime.json 경로. */
  paths: LanePaths;
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
      // 하트비트는 보조 신호 — touch 실패는 warn 후 흡수(레인 동작에 영향 없음).
      void touchRuntime(h.paths).catch((err: unknown) =>
        console.warn(`[supervisor] lane=${h.lane} 하트비트 touch 실패(보조): ${errMsg(err)}`),
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
    console.log(`[supervisor] ${proj}: lanes.d 에 conf 없음`);
    return { lanes: [], message: `${proj}: 레인 0개 — lanes.d 에 conf 없음` };
  }

  const adapterBin = resolveAdapterBin();
  const handles: LaneHandle[] = [];
  const results: LaneStatus[] = [];

  for (const confFile of confFiles) {
    const lane = confFile.replace(/\.conf$/, "");
    const confPath = join(lanesDir, confFile);
    const confText = await readFile(confPath, "utf8");
    const conf = parseLaneConf(confText);

    // 사용자 입력 경로의 ~ 확장 (Node 는 자동 확장 안 함).
    if (conf.cwd) conf.cwd = expandTilde(conf.cwd);
    if (conf.root) conf.root = expandTilde(conf.root);

    const paths = lanePaths(baseDir, proj, lane);

    // 중복 기동 가드 — backend 생성 전 runtime.json + pid 생존 확인.
    const existingRuntime = await readRuntime(paths);
    if (existingRuntime !== null) {
      if (isPidAlive(existingRuntime.pid)) {
        // 이미 running — 경고+스킵(FR-004/SC-005).
        process.stderr.write(
          `[adde] 레인 "${lane}" 이미 실행 중 (pid ${existingRuntime.pid})\n` +
            `  ↳ 조치: adde down ${proj} 후 재기동 또는 adde status ${proj} 확인\n`,
        );
        results.push({ lane, status: "running" });
        continue;
      } else {
        // dead 레인 — 크래시 잔존 runtime.json 정리 후 정상 기동(SC-012/FR-007).
        // 자식 pid 는 runtime.json 에 미기록(스키마 한계 GAP-004) — removeRuntime 으로 파일만 정리.
        await removeRuntime(paths).catch((err: unknown) =>
          console.warn(
            `[supervisor] lane=${lane} dead runtime.json 정리 실패(보조): ${errMsg(err)}`,
          ),
        );
      }
    }

    const channel: "telegram" | "markdown" = conf.source === "markdown" ? "markdown" : "telegram";

    // 권한 경고(perm-diff 등)를 채널로도 표면화 — source 는 아래에서 생성되므로 지연 참조.
    // 알림은 보조 신호: 전송 실패는 warn 후 흡수(레인 동작에 영향 없음).
    const channelWarn = (msg: string): void => {
      void source
        .notify(msg)
        .catch((err: unknown) =>
          console.warn(`[supervisor] lane=${lane} 채널 경고 전송 실패(보조): ${errMsg(err)}`),
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
        },
        cwd: conf.cwd,
        channel,
        channelWarn,
      });
      backend = impl;
    }

    const pendingDecisions = new Map<string, (decision: "allow" | "deny") => void>();

    const engine = conf.engine || "claude";
    let source: Source;

    // injector 를 source 보다 먼저 생성 — render 는 source 를 지연 참조(closure, turn 종료 시 호출).
    // in-process 배선(DEC-001): source.onInbound → injector.notify, injector.render → source.renderOut.
    const injector = createInjector(paths, lane, backend, (id) => source.renderOut(id));
    const onInbound = () => injector.notify();

    if (conf.source === "markdown") {
      source = createMarkdownSource({ lane, proj, engine, paths, conf, onInbound });
    } else {
      const chatId =
        conf.chat_id && !Number.isNaN(Number(conf.chat_id)) ? Number(conf.chat_id) : undefined;
      source = createTelegramSource({ lane, proj, engine, paths, chatId, onInbound });
    }

    source.onDecision((reqId, decision) => {
      const resolve = pendingDecisions.get(reqId);
      if (resolve) {
        pendingDecisions.delete(reqId);
        resolve(decision);
      }
    });

    try {
      // launch 가 레인 state 를 생성한다 — 구독·권한 핸들러 등록은 launch 이후라야 한다.
      const { sessionId } = await backend.launch(lane);

      // 엔진 세션 이벤트 → injector(응답 누적). injector 가 turn 종료에 writeOut + renderOut(B).
      backend.subscribe(lane, (e) => injector.onSessionEvent(e));

      backend.onPermissionRequest(lane, async (req) => {
        const waitForDecision = () =>
          new Promise<"allow" | "deny">((resolveFn) => {
            pendingDecisions.set(req.id, resolveFn);
          });

        const sendPermPrompt = async () => {
          await source.requestPermission(req);
        };

        try {
          return await gateRequestDecision(req, { sendPermPrompt, waitForDecision });
        } finally {
          // 모든 종결 경로(timeout·전송오류·정상결정)에서 대기자 정리 — timeout 시 영구 잔존 누수 제거(FR-3).
          // 늦게 도착한 콜백은 빈 맵에서 no-op(무해).
          pendingDecisions.delete(req.id);
        }
      });

      // 인젝터 기동은 비차단(첫 inject 가 turn 종료까지 블록될 수 있어 await 하지 않음).
      // fire-and-forget 이므로 rejection 은 unhandled 가 되지 않도록 로깅한다.
      void injector.start().catch((err: unknown) => {
        console.error(
          `[supervisor] lane=${lane} injector 기동 오류: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      source.start();

      // autopass 레인 기동 배너 — 자동 허용 모드임을 채널에 명시(A-P006 no-silent).
      if (conf.perm_tier === "autopass") {
        const denyDesc =
          conf.denylist.length > 0
            ? `denylist(${conf.denylist.join(", ")}) 도구만 채널 승인을 거칩니다`
            : "denylist 가 비어 있어 모든 권한 요청이 확인 없이 통과됩니다";
        const banner = formatWarnNote({
          situation: `이 레인은 자동 허용 모드(perm_tier=autopass)로 기동했습니다 — ${denyDesc}. 그 외 도구(파일 쓰기·Bash 실행 포함)는 자동 허용됩니다`,
          action: `확인이 필요한 도구는 lanes.d/${lane}.conf 의 denylist 에 추가하세요. 자동 허용 내역은 adde logs ${proj} ${lane} 으로 확인할 수 있습니다.`,
        });
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
        console.warn(`[supervisor] lane=${lane} runtime.json 기록 실패(보조): ${errMsg(err)}`),
      );

      console.log(`[supervisor] lane=${lane} running`);

      handles.push({
        lane,
        paths,
        // 정지 순서: 소스 먼저(신규 인바운드·turn 차단) → 백엔드 child 정리(C1) → 상태 파일 제거.
        async stop() {
          await source.stop();
          await backend.close(lane);
          await removeRuntime(paths).catch((err: unknown) =>
            console.warn(`[supervisor] lane=${lane} runtime.json 제거 실패(보조): ${errMsg(err)}`),
          );
        },
      });

      results.push({ lane, status: "running" });
    } catch (err) {
      const reason = errMsg(err);
      console.error(`[supervisor] lane=${lane} 기동 실패: ${reason}`);
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
  const messageParts: string[] = [`${proj}: ${newlyStarted}개 레인 기동`];
  if (skipped > 0) messageParts.push(`${skipped}개 이미 실행 중(스킵)`);
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
    message: `${proj}: ${results.length}개 레인 종료`,
  };
}
