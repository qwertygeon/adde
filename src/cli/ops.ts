/**
 * `adde status|doctor|logs` — 운영 가시성 명령의 CLI 표면.
 * core/diagnostics 의 읽기 전용 로직을 호출하고 표/JSON/텍스트로 표면화한다.
 */
import { collectStatus, collectAllStatus, runDoctor, readLogs, readHalt } from "../core/diagnostics.js";
import { checkForUpdate, formatUpdateNotice } from "../core/update-check.js";
import { errMsg } from "../shared/errors.js";
import type { LaneStatusRow, AggregatedLaneStatusRow, DoctorCheck } from "../core/diagnostics.js";
import type { HaltRecord } from "../core/crash-loop.js";
import { USAGE, cmdError, flagErrorText, EXIT } from "../core/messages.js";
import { t } from "../shared/i18n.js";
import { readLedger, formatWhen } from "../core/session-ledger.js";
import { lanePaths, defaultBase } from "../shared/paths.js";
import { daemonLogPaths } from "../core/launchd.js";
import { readFile } from "node:fs/promises";
import { followFile } from "../core/log-follow.js";
import { findCommand } from "./spec.js";
import { parseCommand } from "./parse.js";
import type { ParseResult } from "./parse.js";

const STATUS_SPEC = findCommand("status")!;
const DOCTOR_SPEC = findCommand("doctor")!;
const LOGS_SPEC = findCommand("logs")!;
const SESSIONS_SPEC = findCommand("sessions")!;

/** ms → 사람용 경과시간(예: 1h2m, 3m4s, 12s). */
function formatUptime(ms: number | null): string {
  if (ms === null) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

/** ISO 시각 → 현재 기준 경과(예: 12s, 3m4s). null 이면 "-". */
function formatAge(iso: string | null): string {
  if (iso === null) return "-";
  const ms = Date.now() - Date.parse(iso);
  return formatUptime(Number.isFinite(ms) ? Math.max(0, ms) : null);
}

function statusTable(rows: LaneStatusRow[]): string {
  if (rows.length === 0) return t("ops.status.noLanesConf");
  const header = ["LANE", "STATUS", "PID", "UPTIME", "SEEN", "SOURCE"];
  const body = rows.map((r) => [
    r.lane,
    r.status,
    r.pid === null ? "-" : String(r.pid),
    formatUptime(r.uptimeMs),
    formatAge(r.lastSeenAt),
    r.source ?? "-",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => (row[i] ?? "").length)),
  );
  const fmt = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  return [fmt(header), ...body.map(fmt)].join("\n");
}

/**
 * 집계 status 표 — PROJECT 컬럼을 앞에 둔다(다중 프로젝트 뷰).
 * 단일 프로젝트 표(statusTable)와 분리 — 기존 `status <proj>` 출력은 불변.
 */
function statusTableAggregate(
  rows: AggregatedLaneStatusRow[],
  all: boolean,
  totalRegistered: number,
): string {
  if (rows.length === 0) {
    // 등록 자체가 0 이면(또는 --all) 곧바로 lane add 로 유도한다 — "실행 중 없음 → --all 써봐 →
    // 그래도 없음 → lane add" 의 2단계 탐색을 피한다. 등록은 있는데 실행만 없을 때만 --all 을 권한다.
    if (all || totalRegistered === 0) return t("ops.status.noLanesRegistered");
    return t("ops.status.noRunning");
  }
  const header = ["PROJECT", "LANE", "STATUS", "PID", "UPTIME", "SEEN", "SOURCE"];
  const body = rows.map((r) => [
    r.proj,
    r.lane,
    r.status,
    r.pid === null ? "-" : String(r.pid),
    formatUptime(r.uptimeMs),
    formatAge(r.lastSeenAt),
    r.source ?? "-",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => (row[i] ?? "").length)),
  );
  const fmt = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  return [fmt(header), ...body.map(fmt)].join("\n");
}

/**
 * 새 npm 버전이 있으면 안내 한 줄을 stdout 에 덧붙인다(보조 — 조회 실패는 무시).
 * 네트워크 조회는 대화형(TTY)에서만 허용해 파이프·스크립트에는 지연·잡음을 주지 않는다.
 */
async function printUpdateNoticeIfAny(): Promise<void> {
  try {
    const notice = await checkForUpdate({ allowNetwork: process.stdout.isTTY === true });
    // 조언성 알림 — 1차 데이터가 아니므로 stderr. TTY 게이트(allowNetwork)는 불변.
    if (notice) process.stderr.write("\n" + formatUpdateNotice(notice) + "\n");
  } catch {
    // 보조 기능 — 조회 실패는 흡수.
  }
}

export async function runStatus(rest: readonly string[], parsed?: ParseResult): Promise<number> {
  const p = parsed ?? parseCommand(STATUS_SPEC, rest);
  if (p.error) {
    process.stderr.write(`${cmdError("status", flagErrorText(p.error))}\n\n${USAGE.status}\n`);
    return EXIT.USAGE;
  }
  const json = p.flags.json === true;
  const all = p.flags.all === true;
  const proj = p.positional[0];

  // 인자 없음 → 전 프로젝트 집계(CCTG parity). 기본은 실행 중(정지 제외), --all 은 정지 포함 전체.
  if (!proj) {
    const allRows = await collectAllStatus();
    const rows = all ? allRows : allRows.filter((r) => r.status !== "stopped");
    // halt 조회를 json/text 분기 밖으로 리프트 — 두 모드·종료 코드 모두 halt 를 반영한다.
    // 대상 프로젝트 집합은 비필터 allRows 에서 파생한다 — 표시 필터(rows)로 파생하면 전 레인
    // stopped 인 halt 프로젝트가 기본 뷰에서 빠져 halt 가 누락된다.
    const base = defaultBase();
    const haltMap: Record<string, HaltRecord | null> = {};
    for (const p of [...new Set(allRows.map((r) => r.proj))]) {
      haltMap[p] = await readHalt(base, p);
    }
    if (json) {
      // 최상위 배열 대신 {v, lanes, halt} 객체(halt 는 프로젝트별 상태를 담는 자리). `v` = 스키마
      // 버전(구조 변경 시 증가 — 소비자가 해석 계약을 분기).
      process.stdout.write(JSON.stringify({ v: 1, lanes: rows, halt: haltMap }, null, 2) + "\n");
    } else {
      process.stdout.write(statusTableAggregate(rows, all, allRows.length) + "\n");
      // 경고 블록은 조언성 진단 — 표(1차 데이터)와 분리해 stderr 로 출력.
      const dead = rows.filter((r) => r.status === "dead");
      if (dead.length > 0) {
        process.stderr.write(
          "\n" +
            t("ops.status.deadWarnAggregate", {
              lanes: dead.map((r) => `${r.proj}/${r.lane}`).join(", "),
            }) +
            "\n",
        );
      }
      const stale = rows.filter((r) => r.status === "stale");
      if (stale.length > 0) {
        process.stderr.write(
          "\n" +
            t("ops.status.staleWarnAggregate", {
              lanes: stale.map((r) => `${r.proj}/${r.lane}`).join(", "),
            }) +
            "\n",
        );
      }
      const errored = rows.filter((r) => r.status === "error");
      if (errored.length > 0) {
        process.stderr.write(
          "\n" +
            t("ops.status.errorWarnAggregate", {
              lanes: errored
                .map((r) => `${r.proj}/${r.lane}${r.error ? ` (${r.error})` : ""}`)
                .join(", "),
            }) +
            "\n",
        );
      }
      // 크래시루프 자가 정지 표면화 — 집계 뷰에 등장한 프로젝트마다 halt 기록.
      for (const [p, halt] of Object.entries(haltMap)) {
        if (halt) process.stderr.write("\n" + t("ops.status.haltWarn", { proj: p }) + "\n");
      }
      await printUpdateNoticeIfAny();
    }
    const laneBad = rows.some(
      (r) => r.status === "dead" || r.status === "stale" || r.status === "error",
    );
    // halt(크래시루프 자가정지) 존재도 exit 1 신호에 반영 — 기존 laneBad 판정에 더함.
    return laneBad || Object.values(haltMap).some((h) => h !== null) ? EXIT.FAIL : EXIT.OK;
  }

  let rows: LaneStatusRow[];
  try {
    rows = await collectStatus(proj);
  } catch (err) {
    // 잘못된 proj 이름 등 — 원시 예외 대신 명령 스코프 친절 메시지(logs/sessions 와 일관).
    process.stderr.write(cmdError("status", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
  // halt 조회를 json/text 분기 밖으로 리프트(중복 조회 없음) — 두 모드·종료 코드 모두 반영.
  const halt = await readHalt(defaultBase(), proj);
  if (json) {
    // 최상위 배열 대신 {v, lanes, halt} 객체. `v` = 스키마 버전.
    process.stdout.write(JSON.stringify({ v: 1, lanes: rows, halt }, null, 2) + "\n");
  } else {
    process.stdout.write(statusTable(rows) + "\n");
    // 경고 블록은 조언성 진단 — 표(1차 데이터)와 분리해 stderr 로 출력.
    const dead = rows.filter((r) => r.status === "dead");
    if (dead.length > 0) {
      process.stderr.write(
        "\n" +
          t("ops.status.deadWarnSingle", { lanes: dead.map((r) => r.lane).join(", "), proj }) +
          "\n",
      );
    }
    const stale = rows.filter((r) => r.status === "stale");
    if (stale.length > 0) {
      process.stderr.write(
        "\n" +
          t("ops.status.staleWarnSingle", { lanes: stale.map((r) => r.lane).join(", "), proj }) +
          "\n",
      );
    }
    const errored = rows.filter((r) => r.status === "error");
    if (errored.length > 0) {
      process.stderr.write(
        "\n" +
          t("ops.status.errorWarnSingle", {
            lanes: errored.map((r) => `${r.lane}${r.error ? ` (${r.error})` : ""}`).join(", "),
            proj,
          }) +
          "\n",
      );
    }
    // 크래시루프 자가 정지 표면화(경고 텍스트 유지).
    if (halt) {
      process.stderr.write("\n" + t("ops.status.haltWarn", { proj }) + "\n");
    }
    await printUpdateNoticeIfAny();
  }
  // 비정상(error 기동실패·dead 크래시·stale 행) 또는 halt 잔존을 종료 코드로 신호 — 모니터링 친화.
  const laneBad = rows.some(
    (r) => r.status === "dead" || r.status === "stale" || r.status === "error",
  );
  return laneBad || halt !== null ? EXIT.FAIL : EXIT.OK;
}

/** 진단 레벨 → 표시 심볼. init(전역 doctor 요약)과 공유해 레벨 추가 시 드리프트를 막는다. */
export function checkSymbol(level: DoctorCheck["level"]): string {
  return level === "PASS" ? "✔" : level === "WARN" ? "▲" : level === "INFO" ? "ℹ" : "✘";
}

export async function runDoctorCli(
  rest: readonly string[],
  parsed?: ParseResult,
): Promise<number> {
  const p = parsed ?? parseCommand(DOCTOR_SPEC, rest);
  if (p.error) {
    process.stderr.write(`${cmdError("doctor", flagErrorText(p.error))}\n\n${t("usage.doctor")}\n`);
    return EXIT.USAGE;
  }
  const json = p.flags.json === true;
  const proj = p.positional[0];
  let checks: DoctorCheck[];
  try {
    checks = await runDoctor(proj);
  } catch (err) {
    // 잘못된 proj 이름 등 — 원시 예외 대신 명령 스코프 친절 메시지.
    process.stderr.write(cmdError("doctor", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
  const fails = checks.filter((c) => c.level === "FAIL").length;
  if (json) {
    // 기계가독 모드 — 사람용 심볼 루프·요약·업데이트 알림은 억제(텍스트 미혼입).
    // 최상위 배열 대신 {v, checks} 객체로 감싸 스키마 버전을 부여(BREAKING — 기존 배열 소비자).
    process.stdout.write(JSON.stringify({ v: 1, checks }, null, 2) + "\n");
    return fails > 0 ? EXIT.FAIL : EXIT.OK;
  }
  // 체크 리스트(줄+hint)는 "조회한 진단 결과" payload — stdout 유지.
  for (const c of checks) {
    process.stdout.write(`${checkSymbol(c.level)} [${c.level}] ${c.name}: ${c.detail}\n`);
    if (c.hint) process.stdout.write(t("ops.doctor.hint", { hint: c.hint }) + "\n");
  }
  const warns = checks.filter((c) => c.level === "WARN").length;
  const infos = checks.filter((c) => c.level === "INFO").length;
  process.stdout.write(
    "\n" +
      t("ops.doctor.summary", {
        pass: checks.length - fails - warns - infos,
        warn: warns,
        fail: fails,
        info: infos,
      }) +
      "\n",
  );
  // 업데이트 알림만 조언성 — stderr. 체크리스트+요약은 위에서 이미 stdout 으로 나갔다.
  await printUpdateNoticeIfAny();
  return fails > 0 ? EXIT.FAIL : EXIT.OK;
}

/** `adde sessions <proj> <lane>` — 세션 장부 목록(read-only). 재개는 채널 명령으로 수행. */
export async function runSessions(
  rest: readonly string[],
  parsed?: ParseResult,
): Promise<number> {
  const p = parsed ?? parseCommand(SESSIONS_SPEC, rest);
  if (p.error) {
    process.stderr.write(
      `${cmdError("sessions", flagErrorText(p.error))}\n\n${USAGE.sessions}\n`,
    );
    return EXIT.USAGE;
  }
  const json = p.flags.json === true;
  const [proj, lane] = p.positional;
  if (!proj || !lane) {
    process.stderr.write(USAGE.sessions + "\n");
    return EXIT.USAGE;
  }
  let paths;
  try {
    paths = lanePaths(defaultBase(), proj, lane);
  } catch (err) {
    process.stderr.write(errMsg(err) + "\n");
    return EXIT.FAIL;
  }
  const entries = await readLedger(paths);
  if (entries.length === 0) {
    if (json) {
      // 빈 세션도 {v, sessions:[]} 로 감싼다(비어있음 분기도 동일 스키마 유지 — 배열→객체 BREAKING).
      process.stdout.write(JSON.stringify({ v: 1, sessions: [] }, null, 2) + "\n");
    } else {
      process.stdout.write(t("injector.control.sessionsEmpty") + "\n");
    }
    return EXIT.OK;
  }
  let current: string | null = null;
  try {
    current = (await readFile(paths.sessionIdFile, "utf8")).trim() || null;
  } catch {
    // 세션 파일 부재 — 현재 표시 생략
  }
  if (json) {
    const items = entries.map((e) => ({
      id: e.id,
      label: e.label ?? null,
      createdAt: e.createdAt,
      lastActivityAt: e.lastActivityAt,
      current: e.id === current,
    }));
    // 최상위 배열 대신 {v, sessions} 객체(BREAKING — 기존 배열 소비자).
    process.stdout.write(JSON.stringify({ v: 1, sessions: items }, null, 2) + "\n");
    return EXIT.OK;
  }
  const lines = entries.map((e, i) => {
    const label = e.label ?? t("injector.control.sessionsNoLabel");
    const mark = e.id === current ? " ◀" : "";
    return (
      t("injector.control.sessionsItem", {
        n: i + 1,
        label,
        last: formatWhen(e.lastActivityAt),
        id: e.id,
      }) + mark
    );
  });
  // 힌트는 CLI 전용 문구를 쓴다 — 채널용(control.sessionsHint)은 "checkbox label" 을 언급해
  // 터미널 사용자에겐 생소하다. 재개가 채널 동작임을 CLI 맥락으로 안내한다.
  process.stdout.write(
    `${t("injector.control.sessionsHeader")}\n${lines.join("\n")}\n\n${t("ops.sessions.hint")}\n`,
  );
  return EXIT.OK;
}

/** 파일의 마지막 n 줄(빈 줄 제외). 부재·읽기 실패 시 null. */
async function readTail(path: string, n: number): Promise<string[] | null> {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter((l) => l.length > 0)
      .slice(-Math.max(1, n));
  } catch {
    return null;
  }
}

/**
 * `adde logs <proj> --daemon [N]` — launchd 데몬 로그(기동 실패 원인 등)의 최근 N줄.
 * `json=true` 시 텍스트 대신 `{proj,path,exists,lines}` 를 stdout 에 직렬화(레인 무관이라 lane 필드 없음).
 */
async function runDaemonLogs(proj: string, n: number, json = false): Promise<number> {
  let logs;
  try {
    logs = daemonLogPaths(proj);
  } catch (err) {
    // 잘못된 proj 이름(경로 탈출 차단 등) — 친절 메시지.
    process.stderr.write(errMsg(err) + "\n");
    return EXIT.FAIL;
  }
  // 실패 원인은 stderr 로그(.err.log)에 쌓인다 — 그걸 우선 표시.
  const lines = await readTail(logs.err, n);
  if (json) {
    process.stdout.write(
      JSON.stringify(
        { v: 1, proj, path: logs.err, exists: lines !== null, lines: lines ?? [] },
        null,
        2,
      ) + "\n",
    );
    return EXIT.OK;
  }
  if (lines === null) {
    process.stdout.write(t("ops.logs.daemonNotFound", { path: logs.err, proj }) + "\n");
    return EXIT.OK;
  }
  if (lines.length === 0) {
    process.stdout.write(t("ops.logs.empty", { path: logs.err }) + "\n");
    return EXIT.OK;
  }
  process.stdout.write(lines.join("\n") + "\n");
  return EXIT.OK;
}

/**
 * `logs` 줄수 인자 파싱 — 미지정(undefined)은 무경고 기본 50(불변). 지정됐으나 비숫자·0·음수면
 * 경고(warn=true)와 함께 기본 50 폴백. 유효(정수>0)면 그 값을 그대로 쓴다.
 */
export function parseLineCount(raw: string | undefined): { n: number; warn: boolean } {
  if (raw === undefined) return { n: 50, warn: false };
  if (/^\d+$/.test(raw) && Number(raw) > 0) return { n: Number(raw), warn: false };
  return { n: 50, warn: true };
}

export async function runLogs(rest: readonly string[], parsed?: ParseResult): Promise<number> {
  const p = parsed ?? parseCommand(LOGS_SPEC, rest);
  if (p.error) {
    process.stderr.write(`${cmdError("logs", flagErrorText(p.error))}\n\n${USAGE.logs}\n`);
    return EXIT.USAGE;
  }
  const engine = p.flags.engine === true;
  const daemon = p.flags.daemon === true;
  const follow = p.flags.follow === true;
  const json = p.flags.json === true;
  const positional = p.positional;
  const [proj, lane, nRaw] = positional;

  // --daemon 은 레인 무관(프로젝트 데몬 로그) — proj 만 필요, 둘째 위치인자는 N.
  // daemon 로그는 launchd 소유·제자리 트림이라 follow 대상이 아니다(-f 는 무시하고 스냅샷만 출력).
  if (daemon) {
    if (!proj) {
      process.stderr.write(USAGE.logs + "\n");
      return EXIT.USAGE;
    }
    // N 은 proj 뒤 마지막 위치인자 — `logs proj --daemon 100` / `logs proj lane --daemon 100` 모두
    // 수용(후자는 lane 이 무시되고 마지막 인자가 N). 비daemon 과 동일하게 parseLineCount 를 경유해
    // 비숫자·0·음수를 무경고 흡수하지 않는다.
    const dCandidates = positional.slice(1);
    const dRaw = dCandidates.length > 0 ? dCandidates[dCandidates.length - 1] : undefined;
    const { n: dn, warn: dWarn } = parseLineCount(dRaw);
    if (dWarn && dRaw !== undefined) {
      process.stderr.write(t("ops.logs.badCount", { raw: dRaw }) + "\n");
    }
    return runDaemonLogs(proj, dn, json);
  }

  if (!proj || !lane) {
    process.stderr.write(USAGE.logs + "\n");
    return EXIT.USAGE;
  }
  const { n, warn } = parseLineCount(nRaw);
  if (warn && nRaw !== undefined) {
    process.stderr.write(t("ops.logs.badCount", { raw: nRaw }) + "\n");
  }
  // follow 의 SIGINT graceful 종료 계약은 스냅샷 출력 창을 포함한다 — 핸들러를 스냅샷 출력
  // 전에 등록해, 그 창에 도착한 SIGINT 가 기본 처분(시그널 종료)으로 새지 않게 한다.
  // 비-follow 경로는 등록하지 않는다(기본 처분 유지 — 최소 표면). --json 은 비스트리밍 계약이라
  // follow 보다 우선한다 — follow 가 지정돼도 --json 이면 스냅샷만 내고 follow 루프에 진입하지 않는다.
  let abort: AbortController | null = null;
  let onSigint: (() => void) | null = null;
  if (follow && !json) {
    const ctrl = new AbortController();
    abort = ctrl;
    onSigint = () => ctrl.abort();
    process.once("SIGINT", onSigint);
  }
  try {
    let result;
    try {
      result = await readLogs(proj, lane, n, { engine });
    } catch (err) {
      // proj/lane 검증 실패(경로 탈출 차단 등) — 친절한 메시지 후 비정상 종료코드.
      process.stderr.write(errMsg(err) + "\n");
      return EXIT.FAIL;
    }
    if (json) {
      process.stdout.write(
        JSON.stringify(
          { v: 1, proj, lane, path: result.path, exists: result.exists, lines: result.lines },
          null,
          2,
        ) + "\n",
      );
      return EXIT.OK;
    }
    if (!result.exists) {
      // follow 요청이어도 시작 시 부재면 생성 대기 상주하지 않는다.
      const what = engine ? t("ops.logs.whatEngine") : t("ops.logs.whatTranscript");
      process.stdout.write(t("ops.logs.notFound", { what, path: result.path, proj }) + "\n");
      return EXIT.OK;
    }
    if (result.lines.length === 0) {
      process.stdout.write(t("ops.logs.empty", { path: result.path }) + "\n");
    } else {
      process.stdout.write(result.lines.join("\n") + "\n");
    }
    if (!follow || abort === null) return EXIT.OK;

    // follow 진입 — 스냅샷이 실제로 읽은 지점(endOffset/startIno)에서 정확히 이어 추적한다.
    // 별도 stat 재조회 없이 readLogs 의 원자 취득 결과를 그대로 이어받아 L-2 유실 창을 닫는다.
    await followFile(result.path, {
      onData: (chunk) => process.stdout.write(chunk),
      signal: abort.signal,
      startOffset: result.endOffset,
      startIno: result.startIno,
      onWatchError: (err) => {
        process.stderr.write(t("ops.logs.watchError", { msg: errMsg(err) }) + "\n");
      },
    });
    return EXIT.OK;
  } finally {
    // 조기 return(검증 실패·부재) 포함 전 경로에서 once-핸들러를 해제 — 한 프로세스에서
    // 반복 호출되는 환경(vitest 워커 등)의 리스너 누적을 막는다.
    if (onSigint !== null) process.off("SIGINT", onSigint);
  }
}
