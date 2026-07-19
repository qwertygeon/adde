/**
 * 레인별 경로 동적 구성. 레인 ID 하드코딩 금지 — 전부 파라미터.
 * 레인 A 가 레인 B 의 경로에 접근하지 않도록 파라미터 기반 격리.
 */
import { join, relative, isAbsolute } from "node:path";
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
  /** out-상태 구조화 레코드(013-out-state-ledger) — id → {state, sidecar} 단일 파일. */
  outLedgerFile: string;
  stateDir: string;
  envFile: string;
  sessionIdFile: string;
  /** 세션 장부(sessions.json) — /resume 목록·마지막 대화 시각의 SSOT(ADDE 자체 관리). */
  sessionsFile: string;
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

/** proj/lane 세그먼트 안전성 여부(throw 없이). 디렉터리 열거 등에서 비안전 이름을 걸러낼 때 사용. */
export function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT_RE.test(value);
}

// --- 경로 포함/중첩 판정 ------------------------------------------------------
// markdown 어댑터의 기동 fail-closed 가드와 lane-config 의 생성 시 사전 경고가
// 반드시 같은 규칙으로 판정해야 하므로(어긋나면 경고 없이 기동만 거부되는 갈림),
// 판정 로직의 SSOT 를 여기 둔다.

/** child 가 parent 와 같거나 그 내부인지(대소문자 정규화 없음 — 필요 시 normCasePath 로 감싼다). */
export function isPathInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 대소문자 정규화 — macOS 기본 FS 는 대소문자 무시라 Shared/shared 가 같은 물리 디렉터리.
 * darwin 은 소문자 정규화 후 비교한다(대소문자 구분 볼륨에선 과차단이나 fail-closed 방향이라 수용).
 */
export function normCasePath(p: string): string {
  return process.platform === "darwin" ? p.toLowerCase() : p;
}

/** 두 경로가 같거나 포함 관계인지(대소문자 정규화 적용). */
export function pathsOverlap(a: string, b: string): boolean {
  const na = normCasePath(a);
  const nb = normCasePath(b);
  return isPathInside(na, nb) || isPathInside(nb, na);
}

/** `<base>/<proj>/proj.conf` — 프로젝트 수준 설정(auto_restart 등). 데몬은 proj 당 1개라 레인 하위가 아닌 proj 루트. */
export function projConfPath(base: string, proj: string): string {
  assertSafeSegment("proj", proj);
  return join(base, proj, "proj.conf");
}

/** `<base>/<proj>/daemon-boots.json` — 크래시루프 짧은-수명 연속 카운터(데몬 단일 writer). */
export function daemonBootsPath(base: string, proj: string): string {
  assertSafeSegment("proj", proj);
  return join(base, proj, "daemon-boots.json");
}

/** `<base>/<proj>/daemon-halt.json` — 크래시루프 자가 정지 기록(원인·시점). */
export function daemonHaltPath(base: string, proj: string): string {
  assertSafeSegment("proj", proj);
  return join(base, proj, "daemon-halt.json");
}

/** `<base>/<proj>/daemon-boot-report.json` — 최신 부팅 리포트(데몬 단일 writer, CLI reader). */
export function daemonBootReportPath(base: string, proj: string): string {
  assertSafeSegment("proj", proj);
  return join(base, proj, "daemon-boot-report.json");
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
    outLedgerFile: join(root, "out", lane, "ledger.json"),
    stateDir,
    envFile: join(stateDir, ".env"),
    sessionIdFile: join(stateDir, "session.id"),
    sessionsFile: join(stateDir, "sessions.json"),
    transcriptLog: join(stateDir, "transcript.log"),
    engineLog: join(stateDir, "engine.log"),
    runtimeJson: join(stateDir, "runtime.json"),
    confFile: join(root, "lanes.d", `${lane}.conf`),
  };
}

export { defaultBase };
