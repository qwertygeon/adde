/**
 * macOS launchd LaunchAgent 상호작용 전담 모듈.
 * plist 생성·경로·launchctl 호출을 단일 소스로 관리한다.
 * 비-macOS 환경에서는 assertMacOS() 가 actionable throw(SC-016: 침묵 실패 금지).
 */
import { execFile as nodeExecFile } from "node:child_process";
import { writeFile, unlink, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { formatBlock } from "../shared/notify.js";
import { assertSafeSegment } from "../shared/paths.js";

// ── 타입 정의 ───────────────────────────────────────────────────────────────

/** launchctl 실행자 타입 — 테스트에서 fake 로 주입 가능(CI 실 launchctl 미접촉). */
export type LaunchctlExec = (args: string[]) => Promise<{ stdout: string; code: number }>;

/** 주입 가능한 의존성 — exec(fake launchctl), home(테스트용 홈 경로). */
export interface LaunchdDeps {
  exec?: LaunchctlExec;
  home?: string;
}

// ── macOS 가드 ──────────────────────────────────────────────────────────────

/**
 * macOS(darwin) 이 아닌 환경에서 actionable throw.
 * launchd 코드 경로의 SSOT 가드 — 개별 함수에서 직접 process.platform 체크 금지(ADR-007).
 */
export function assertMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      formatBlock({
        situation: `launchd 기능은 macOS 에서만 동작합니다 (현재 플랫폼: ${process.platform})`,
        action: "macOS 에서 실행하세요. Linux/WSL 지원은 추후 spec 범위.",
      }),
    );
  }
}

// ── plist 경로·Label 헬퍼 ───────────────────────────────────────────────────

/**
 * launchd Label: "com.rtm.adde.<proj>".
 * proj 안전성은 assertSafeSegment 로 검증(Label/파일명 인젝션 차단).
 */
export function plistLabel(proj: string): string {
  assertSafeSegment("proj", proj);
  return `com.rtm.adde.${proj}`;
}

/**
 * plist 파일 경로: ~/Library/LaunchAgents/com.rtm.adde.<proj>.plist.
 * deps.home 미지정 시 os.homedir() 사용(테스트 주입 가능).
 */
export function plistPath(proj: string, deps?: LaunchdDeps): string {
  assertSafeSegment("proj", proj);
  const base = deps?.home ?? homedir();
  return join(base, "Library", "LaunchAgents", `${plistLabel(proj)}.plist`);
}

// ── plist XML 렌더 ──────────────────────────────────────────────────────────

export interface RenderPlistOpts {
  nodeBin: string;
  addeBin: string;
  logPath: string;
}

/**
 * launchd plist XML 생성.
 * - KeepAlive=true, RunAtLoad=true (FR-005/SC-007).
 * - ProgramArguments=[nodeBin, addeBin, "__daemon", proj] — 시크릿 미포함(FR-008/ADR-008).
 * - EnvironmentVariables 키 없음 — 토큰은 데몬이 .env 파일에서 로드.
 */
export function renderPlist(proj: string, opts: RenderPlistOpts): string {
  assertSafeSegment("proj", proj);
  const label = plistLabel(proj);
  const { nodeBin, addeBin, logPath } = opts;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${addeBin}</string>
    <string>__daemon</string>
    <string>${proj}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}.out.log</string>
  <key>StandardErrorPath</key>
  <string>${logPath}.err.log</string>
</dict>
</plist>
`;
}

// ── launchctl 실행자 기본 구현 ────────────────────────────────────────────

/** 기본 LaunchctlExec 구현 — node:child_process.execFile("launchctl", args). */
function defaultExec(args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    nodeExecFile("launchctl", args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        const code = typeof err.code === "number" ? err.code : 1;
        resolve({ stdout: stdout + stderr, code });
      } else {
        resolve({ stdout: stdout + stderr, code: 0 });
      }
    });
  });
}

// ── loadDaemon / unloadDaemon ────────────────────────────────────────────────

/**
 * plist 생성 후 launchctl load 로 데몬 등록.
 * exit code ≠ 0 이면 actionable throw(NFR-003).
 */
export async function loadDaemon(proj: string, deps?: LaunchdDeps): Promise<void> {
  assertMacOS();
  const exec = deps?.exec ?? defaultExec;

  const nodeBin = process.execPath;
  // adde 바이너리: dist/cli/adde.js 절대 경로 해석 — import.meta.url 기준.
  // launchd 가 워커를 기동할 때 동일 Node 바이너리 + 동일 adde.js 를 사용한다.
  const addeBinUrl = new URL("../cli/adde.js", import.meta.url);
  const addeBin = addeBinUrl.pathname;

  const targetPlist = plistPath(proj, deps);
  // 데몬 stdout/stderr 로그 경로: ~/Library/Logs/adde/<proj>
  const baseHome = deps?.home ?? homedir();
  const logPath = join(baseHome, "Library", "Logs", "adde", proj);

  const plistContent = renderPlist(proj, { nodeBin, addeBin, logPath });

  // LaunchAgents 디렉터리 생성(존재하면 noop).
  await mkdir(dirname(targetPlist), { recursive: true });
  await writeFile(targetPlist, plistContent, "utf8");

  const { stdout, code } = await exec(["load", targetPlist]);
  if (code !== 0) {
    throw new Error(
      formatBlock({
        situation: `launchctl load 실패 (exit ${code}): ${stdout.trim()}`,
        action: `adde doctor ${proj} 로 등록 상태를 점검하거나, 기존 등록을 먼저 해제하세요 (adde down ${proj}).`,
      }),
    );
  }
}

/**
 * launchctl unload 후 plist 제거 — 멱등(실패 흡수).
 * 순서: unload 먼저(KeepAlive 재기동 차단) → plist rm.
 */
export async function unloadDaemon(proj: string, deps?: LaunchdDeps): Promise<void> {
  assertMacOS();
  const exec = deps?.exec ?? defaultExec;
  const targetPlist = plistPath(proj, deps);

  // unload 실패는 멱등 — 이미 미등록이거나 plist 없는 경우를 정상 취급.
  await exec(["unload", targetPlist]).catch(() => {
    // 오류 흡수 — 미등록 상태도 down 의 의도(종료)와 일치.
  });

  // plist 파일 제거(ENOENT 흡수 — 멱등).
  try {
    await unlink(targetPlist);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// ── daemonRegState ─────────────────────────────────────────────────────────

/** 데몬 등록 상태 — doctor·정합성 점검용. */
export interface DaemonRegState {
  /** plist 파일이 ~/Library/LaunchAgents/ 에 존재하는가. */
  plistExists: boolean;
  /** launchctl list 에 Label(com.rtm.adde.<proj>)이 등록되어 있는가. */
  launchctlRegistered: boolean;
}

/**
 * plist 파일 존재 + launchctl list 등록 여부를 독립적으로 확인.
 * PID/status 컬럼 파싱 회피 — Label 부분문자열 매칭만(견고성).
 * exec 주입으로 CI 실 launchctl 미접촉(테스트 부작용 방지).
 */
export async function daemonRegState(proj: string, deps?: LaunchdDeps): Promise<DaemonRegState> {
  assertSafeSegment("proj", proj);
  const exec = deps?.exec ?? defaultExec;
  const targetPlist = plistPath(proj, deps);
  const label = plistLabel(proj);

  // plist 파일 존재 여부.
  let plistExists = false;
  try {
    await stat(targetPlist);
    plistExists = true;
  } catch {
    plistExists = false;
  }

  // launchctl list 에 Label 등록 여부 — 부분문자열 매칭.
  let launchctlRegistered = false;
  try {
    const { stdout } = await exec(["list"]);
    launchctlRegistered = stdout.includes(label);
  } catch {
    launchctlRegistered = false;
  }

  return { plistExists, launchctlRegistered };
}
