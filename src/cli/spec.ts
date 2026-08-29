/**
 * CLI 명령·플래그 스펙(SSOT, v2) — 레인 명령군 제거, project/session/bind/vault 표면으로 교체.
 * 파서(parse.ts)·자동완성(completion.ts)·usage(locales)·디스패치(run.ts)가 공유한다.
 */

/** 위치 인자 종류 — 자동완성 동적 후보(proj/session 이름 스캔)를 결정한다. */
export type ArgKind = "proj" | "session";

export interface FlagSpec {
  name: string;
  short?: string;
  takesValue?: boolean;
}

export interface SubSpec {
  name: string;
  aliases?: readonly string[];
  flags: readonly FlagSpec[];
  positional?: readonly ArgKind[];
  usageKey?: string;
}

export interface CommandSpec {
  name: string;
  args: string;
  flags: readonly FlagSpec[];
  positional?: readonly ArgKind[];
  desc?: string;
  usageKey?: string;
  subs?: readonly SubSpec[];
  hidden?: boolean;
}

export const FLAG_VALUES: Record<string, readonly string[]> = {
  "--perm-tier": ["acp", "autopass"],
  "--file-mode": ["private", "shared"],
  "--lang": ["en", "ko"],
  "--sync-provider": ["local", "icloud"],
  "--surface": ["markdown", "telegram", "discord"],
};

export const DIR_FLAGS = ["--cwd", "--vault", "--backup"] as const;
export const GLOBAL_FLAGS = ["-h", "--help", "-v", "--version"] as const;

const PROJECT_ADD_FLAGS: readonly FlagSpec[] = [
  { name: "--vault", takesValue: true },
  { name: "--cwd", takesValue: true },
  { name: "--engine", takesValue: true },
  { name: "--perm-tier", takesValue: true },
  { name: "--allowlist", takesValue: true },
  { name: "--denylist", takesValue: true },
  { name: "--hard-deny", takesValue: true },
  { name: "--safe-defaults" },
  { name: "--backup", takesValue: true },
  { name: "--retention-days", takesValue: true },
  { name: "--sync-provider", takesValue: true },
];

const PROJECT_SET_FLAGS: readonly FlagSpec[] = [
  { name: "--unset" },
  { name: "--add-allow", takesValue: true },
  { name: "--rm-allow", takesValue: true },
  { name: "--add-deny", takesValue: true },
  { name: "--rm-deny", takesValue: true },
  { name: "--add-hard-deny", takesValue: true },
  { name: "--rm-hard-deny", takesValue: true },
];

const PROJECT_SUBS: readonly SubSpec[] = [
  { name: "add", flags: PROJECT_ADD_FLAGS, positional: ["proj"] },
  { name: "set", flags: PROJECT_SET_FLAGS, positional: ["proj"] },
  { name: "show", flags: [{ name: "--json" }, { name: "--defaults" }], positional: ["proj"] },
  { name: "ls", aliases: ["list"], flags: [{ name: "--json" }] },
  { name: "rm", aliases: ["remove"], flags: [{ name: "--force" }], positional: ["proj"] },
];

const SESSION_SUBS: readonly SubSpec[] = [
  { name: "new", flags: [{ name: "--engine", takesValue: true }, { name: "--title", takesValue: true }, { name: "--engine-args", takesValue: true }, { name: "--json" }], positional: ["proj"] }, // prettier-ignore
  { name: "ls", aliases: ["list"], flags: [{ name: "--json" }], positional: ["proj"] },
  { name: "show", flags: [{ name: "--json" }], positional: ["proj", "session"] },
  { name: "clear", flags: [], positional: ["proj", "session"] },
  { name: "stop", flags: [{ name: "--json" }], positional: ["proj", "session"] },
  // session 은 선택(생략 시 대상 열거·목록 안내, FR-021).
  { name: "resume", flags: [{ name: "--json" }], positional: ["proj", "session"] },
  // `--force` 제거 — 확인 없는 완전 제거는 `--purge` 전용.
  { name: "rm", aliases: ["remove"], flags: [{ name: "--purge" }], positional: ["proj", "session"] }, // prettier-ignore
];

const BIND_SUBS: readonly SubSpec[] = [
  { name: "add", flags: [{ name: "--surface", takesValue: true }, { name: "--address", takesValue: true }], positional: ["proj", "session"] }, // prettier-ignore
  { name: "rm", aliases: ["remove"], flags: [{ name: "--surface", takesValue: true }, { name: "--address", takesValue: true }], positional: ["proj", "session"] }, // prettier-ignore
  { name: "ls", aliases: ["list"], flags: [{ name: "--json" }], positional: ["proj"] },
];

const VAULT_SUBS: readonly SubSpec[] = [
  { name: "rebuild", flags: [{ name: "--sid", takesValue: true }, { name: "--json" }], positional: ["proj"] }, // prettier-ignore
];

/** 최상위 명령 SSOT. */
export const COMMAND_SPECS: readonly CommandSpec[] = [
  { name: "init", args: "[<proj>]", flags: [], positional: ["proj"], desc: "guided setup", usageKey: "usage.init" }, // prettier-ignore
  { name: "up", args: "<proj>", flags: [{ name: "--json" }], positional: ["proj"], desc: "start the daemon", usageKey: "usage.up" }, // prettier-ignore
  { name: "down", args: "<proj>", flags: [{ name: "--json" }], positional: ["proj"], desc: "stop the daemon", usageKey: "usage.down" }, // prettier-ignore
  { name: "restart", args: "<proj>", flags: [{ name: "--json" }], positional: ["proj"], desc: "restart the daemon", usageKey: "usage.restart" }, // prettier-ignore
  { name: "status", args: "[<proj>]", flags: [{ name: "--all" }, { name: "--json" }], positional: ["proj"], desc: "session status", usageKey: "usage.status" }, // prettier-ignore
  { name: "doctor", args: "[<proj>]", flags: [{ name: "--json" }], positional: ["proj"], desc: "environment checks", usageKey: "usage.doctor" }, // prettier-ignore
  { name: "logs", args: "<proj> <session> [N]", flags: [{ name: "--engine" }, { name: "--daemon" }, { name: "--follow", short: "-f" }, { name: "--json" }], positional: ["proj", "session"], desc: "session event log", usageKey: "usage.logs" }, // prettier-ignore
  { name: "project", args: "<add|set|show|ls|rm>", flags: [], subs: PROJECT_SUBS, desc: "manage projects", usageKey: "usage.project" }, // prettier-ignore
  { name: "session", args: "<new|ls|show|clear|stop|resume|rm>", flags: [], subs: SESSION_SUBS, desc: "manage sessions", usageKey: "usage.session" }, // prettier-ignore
  { name: "bind", args: "<add|rm|ls>", flags: [], subs: BIND_SUBS, desc: "manage channel bindings", usageKey: "usage.bind" }, // prettier-ignore
  { name: "vault", args: "<rebuild>", flags: [], subs: VAULT_SUBS, desc: "vault maintenance", usageKey: "usage.vault" }, // prettier-ignore
  { name: "completion", args: "<bash|zsh>", flags: [], desc: "shell completion", usageKey: "usage.completion" }, // prettier-ignore
  { name: "alias", args: "[names...]", flags: [], desc: "install short aliases", usageKey: "usage.alias" }, // prettier-ignore
  // 명령 전용 — 노트·팔레트 진입점 없음. 인자·플래그 0개(대화형 확인만).
  { name: "factory-reset", args: "", flags: [], desc: "wipe all projects and sessions (factory reset)", usageKey: "usage.factoryReset" }, // prettier-ignore
  { name: "__daemon", args: "<proj>", flags: [], usageKey: "usage.daemon", hidden: true },
] as const;

/** v0.2.x 제거 명령 → 안내(대체 명령) — 실행 시 "제거됨" 안내 + exit 2. */
export const REMOVED_COMMANDS: Record<string, string> = {
  lane: "project / session / bind",
  sessions: "session ls",
  proj: "project",
};

export function visibleCommands(): CommandSpec[] {
  return COMMAND_SPECS.filter((c) => !c.hidden);
}

export function findCommand(name: string): CommandSpec | undefined {
  return COMMAND_SPECS.find((c) => c.name === name);
}

export function findSub(cmdName: string, subName: string): SubSpec | undefined {
  const cmd = findCommand(cmdName);
  return cmd?.subs?.find((s) => s.name === subName || s.aliases?.includes(subName));
}

export function flagNames(spec: { flags: readonly FlagSpec[] }): string[] {
  const out: string[] = [];
  for (const f of spec.flags) {
    out.push(f.name);
    if (f.short) out.push(f.short);
  }
  return out;
}

export function subFlagNames(cmdName: string, subName: string): string[] {
  const sub = findSub(cmdName, subName);
  return sub ? flagNames(sub) : [];
}

export function valueKeys(flags: readonly FlagSpec[]): Set<string> {
  return new Set(flags.filter((f) => f.takesValue).map((f) => f.name.slice(2)));
}

export function suggestCommands(input: string, max = 2): string[] {
  const names = visibleCommands().map((c) => c.name);
  const scored = names
    .map((name) => ({ name, d: editDistance(input, name) }))
    .filter(({ name, d }) => d <= Math.max(2, Math.floor(name.length / 2)))
    .sort((a, b) => a.d - b.d);
  return scored.slice(0, max).map((s) => s.name);
}

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
