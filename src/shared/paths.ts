/**
 * 레인별 경로 동적 구성. 레인 ID 하드코딩 금지 — 전부 파라미터.
 * NFR-004/ADR-009: 레인 A 가 레인 B 의 경로에 접근하지 않도록 파라미터 기반 격리.
 */
import { join } from "node:path";
import { homedir } from "node:os";

/** 기본 base 경로. 테스트 환경 override 용으로 분리 주입 가능. */
function defaultBase(): string {
  const override = process.env["ADDE_HOME"];
  if (override) return override;
  return join(homedir(), ".config", "adde");
}

export interface LanePaths {
  lanesDir: string;
  queueDir: string;
  processingDir: string;
  outDir: string;
  stateDir: string;
  envFile: string;
  sessionIdFile: string;
  transcriptLog: string;
  confFile: string;
}

/**
 * 선행 `~`/`~/` 를 홈 디렉터리로 확장. (Node 는 셸과 달리 ~ 를 자동 확장하지 않음)
 * conf 의 cwd/root 같은 사용자 입력 경로에 적용한다. ~user 형태는 미지원.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function lanePaths(base: string, proj: string, lane: string): LanePaths {
  const root = join(base, proj);
  const stateDir = join(root, "state", lane);
  return {
    lanesDir: join(root, "lanes.d"),
    queueDir: join(root, "queue", lane),
    processingDir: join(root, "processing", lane),
    outDir: join(root, "out", lane),
    stateDir,
    envFile: join(stateDir, ".env"),
    sessionIdFile: join(stateDir, "session.id"),
    transcriptLog: join(stateDir, "transcript.log"),
    confFile: join(root, "lanes.d", `${lane}.conf`),
  };
}

export { defaultBase };
