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

async function handleAdd(rest: readonly string[]): Promise<number> {
  const { positional, flags } = parseArgs(rest, ADD_VALUE_KEYS);
  const [proj, lane] = positional;
  if (!proj || !lane) {
    process.stderr.write(USAGE.laneAdd + "\n");
    return 1;
  }

  const opts: LaneAddOptions = {};
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

  const result = await laneAdd(proj, lane, opts);
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
