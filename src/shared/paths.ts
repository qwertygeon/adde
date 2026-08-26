/**
 * 프로젝트·세션 경로 동적 구성(v2 — 레인축 폐기). 식별자 하드코딩 금지 — 전부 파라미터.
 * 세션 A 가 세션 B 의 경로에 접근하지 않도록 파라미터 기반 격리(NFR-001).
 *
 * 조립 축은 (project, session) 2단이며, 설정 루트(base)와 저장소 루트(vault)를 분리한다(FR-029):
 *   - 설정 루트: `<base>/projects/<proj>/` — project.conf·sessions.d·.env·runtime(큐·엔진 상주 상태)
 *   - 저장소 루트: `<vault>/adde/projects/<proj>/` — 이벤트 기록·노트·첨부·중복 판정 기록
 */
import { join, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";

/** 기본 base 경로. 테스트 환경 override 용으로 분리 주입 가능. */
function defaultBase(): string {
  const override = process.env["ADDE_HOME"];
  if (override) return override;
  return join(homedir(), ".config", "adde");
}

/**
 * 선행 `~`/`~/` 를 홈 디렉터리로 확장. (Node 는 셸과 달리 ~ 를 자동 확장하지 않음)
 * conf 의 cwd/vault 같은 사용자 입력 경로에 적용한다. ~user 형태는 미지원.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** 셸이 이스케이프하는 메타문자(공백·틸드·글롭·인용부호 등) 앞의 백슬래시. */
const SHELL_ESCAPED = /\\([ \t~!"#$&'()*;<>?[\]`{|}\\])/g;

/**
 * 사용자·conf 에서 받은 경로의 셸식 백슬래시 이스케이프를 제거한다(예: `Mobile\ Documents` → `Mobile Documents`).
 * 드래그드롭·탭완성·터미널 복붙으로 유입된 이스케이프가 리터럴 백슬래시로 파일시스템 경로에 섞이는 것을 막는다.
 * 메타문자 앞 백슬래시만 제거한다 — POSIX 에서 백슬래시는 합법 파일명 문자라 일반문자·경로구분자(`/`) 앞의
 * 백슬래시는 보존한다(전체 언이스케이프는 실재 백슬래시 경로를 손상시킨다).
 */
export function normalizeUserPath(p: string): string {
  return p.replace(SHELL_ESCAPED, "$1");
}

/** proj/session 식별자 허용 문자셋 — 경로 세그먼트로 안전(`..`·`/`·구분자 차단). */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * proj/session 이 경로 세그먼트로 안전한지 검증 — 위반 시 throw.
 * 경로 구성의 SSOT 이므로 여기서 막으면 모든 호출부(진단·세션 매니저 등)가 일괄 보호된다(디렉터리 탈출·세션 격리 위반 차단).
 */
export function assertSafeSegment(kind: "proj" | "session", value: string): void {
  if (!SAFE_SEGMENT_RE.test(value)) {
    throw new Error(`잘못된 ${kind} 이름 "${value}" — 영숫자·_·- 만 허용됩니다(경로 탈출 차단).`);
  }
}

/** proj/session 세그먼트 안전성 여부(throw 없이). 디렉터리 열거 등에서 비안전 이름을 걸러낼 때 사용. */
export function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT_RE.test(value);
}

// --- 경로 포함/중첩 판정 ------------------------------------------------------
// markdown Surface 의 기동 fail-closed 가드와 프로젝트 생성 시 사전 경고·보관 위치 겹침 거부가
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

// --- 설정 루트(base) 경로 ----------------------------------------------------

export interface ProjectPaths {
  /** `<base>/projects/<proj>` */
  root: string;
  /** `<base>/projects/<proj>/project.conf` */
  projectConf: string;
  /** `<base>/projects/<proj>/sessions.d` — 세션 레코드(JSON) 디렉터리 */
  sessionsDir: string;
  /** `<base>/projects/<proj>/.env` — 시크릿(0600) */
  envFile: string;
  /** `<base>/projects/<proj>/runtime` */
  runtimeDir: string;
  /** `<base>/projects/<proj>/runtime/runtime.json` — 데몬 pid·하트비트 */
  runtimeJson: string;
  /** `<base>/projects/<proj>/runtime/engines.json` — 상주 엔진 스냅샷(세션→pid) */
  enginesJson: string;
  /** `<base>/projects/<proj>/runtime/control` — 데몬 기동 중 CLI 변경 요청 큐 */
  controlDir: string;
}

export function projectPaths(base: string, proj: string): ProjectPaths {
  assertSafeSegment("proj", proj);
  const root = join(base, "projects", proj);
  const runtimeDir = join(root, "runtime");
  return {
    root,
    projectConf: join(root, "project.conf"),
    sessionsDir: join(root, "sessions.d"),
    envFile: join(root, ".env"),
    runtimeDir,
    runtimeJson: join(runtimeDir, "runtime.json"),
    enginesJson: join(runtimeDir, "engines.json"),
    controlDir: join(runtimeDir, "control"),
  };
}

export interface SessionPaths {
  /** `<base>/projects/<proj>/sessions.d/<sid>.json` — 세션 레코드 파일(session-store.ts 가 소유) */
  recordFile: string;
  /** `<base>/projects/<proj>/runtime/sessions/<sid>/queue` (ADR-011 — 큐는 설정 루트) */
  queueDir: string;
  /** `<base>/projects/<proj>/runtime/sessions/<sid>/processing` */
  processingDir: string;
}

export function sessionPaths(base: string, proj: string, sid: string): SessionPaths {
  assertSafeSegment("session", sid);
  const pp = projectPaths(base, proj);
  const sessionRuntimeDir = join(pp.runtimeDir, "sessions", sid);
  return {
    recordFile: join(pp.sessionsDir, `${sid}.json`),
    queueDir: join(sessionRuntimeDir, "queue"),
    processingDir: join(sessionRuntimeDir, "processing"),
  };
}

/** `<base>/projects/<proj>/runtime/sessions/<sid>/engine.log` — 엔진 진단 로그(회전 허용, FR-043). */
export function engineLogPath(base: string, proj: string, sid: string): string {
  assertSafeSegment("session", sid);
  const pp = projectPaths(base, proj);
  return join(pp.runtimeDir, "sessions", sid, "engine.log");
}

/** `<base>/projects/<proj>/runtime/retention-last-run` — 일간 보관 이관 게이트(날짜 문자열). */
export function retentionLastRunPath(base: string, proj: string): string {
  const pp = projectPaths(base, proj);
  return join(pp.runtimeDir, "retention-last-run");
}

/** `<base>/projects/<proj>/daemon-boots.json` — 크래시루프 짧은-수명 연속 카운터(데몬 단일 writer). */
export function daemonBootsPath(base: string, proj: string): string {
  return join(projectPaths(base, proj).root, "daemon-boots.json");
}

/** `<base>/projects/<proj>/daemon-halt.json` — 크래시루프 자가 정지 기록(원인·시점). */
export function daemonHaltPath(base: string, proj: string): string {
  return join(projectPaths(base, proj).root, "daemon-halt.json");
}

/** `<base>/projects/<proj>/daemon-boot-report.json` — 최신 부팅 리포트(데몬 단일 writer, CLI reader). */
export function daemonBootReportPath(base: string, proj: string): string {
  return join(projectPaths(base, proj).root, "daemon-boot-report.json");
}

// --- 저장소 루트(vault) 경로 -------------------------------------------------

export interface VaultPaths {
  /** `<vault>/adde/projects/<proj>` */
  projectDir: string;
  /** `<vault>/adde/projects/<proj>/project.md` */
  projectNote: string;
  /** `<vault>/adde/projects/<proj>/sessions/<sid>` (sid 미지정 시 `sessions/` 루트) */
  sessionDir: string;
  /** `<sessionDir>/session.md` */
  sessionNote: string;
  /** `<sessionDir>/inbox.md` */
  inboxNote: string;
  /** `<sessionDir>/approvals` */
  approvalsDir: string;
  /** `<sessionDir>/turns` */
  turnsDir: string;
  /** `<vault>/adde/projects/<proj>/.adde/sessions/<sid>` — 이벤트 세대·요약 sidecar */
  eventsDir: string;
  /** `<vault>/adde/projects/<proj>/.adde/blobs` — 내용 주소 저장(프로젝트 스코프) */
  blobsDir: string;
  /** `<vault>/adde/projects/<proj>/.adde/ledger/dedup.jsonl` — 중복 판정 기록(프로젝트 스코프) */
  dedupFile: string;
}

export function vaultPaths(vaultRoot: string, proj: string, sid?: string): VaultPaths {
  assertSafeSegment("proj", proj);
  if (sid !== undefined) assertSafeSegment("session", sid);
  const projectDir = join(vaultRoot, "adde", "projects", proj);
  const sessionsRoot = join(projectDir, "sessions");
  const sessionDir = sid !== undefined ? join(sessionsRoot, sid) : sessionsRoot;
  const addeDir = join(projectDir, ".adde");
  const eventsSessionsRoot = join(addeDir, "sessions");
  return {
    projectDir,
    projectNote: join(projectDir, "project.md"),
    sessionDir,
    sessionNote: join(sessionDir, "session.md"),
    inboxNote: join(sessionDir, "inbox.md"),
    approvalsDir: join(sessionDir, "approvals"),
    turnsDir: join(sessionDir, "turns"),
    eventsDir: sid !== undefined ? join(eventsSessionsRoot, sid) : eventsSessionsRoot,
    blobsDir: join(addeDir, "blobs"),
    dedupFile: join(addeDir, "ledger", "dedup.jsonl"),
  };
}

export { defaultBase };
