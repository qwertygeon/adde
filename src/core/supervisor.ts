/**
 * 프로젝트 부팅 조립(L3, v2 재작성) — 현행 `assembleLane`(레인 축)을 세션 축으로 재조립한다.
 * SessionManager·Router·markdown Surface 를 배선하고 `resumeAllOnBoot()` 를 수행한다(FR-001·
 * FR-002·FR-006). 중복 기동 가드·graceful shutdown 은 현행 계약을 승계한다.
 */
import { readFile } from "node:fs/promises";
import { defaultBase, projectPaths } from "../shared/paths.js";
import { parseProjectConf } from "../shared/conf.js";
import type { ProjectConf } from "../shared/conf.js";
import { detectLegacyLayout, detectProjectsNameCollision } from "./legacy-guard.js";
import { createSessionManager } from "./session-manager.js";
import type { SessionManagerWithLoad } from "./session-manager.js";
import { createRouter } from "./router.js";
import type { RouterWithIndex } from "./router.js";
import { ENGINE_REGISTRY } from "../engines/index.js";
import { SURFACE_REGISTRY } from "../surfaces/index.js";
import type { Surface } from "../surfaces/types.js";
import { forceFinalizeApproval } from "../surfaces/markdown/index.js";
import { errMsg } from "../shared/errors.js";
import { formatWarnNote } from "../shared/notify.js";
import { tFor, t } from "../shared/i18n.js";
import { applyProjectFileMode } from "../shared/file-mode.js";

export interface SessionStatusRow {
  sid: string;
  status: "active" | "hibernated" | "detached" | "archived";
}

export interface SupervisorUpResult {
  message: string;
  sessions: SessionStatusRow[];
  /** 부팅 시점 안내(자동 허용 티어 배너 등) — 부팅 리포트에 실려 `up`/`restart` 출력에 나타난다. */
  notices: string[];
}

interface Assembly {
  conf: ProjectConf;
  sessionManager: SessionManagerWithLoad;
  router: RouterWithIndex;
  surface: Surface;
}

const assemblies = new Map<string, Assembly>();

async function loadConf(base: string, proj: string): Promise<ProjectConf> {
  const { projectConf } = projectPaths(base, proj);
  return parseProjectConf(await readFile(projectConf, "utf8"));
}

/**
 * 자동 허용 티어 기동 배너 — 어떤 거부 목록 위에서 자동 승인이 도는지 기동 시점에 알린다(no-silent).
 * 이 신호가 없으면 권한 정책이 의도대로 걸렸는지 확인할 능동 지점이 없고 수동 조회만 남는다.
 */
function autopassBanner(conf: ProjectConf, proj: string): string | null {
  if (conf.perm_tier !== "autopass") return null;
  const tl = tFor(conf.lang);
  const denyDesc =
    conf.denylist.length > 0
      ? tl("supervisor.autopassDenySome", { tools: conf.denylist.join(", ") })
      : tl("supervisor.autopassDenyEmpty");
  return formatWarnNote(
    {
      situation: tl("supervisor.autopassBanner.situation", { denyDesc }),
      action: tl("supervisor.autopassBanner.action", { proj }),
    },
    tl,
  );
}

/** 프로젝트 부팅 — 이미 조립되어 있으면(중복 기동) 그대로 반환(멱등). */
export async function supervisorUp(proj: string): Promise<SupervisorUpResult> {
  if (assemblies.has(proj)) {
    const a = assemblies.get(proj)!;
    return {
      message: `이미 기동 중입니다: ${proj}`,
      sessions: a.sessionManager.list().map((r) => ({ sid: r.sid, status: r.status })),
      notices: [],
    };
  }

  const base = defaultBase();
  const collision = await detectProjectsNameCollision(base);
  if (collision) throw new Error(collision);
  const legacy = await detectLegacyLayout(base);
  if (legacy.length > 0) {
    console.warn(`v0.2.x 데이터 감지(무접촉 보존): ${legacy.map((l) => l.path).join(", ")}`);
  }

  const conf = await loadConf(base, proj);

  // 기동 시점 권한 재적용 — 생성 이후 만들어진 디렉터리나 다른 머신에서 복제된 설정도 선언대로
  // 잠근다. 실패는 기동을 막지 않되(가용성) 조용히 넘기지 않는다 — 부팅 안내로 사용자에게 올린다.
  const notices: string[] = [];
  await applyProjectFileMode(base, proj, conf.file_mode).catch((err: unknown) => {
    const line = t("log.supervisor.securePermsFail", { proj, error: errMsg(err) });
    console.warn(line);
    notices.push(line);
  });

  const sessionManager = createSessionManager({
    base,
    proj,
    vaultRoot: conf.vault,
    conf,
    registry: ENGINE_REGISTRY,
    clock: { now: () => Date.now() },
    scheduler: {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
    },
    askPermission: async (sid, req) => {
      const binding = sessionManager.get(sid)?.bindings.find((b) => b.surface === "markdown");
      if (!binding) throw new Error(`supervisor: sid=${sid} 의 markdown 바인딩이 없습니다.`);
      await surface.askPermission(binding, {
        reqId: req.reqId,
        sid,
        tool: req.tool,
        input: req.input,
      });
    },
    onDecisionRecorded: async (sid, reqId) => {
      const binding = sessionManager.get(sid)?.bindings.find((b) => b.surface === "markdown");
      if (binding) await surface.onDecisionRecorded(binding, reqId);
    },
    onTurnAssigned: async (sid, envelopeId, turnRef) => {
      const binding = sessionManager.get(sid)?.bindings.find((b) => b.surface === "markdown");
      if (binding) await surface.onTurnAssigned(binding, { envelopeId, turnRef });
    },
    onTurnDelivered: async (sid, msg) => {
      const binding = sessionManager.get(sid)?.bindings.find((b) => b.surface === "markdown");
      if (binding) await surface.deliver(binding, msg);
    },
    onSessionError: async (sid, reason) => {
      console.error(`session ${sid} 오류: ${reason}`);
    },
    onStateChange: async (sid, status, reason) => {
      console.warn(`session ${sid} → ${status} (${reason})`);
    },
  });
  await sessionManager.load();

  const router = createRouter({ base, proj, sessionManager });

  const markdownDescriptor = SURFACE_REGISTRY["markdown"];
  if (!markdownDescriptor?.factory) throw new Error("supervisor: markdown surface 미등록");
  const surface = markdownDescriptor.factory({
    base,
    vaultRoot: conf.vault,
    proj,
    sessionManager,
    router,
    conf,
  });
  surface.onDecision((reqId, decision) => {
    // reqId 로부터 sid 를 알 수 없으므로(승인 파일이 세션별 디렉터리에 있어 Surface 가 sid 를 안다) —
    // Surface 구현이 onDecisionRecorded 호출 시 sid 를 함께 넘기도록 세션별 파일 스캔 결과를 활용한다.
    // 단순화: 전 세션을 순회해 해당 reqId 의 pending 을 가진 세션에 전달한다(세션 수가 적어 비용 낮음).
    for (const rec of sessionManager.list()) {
      sessionManager.resolvePermissionDecision(rec.sid, reqId, decision);
    }
  });
  await surface.start(router);

  const bootReport = await sessionManager.resumeAllOnBoot();
  assemblies.set(proj, { conf, sessionManager, router, surface });

  const sessions = sessionManager.list().map((r) => ({ sid: r.sid, status: r.status }));
  const message = `부팅 완료: 재개 ${bootReport.resumed.length}개, detached ${bootReport.detached.length}개, 생략 ${bootReport.skipped.length}개.`;
  const banner = autopassBanner(conf, proj);
  if (banner) notices.push(banner);
  return { message, sessions, notices };
}

export async function supervisorDown(proj: string): Promise<{ message: string }> {
  const a = assemblies.get(proj);
  if (!a) return { message: `기동 상태가 아닙니다: ${proj}` };
  await a.surface
    .stop()
    .catch((err: unknown) => console.error(`surface stop 실패: ${errMsg(err)}`));
  await a.sessionManager
    .shutdown()
    .catch((err: unknown) => console.error(`session-manager shutdown 실패: ${errMsg(err)}`));
  assemblies.delete(proj);
  return { message: `종료 완료: ${proj}` };
}

/** gate 배선부(session-manager)가 타임아웃으로 deny 를 확정한 뒤 승인 파일도 종단 표기하도록
 * 호출하는 보조(ADR-016) — 현재 배선에서는 gateRequestDecision 자체가 fail-closed 를 보장하고,
 * 파일 종단은 onDecisionRecorded 경로로 수렴하므로 본 함수는 예외적 강제 정리에만 쓰인다. */
export async function forceFinalizePending(
  proj: string,
  sid: string,
  reqId: string,
  reason: string,
): Promise<void> {
  const a = assemblies.get(proj);
  if (!a) return;
  await forceFinalizeApproval(a.conf.vault, proj, sid, reqId, reason);
}
