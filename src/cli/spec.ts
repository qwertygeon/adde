/**
 * CLI 명령·플래그 스펙(SSOT) — 셸 자동완성·서브커맨드 도움말·미지원 명령 힌트가 공유한다.
 * 명령/플래그를 한 곳에서 선언해 자동완성·힌트가 함께 갱신되도록(확장성): 새 명령·플래그는
 * 여기에 추가하면 completion·help·"did you mean" 힌트에 자동 반영된다. 문구 본문(설명)은
 * i18n 카탈로그가 소유하고, 본 스펙은 이름·인자 형태·플래그 목록(구조)만 담는다.
 */

/** 최상위 명령 스펙. usageKey 는 `adde <cmd> --help` 및 인자 누락 시 출력할 i18n usage 키. */
export interface CommandSpec {
  /** 명령 이름(디스패치·자동완성 후보). */
  name: string;
  /** 위치 인자 형태 힌트(예: `<proj>`, `[<proj>]`). */
  args: string;
  /** 이 명령이 받는 옵션 플래그(자동완성·힌트용). */
  flags: readonly string[];
  /** i18n usage 키(있으면 `--help`·인자누락 시 출력). */
  usageKey?: string;
  /** 하위 명령 이름(예: lane 의 add/ls/show/rm). */
  subs?: readonly string[];
  /** 도움말·자동완성 노출 제외(내부 명령). */
  hidden?: boolean;
}

/** 전역 옵션(모든 명령 위치에서 완성 후보). */
export const GLOBAL_FLAGS = ["-h", "--help", "-v", "--version"] as const;

/** `lane add` 옵션 플래그(SSOT — lane.ts ADD_VALUE_KEYS 의 표면형 `--key`). */
export const LANE_ADD_FLAGS = [
  "--source",
  "--engine",
  "--backend",
  "--channel",
  "--perm-tier",
  "--acp-version",
  "--cwd",
  "--allowlist",
  "--denylist",
  "--hard-deny",
  "--safe-defaults",
  "--lang",
  "--chat-id",
  "--allow-from",
  "--file-mode",
  "--token-stdin",
  "--root",
  "--inbox",
  "--approvals",
  "--outbox",
  "--force",
  "--interactive",
] as const;

/** lane 하위 명령(정식 이름 — list/remove 별칭은 자동완성 미노출, 디스패치만 허용). */
export const LANE_SUBS = ["add", "ls", "show", "rm", "help"] as const;

/** 최상위 명령 SSOT. hidden 명령은 도움말·자동완성에서 제외. */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: "init", args: "[<proj>]", flags: [], usageKey: "usage.init" },
  { name: "up", args: "<proj>", flags: [], usageKey: "usage.up" },
  { name: "down", args: "<proj>", flags: [], usageKey: "usage.down" },
  { name: "restart", args: "<proj>", flags: [], usageKey: "usage.restart" },
  { name: "status", args: "[<proj>]", flags: ["--all", "--json"], usageKey: "usage.status" },
  { name: "doctor", args: "[<proj>]", flags: [], usageKey: "usage.doctor" },
  { name: "logs", args: "<proj> <lane> [N]", flags: ["--engine"], usageKey: "usage.logs" },
  { name: "sessions", args: "<proj> <lane>", flags: [], usageKey: "usage.sessions" },
  { name: "lane", args: "<add|ls|show|rm>", flags: [], subs: LANE_SUBS, usageKey: "usage.lane" },
  { name: "completion", args: "<bash|zsh>", flags: [], usageKey: "usage.completion" },
  { name: "alias", args: "[names...]", flags: [], usageKey: "usage.alias" },
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
