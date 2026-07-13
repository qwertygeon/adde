/**
 * CLI 명령·플래그 스펙(SSOT) — 셸 자동완성·서브커맨드 도움말·미지원 명령 힌트·실제 인자 파싱이
 * 공유한다. 명령/플래그를 한 곳에서 선언해 네 소비자가 함께 갱신되도록(확장성): 새 명령·플래그는
 * 여기에 추가하면 completion·help·"did you mean" 힌트·parseCommand 파싱에 자동 반영된다. 문구
 * 본문(설명)은 i18n 카탈로그가 소유하고, 본 스펙은 이름·인자 형태·플래그 목록(구조)만 담는다.
 */

/** 위치 인자 종류 — 자동완성 동적 후보(proj/lane 이름 스캔)를 결정한다. */
export type ArgKind = "proj" | "lane";

/** 플래그 선언 — 파서(arity)·자동완성(long+short)·도움말이 공유하는 구조. */
export interface FlagSpec {
  /** 정식 long 이름(예: "--json", "--follow"). */
  name: string;
  /** 단축형(예: "-f"). */
  short?: string;
  /** true = 값 플래그(`--key value` / `--key=value`), 미지정 = boolean. */
  takesValue?: boolean;
}

/** 하위 명령 스펙(예: lane 의 add/ls/show/rm). */
export interface SubSpec {
  /** 정식 이름(디스패치·자동완성 후보). */
  name: string;
  /** 디스패치 별칭(예: list→ls, remove→rm) — 자동완성에는 노출하지 않는다. */
  aliases?: readonly string[];
  /** 이 하위 명령이 받는 플래그. */
  flags: readonly FlagSpec[];
  /** 위치 인자 종류(순서대로). */
  positional?: readonly ArgKind[];
  /** i18n usage 키. */
  usageKey?: string;
}

/** 최상위 명령 스펙. usageKey 는 `adde <cmd> --help` 및 인자 누락 시 출력할 i18n usage 키. */
export interface CommandSpec {
  /** 명령 이름(디스패치·자동완성 후보). */
  name: string;
  /** 위치 인자 형태 힌트(예: `<proj>`, `[<proj>]`). */
  args: string;
  /** 이 명령이 받는 옵션 플래그(자동완성·힌트·파싱용). */
  flags: readonly FlagSpec[];
  /** 위치 인자 종류(순서대로) — 자동완성이 해당 위치에서 proj/lane 이름을 완성한다. */
  positional?: readonly ArgKind[];
  /** zsh 자동완성에서 명령 옆에 표시할 짧은 설명(영문). */
  desc?: string;
  /** i18n usage 키(있으면 `--help`·인자누락 시 출력). */
  usageKey?: string;
  /** 하위 명령(예: lane 의 add/ls/show/rm). */
  subs?: readonly SubSpec[];
  /** 도움말·자동완성 노출 제외(내부 명령). */
  hidden?: boolean;
}

/** 값이 열거형인 플래그 — 자동완성이 플래그 뒤에서 이 값들을 완성한다. */
export const FLAG_VALUES: Record<string, readonly string[]> = {
  // 완성 스크립트 생성 전용 경량 미러 — 소스 SoT 는 src-adapters SOURCE_REGISTRY.
  // (spec 는 CLI 진입점이 eager import 하므로 어댑터를 import 하지 않는다 — startup 비용 회피.)
  "--source": ["markdown", "telegram"],
  "--perm-tier": ["acp", "autopass"],
  "--file-mode": ["private", "shared"],
  "--lang": ["en", "ko"],
};

/** 디렉터리 경로를 받는 플래그 — 자동완성이 뒤에서 디렉터리를 완성한다. */
export const DIR_FLAGS = ["--cwd", "--root"] as const;

/** 전역 옵션(모든 명령 위치에서 완성 후보) — completion 용 문자열 미러. */
export const GLOBAL_FLAGS = ["-h", "--help", "-v", "--version"] as const;

/** `lane add` 하위 명령 플래그(값 플래그는 takesValue:true). */
const LANE_ADD_FLAGS: readonly FlagSpec[] = [
  { name: "--source", takesValue: true },
  { name: "--perm-tier", takesValue: true },
  { name: "--engine-args", takesValue: true },
  { name: "--cwd", takesValue: true },
  { name: "--allowlist", takesValue: true },
  { name: "--denylist", takesValue: true },
  { name: "--hard-deny", takesValue: true },
  { name: "--safe-defaults" },
  { name: "--lang", takesValue: true },
  { name: "--chat-id", takesValue: true },
  { name: "--allow-from", takesValue: true },
  { name: "--file-mode", takesValue: true },
  { name: "--token-stdin" },
  { name: "--root", takesValue: true },
  { name: "--inbox", takesValue: true },
  { name: "--approvals", takesValue: true },
  { name: "--outbox", takesValue: true },
  { name: "--force" },
  { name: "--interactive" },
  { name: "--no-interactive" },
];

/** `lane rm` 하위 명령 플래그 — 부수 데이터 정리·확인 생략. */
const LANE_RM_FLAGS: readonly FlagSpec[] = [{ name: "--purge" }, { name: "--force" }];

/**
 * `lane set` 하위 명령 플래그 — 편집 가능 필드(LANE_ADD_FLAGS 의 부분집합).
 * 정체성(--source/--backend/--engine/--acp-version)·--token-stdin·--safe-defaults·--force·
 * --interactive·--no-interactive 는 제외한다(최소 표면 원칙). 전부 takesValue:true.
 */
const LANE_SET_FLAGS: readonly FlagSpec[] = [
  { name: "--perm-tier", takesValue: true },
  { name: "--allowlist", takesValue: true },
  { name: "--denylist", takesValue: true },
  { name: "--hard-deny", takesValue: true },
  { name: "--cwd", takesValue: true },
  { name: "--engine-args", takesValue: true },
  { name: "--lang", takesValue: true },
  { name: "--file-mode", takesValue: true },
  { name: "--chat-id", takesValue: true },
  { name: "--allow-from", takesValue: true },
  { name: "--root", takesValue: true },
  { name: "--inbox", takesValue: true },
  { name: "--approvals", takesValue: true },
  { name: "--outbox", takesValue: true },
];

/**
 * 레인 정체성 필드(source/backend/engine/acp_version) — `lane set` 에서 편집 불가.
 * `LANE_SET_FLAGS` 에는 등록하지 않는다(등록하면 자동완성에 노출되고 부분집합 단정도 깨진다) —
 * `runLane` 이 `parseCommand` 앞단에서 raw argv 를 이 목록으로 pre-scan 해 친절 오류로 차단한다.
 */
export const LANE_SET_IDENTITY_FLAGS: readonly string[] = [
  "--source",
  "--backend",
  "--engine",
  "--acp-version",
];

/** lane 하위 명령(정식 이름 — list/remove 별칭은 자동완성 미노출, 디스패치만 허용). */
const LANE_SUBS: readonly SubSpec[] = [
  { name: "add", flags: LANE_ADD_FLAGS, positional: ["proj", "lane"] },
  { name: "set", flags: LANE_SET_FLAGS, positional: ["proj", "lane"] },
  { name: "ls", aliases: ["list"], flags: [], positional: ["proj"] },
  { name: "show", flags: [], positional: ["proj", "lane"] },
  { name: "rm", aliases: ["remove"], flags: LANE_RM_FLAGS, positional: ["proj", "lane"] },
  { name: "help", flags: [] },
];

/** `proj ls`/`proj rm` 하위 명령 플래그. */
const PROJ_LS_FLAGS: readonly FlagSpec[] = [{ name: "--json" }];
const PROJ_RM_FLAGS: readonly FlagSpec[] = [{ name: "--force" }];

/** proj 하위 명령 — ls(프로젝트 목록)·rm(프로젝트 삭제). */
const PROJ_SUBS: readonly SubSpec[] = [
  { name: "ls", aliases: ["list"], flags: PROJ_LS_FLAGS },
  { name: "rm", aliases: ["remove"], flags: PROJ_RM_FLAGS, positional: ["proj"] },
  { name: "help", flags: [] },
];

/** 최상위 명령 SSOT. hidden 명령은 도움말·자동완성에서 제외. */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: "init", args: "[<proj>]", flags: [], positional: ["proj"], desc: "guided setup", usageKey: "usage.init" }, // prettier-ignore
  { name: "up", args: "<proj>", flags: [], positional: ["proj"], desc: "start lanes (daemon)", usageKey: "usage.up" }, // prettier-ignore
  { name: "down", args: "<proj>", flags: [], positional: ["proj"], desc: "stop the daemon", usageKey: "usage.down" }, // prettier-ignore
  { name: "restart", args: "<proj>", flags: [], positional: ["proj"], desc: "restart the daemon", usageKey: "usage.restart" }, // prettier-ignore
  { name: "status", args: "[<proj>]", flags: [{ name: "--all" }, { name: "--json" }], positional: ["proj"], desc: "lane status", usageKey: "usage.status" }, // prettier-ignore
  { name: "doctor", args: "[<proj>]", flags: [{ name: "--json" }], positional: ["proj"], desc: "environment checks", usageKey: "usage.doctor" }, // prettier-ignore
  { name: "logs", args: "<proj> <lane> [N]", flags: [{ name: "--engine" }, { name: "--daemon" }, { name: "--follow", short: "-f" }], positional: ["proj", "lane"], desc: "lane logs", usageKey: "usage.logs" }, // prettier-ignore
  { name: "sessions", args: "<proj> <lane>", flags: [{ name: "--json" }], positional: ["proj", "lane"], desc: "engine sessions", usageKey: "usage.sessions" }, // prettier-ignore
  { name: "lane", args: "<add|set|ls|show|rm>", flags: [], subs: LANE_SUBS, desc: "manage lane configs", usageKey: "usage.lane" }, // prettier-ignore
  { name: "proj", args: "<ls|rm>", flags: [], subs: PROJ_SUBS, desc: "list/delete projects", usageKey: "usage.proj" }, // prettier-ignore
  { name: "completion", args: "<bash|zsh>", flags: [], desc: "shell completion", usageKey: "usage.completion" }, // prettier-ignore
  { name: "alias", args: "[names...]", flags: [], desc: "install short aliases", usageKey: "usage.alias" }, // prettier-ignore
  { name: "__daemon", args: "<proj>", flags: [], usageKey: "usage.daemon", hidden: true },
] as const;

/** 도움말·자동완성에 노출할 명령(hidden 제외). */
export function visibleCommands(): CommandSpec[] {
  return COMMAND_SPECS.filter((c) => !c.hidden);
}

/** 이름으로 명령 스펙 조회(디스패치 힌트·help 라우팅). */
export function findCommand(name: string): CommandSpec | undefined {
  return COMMAND_SPECS.find((c) => c.name === name);
}

/** 하위 명령 조회(별칭 포함) — lane/proj 디스패치·`--help` 라우팅이 사용한다. */
export function findSub(cmdName: string, subName: string): SubSpec | undefined {
  const cmd = findCommand(cmdName);
  return cmd?.subs?.find((s) => s.name === subName || s.aliases?.includes(subName));
}

/** 플래그의 long+short 이름 평탄화(자동완성 완성 후보용). */
export function flagNames(spec: { flags: readonly FlagSpec[] }): string[] {
  const out: string[] = [];
  for (const f of spec.flags) {
    out.push(f.name);
    if (f.short) out.push(f.short);
  }
  return out;
}

/** 하위 명령의 플래그 long+short 이름(자동완성·표면 불변 점검용). */
export function subFlagNames(cmdName: string, subName: string): string[] {
  const sub = findSub(cmdName, subName);
  return sub ? flagNames(sub) : [];
}

/** 값 플래그(takesValue) 의 키 집합(`--` 제거) — 파서가 다음 토큰을 값으로 소비할지 판정. */
export function valueKeys(flags: readonly FlagSpec[]): Set<string> {
  return new Set(flags.filter((f) => f.takesValue).map((f) => f.name.slice(2)));
}

/**
 * 오타 추정 — 후보 중 대상과 편집거리가 가장 가까운 이름들(임계 이하)을 반환.
 * 미지원 명령 힌트("did you mean")용. 완전 일치는 호출 전 이미 걸러진 상태를 가정.
 */
export function suggestCommands(input: string, max = 2): string[] {
  const names = visibleCommands().map((c) => c.name);
  const scored = names
    .map((name) => ({ name, d: editDistance(input, name) }))
    // 짧은 명령의 오타를 잡되 무관한 제안 남발 방지 — 거리 ≤ max(2, len/2).
    .filter(({ name, d }) => d <= Math.max(2, Math.floor(name.length / 2)))
    .sort((a, b) => a.d - b.d);
  return scored.slice(0, max).map((s) => s.name);
}

/** Levenshtein 편집거리(오타 제안용, 소규모 문자열 전용). */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j]!, dp[j - 1]!);
      prev = tmp;
    }
  }
  return dp[n]!;
}
