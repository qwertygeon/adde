/**
 * denylist 항목 파싱·매칭 — `Tool`(도구 전체) 또는 `Tool(glob)`(대표 인자 글롭).
 * 실패 방향 = 채널 승인 폴백이므로 판단 불가(파싱 불가·매핑 없음·인자 부재)는
 * 매칭으로 간주한다(fail-closed — 과매칭은 "물어봄"일 뿐 위험하지 않다).
 */
import { homedir } from "node:os";
import { posix } from "node:path";

/** 도구별 대표 인자 필드. 매핑 없는 도구에 패턴을 걸면 도구명 일치만으로 매칭. */
const PRIMARY_ARG_FIELD: Record<string, string> = {
  Bash: "command",
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookRead: "notebook_path",
  NotebookEdit: "notebook_path",
  WebFetch: "url",
};

export interface DenyEntry {
  tool: string;
  /** 괄호 안 글롭. 없으면 도구 전체 매칭. */
  glob?: string;
}

/** `"Bash(git push*)"` | `"Bash"` → {tool, glob?}. 형식 위반 시 null. */
export function parseDenyEntry(entry: string): DenyEntry | null {
  const m = /^([A-Za-z0-9_.-]+)(?:\((.+)\))?$/.exec(entry);
  if (!m || !m[1]) return null;
  const tool = m[1];
  const glob = m[2];
  return glob !== undefined ? { tool, glob } : { tool };
}

/** 글롭 → 전체 문자열 앵커 정규식. `*`·`**` 동일 취급(임의 문자열 — 경로 구분자 포함, 과매칭=안전 방향). */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function globMatches(glob: string, value: string): boolean {
  if (globToRegExp(glob).test(value)) return true;
  // 선행 ~ 는 홈 확장 변형도 매칭 — 경로 인자가 절대경로로 도착하는 경우 대비.
  if (glob.startsWith("~/") || glob.startsWith("~*")) {
    if (globToRegExp(homedir() + glob.slice(1)).test(value)) return true;
  }
  return false;
}

/** 셸 인터프리터 `-c <payload>` 추출 — 인용 페이로드 안 위험명령이 래퍼 세그먼트 하나에 갇혀 인식기를 우회하던 것 방지. */
const SHELL_C_PAYLOAD =
  /\b(?:sh|bash|zsh|dash|ksh|ash)\s+(?:-[A-Za-z]+\s+)*-c\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g;

/**
 * 셸 명령을 제어 연산자(`;` `&&` `||` `|` `&` 개행)와 그룹·명령치환 경계
 * (`(` `)` `{` `}` `$(` 백틱)로 분해해 체이닝·서브셸·그룹의 하위 명령을 개별 후보로 낸다.
 * 각 세그먼트의 선행 환경변수 대입(`FOO=1 sudo …`)은 제거해 실제 실행 명령 토큰이 앞에 오도록 한다.
 * 앵커 글롭이 전체 문자열만 봤을 때 `cd /tmp && sudo rm -rf /`·`(sudo rm -rf /)` 같은
 * 체이닝·서브셸이 위험 패턴을 우회하던 문제를 막는다(과분리=더 많은 후보 대조=안전 방향).
 * 아울러 `sh -c "…"`/`bash -c '…'` 페이로드를 추가 세그먼트로 재귀 분해(최대 깊이 3)해 셸 중첩 우회를 막는다.
 * best-effort 다 — 따옴표를 인식하지 않으므로 인용부 안 연산자에서도 분리한다(과매칭=안전).
 */
function shellSegments(command: string, depth = 0): string[] {
  // `$HOME`/`${HOME}` 를 homedir 로 선확장 — 홈 삭제/자격증명 경로를 균일 대조하고,
  // `${HOME}` 의 중괄호가 브레이스그룹 구분자로 오분리되던 문제도 함께 해소.
  command = command.replace(/\$\{HOME\}|\$HOME\b/g, () => homedir());
  const out: string[] = [];
  for (const raw of command.split(/(?:&&|\|\||[;&|(){}\n]|`)/)) {
    const seg = raw.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").trim();
    if (seg) out.push(seg);
  }
  if (depth < 3) {
    // matchAll 은 정규식을 복제하므로 재귀 재진입에도 lastIndex 공유 문제가 없다(전역 exec 루프는 무한루프 위험).
    for (const m of command.matchAll(SHELL_C_PAYLOAD)) {
      const payload = m[1] ?? m[2] ?? m[3];
      if (payload) out.push(...shellSegments(payload, depth + 1));
    }
  }
  return out;
}

/** rm 재귀 플래그 — `--recursive`, 또는 r/R 을 포함한 번들 단축플래그(`-r`·`-rf`·`-fr`·`-Rfv` 등, 순서 무관). */
const RM_RECURSIVE_FLAG = /^--recursive$|^-[A-Za-z]*[rR][A-Za-z]*$/;

/** 명령 래퍼 — 뒤 명령의 기본명을 바꾸지 않는 선행 래퍼. 벗겨서 실제 명령을 head 로 올린다. */
const WRAPPER_CMDS = new Set([
  "env",
  "command",
  "builtin",
  "exec",
  "nice",
  "ionice",
  "time",
  "stdbuf",
  "setsid",
  "timeout",
  "nohup",
  "xargs",
]);

/** 래퍼별 값 소비 옵션(분리형 `-n 10` 의 값 토큰을 함께 건너뛴다). */
const WRAPPER_VALUE_OPT: Record<string, Set<string>> = {
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p"]),
  env: new Set(["-u"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  xargs: new Set(["-n", "-I", "-P", "-L", "-s", "-d", "-a", "-E", "--replace", "--max-args"]),
};

/** 래퍼별 명령 앞 위치인자 개수(예: `timeout DURATION cmd` 의 DURATION 1개). */
const WRAPPER_POSITIONAL_SKIP: Record<string, number> = {
  timeout: 1,
};

/** 권한상승 명령 — 경로·래퍼 불문 그 자체가 위험. */
const PRIV_ESC_CMDS = new Set(["sudo", "doas"]);

/** git 값 소비 전역 옵션 — 서브커맨드 탐색 시 값 토큰 1개를 함께 건너뛴다. */
const GIT_GLOBAL_VALUE_OPT = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

/** 감싼 따옴표·선행 백슬래시(alias 회피 `\rm`) 제거. */
function unquote(tok: string): string {
  return tok.replace(/^\\+/, "").replace(/^['"]/, "").replace(/['"]$/, "");
}

/** 명령 토큰 → 기본명(`/bin/rm`→`rm`, `"rm"`→`rm`, `\rm`→`rm`). */
function commandBasename(tok: string): string {
  const t = unquote(tok);
  const slash = t.lastIndexOf("/");
  return slash >= 0 ? t.slice(slash + 1) : t;
}

/** 선행 홈 참조(`~`·`$HOME`·`${HOME}`)를 homedir 로 확장(없으면 원본) — `rm -rf $HOME` 등 홈 삭제를 `~` 스코프로 포섭. */
function expandLeadingHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return homedir() + p.slice(1);
  if (p === "$HOME" || p === "${HOME}") return homedir();
  if (p.startsWith("$HOME/")) return homedir() + p.slice("$HOME".length);
  if (p.startsWith("${HOME}/")) return homedir() + p.slice("${HOME}".length);
  return p;
}

/**
 * 세그먼트를 정규화해 `{cmd 기본명, args(따옴표 제거)}` 로. 선행 래퍼(env[VAR=/-opt]·command·nice[-n N]·
 * time·exec 등)를 반복 제거해 실제 명령을 head 로 올리고, 경로·따옴표·백슬래시·이중공백을 흡수한다.
 * 리터럴 글롭이 놓치던 절대경로/래퍼/공백 우회(`/bin/rm`·`env rm`·`git  push`)를 인식기 앞단에서 정규화.
 * best-effort — 미지의 래퍼 옵션값은 정밀 처리하지 않는다(오분류 시 리터럴 글롭 매칭이 폴백).
 */
function normalizeCommand(segment: string): { cmd: string; args: string[] } | null {
  let toks = segment.split(/\s+/).filter(Boolean);
  if (toks.length === 0) return null;
  for (;;) {
    const head = commandBasename(toks[0] as string);
    if (!WRAPPER_CMDS.has(head)) break;
    let i = 1;
    while (i < toks.length) {
      const t = toks[i] as string;
      if (head === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        i += 1;
        continue;
      }
      if (t.startsWith("-")) {
        i += WRAPPER_VALUE_OPT[head]?.has(t) ? 2 : 1;
        continue;
      }
      break;
    }
    i += WRAPPER_POSITIONAL_SKIP[head] ?? 0; // `timeout DURATION cmd` 등 명령 앞 위치인자 건너뛰기
    if (i >= toks.length) return null; // 래퍼만 있고 명령 없음
    toks = toks.slice(i);
  }
  return { cmd: commandBasename(toks[0] as string), args: toks.slice(1).map(unquote) };
}

/**
 * 정규화된 명령이 재귀 rm 이면 삭제 대상(비플래그 인자) 목록을, 아니면 null.
 * 플래그 순서·번들·대소문자·`--recursive` 불문(`rm -r`·`-fr`·`-R`·`-rfv`·`--recursive`).
 */
function rmRecursiveTargets(cmd: string, args: string[]): string[] | null {
  if (cmd !== "rm") return null;
  let recursive = false;
  const targets: string[] = [];
  for (const tok of args) {
    if (tok === "--") continue; // 옵션 종료 표식
    if (tok.startsWith("-") && tok !== "-") {
      if (RM_RECURSIVE_FLAG.test(tok)) recursive = true;
      continue; // 그 외 플래그(-f·-i 등)는 무시
    }
    targets.push(tok);
  }
  return recursive ? targets : null;
}

/** git 전역 옵션(`-C <dir>`·`-c k=v`·`--git-dir=…` 등)을 건너뛴 서브커맨드와 그 뒤 인자. 없으면 null. */
function gitSubcommand(args: string[]): { sub: string; rest: string[] } | null {
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (!a.startsWith("-")) break; // 서브커맨드
    if (a.includes("="))
      i += 1; // `--git-dir=…`(값 포함)
    else if (GIT_GLOBAL_VALUE_OPT.has(a))
      i += 2; // `-C <dir>`(값 분리)
    else i += 1; // 그 외 무값 전역 옵션(`-p` 등)
  }
  return i < args.length ? { sub: args[i] as string, rest: args.slice(i + 1) } : null;
}

/** 강제 플래그 — `--force`/`--force-with-lease`·`-f`·`f` 포함 번들 단축플래그. */
function hasForceFlag(args: string[]): boolean {
  return args.some(
    (a) =>
      a === "--force" ||
      a === "--force-with-lease" ||
      a.startsWith("--force-with-lease=") ||
      (a.startsWith("-") && !a.startsWith("--") && a.includes("f")),
  );
}

/**
 * 정규화된 git 명령이 지정 서브커맨드에서 위험한지 — push 강제(force 플래그 또는 `+refspec`)·
 * reset `--hard`·clean 강제. 전역 옵션(`-C` 등)은 gitSubcommand 이 이미 건너뛴다.
 */
function isGitDangerous(cmd: string, args: string[], sub: string): boolean {
  if (cmd !== "git") return false;
  const s = gitSubcommand(args);
  if (!s || s.sub !== sub) return false;
  if (sub === "push") {
    return hasForceFlag(s.rest) || s.rest.some((a) => a.startsWith("+") && !a.startsWith("-"));
  }
  if (sub === "reset") return s.rest.includes("--hard");
  if (sub === "clean") return hasForceFlag(s.rest);
  return false;
}

/**
 * Bash 엔트리 글롭이 알려진 위험 명령 패턴이면, 정규화된 세그먼트를 형태 불문 대조하는 술어를 반환(옵션1).
 * 엔트리가 스위치 — rm 재귀(+대상 스코프)·git 서브커맨드·권한상승 종류를 엔트리에서 읽어 인식기를 활성화한다.
 * 알려진 패턴이 아니면 null → 리터럴 글롭 매칭에 맡긴다(사용자 커스텀 경로 등).
 */
function dangerousBashEntry(
  glob: string,
): ((n: { cmd: string; args: string[] }) => boolean) | null {
  const entry = normalizeCommand(glob);
  if (!entry) return null;
  const rmTargets = rmRecursiveTargets(entry.cmd, entry.args);
  if (rmTargets && rmTargets.length > 0) {
    return (n) => {
      const t = rmRecursiveTargets(n.cmd, n.args);
      if (!t) return false;
      return t.some((x) => {
        const home = expandLeadingHome(x); // `$HOME`/`${HOME}`/`~` → homedir 확장 후에도 대조
        return rmTargets.some((g) => globMatches(g, x) || globMatches(g, home));
      });
    };
  }
  if (entry.cmd === "git") {
    const es = gitSubcommand(entry.args);
    if (es) return (n) => isGitDangerous(n.cmd, n.args, es.sub);
  }
  if (PRIV_ESC_CMDS.has(entry.cmd)) return (n) => n.cmd === entry.cmd;
  return null;
}

/**
 * 셸 명령(command) 전용 매칭 — 전체 문자열 + 각 세그먼트 리터럴 글롭 대조에 더해,
 * 엔트리가 알려진 위험 명령(rm 재귀·git 강제/reset --hard/clean·sudo/doas)이면 정규화 인식기로
 * 형태 불문(플래그 순서·번들·롱숏·절대경로·래퍼·이중공백·`+refspec`·전역옵션) 대조한다.
 */
function commandGlobMatch(glob: string, command: string): boolean {
  if (globMatches(glob, command)) return true;
  const segments = shellSegments(command);
  for (const seg of segments) {
    if (globMatches(glob, seg)) return true;
  }
  const recognizer = dangerousBashEntry(glob);
  if (recognizer) {
    for (const seg of segments) {
      const norm = normalizeCommand(seg);
      if (norm && recognizer(norm)) return true;
    }
  }
  return false;
}

/** 자격증명 경로 교차 보호 대상 파일 도구. */
const CRED_FILE_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookRead",
  "NotebookEdit",
]);

/** 경로형 글롭(선행 `~`·`/`) — 자격증명 교차 보호 대상 후보. */
function isPathGlob(glob: string): boolean {
  return glob.startsWith("~") || glob.startsWith("/");
}

/** 후보 경로가 자격증명 글롭 중 하나와 매칭 — 따옴표 제거·`~`/`$HOME` 확장·`..` 접기 변형까지 대조. */
function pathMatchesCredential(candidate: string, globs: string[]): boolean {
  const u = unquote(candidate);
  const variants = new Set<string>([u, expandLeadingHome(u)]);
  for (const v of [...variants]) variants.add(posix.normalize(v));
  return globs.some((g) => [...variants].some((v) => globMatches(g, v)));
}

/**
 * denylist 매칭 — 하나라도 걸리면 true(채널 승인 폴백).
 * 파싱 불가 항목은 전 도구 매칭으로 처리한다(fail-closed) — 손편집 오타가 자동 허용 구멍이
 * 되는 대신 전 요청이 채널로 가서 즉시 표면화된다. 생성 시점 검증(lane-config)이 1차 방어.
 */
export function matchesDenylist(
  denylist: string[] | undefined,
  toolName: string,
  rawInput: unknown,
): boolean {
  const list = denylist ?? [];
  const asArg = (field: string): unknown =>
    rawInput && typeof rawInput === "object"
      ? (rawInput as Record<string, unknown>)[field]
      : undefined;

  // 자격증명 경로 교차 보호 준비 — 파일도구 엔트리의 경로 글롭을 모아, 엔트리 도구와 무관하게
  // 파일도구 전반(Write/Edit/…)과 Bash args 에서 보호한다(리터럴 엔트리는 단일 도구만 봤음).
  const credGlobs: string[] = [];
  for (const raw of list) {
    const e = parseDenyEntry(raw.trim());
    if (e?.glob && CRED_FILE_TOOLS.has(e.tool) && isPathGlob(e.glob)) {
      credGlobs.push(e.glob);
      // `~/.ssh/**` 은 자식 경로만 매칭 → 디렉터리 자체(`~/.ssh`)도 추가해 통째 exfil(tar/cp -r/zip) 포섭.
      if (e.glob.endsWith("/**")) credGlobs.push(e.glob.slice(0, -3));
    }
  }

  for (const raw of list) {
    const entry = parseDenyEntry(raw.trim());
    if (!entry) return true;
    // 도구명은 대소문자 무시 비교 — 오타(bash)로 매칭이 스킵되면 자동 허용(위험 방향)으로 새므로
    // 넓게 잡는다(과매칭=채널 승인, 안전 방향).
    if (entry.tool.toLowerCase() !== toolName.toLowerCase()) continue;
    if (entry.glob === undefined) return true;
    const field = PRIMARY_ARG_FIELD[toolName];
    if (!field) return true;
    const arg = asArg(field);
    if (typeof arg !== "string") return true;
    // Bash 명령(command)은 세그먼트 분해 매칭 — 체이닝·선행대입 우회 차단. 경로·URL 은 전체 문자열.
    const hit =
      field === "command" ? commandGlobMatch(entry.glob, arg) : globMatches(entry.glob, arg);
    if (hit) return true;
  }

  // 자격증명 경로 교차 보호 — 위 루프(엔트리 도구 == 호출 도구)를 넘어, 같은 경로를 다른 파일도구·Bash 에서도 차단.
  if (credGlobs.length > 0) {
    if (toolName === "Bash") {
      const cmd = asArg("command");
      if (typeof cmd === "string") {
        for (const seg of shellSegments(cmd)) {
          const norm = normalizeCommand(seg);
          if (!norm) continue;
          for (const tok of [norm.cmd, ...norm.args]) {
            // 토큰 자체 + `opt=path` 우변(`dd if=~/.aws/x`·`--file=~/.ssh/x`)을 함께 대조.
            const eq = tok.indexOf("=");
            const cands = eq >= 0 ? [tok, tok.slice(eq + 1)] : [tok];
            if (cands.some((c) => pathMatchesCredential(c, credGlobs))) return true;
          }
        }
      }
    } else if (CRED_FILE_TOOLS.has(toolName)) {
      const field = PRIMARY_ARG_FIELD[toolName];
      const arg = field ? asArg(field) : undefined;
      if (typeof arg === "string" && pathMatchesCredential(arg, credGlobs)) return true;
    }
  }

  return false;
}

/**
 * autopass 내장 기본 denylist — 파괴적 셸 명령(권한상승·재귀 rm·git 강제 변경)과
 * 자격증명 저장소 접근(ssh·aws·npm·gh·kube·docker·gcloud 토큰/키)을 채널 승인으로 폴백시킨다.
 *
 * 아래 Bash 엔트리는 리터럴 글롭이 아니라 **정규화 인식기의 스위치**다(옵션1) — 엔트리에서 명령·
 * 서브커맨드·대상 스코프를 읽어, 실제 명령을 정규화(경로/래퍼/따옴표/이중공백 흡수)한 뒤 형태 불문 대조한다:
 *   rm      → 재귀 플래그(-r·-R·-fr·-rfv·--recursive·번들) + 대상 스코프(/·~·.)
 *   git     → 전역옵션(-C 등) 건너뛴 서브커맨드 기준 — push 강제(--force/-f/+refspec)·reset --hard·clean 강제(-f)
 *   sudo/doas → 명령 기본명(경로·래퍼 불문)
 * 자격증명 Read 경로는 matchesDenylist 의 교차 보호로 Write/Edit/NotebookEdit 및 Bash args(cat/cp 등)까지 포섭한다.
 */
export const DEFAULT_AUTOPASS_DENYLIST: readonly string[] = [
  "Bash(sudo *)",
  "Bash(doas *)",
  // rm 재귀 삭제 — 아래 3개는 대상 스코프(루트/홈/닷)를 정의하며, 재귀 플래그 형태는 인식기가 불문 처리.
  "Bash(rm -rf /*)",
  "Bash(rm -rf ~*)",
  "Bash(rm -rf .*)",
  "Bash(git push --force*)",
  "Bash(git push -f*)",
  "Bash(git reset --hard*)",
  "Bash(git clean -fd*)",
  "Read(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Read(~/.npmrc)",
  "Read(~/.config/gh/hosts.yml)",
  "Read(~/.kube/config)",
  "Read(~/.docker/config.json)",
  "Read(~/.config/gcloud/**)",
];
