/**
 * `adde lane <add|set|ls|show|rm>` 서브커맨드 그룹 — 레인 .conf 설정 CLI.
 * argv 파싱 후 core/lane-config 의 코어 함수에 위임하고, 결과/오류를 stdout/stderr 로 표면화.
 */
import {
  laneAdd,
  laneSet,
  laneList,
  laneShow,
  laneRemove,
  laneKeyMeta,
  LaneConfigError,
  parseCsv,
} from "../core/lane-config.js";
import type { LaneAddOptions, LaneSetOptions } from "../core/lane-config.js";
import {
  LANE_KEY_DESCRIPTORS,
  findDescriptor,
  exposedEditableKeys,
  suggestKeys,
} from "../core/lane-schema.js";
import type { LaneConf } from "../shared/conf.js";
import { collectStatus } from "../core/diagnostics.js";
import {
  USAGE,
  buildLaneUsage,
  cmdError,
  laneError,
  unknownLaneSub,
  flagErrorText,
  EXIT,
} from "../core/messages.js";
import { errMsg } from "../shared/errors.js";
import { formatException } from "../shared/notify.js";
import { t } from "../shared/i18n.js";
import { SOURCE_IDS, SOURCE_REGISTRY } from "../src-adapters/index.js";
import { createPrompter, askYesNo } from "./prompt.js";
import type { Ask } from "./prompt.js";
import { findSub, valueKeys, LANE_SET_IDENTITY_FLAGS } from "./spec.js";
import { parseCommand } from "./parse.js";
import type { ParseResult } from "./parse.js";

export type { Ask } from "./prompt.js";

/** 스키마 i18nLabel 은 런타임 동적 문자열 키라 t 의 리터럴 유니온으로 좁힐 수 없어 캐스팅한다. */
const tLabel = t as unknown as (key: string) => string;

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
  // 안내 줄을 메뉴 뒤 별도 줄로 두어, question() 이 붙이는 ` [def]: ` 가 마지막 옵션이 아니라
  // 안내 줄에 달라붙게 한다(번호/값 입력임을 명확히 — enum 기본값 밀착 해소).
  const question = `${label}\n${menu}\n${t("lane.prompt.enumHint")}`;
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
    // 빈 입력이면 미기록 → laneAdd 가 autopass 기본 denylist 를 적용(동작 동일). 긴 기본 CSV 를
    // `[def]` 로 노출하지 않아 프롬프트가 간결하다.
    const deny = await ask(t("lane.prompt.denylist"), "");
    if (deny) opts.denylist = parseCsv(deny);
  }
  // 방어심화 하드-거부 기본값(sudo·rm -rf·git 강제·자격증명 읽기 등 즉시 거부) — 기본 켬 권장(Yes).
  if (await askYesNo(ask, t("lane.prompt.safeDefaults"), true)) opts.safe_defaults = true;

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
    return EXIT.USAGE;
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
      return EXIT.FAIL;
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
  return EXIT.OK;
}

/** CSV → 트림·빈값 제거 배열. handleAdd 의 splitTools 와 동일 파싱(allowlist/denylist/hard_deny CLI 입력). */
function splitTools(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * argv 토큰(`--flag`/`--flag=v` 양형)에서 레인 정체성 플래그(LANE_SET_IDENTITY_FLAGS)를 찾는다.
 * `parseCommand` 는 이 플래그들을 모르므로(LANE_SET_FLAGS 미등록) 일반 unknown-flag 로
 * 흘려보내기 전에 먼저 검사해 친절 오류로 안내한다.
 */
function scanIdentityFlags(argv: readonly string[]): string | undefined {
  for (const tok of argv) {
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    const name = eq === -1 ? tok : tok.slice(0, eq);
    if (LANE_SET_IDENTITY_FLAGS.includes(name)) return name;
  }
  return undefined;
}

/** 명명 플래그(하위호환)를 LaneSetOptions typed 필드로 수집. 점표기/위저드와 병존한다. */
function collectNamedEdits(flags: Record<string, string | true>): LaneSetOptions {
  const edits: LaneSetOptions = {};
  const permTier = flagStr(flags, "perm-tier");
  if (permTier !== undefined) edits.perm_tier = permTier;
  const cwd = flagStr(flags, "cwd");
  if (cwd !== undefined) edits.cwd = cwd;
  const engineArgs = flagStr(flags, "engine-args");
  if (engineArgs !== undefined) edits.engine_args = engineArgs;
  const lang = flagStr(flags, "lang");
  if (lang !== undefined) edits.lang = lang;
  const fileMode = flagStr(flags, "file-mode");
  if (fileMode !== undefined) edits.file_mode = fileMode;
  const chatId = flagStr(flags, "chat-id");
  if (chatId !== undefined) edits.chat_id = chatId;
  const allowFrom = flagStr(flags, "allow-from");
  if (allowFrom !== undefined) edits.allow_from = allowFrom;
  const root = flagStr(flags, "root");
  if (root !== undefined) edits.root = root;
  const inbox = flagStr(flags, "inbox");
  if (inbox !== undefined) edits.inbox = inbox;
  const approvals = flagStr(flags, "approvals");
  if (approvals !== undefined) edits.approvals = approvals;
  const outbox = flagStr(flags, "outbox");
  if (outbox !== undefined) edits.outbox = outbox;
  const allowlist = flagStr(flags, "allowlist");
  if (allowlist !== undefined) edits.allowlist = splitTools(allowlist);
  const denylist = flagStr(flags, "denylist");
  if (denylist !== undefined) edits.denylist = splitTools(denylist);
  const hardDeny = flagStr(flags, "hard-deny");
  if (hardDeny !== undefined) edits.hard_deny = splitTools(hardDeny);
  return edits;
}

/** conf 에서 canonical key 의 현재값을 표시 문자열로(부재=""; 리스트=CSV). 위저드 프리필·diff 용. */
function currentDisplay(conf: LaneConf, key: string): string {
  const d = findDescriptor(key);
  if (!d) return "";
  const src = conf as unknown as Record<string, unknown>;
  const raw = d.namespace
    ? (src[d.namespace] as Record<string, unknown> | undefined)?.[d.field]
    : src[d.field];
  if (raw === undefined || raw === null) return "";
  return Array.isArray(raw) ? raw.join(",") : String(raw);
}

/**
 * 무인자 대화형 위저드(FR-003) — 노출 편집 키를 소스별로 순회하며 현재값 프리필. 빈 입력=현재값
 * 유지(변경 미기록), 값 입력=변경, enum=번호선택, 경로=Tab완성(askPath). identity 는 편집 표면에
 * 없으므로 자연 건너뜀. 반환은 변경된 점표기 편집만(빈 배열=변경 없음). ask 주입으로 단위 테스트 가능.
 */
export async function collectSetInteractive(
  ask: Ask,
  conf: LaneConf,
  askPath: Ask = ask,
): Promise<Array<{ key: string; value: string }>> {
  const edits: Array<{ key: string; value: string }> = [];
  for (const d of LANE_KEY_DESCRIPTORS) {
    if (!d.exposed || !d.editable) continue;
    if (d.appliesTo !== "common" && d.appliesTo !== conf.source) continue;
    const current = currentDisplay(conf, d.key);
    const label = current ? `${tLabel(d.i18nLabel)} (${current})` : tLabel(d.i18nLabel);
    let input: string;
    if (d.type === "enum") {
      input = await askEnum(ask, label, d.enumValues ?? [], "", { allowEmpty: true });
    } else if (d.type === "path") {
      input = await askPath(label, "");
    } else {
      input = await ask(label, "");
    }
    const val = (input ?? "").trim();
    if (val === "" || val === current) continue; // 빈=유지 / 동일=변경 없음
    edits.push({ key: d.key, value: val });
  }
  return edits;
}

/** 무인자 TTY 위저드 실행 — 수집 → diff 확인 → 적용. 취소·무변경은 exit 0. */
async function runSetWizard(proj: string, lane: string): Promise<number> {
  const { conf } = await laneShow(proj, lane);
  const prompter = createPrompter();
  const collected: { dotEdits: Array<{ key: string; value: string }>; confirmed: boolean } = {
    dotEdits: [],
    confirmed: false,
  };
  try {
    process.stdout.write(t("lane.set.wizardHeader", { lane }) + "\n");
    collected.dotEdits = await collectSetInteractive(prompter.ask, conf, prompter.askPath);
    if (collected.dotEdits.length > 0) {
      process.stdout.write(t("lane.set.diffHeader") + "\n");
      for (const e of collected.dotEdits) {
        const from = currentDisplay(conf, e.key) || t("lane.show.unset");
        process.stdout.write(t("lane.set.diffLine", { key: e.key, from, to: e.value }) + "\n");
      }
      collected.confirmed = await askYesNo(prompter.ask, t("lane.set.confirm"), false);
    }
  } finally {
    prompter.close();
  }
  const { dotEdits, confirmed } = collected;
  if (dotEdits.length === 0) {
    process.stdout.write(t("lane.set.noChange") + "\n");
    return EXIT.OK;
  }
  if (!confirmed) {
    process.stdout.write(t("lane.set.aborted") + "\n");
    return EXIT.OK;
  }
  const result = await laneSet(proj, lane, { edits: dotEdits });
  for (const w of result.warnings) process.stdout.write(w + "\n");
  process.stdout.write(
    t("lane.set.updated", { lane: result.lane, confPath: result.confPath }) + "\n",
  );
  process.stdout.write(t("lane.set.restartHint", { proj }) + "\n");
  return EXIT.OK;
}

async function handleSet(p: ParseResult): Promise<number> {
  const { positional, flags } = p;
  const [proj, lane] = positional;
  if (!proj || !lane) {
    process.stderr.write(USAGE.laneSet + "\n");
    return EXIT.USAGE;
  }

  const edits = collectNamedEdits(flags);
  const rest = positional.slice(2); // proj/lane 뒤 위치인자 = 점표기 key/value 또는 unset 키.
  const unsetMode = flags["unset"] === true;

  if (unsetMode) {
    if (rest.length > 0) edits.unset = rest;
  } else if (rest.length > 0) {
    if (rest.length % 2 !== 0) {
      process.stderr.write(
        laneError(t("laneConfig.err.keyValueIncomplete")) + "\n\n" + USAGE.laneSet + "\n",
      );
      return EXIT.FAIL;
    }
    const dotEdits: Array<{ key: string; value: string }> = [];
    for (let i = 0; i < rest.length; i += 2) {
      dotEdits.push({ key: rest[i]!, value: rest[i + 1]! });
    }
    edits.edits = dotEdits;
  }

  // 실질 편집 유무 — 명명 플래그(base 제외)·점표기 edits·unset 중 하나라도 있으면 편집.
  const anyEdit =
    Object.keys(edits).some((k) => k !== "base" && k !== "edits" && k !== "unset") ||
    (edits.edits?.length ?? 0) > 0 ||
    (edits.unset?.length ?? 0) > 0;

  if (!anyEdit) {
    // 인자 없음 + TTY → 대화형 위저드(FR-003). 비-TTY → no-op 거부(exit 1).
    if (process.stdin.isTTY === true) return await runSetWizard(proj, lane);
    process.stderr.write(laneError(t("laneConfig.err.noEdits")) + "\n\n" + USAGE.laneSet + "\n");
    return EXIT.FAIL;
  }

  const result = await laneSet(proj, lane, edits);
  for (const w of result.warnings) process.stdout.write(w + "\n");
  process.stdout.write(
    t("lane.set.updated", { lane: result.lane, confPath: result.confPath }) + "\n",
  );
  process.stdout.write(t("lane.set.restartHint", { proj }) + "\n");
  return EXIT.OK;
}

async function handleList(p: ParseResult): Promise<number> {
  const [proj] = p.positional;
  if (!proj) {
    process.stderr.write(USAGE.laneLs + "\n");
    return EXIT.USAGE;
  }
  const json = p.flags.json === true;
  const { lanes } = await laneList(proj);
  if (json) {
    // 최상위 배열 대신 {v, lanes} 객체(BREAKING — 기존 배열 소비자). `v` = 스키마 버전.
    process.stdout.write(JSON.stringify({ v: 1, lanes }, null, 2) + "\n");
  } else if (lanes.length === 0) {
    process.stdout.write(t("lane.noLanes", { proj }) + "\n");
  } else {
    process.stdout.write(lanes.join("\n") + "\n");
  }
  return EXIT.OK;
}

/** null/배열/스칼라 값을 사람용 표시 문자열로(부재=미설정 라벨). */
function showValue(v: string | number | string[] | null): string {
  if (v === null) return t("lane.show.unset");
  return Array.isArray(v) ? v.join(",") : String(v);
}

async function handleShow(p: ParseResult): Promise<number> {
  const [proj, lane, key] = p.positional;
  if (!proj || !lane) {
    process.stderr.write(USAGE.laneShow + "\n");
    return EXIT.USAGE;
  }
  const json = p.flags.json === true;
  const defaults = p.flags.defaults === true;
  const { confPath, conf, text } = await laneShow(proj, lane);

  // 단건 key 조회 — value/default/explicit/editable/identity 메타(FR-004, SC-008).
  if (key) {
    const meta = laneKeyMeta(conf, text, key);
    if (!meta) {
      const suggestions = suggestKeys(key);
      const msg =
        suggestions.length > 0
          ? t("laneConfig.err.unknownKeyDidYouMean", { key, suggestions: suggestions.join(", ") })
          : t("laneConfig.err.unknownKey", { key });
      process.stderr.write(laneError(msg) + "\n");
      return EXIT.FAIL;
    }
    if (json) {
      process.stdout.write(JSON.stringify(meta, null, 2) + "\n");
    } else {
      process.stdout.write(
        t("lane.show.line", {
          key: meta.key,
          value: showValue(meta.value),
          default: meta.default === null ? t("lane.show.unset") : String(meta.default),
          explicit: String(meta.explicit),
          editable: String(meta.editable),
          identity: String(meta.identity),
        }) + "\n",
      );
    }
    return EXIT.OK;
  }

  // --defaults — 노출 편집 키와 그 기본값 열거(key 미지정 시).
  if (defaults) {
    const rows = exposedEditableKeys().map((k) => {
      const d = findDescriptor(k)!;
      return { key: k, default: d.default ?? null };
    });
    if (json) {
      process.stdout.write(JSON.stringify({ v: 1, defaults: rows }, null, 2) + "\n");
    } else {
      process.stdout.write(t("lane.show.defaultsHeader") + "\n");
      for (const r of rows) {
        process.stdout.write(
          `  ${r.key} = ${r.default === null ? t("lane.show.unset") : String(r.default)}\n`,
        );
      }
    }
    return EXIT.OK;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ v: 1, lane, confPath, conf }, null, 2) + "\n");
  } else {
    process.stdout.write(`# ${confPath}\n${text}`);
  }
  return EXIT.OK;
}

async function handleRemove(p: ParseResult): Promise<number> {
  const { positional, flags } = p;
  const [proj, lane] = positional;
  if (!proj || !lane) {
    process.stderr.write(USAGE.laneRm + "\n");
    return EXIT.USAGE;
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
      return EXIT.FAIL;
    }
    // 확인 — TTY 면 레인 이름 재입력, 비-TTY 면 --force 요구.
    if (!process.stdin.isTTY) {
      process.stderr.write(laneError(t("lane.purgeNeedForce")) + "\n");
      return EXIT.FAIL;
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
      return EXIT.FAIL;
    }
  }

  const { confPath, purged } = await laneRemove(proj, lane, { purge });
  process.stdout.write(
    (purged ? t("lane.removedPurged", { lane, confPath }) : t("lane.removed", { lane, confPath })) +
      "\n",
  );
  return EXIT.OK;
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
    return EXIT.OK;
  }
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(`${buildLaneUsage()}\n`);
    return EXIT.OK;
  }
  const subSpec = findSub("lane", sub);
  if (!subSpec) {
    // 미지원 *서브커맨드* — "미지원 명령" 계열로 보아 exit 1 유지.
    process.stderr.write(unknownLaneSub(sub) + "\n");
    return EXIT.FAIL;
  }
  try {
    // 정체성 필드(source/backend/engine/acp_version) pre-scan — set 은 이 플래그들을 spec 에
    // 등록하지 않으므로 parseCommand 의 일반 unknown-flag 보다 먼저 친절 오류로 안내한다.
    if (subSpec.name === "set") {
      const identityFlag = scanIdentityFlags(rest);
      if (identityFlag !== undefined) {
        process.stderr.write(
          laneError(t("laneConfig.err.identityFieldImmutable", { field: identityFlag })) + "\n",
        );
        return EXIT.FAIL;
      }
    }
    const p = parseCommand(subSpec, rest);
    if (p.error) {
      process.stderr.write(`${laneError(flagErrorText(p.error))}\n\n${buildLaneUsage()}\n`);
      return EXIT.USAGE;
    }
    switch (subSpec.name) {
      case "add":
        return await handleAdd(p);
      case "set":
        return await handleSet(p);
      case "ls":
        return await handleList(p);
      case "show":
        return await handleShow(p);
      case "rm":
        return await handleRemove(p);
      default:
        // 도달하지 않음(lane subs 는 add/set/ls/show/rm/help 로 한정) — 방어.
        process.stderr.write(unknownLaneSub(sub) + "\n");
        return EXIT.FAIL;
    }
  } catch (err) {
    // LaneConfigError 는 검증 실패(친절 메시지) — 그 외 예기치 못한 예외도 원시 스택 대신
    // 명령 스코프 메시지로 표면화(방어코드: 어떤 경로든 사용자에게 actionable 하게).
    if (err instanceof LaneConfigError) {
      process.stderr.write(laneError(err.message) + "\n");
    } else {
      process.stderr.write(cmdError("lane", errMsg(err)) + "\n");
    }
    return EXIT.FAIL;
  }
}
