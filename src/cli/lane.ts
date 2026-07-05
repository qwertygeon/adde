/**
 * `adde lane <add|ls|show|rm>` 서브커맨드 그룹 — 레인 .conf 설정 CLI.
 * argv 파싱 후 core/lane-config 의 코어 함수에 위임하고, 결과/오류를 stdout/stderr 로 표면화.
 */
import {
  laneAdd,
  laneList,
  laneShow,
  laneRemove,
  LaneConfigError,
  parseCsv,
} from "../core/lane-config.js";
import type { LaneAddOptions } from "../core/lane-config.js";
import { collectStatus } from "../core/diagnostics.js";
import { USAGE, buildLaneUsage, cmdError, laneError, unknownLaneSub } from "../core/messages.js";
import { errMsg } from "../shared/errors.js";
import { formatException } from "../shared/notify.js";
import { t } from "../shared/i18n.js";
import { DEFAULT_AUTOPASS_DENYLIST } from "../shared/deny-match.js";
import { createPrompter } from "./prompt.js";
import type { Ask } from "./prompt.js";

export type { Ask } from "./prompt.js";

/** `--key value` / `--flag` 혼합 파싱. 값이 필요한 키는 valueKeys 로 지정. */
interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: readonly string[], valueKeys: ReadonlySet<string>): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const eq = key.indexOf("=");
      if (eq !== -1) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else if (valueKeys.has(key)) {
        const next = argv[i + 1];
        if (next === undefined) throw new LaneConfigError(t("lane.valueRequired", { key }));
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const ADD_VALUE_KEYS = new Set([
  "source",
  "engine",
  "backend",
  "perm-tier",
  "acp-version",
  "cwd",
  "allowlist",
  "denylist",
  "hard-deny",
  "chat-id",
  "allow-from",
  "file-mode",
  "lang",
  "root",
  "inbox",
  "approvals",
  "outbox",
]);

/**
 * 대화형 여부 결정 — 명시 `--interactive`, 또는 (`--no-interactive` 아님 && 필드 플래그 없음 && TTY).
 * 필드 플래그(값 키·`--safe-defaults`·`--token-stdin`)가 하나라도 있으면 스크립트 의도로 보고 비대화형.
 */
export function shouldRunInteractive(
  flags: Record<string, string | true>,
  isTTY: boolean,
): boolean {
  const fieldFlagsGiven =
    [...ADD_VALUE_KEYS].some((k) => flags[k] !== undefined) ||
    flags["safe-defaults"] === true ||
    flags["token-stdin"] === true;
  return (
    flags["interactive"] === true ||
    (flags["no-interactive"] !== true && !fieldFlagsGiven && isTTY === true)
  );
}

function flagStr(flags: Record<string, string | true>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 유효한 응답이 나올 때까지 재질의한다(숫자·CSV 필드 입력 시점 검증). */
async function askUntil(
  ask: Ask,
  question: string,
  def: string,
  valid: (v: string) => boolean,
  retry: string,
): Promise<string> {
  let v = await ask(question, def);
  while (!valid(v)) v = await ask(retry, def);
  return v;
}

/**
 * enum 필드를 번호(1/2/…) 또는 값 문자열로 선택한다. 유효할 때까지 재질의하고 정규화된 값을 반환.
 * 번호는 options 순서(1-기반)에 매핑한다. allowEmpty 면 빈 입력을 ""(전역/기본 위임)로 허용.
 * 직접 타이핑 없이 번호로 고를 수 있게 하는 대화형 편의 — 라벨 아래 번호 메뉴를 함께 출력한다.
 */
async function askEnum(
  ask: Ask,
  label: string,
  options: readonly string[],
  def: string,
  opts: { allowEmpty?: boolean } = {},
): Promise<string> {
  const menu = options.map((o, i) => `  ${i + 1}) ${o}`).join("\n");
  const question = `${label}\n${menu}`;
  for (;;) {
    const raw = (await ask(question, def)).trim().toLowerCase();
    if (opts.allowEmpty && raw === "") return "";
    if (options.includes(raw)) return raw;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1] as string;
  }
}

/**
 * 소스별 필드를 순차 질의해 LaneAddOptions 를 구성한다(대화형 default).
 * enum·숫자 필드는 입력 시점에 검증·재질의한다. askSecret 이 주어지면 telegram 봇 토큰을
 * 가려진 입력으로 수집한다(없거나 빈 입력이면 생성 후 .env/--token-stdin 안내로 위임).
 * ask/askSecret 주입으로 단위 테스트 가능.
 */
export async function collectInteractive(
  ask: Ask,
  askSecret?: (question: string) => Promise<string>,
  askPath: Ask = ask,
): Promise<LaneAddOptions> {
  const opts: LaneAddOptions = {};
  const isNumericId = (v: string): boolean => /^-?\d+$/.test(v);
  const isIdCsv = (v: string): boolean => {
    const ids = parseCsv(v);
    return ids.length > 0 && ids.every(isNumericId);
  };

  const source = await askEnum(ask, t("lane.prompt.source"), ["markdown", "telegram"], "markdown");
  opts.source = source;
  opts.engine = await ask("engine", "claude-agent-acp");
  opts.backend = await ask("backend", "acp");
  opts.perm_tier = await askEnum(ask, t("lane.prompt.permTier"), ["acp", "autopass"], "acp");
  opts.acp_version = await ask("acp_version", "v1");

  const allow = await ask(t("lane.prompt.allowlist"), "");
  if (allow) opts.allowlist = parseCsv(allow);
  if (opts.perm_tier === "autopass") {
    const deny = await ask(t("lane.prompt.denylist"), DEFAULT_AUTOPASS_DENYLIST.join(","));
    if (deny) opts.denylist = parseCsv(deny);
  }
  // 방어심화 하드-거부 기본값(sudo·rm -rf·git 강제·자격증명 읽기 등 즉시 거부) — 기본 켬 권장.
  const safeDefaults = (await ask(t("lane.prompt.safeDefaults"), "y")).toLowerCase();
  if (safeDefaults === "y" || safeDefaults === "yes") opts.safe_defaults = true;

  const lang = await askEnum(ask, t("lane.prompt.lang"), ["en", "ko"], "", { allowEmpty: true });
  if (lang) opts.lang = lang;

  const cwd = await askPath(t("lane.prompt.cwd"), "");
  if (cwd) opts.cwd = cwd;

  if (source === "telegram") {
    const chatId = await askUntil(
      ask,
      t("lane.prompt.chatId"),
      "",
      (v) => v === "" || isNumericId(v),
      t("lane.retry.chatId"),
    );
    if (chatId) opts.chat_id = chatId;
    const allowFrom = await askUntil(
      ask,
      t("lane.prompt.allowFrom"),
      "",
      (v) => v === "" || isIdCsv(v),
      t("lane.retry.allowFrom"),
    );
    if (allowFrom) opts.allow_from = allowFrom;
  } else {
    const root = await askPath(t("lane.prompt.root"), "");
    if (root) opts.root = root;
    const inbox = await askPath(t("lane.prompt.inbox"), "inbox.md");
    if (inbox) opts.inbox = inbox;
    const approvals = await askPath(t("lane.prompt.approvals"), "");
    if (approvals) opts.approvals = approvals;
    const outbox = await askPath(t("lane.prompt.outbox"), "");
    if (outbox) opts.outbox = outbox;
  }

  const fileMode = await askEnum(ask, t("lane.prompt.fileMode"), ["private", "shared"], "private");
  if (fileMode && fileMode !== "private") opts.file_mode = fileMode;

  // 봇 토큰(telegram) — 가려진 입력. 빈 입력이면 생성 후 안내로 위임(시크릿 비노출).
  if (source === "telegram" && askSecret) {
    const token = await askSecret(t("lane.prompt.token"));
    if (token) opts.token = token;
  }

  return opts;
}

async function handleAdd(rest: readonly string[]): Promise<number> {
  const { positional, flags } = parseArgs(rest, ADD_VALUE_KEYS);
  const [proj, lane] = positional;
  if (!proj || !lane) {
    process.stderr.write(USAGE.laneAdd + "\n");
    return 1;
  }

  const wantInteractive = shouldRunInteractive(flags, process.stdin.isTTY === true);

  let opts: LaneAddOptions;
  if (wantInteractive) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        formatException({
          situation: t("lane.ttyOnly.situation"),
          action: t("lane.ttyOnly.action"),
        }) + "\n",
      );
      return 1;
    }
    const prompter = createPrompter();
    try {
      opts = await collectInteractive(prompter.ask, prompter.askSecret, prompter.askPath);
    } finally {
      prompter.close();
    }
    if (flags["force"] === true) opts.force = true;
  } else {
    opts = {};
    const source = flagStr(flags, "source");
    if (source !== undefined) opts.source = source;
    const engine = flagStr(flags, "engine");
    if (engine !== undefined) opts.engine = engine;
    const backend = flagStr(flags, "backend");
    if (backend !== undefined) opts.backend = backend;
    const permTier = flagStr(flags, "perm-tier");
    if (permTier !== undefined) opts.perm_tier = permTier;
    const acpVersion = flagStr(flags, "acp-version");
    if (acpVersion !== undefined) opts.acp_version = acpVersion;
    const cwd = flagStr(flags, "cwd");
    if (cwd !== undefined) opts.cwd = cwd;
    const lang = flagStr(flags, "lang");
    if (lang !== undefined) opts.lang = lang;
    const chatId = flagStr(flags, "chat-id");
    if (chatId !== undefined) opts.chat_id = chatId;
    const allowFrom = flagStr(flags, "allow-from");
    if (allowFrom !== undefined) opts.allow_from = allowFrom;
    const fileMode = flagStr(flags, "file-mode");
    if (fileMode !== undefined) opts.file_mode = fileMode;
    const root = flagStr(flags, "root");
    if (root !== undefined) opts.root = root;
    const inbox = flagStr(flags, "inbox");
    if (inbox !== undefined) opts.inbox = inbox;
    const approvals = flagStr(flags, "approvals");
    if (approvals !== undefined) opts.approvals = approvals;
    const outbox = flagStr(flags, "outbox");
    if (outbox !== undefined) opts.outbox = outbox;
    const splitTools = (raw: string): string[] =>
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    const allowlist = flagStr(flags, "allowlist");
    if (allowlist !== undefined) opts.allowlist = splitTools(allowlist);
    const denylist = flagStr(flags, "denylist");
    if (denylist !== undefined) opts.denylist = splitTools(denylist);
    const hardDeny = flagStr(flags, "hard-deny");
    if (hardDeny !== undefined) opts.hard_deny = splitTools(hardDeny);
    if (flags["safe-defaults"] === true) opts.safe_defaults = true;
    if (flags["force"] === true) opts.force = true;
    if (flags["token-stdin"] === true) opts.token = (await readStdin()).trim();
  }

  const result = await laneAdd(proj, lane, opts);
  for (const w of result.warnings) process.stdout.write(w + "\n");
  process.stdout.write(t("lane.created", { lane: result.lane, confPath: result.confPath }) + "\n");
  if (result.envPath)
    process.stdout.write(t("lane.tokenWritten", { envPath: result.envPath }) + "\n");
  else if (result.conf.source === "telegram") {
    process.stdout.write(
      t("lane.tokenNext", {
        envPath: result.confPath.replace(/lanes\.d\/.*$/, `state/${result.lane}/.env`),
      }) + "\n",
    );
  }
  process.stdout.write(t("lane.startHint", { proj }) + "\n");
  return 0;
}

async function handleList(rest: readonly string[]): Promise<number> {
  const { positional } = parseArgs(rest, new Set());
  const [proj] = positional;
  if (!proj) {
    process.stderr.write(USAGE.laneLs + "\n");
    return 1;
  }
  const { lanes } = await laneList(proj);
  if (lanes.length === 0) process.stdout.write(t("lane.noLanes", { proj }) + "\n");
  else process.stdout.write(lanes.join("\n") + "\n");
  return 0;
}

async function handleShow(rest: readonly string[]): Promise<number> {
  const { positional } = parseArgs(rest, new Set());
  const [proj, lane] = positional;
  if (!proj || !lane) {
    process.stderr.write(USAGE.laneShow + "\n");
    return 1;
  }
  const { confPath, text } = await laneShow(proj, lane);
  process.stdout.write(`# ${confPath}\n${text}`);
  return 0;
}

async function handleRemove(rest: readonly string[]): Promise<number> {
  const { positional, flags } = parseArgs(rest, new Set());
  const [proj, lane] = positional;
  if (!proj || !lane) {
    process.stderr.write(USAGE.laneRm + "\n");
    return 1;
  }
  const purge = flags["purge"] === true;
  const force = flags["force"] === true;

  // --purge 는 state(.env 토큰 포함)/queue/out 을 지우는 파괴적 동작 — proj rm 과 동일한 가드.
  // 평범한 rm(conf 만 삭제)은 재생성 가능·저위험이라 가드 없이 진행한다.
  if (purge && !force) {
    // 실행 중(또는 크래시·기동실패 잔존)인 레인의 state/queue 를 지우면 데몬 동작을 깬다 — 거부.
    // error 도 포함: 데몬(KeepAlive)이 살아있는 채로 특정 레인만 기동 실패한 경우 runtime.json 에
    // 살아있는 데몬 pid 가 남으므로, state/토큰 삭제는 --force 를 요구한다(proj rm 과 동일 가드 표면).
    const row = (await collectStatus(proj)).find((r) => r.lane === lane);
    if (
      row &&
      (row.status === "running" ||
        row.status === "dead" ||
        row.status === "stale" ||
        row.status === "error")
    ) {
      process.stderr.write(laneError(t("lane.purgeRunning", { proj, lane })) + "\n");
      return 1;
    }
    // 확인 — TTY 면 레인 이름 재입력, 비-TTY 면 --force 요구.
    if (!process.stdin.isTTY) {
      process.stderr.write(laneError(t("lane.purgeNeedForce")) + "\n");
      return 1;
    }
    const prompter = createPrompter();
    let typed: string;
    try {
      typed = await prompter.ask(t("lane.purgeConfirm", { lane }), "");
    } finally {
      prompter.close();
    }
    if (typed.trim() !== lane) {
      process.stdout.write(t("lane.purgeAborted") + "\n");
      return 1;
    }
  }

  const { confPath, purged } = await laneRemove(proj, lane, { purge });
  process.stdout.write(
    (purged ? t("lane.removedPurged", { lane, confPath }) : t("lane.removed", { lane, confPath })) +
      "\n",
  );
  return 0;
}

/**
 * `adde lane ...` 진입. argv 는 "lane" 다음 토큰들.
 * @returns 종료 코드.
 */
export async function runLane(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  // `adde lane <sub> --help` — 전체 lane 옵션 도움말(하위 명령 인자 검증보다 우선).
  if (sub !== undefined && sub !== "help" && (rest.includes("--help") || rest.includes("-h"))) {
    process.stdout.write(`${buildLaneUsage()}\n`);
    return 0;
  }
  try {
    switch (sub) {
      case "add":
        return await handleAdd(rest);
      case "ls":
      case "list":
        return await handleList(rest);
      case "show":
        return await handleShow(rest);
      case "rm":
      case "remove":
        return await handleRemove(rest);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(`${buildLaneUsage()}\n`);
        return 0;
      default:
        process.stderr.write(unknownLaneSub(sub) + "\n");
        return 1;
    }
  } catch (err) {
    // LaneConfigError 는 검증 실패(친절 메시지) — 그 외 예기치 못한 예외도 원시 스택 대신
    // 명령 스코프 메시지로 표면화(방어코드: 어떤 경로든 사용자에게 actionable 하게).
    if (err instanceof LaneConfigError) {
      process.stderr.write(laneError(err.message) + "\n");
    } else {
      process.stderr.write(cmdError("lane", errMsg(err)) + "\n");
    }
    return 1;
  }
}
