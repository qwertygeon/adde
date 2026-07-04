/**
 * denylist 항목 파싱·매칭 — `Tool`(도구 전체) 또는 `Tool(glob)`(대표 인자 글롭).
 * 실패 방향 = 채널 승인 폴백이므로 판단 불가(파싱 불가·매핑 없음·인자 부재)는
 * 매칭으로 간주한다(fail-closed — 과매칭은 "물어봄"일 뿐 위험하지 않다).
 */
import { homedir } from "node:os";

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

/**
 * 셸 명령을 제어 연산자(`;` `&&` `||` `|` `&` 개행)와 명령치환 경계(`$(` `)` 백틱)로
 * 분해해 체이닝된 하위 명령을 개별 후보로 낸다. 각 세그먼트의 선행 환경변수 대입
 * (`FOO=1 sudo …`)은 제거해 실제 실행 명령 토큰이 앞에 오도록 한다.
 * 앵커 글롭이 전체 문자열만 봤을 때 `cd /tmp && sudo rm -rf /` 같은 체이닝이 위험 패턴을
 * 우회하던 문제를 막는다(과분리=더 많은 후보를 denylist 에 대조 = 안전 방향).
 */
function shellSegments(command: string): string[] {
  const out: string[] = [];
  for (const raw of command.split(/(?:&&|\|\||[;&|\n]|\$\(|\)|`)/)) {
    const seg = raw.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "").trim();
    if (seg) out.push(seg);
  }
  return out;
}

/** 셸 명령(command) 전용 매칭 — 전체 문자열 + 각 세그먼트를 글롭에 대조. */
function commandGlobMatch(glob: string, command: string): boolean {
  if (globMatches(glob, command)) return true;
  for (const seg of shellSegments(command)) {
    if (globMatches(glob, seg)) return true;
  }
  return false;
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
  for (const raw of denylist ?? []) {
    const entry = parseDenyEntry(raw.trim());
    if (!entry) return true;
    // 도구명은 대소문자 무시 비교 — 오타(bash)로 매칭이 스킵되면 자동 허용(위험 방향)으로 새므로
    // 넓게 잡는다(과매칭=채널 승인, 안전 방향).
    if (entry.tool.toLowerCase() !== toolName.toLowerCase()) continue;
    if (entry.glob === undefined) return true;
    const field = PRIMARY_ARG_FIELD[toolName];
    if (!field) return true;
    const arg =
      rawInput && typeof rawInput === "object"
        ? (rawInput as Record<string, unknown>)[field]
        : undefined;
    if (typeof arg !== "string") return true;
    // Bash 명령(command)은 세그먼트 분해 매칭 — 체이닝·선행대입 우회 차단. 경로·URL 은 전체 문자열.
    const hit =
      field === "command" ? commandGlobMatch(entry.glob, arg) : globMatches(entry.glob, arg);
    if (hit) return true;
  }
  return false;
}

/**
 * autopass 내장 기본 denylist — 파괴적 셸 명령(sudo·rm -rf·git 강제 변경)과
 * 자격증명 저장소 읽기(ssh·aws·npm·gh·kube·docker·gcloud 토큰/키)를 채널 승인으로 폴백시킨다.
 * git clean -fdx 는 -fd* 글롭이 포섭한다. 셸 체이닝은 matchesDenylist 의 세그먼트 매칭이 포섭한다.
 */
export const DEFAULT_AUTOPASS_DENYLIST: readonly string[] = [
  "Bash(sudo *)",
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
