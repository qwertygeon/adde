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
import { markdownSessionHooks } from "../core/markdown-hooks.js";

export async function loadProjectConfOrThrow(base: string, proj: string): Promise<ProjectConf> {
  const { projectConf } = projectPaths(base, proj);
  const text = await readFile(projectConf, "utf8");
  return parseProjectConf(text);
}

export async function withSessionManager<T>(
  proj: string,
  fn: (sm: SessionManagerWithLoad, conf: ProjectConf) => Promise<T>,
  baseOverride?: string,
): Promise<T> {
  const base = baseOverride ?? defaultBase();
  const conf = await loadProjectConfOrThrow(base, proj);
  // 노트 훅 3종이 필수 의존으로 승격됨(rework2 §단일 소유자) — 데몬 미기동 CLI 직접 적용 경로도
  // `supervisor.ts` 와 동일하게 markdown surface 배선을 갖춰야 한다. 이전에는 이 경로가 훅을
  // 아예 주입하지 않아(옵셔널이라 조용히 통과) CLI 단독 stop·resume·clear 가 노트 배너·스켈레톤을
  // 전혀 갱신하지 않는 잠재 결함이 있었다(필수화가 표면화한 실제 조립 공백, 이번에 같이 닫는다).
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
    ...markdownSessionHooks({ vaultRoot: conf.vault, proj, sm: () => sm }),
  });
  await sm.load();
  try {
    return await fn(sm, conf);
  } finally {
    await sm.shutdown();
  }
}
