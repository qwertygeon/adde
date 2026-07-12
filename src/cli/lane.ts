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
import {
  USAGE,
  buildLaneUsage,
  cmdError,
  laneError,
  unknownLaneSub,
  flagErrorText,
} from "../core/messages.js";
import { errMsg } from "../shared/errors.js";
import { formatException } from "../shared/notify.js";
import { t } from "../shared/i18n.js";
import { DEFAULT_AUTOPASS_DENYLIST } from "../shared/deny-match.js";
import { SOURCE_IDS, SOURCE_REGISTRY } from "../src-adapters/index.js";
import { createPrompter } from "./prompt.js";
import type { Ask } from "./prompt.js";
import { findSub, valueKeys } from "./spec.js";
import { parseCommand } from "./parse.js";
import type { ParseResult } from "./parse.js";

export type { Ask } from "./prompt.js";

/** `lane add` 값 플래그 키(`--` 제거) — spec.ts 의 SubSpec 선언에서 파생(SSOT). */
const laneAddValueKeys = valueKeys(findSub("lane", "add")!.flags);

/**
 * 대화형 여부 결정 — 명시 `--interactive`, 또는 (`--no-interactive` 아님 && 필드 플래그 없음 && TTY).
 * 필드 플래그(값 키·`--safe-defaults`·`--token-stdin`)가 하나라도 있으면 스크립트 의도로 보고 비대화형.
 */
export function shouldRunInteractive(
  flags: Record<string, string | true>,
  isTTY: boolean,
): boolean {
  const fieldFlagsGiven =
    [...laneAddValueKeys].some((k) => flags[k] !== undefined) ||
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

  const source = await askEnum(ask, t("lane.prompt.source"), [...SOURCE_IDS], "markdown");
  opts.source = source;
  opts.perm_tier = await askEnum(ask, t("lane.prompt.permTier"), ["acp", "autopass"], "acp");

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

  const engineArgs = await ask(t("lane.prompt.engineArgs"), "");
  if (engineArgs) opts.engine_args = engineArgs;

  // 공통 파일모드 프롬프트를 소스별 위저드보다 먼저 — 리팩터 전 프롬프트 순서(파일모드 → 소스별
  // 토큰 등) 보존. 소스별 위저드가 시크릿(토큰) 프롬프트를 포함하므로 순서 역전 방지.
  const fileMode = await askEnum(ask, t("lane.prompt.fileMode"), ["private", "shared"], "private");
  if (fileMode && fileMode !== "private") opts.file_mode = fileMode;

  // 소스별 필드 프롬프트 위임 — 훅 미제공 소스는 공통 프롬프트만(생략).
  const wizard = SOURCE_REGISTRY[source]?.wizard;
  if (wizard) {
    Object.assign(opts, await wizard.collect({ ask, askSecret, askPath }));
  }

  return opts;
}

async function handleAdd(p: ParseResult): Promise<number> {
  const { positional, flags } = p;
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
    const permTier = flagStr(flags, "perm-tier");
    if (permTier !== undefined) opts.perm_tier = permTier;
    const engineArgs = flagStr(flags, "engine-args");
    if (engineArgs !== undefined) opts.engine_args = engineArgs;
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
  if (result.envPath) {
    process.stdout.write(t("lane.tokenWritten", { envPath: result.envPath }) + "\n");
  } else {
    // 생성 후 힌트 위임 — 훅 미제공 소스는 힌트 없음(생략).
    const hint = SOURCE_REGISTRY[result.conf.source]?.wizard?.postCreateHint?.(result);
    if (hint) process.stdout.write(hint + "\n");
  }
  process.stdout.write(t("lane.startHint", { proj }) + "\n");
  return 0;
}

async function handleList(p: ParseResult): Promise<number> {
  const [proj] = p.positional;
  if (!proj) {
    process.stderr.write(USAGE.laneLs + "\n");
    return 1;
  }
  const { lanes } = await laneList(proj);
  if (lanes.length === 0) process.stdout.write(t("lane.noLanes", { proj }) + "\n");
  else process.stdout.write(lanes.join("\n") + "\n");
  return 0;
}

async function handleShow(p: ParseResult): Promise<number> {
  const [proj, lane] = p.positional;
  if (!proj || !lane) {
    process.stderr.write(USAGE.laneShow + "\n");
    return 1;
  }
  const { confPath, text } = await laneShow(proj, lane);
  process.stdout.write(`# ${confPath}\n${text}`);
  return 0;
}

async function handleRemove(p: ParseResult): Promise<number> {
  const { positional, flags } = p;
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
    // error 도 포함: lane rm --purge 는 (proj rm 과 달리) 데몬을 내리지 않으므로, 데몬(KeepAlive)이
    // 살아있는 채로 특정 레인만 error 이면 살아있는 데몬 pid 하에서 state/토큰을 지우게 된다 → --force 요구.
    // (proj rm 은 삭제 전 unloadDaemon 하므로 error 를 가드에 넣지 않아도 안전 — 두 가드가 error 에서 갈리는 이유.)
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
  if (sub !== undefined && sub !== "help" && parseCommand({ flags: [] }, rest).help) {
    process.stdout.write(`${buildLaneUsage()}\n`);
    return 0;
  }
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(`${buildLaneUsage()}\n`);
    return 0;
  }
  const subSpec = findSub("lane", sub);
  if (!subSpec) {
    process.stderr.write(unknownLaneSub(sub) + "\n");
    return 1;
  }
  try {
    const p = parseCommand(subSpec, rest);
    if (p.error) {
      process.stderr.write(`${laneError(flagErrorText(p.error))}\n\n${buildLaneUsage()}\n`);
      return 1;
    }
    switch (subSpec.name) {
      case "add":
        return await handleAdd(p);
      case "ls":
        return await handleList(p);
      case "show":
        return await handleShow(p);
      case "rm":
        return await handleRemove(p);
      default:
        // 도달하지 않음(lane subs 는 add/ls/show/rm/help 로 한정) — 방어.
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
