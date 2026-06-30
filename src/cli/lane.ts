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
} from "../core/lane-config.js";
import type { LaneAddOptions } from "../core/lane-config.js";
import { USAGE, LANE_USAGE, laneError, unknownLaneSub } from "../core/messages.js";
import { formatException } from "../shared/notify.js";
import * as readline from "node:readline/promises";

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
        if (next === undefined) throw new LaneConfigError(`--${key} 에 값이 필요합니다`);
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
  "chat-id",
  "root",
  "inbox",
  "approvals",
  "outbox",
]);

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

/** 한 줄 질의 함수 — (질문, 기본값) → 응답. readline 또는 테스트 더블이 공급. */
export type Ask = (question: string, def?: string) => Promise<string>;

/**
 * 소스별 필드를 순차 질의해 LaneAddOptions 를 구성한다(--interactive).
 * 시크릿 비노출(DEC-002): 봇 토큰은 받지 않는다 — 생성 후 .env/--token-stdin 안내로 위임.
 * ask 주입으로 단위 테스트 가능(DEC-001).
 */
export async function collectInteractive(ask: Ask): Promise<LaneAddOptions> {
  const opts: LaneAddOptions = {};

  let source = (await ask("source (telegram/markdown)", "telegram")).toLowerCase();
  while (source !== "telegram" && source !== "markdown") {
    source = (await ask("  telegram 또는 markdown 중 하나를 입력하세요", "telegram")).toLowerCase();
  }
  opts.source = source;
  opts.engine = await ask("engine", "claude-code-acp");
  opts.backend = await ask("backend", "acp");
  opts.channel = await ask("channel", source);
  opts.perm_tier = await ask("perm_tier", "acp");
  opts.acp_version = await ask("acp_version", "v1");

  const allow = await ask("allowlist (콤마 구분, 없으면 비움)", "");
  if (allow) {
    opts.allowlist = allow
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const cwd = await ask("cwd (레인 작업 폴더 절대경로, 없으면 비움)", "");
  if (cwd) opts.cwd = cwd;

  if (source === "telegram") {
    const chatId = await ask("chat_id (회신 대상, 없으면 비움)", "");
    if (chatId) opts.chat_id = chatId;
  } else {
    const root = await ask("root (markdown 루트 절대경로)", "");
    if (root) opts.root = root;
    const inbox = await ask("inbox (root 상대)", "inbox.md");
    if (inbox) opts.inbox = inbox;
    const approvals = await ask("approvals (root 상대, 없으면 기본)", "");
    if (approvals) opts.approvals = approvals;
    const outbox = await ask("outbox (root 상대, 없으면 기본)", "");
    if (outbox) opts.outbox = outbox;
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

  let opts: LaneAddOptions;
  if (flags["interactive"] === true) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        formatException({
          situation: "--interactive 는 대화형 터미널(TTY)에서만 동작합니다",
          action:
            "플래그로 지정하세요(예: adde lane add <proj> <lane> --source telegram). 옵션 목록은 adde lane help.",
        }) + "\n",
      );
      return 1;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      opts = await collectInteractive(async (q, def) => {
        const a = (await rl.question(`${q}${def ? ` [${def}]` : ""}: `)).trim();
        return a || (def ?? "");
      });
    } finally {
      rl.close();
    }
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
    const chatId = flagStr(flags, "chat-id");
    if (chatId !== undefined) opts.chat_id = chatId;
    const root = flagStr(flags, "root");
    if (root !== undefined) opts.root = root;
    const inbox = flagStr(flags, "inbox");
    if (inbox !== undefined) opts.inbox = inbox;
    const approvals = flagStr(flags, "approvals");
    if (approvals !== undefined) opts.approvals = approvals;
    const outbox = flagStr(flags, "outbox");
    if (outbox !== undefined) opts.outbox = outbox;
    const allowlist = flagStr(flags, "allowlist");
    if (allowlist !== undefined) {
      opts.allowlist = allowlist
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (flags["force"] === true) opts.force = true;
    if (flags["token-stdin"] === true) opts.token = (await readStdin()).trim();
  }

  const result = await laneAdd(proj, lane, opts);
  for (const w of result.warnings) process.stdout.write(w + "\n");
  process.stdout.write(`레인 "${result.lane}" 생성: ${result.confPath}\n`);
  if (result.envPath) process.stdout.write(`토큰 기록: ${result.envPath} (0600)\n`);
  else if (result.conf.source === "telegram") {
    process.stdout.write(
      `다음: 봇 토큰을 ${result.confPath.replace(/lanes\.d\/.*$/, `state/${result.lane}/.env`)} 에 TELEGRAM_BOT_TOKEN=... 으로 두세요\n`,
    );
  }
  process.stdout.write(`기동: adde up ${proj}\n`);
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
  if (lanes.length === 0) process.stdout.write(`${proj}: 레인 없음\n`);
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
  process.stdout.write(`레인 "${lane}" 삭제: ${confPath}\n`);
  return 0;
}

/**
 * `adde lane ...` 진입. argv 는 "lane" 다음 토큰들.
 * @returns 종료 코드.
 */
export async function runLane(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
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
        process.stdout.write(`${LANE_USAGE}\n`);
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
