/**
 * macOS launchd LaunchAgent 상호작용 전담 모듈.
 * plist 생성·경로·launchctl 호출을 단일 소스로 관리한다.
 * 비-macOS 환경에서는 assertMacOS() 가 actionable throw(침묵 실패 금지).
 */
import { t } from "../shared/i18n.js";
import { execFile as nodeExecFile } from "node:child_process";
import { writeFile, unlink, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatBlock } from "../shared/notify.js";
import { assertSafeSegment } from "../shared/paths.js";

// ── 타입 정의 ───────────────────────────────────────────────────────────────

/** launchctl 실행자 타입 — 테스트에서 fake 로 주입 가능(CI 실 launchctl 미접촉). */
export type LaunchctlExec = (args: string[]) => Promise<{ stdout: string; code: number }>;

/** 주입 가능한 의존성 — exec(fake launchctl), home(테스트용 홈 경로). */
export interface LaunchdDeps {
  exec?: LaunchctlExec;
  home?: string;
  /** 플랫폼 가드 주입(테스트 전용 — 미지정 시 process.platform). */
  platform?: NodeJS.Platform;
  /** node 바이너리 경로 override(테스트 전용 — 미지정 시 process.execPath). */
  nodeBin?: string;
  /** 데몬 실행 파일 경로 override(테스트 전용 — 미지정 시 import.meta.url 기준 dist/cli/adde.js). */
  addeBin?: string;
  /** 데몬 PATH override(테스트 전용 — 미지정 시 node 디렉터리를 앞에 붙인 process.env.PATH). */
  pathEnv?: string;
}

// ── macOS 가드 ──────────────────────────────────────────────────────────────

/**
 * macOS(darwin) 이 아닌 환경에서 actionable throw.
 * launchd 코드 경로의 SSOT 가드 — 개별 함수에서 직접 process.platform 체크 금지.
 */
export function assertMacOS(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") {
    throw new Error(
      formatBlock({
        situation: t("launchd.macOnly.situation", { platform }),
        action: t("launchd.macOnly.action"),
      }),
    );
  }
}

// ── plist 경로·Label 헬퍼 ───────────────────────────────────────────────────

/**
 * launchd Label: "com.qwertygeon.adde.<proj>".
 * proj 안전성은 assertSafeSegment 로 검증(Label/파일명 인젝션 차단).
 */
export function plistLabel(proj: string): string {
  assertSafeSegment("proj", proj);
  return `com.qwertygeon.adde.${proj}`;
}

/**
 * plist 파일 경로: ~/Library/LaunchAgents/com.qwertygeon.adde.<proj>.plist.
 * deps.home 미지정 시 os.homedir() 사용(테스트 주입 가능).
 */
export function plistPath(proj: string, deps?: LaunchdDeps): string {
  assertSafeSegment("proj", proj);
  const base = deps?.home ?? homedir();
  return join(base, "Library", "LaunchAgents", `${plistLabel(proj)}.plist`);
}

/**
 * 데몬 로그 경로 base — launchd StandardOut/ErrorPath 의 접두(`~/Library/Logs/adde/<proj>`).
 * loadDaemon(plist 기록)과 `adde logs --daemon`(조회)이 같은 경로를 쓰도록 SSOT.
 */
export function daemonLogBase(proj: string, deps?: LaunchdDeps): string {
  assertSafeSegment("proj", proj);
  const base = deps?.home ?? homedir();
  return join(base, "Library", "Logs", "adde", proj);
}

/** 데몬 stdout/stderr 로그 파일 경로. 기동 실패 원인 등 데몬 콘솔 출력이 여기 쌓인다. */
export function daemonLogPaths(proj: string, deps?: LaunchdDeps): { out: string; err: string } {
  const b = daemonLogBase(proj, deps);
  return { out: `${b}.out.log`, err: `${b}.err.log` };
}

// ── plist XML 렌더 ──────────────────────────────────────────────────────────

export interface RenderPlistOpts {
  nodeBin: string;
  addeBin: string;
  logPath: string;
  /**
   * 데몬 PATH. launchd 는 기본적으로 최소 PATH(/usr/bin:/bin:/usr/sbin:/sbin)만 주는데,
   * ACP 엔진 어댑터가 `claude` CLI 를 `#!/usr/bin/env node` 로 스폰하므로 node·claude 가
   * 이 PATH 에 있어야 한다. 미지정 시 EnvironmentVariables 를 생략(구 동작).
   */
  pathEnv?: string;
}

/** plist 문자열 값의 XML 특수문자 이스케이프(경로에 &·< 등이 있어도 유효한 plist 유지). */
function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * launchd plist XML 생성.
 * - KeepAlive=true, RunAtLoad=true.
 * - ProgramArguments=[nodeBin, addeBin, "__daemon", proj] — 시크릿 미포함.
 * - EnvironmentVariables: PATH 만 주입(pathEnv 지정 시). 토큰 등 시크릿은 넣지 않는다
 *   (데몬이 .env 파일에서 로드). PATH 는 시크릿이 아니다.
 */
export function renderPlist(proj: string, opts: RenderPlistOpts): string {
  assertSafeSegment("proj", proj);
  const label = plistLabel(proj);
  const { nodeBin, addeBin, logPath, pathEnv } = opts;
  const envBlock = pathEnv
    ? `  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
`
    : "";
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
${envBlock}  <key>RunAtLoad</key>
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
 * 데몬 워커가 실행할 adde 진입 파일(절대 경로) — import.meta.url 기준 `dist/cli/adde.js`.
 * 빌드본에선 dist/cli/adde.js(존재), tsx dev 에선 src/cli/adde.js(부재)로 해석된다 —
 * loadDaemon 가드·doctor 사전점검의 SSOT. launchd 워커는 분리 프로세스라 이 파일이 실재해야 한다.
 */
export function daemonEntryPath(): string {
  // fileURLToPath — .pathname 은 공백·특수문자를 퍼센트 인코딩해(예: "John%20Doe") 실경로와
  // 어긋난다. 가드 stat·plist ProgramArguments 양쪽이 실경로를 써야 하므로 디코딩 변환.
  return fileURLToPath(new URL("../cli/adde.js", import.meta.url));
}

/**
 * plist 생성 후 launchctl load 로 데몬 등록.
 * exit code ≠ 0 이면 actionable throw.
 */
export async function loadDaemon(proj: string, deps?: LaunchdDeps): Promise<void> {
  assertMacOS(deps?.platform);
  const exec = deps?.exec ?? defaultExec;

  const nodeBin = deps?.nodeBin ?? process.execPath;
  // launchd 가 워커를 기동할 때 동일 Node 바이너리 + 동일 adde.js 를 사용한다.
  const addeBin = deps?.addeBin ?? daemonEntryPath();

  // 데몬 실행 파일 존재 가드 — launchd 워커는 분리 프로세스라 tsx 트랜스파일을 못 쓴다.
  // `pnpm run dev up`(tsx) 은 addeBin 이 src/cli/adde.js(부재)로 해석돼 데몬이 MODULE_NOT_FOUND
  // 로 크래시루프한다 → 빌드 산출물/전역 설치가 필요함을 여기서 명시 거부한다.
  try {
    await stat(addeBin);
  } catch {
    throw new Error(
      formatBlock({
        situation: t("launchd.binMissing.situation", { path: addeBin }),
        action: t("launchd.binMissing.action"),
      }),
    );
  }

  // 데몬 PATH: node 디렉터리를 앞에 두고 현재 PATH 를 승계(중복 제거).
  // launchd 최소 PATH 로는 엔진 어댑터의 `env node`/`claude` 스폰이 실패하므로,
  // up 실행 시점(사용자 셸)의 PATH 를 plist 에 구워 넣어 재부팅 후에도 유지한다.
  const pathEnv =
    deps?.pathEnv ??
    (() => {
      const parts = [dirname(nodeBin), ...(process.env.PATH ?? "").split(":")];
      return parts.filter((p, i) => p && parts.indexOf(p) === i).join(":");
    })();

  const targetPlist = plistPath(proj, deps);
  // 데몬 stdout/stderr 로그 경로 base: ~/Library/Logs/adde/<proj> (adde logs --daemon 과 동일 SSOT).
  const logPath = daemonLogBase(proj, deps);

  const plistContent = renderPlist(proj, { nodeBin, addeBin, logPath, pathEnv });

  // LaunchAgents 디렉터리 생성(존재하면 noop).
  await mkdir(dirname(targetPlist), { recursive: true });
  await writeFile(targetPlist, plistContent, "utf8");

  const { stdout, code } = await exec(["load", targetPlist]);
  if (code !== 0) {
    throw new Error(
      formatBlock({
        situation: t("launchd.loadFail.situation", { code, output: stdout.trim() }),
        action: t("launchd.loadFail.action", { proj }),
      }),
    );
  }
}

/**
 * launchctl unload 후 plist 제거 — 멱등(실패 흡수).
 * 순서: unload 먼저(KeepAlive 재기동 차단) → plist rm.
 */
export async function unloadDaemon(proj: string, deps?: LaunchdDeps): Promise<void> {
  assertMacOS(deps?.platform);
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
  /** launchctl list 에 Label(com.qwertygeon.adde.<proj>)이 등록되어 있는가. */
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
    // stat 실패 = plist 부재(초기값 유지)
  }

  // launchctl list 에 Label 등록 여부 — 부분문자열 매칭.
  let launchctlRegistered = false;
  try {
    const { stdout } = await exec(["list"]);
    launchctlRegistered = stdout.includes(label);
  } catch {
    // launchctl 실행 실패 = 등록 확인 불가 → 미등록 취급(초기값 유지)
  }

  return { plistExists, launchctlRegistered };
}
