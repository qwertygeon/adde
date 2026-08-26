/**
 * CLI 단독 실행(데몬 미기동)에서 SessionManager 를 1회용으로 구성하는 헬퍼 — `session
 * new/ls/show/clear/rm`·`bind *`·`project show` 등이 공유한다. 사용 후 반드시 `shutdown()` 으로
 * 유휴 타이머를 해제해 프로세스가 정상 종료되게 한다.
 */
import { readFile } from "node:fs/promises";
import { defaultBase, projectPaths } from "../shared/paths.js";
import { parseProjectConf } from "../shared/conf.js";
import type { ProjectConf } from "../shared/conf.js";
import { createSessionManager } from "../core/session-manager.js";
import type { SessionManagerWithLoad } from "../core/session-manager.js";
import { ENGINE_REGISTRY } from "../engines/index.js";

export async function loadProjectConfOrThrow(base: string, proj: string): Promise<ProjectConf> {
  const { projectConf } = projectPaths(base, proj);
  const text = await readFile(projectConf, "utf8");
  return parseProjectConf(text);
}

export async function withSessionManager<T>(
  proj: string,
  fn: (sm: SessionManagerWithLoad, conf: ProjectConf) => Promise<T>,
): Promise<T> {
  const base = defaultBase();
  const conf = await loadProjectConfOrThrow(base, proj);
  const sm = createSessionManager({
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
    // CLI 단독 실행은 엔진을 기동하지 않으므로(admit() 을 호출하지 않는 명령만 이 헬퍼를 쓴다)
    // 권한 요청이 발생하지 않는다 — 방어적으로 즉시 deny(호출되면 버그 신호).
    askPermission: async () => {
      throw new Error("cli: 데몬 미기동 상태에서 권한 요청이 발생했습니다(버그).");
    },
  });
  await sm.load();
  try {
    return await fn(sm, conf);
  } finally {
    await sm.shutdown();
  }
}
