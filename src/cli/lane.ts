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
import { USAGE, buildLaneUsage, laneError, unknownLaneSub } from "../core/messages.js";
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
  "channel",
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

/** 유효한 응답이 나올 때까지 재질의한다(enum·숫자 필드 입력 시점 검증). */
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
 * 소스별 필드를 순차 질의해 LaneAddOptions 를 구성한다(대화형 default).
 * enum·숫자 필드는 입력 시점에 검증·재질의한다. askSecret 이 주어지면 telegram 봇 토큰을
 * 가려진 입력으로 수집한다(없거나 빈 입력이면 생성 후 .env/--token-stdin 안내로 위임).
 * ask/askSecret 주입으로 단위 테스트 가능.
 */
export async function collectInteractive(
  ask: Ask,
  askSecret?: (question: string) => Promise<string>,
): Promise<LaneAddOptions> {
  const opts: LaneAddOptions = {};
  const isNumericId = (v: string): boolean => /^-?\d+$/.test(v);
  const isIdCsv = (v: string): boolean => {
    const ids = parseCsv(v);
    return ids.length > 0 && ids.every(isNumericId);
  };

  let source = (await ask(t("lane.prompt.source"), "telegram")).toLowerCase();
  while (source !== "telegram" && source !== "markdown") {
    source = (await ask(t("lane.sourceRetry"), "telegram")).toLowerCase();
  }
  opts.source = source;
  opts.engine = await ask("engine", "claude-agent-acp");
  opts.backend = await ask("backend", "acp");
  opts.channel = await ask("channel", source);
  opts.perm_tier = await askUntil(
    ask,
    t("lane.prompt.permTier"),
    "acp",
    (v) => v === "acp" || v === "autopass",
    t("lane.retry.permTier"),
  );
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

  const lang = await askUntil(
    ask,
    t("lane.prompt.lang"),
    "",
    (v) => v === "" || v === "en" || v === "ko",
    t("lane.retry.lang"),
  );
  if (lang) opts.lang = lang;

  const cwd = await ask(t("lane.prompt.cwd"), "");
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
    const root = await ask(t("lane.prompt.root"), "");
    if (root) opts.root = root;
    const inbox = await ask(t("lane.prompt.inbox"), "inbox.md");
    if (inbox) opts.inbox = inbox;
    const approvals = await ask(t("lane.prompt.approvals"), "");
    if (approvals) opts.approvals = approvals;
    const outbox = await ask(t("lane.prompt.outbox"), "");
    if (outbox) opts.outbox = outbox;
  }

  const fileMode = await askUntil(
    ask,
    t("lane.prompt.fileMode"),
    "private",
    (v) => v === "private" || v === "shared",
    t("lane.retry.fileMode"),
  );
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
      opts = await collectInteractive(prompter.ask, prompter.askSecret);
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
    const channel = flagStr(flags, "channel");
    if (channel !== undefined) opts.channel = channel;
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
  const { positional } = parseArgs(rest, new Set());
  const [proj, lane] = positional;
  if (!proj || !lane) {
    process.stderr.write(USAGE.laneRm + "\n");
    return 1;
  }
  const { confPath } = await laneRemove(proj, lane);
  process.stdout.write(t("lane.removed", { lane, confPath }) + "\n");
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
    if (err instanceof LaneConfigError) {
      process.stderr.write(laneError(err.message) + "\n");
      return 1;
    }
    throw err;
  }
}
