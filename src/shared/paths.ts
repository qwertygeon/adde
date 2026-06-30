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
  /** 엔진 서브프로세스 stderr 캡처 파일(append). ACP stdout 은 프로토콜 채널이라 대상 아님. */
  engineLog: string;
  /** up 프로세스가 기동 시 기록하는 라이브니스 상태 파일(pid 등). 별도 status 프로세스가 교차 읽기. */
  runtimeJson: string;
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

/** proj/lane 식별자 허용 문자셋 — 경로 세그먼트로 안전(`..`·`/`·구분자 차단). lane-config 의 NAME_RE 와 동일 규약. */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * proj/lane 이 경로 세그먼트로 안전한지 검증 — 위반 시 throw.
 * lanePaths 가 경로 구성의 SSOT 이므로 여기서 막으면 모든 호출부(진단·수퍼바이저 등)가 일괄 보호된다(디렉터리 탈출·레인 격리 위반 차단).
 */
export function assertSafeSegment(kind: "proj" | "lane", value: string): void {
  if (!SAFE_SEGMENT_RE.test(value)) {
    throw new Error(`잘못된 ${kind} 이름 "${value}" — 영숫자·_·- 만 허용됩니다(경로 탈출 차단).`);
  }
}

export function lanePaths(base: string, proj: string, lane: string): LanePaths {
  assertSafeSegment("proj", proj);
  assertSafeSegment("lane", lane);
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
    engineLog: join(stateDir, "engine.log"),
    runtimeJson: join(stateDir, "runtime.json"),
    confFile: join(root, "lanes.d", `${lane}.conf`),
  };
}

export { defaultBase };
