/**
 * `adde status|doctor|logs` — 운영 가시성 명령의 CLI 표면(v2, 세션 스코프).
 * core/diagnostics 의 읽기 전용 로직을 호출하고 표/JSON/텍스트로 표면화한다.
 */
import {
  collectStatus,
  collectAllStatus,
  collectDaemonStatus,
  listRegisteredProjects,
  runDoctor,
  readHalt,
} from "../core/diagnostics.js";
import type {
  SessionStatusRow,
  AggregatedSessionStatusRow,
  DoctorCheck,
  DaemonStatus,
  HaltRead,
} from "../core/diagnostics.js";
import type { Liveness } from "../core/runtime-state.js";
import type { HaltRecord } from "../core/crash-loop.js";
import { checkForUpdate, formatUpdateNotice } from "../core/update-check.js";
import { errMsg } from "../shared/errors.js";
import { USAGE, cmdError, flagErrorText, EXIT } from "../core/messages.js";
import { defaultBase, engineLogPath, projectPaths } from "../shared/paths.js";
import { parseProjectConf } from "../shared/conf.js";
import { daemonLogPaths } from "../core/launchd.js";
import { readFile, stat } from "node:fs/promises";
import { followFile } from "../core/log-follow.js";
import { renderSessionLog, followSessionLog } from "../record/render.js";
import { findCommand } from "./spec.js";
import { parseCommand } from "./parse.js";
import { table } from "./table.js";
import type { ParseResult } from "./parse.js";
import { t } from "../shared/i18n.js";

const STATUS_SPEC = findCommand("status")!;
const DOCTOR_SPEC = findCommand("doctor")!;
const LOGS_SPEC = findCommand("logs")!;

/** 경고 셀 — 없으면 `-`, 있으면 건수. */
function warnCell(warnings: string[]): string {
  return warnings.length === 0 ? "-" : String(warnings.length);
}

function statusTable(rows: SessionStatusRow[]): string {
  if (rows.length === 0) return "(세션 없음)";
  // WARN 은 건수만 — 경고 본문을 실으면 표가 넓어지고 줄바꿈으로 정렬이 깨진다. 상세는 session show.
  return table(
    ["SID", "STATUS", "ENGINE", "PRESENT", "WARN", "TITLE", "LAST_ACTIVITY"],
    rows.map((r) => [
      r.sid,
      r.status,
      r.engine,
      r.enginePresent ? "yes" : "no",
      warnCell(r.warnings),
      r.title ?? "-",
      r.lastActivityAt,
    ]),
  );
}

function statusTableAggregate(rows: AggregatedSessionStatusRow[]): string {
  if (rows.length === 0) return "(등록된 세션 없음)";
  return table(
    ["PROJECT", "SID", "STATUS", "ENGINE", "PRESENT", "WARN", "LAST_ACTIVITY"],
    rows.map((r) => [
      r.proj,
      r.sid,
      r.status,
      r.engine,
      r.enginePresent ? "yes" : "no",
      warnCell(r.warnings),
      r.lastActivityAt,
    ]),
  );
}

/** `Liveness` 값 → 로케일 키 매핑(단일 지점 — 상태 라벨 조립은 여기서만 수행). */
function daemonStateLabel(liveness: Liveness): string {
  return t(`ops.status.daemonState.${liveness}`);
}

/** 이상 상태(`dead`·`stale`·`unreadable`)의 조치 안내 — 정상 상태는 빈 문자열. */
function daemonActionNotice(daemon: DaemonStatus): string | null {
  if (daemon.liveness === "dead") return t("ops.status.daemonDead", { proj: daemon.proj });
  if (daemon.liveness === "stale") return t("ops.status.daemonStale", { proj: daemon.proj });
  if (daemon.liveness === "unreadable")
    return t("ops.status.daemonUnreadable", { proj: daemon.proj, reason: daemon.reason ?? "" });
  return null;
}

/** 종료코드 계약(§핵심 설계 3) — 단일 헬퍼. 두 분기가 공유해 판정 로직 중복을 막는다.
 * 자가정지 기록이 존재(`ok`)하거나 판독 불가(`unreadable`)면 실패로 계산한다 — 판독 불가를
 * "기록 없음"으로 접으면 손상된 기록이 정상으로 위장된다. */
function statusExitCode(params: {
  detachedPresent: boolean;
  halts: readonly HaltRead[];
  liveness: readonly Liveness[];
}): number {
  const bad =
    params.detachedPresent ||
    params.halts.some((h) => h.kind !== "absent") ||
    params.liveness.some((l) => l === "dead" || l === "stale" || l === "unreadable");
  return bad ? EXIT.FAIL : EXIT.OK;
}

/** halt 경고 문구 — `ok`(자가정지) 는 기존 경고, `unreadable`(판독 불가) 는 사유·조치를 포함. */
function haltNotice(halt: HaltRead, proj: string): string | null {
  if (halt.kind === "ok") return t("ops.status.haltWarn", { proj });
  if (halt.kind === "unreadable")
    return t("ops.status.haltUnreadable", { proj, reason: halt.reason });
  return null;
}

/** 기계 출력 `halt` 필드 — 기준 커밋(a2dc188 도입, d0fd5d8) 형태로 원복(`HaltRecord | null`).
 * 판독 불가는 이 필드에 실지 않고 신규 추가 필드 `haltUnreadable` 로만 표면화한다(GAP-014,
 * additive-only 계약 — 기존 소비자의 `if (data.halt)`/`data.halt.field` 패턴을 보존). */
function toHaltRecord(halt: HaltRead): HaltRecord | null {
  return halt.kind === "ok" ? halt.record : null;
}

/** 판독 불가 사유 — `ok`/`absent` 는 `null`(필드 부재와 동등하게 소비 가능). */
function haltUnreadableReason(halt: HaltRead): string | null {
  return halt.kind === "unreadable" ? halt.reason : null;
}

async function printUpdateNoticeIfAny(): Promise<void> {
  try {
    const notice = await checkForUpdate({ allowNetwork: process.stdout.isTTY === true });
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
  const base = defaultBase();

  if (!proj) {
    // 판정(경고·종료코드·기계 판독)은 필터 이전 전체 집합(allRows)에서, 표 렌더만 필터 결과에서
    // 파생한다(ADR-010) — 현행 결함(필터 결과 재사용)의 직접 원인이었다.
    let allRows: AggregatedSessionStatusRow[];
    let projs: string[];
    try {
      allRows = await collectAllStatus();
      projs = await listRegisteredProjects();
    } catch (err) {
      // 프로젝트 열거 실패(부재 이외 errno) — 흡수하면 "등록된 프로젝트 없음 + 정상"으로 위장된다.
      process.stderr.write(cmdError("status", errMsg(err)) + "\n");
      return EXIT.FAIL;
    }
    const displayRows = all
      ? allRows
      : allRows.filter((r) => r.status === "active" || r.status === "hibernated");
    const haltMap: Record<string, HaltRead> = {};
    const daemonMap: Record<string, DaemonStatus> = {};
    for (const pname of projs) {
      haltMap[pname] = await readHalt(base, pname);
      daemonMap[pname] = await collectDaemonStatus(pname, { base });
    }
    if (json) {
      const haltRecordMap: Record<string, HaltRecord | null> = {};
      const haltUnreadableMap: Record<string, string> = {};
      for (const [pname, halt] of Object.entries(haltMap)) {
        haltRecordMap[pname] = toHaltRecord(halt);
        const reason = haltUnreadableReason(halt);
        if (reason !== null) haltUnreadableMap[pname] = reason;
      }
      process.stdout.write(
        JSON.stringify(
          {
            v: 1,
            sessions: allRows,
            halt: haltRecordMap,
            haltUnreadable: haltUnreadableMap,
            daemon: daemonMap,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(statusTableAggregate(displayRows) + "\n");
      for (const pname of projs) {
        process.stdout.write(
          t("ops.status.daemonLine", {
            proj: pname,
            state: daemonStateLabel(daemonMap[pname]!.liveness),
          }) + "\n",
        );
      }
      const detached = allRows.filter((r) => r.status === "detached");
      if (detached.length > 0) {
        process.stderr.write(
          `\ndetached: ${detached.map((r) => `${r.proj}/${r.sid}`).join(", ")}\n`,
        );
      }
      for (const pname of projs) {
        const notice = daemonActionNotice(daemonMap[pname]!);
        if (notice) process.stderr.write(`\n${notice}\n`);
      }
      for (const [pname, halt] of Object.entries(haltMap)) {
        const notice = haltNotice(halt, pname);
        if (notice) process.stderr.write(`\n${notice}\n`);
      }
      await printUpdateNoticeIfAny();
    }
    return statusExitCode({
      detachedPresent: allRows.some((r) => r.status === "detached"),
      halts: Object.values(haltMap),
      liveness: Object.values(daemonMap).map((d) => d.liveness),
    });
  }

  let rows: SessionStatusRow[];
  try {
    rows = await collectStatus(proj);
  } catch (err) {
    process.stderr.write(cmdError("status", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
  const halt = await readHalt(base, proj);
  const daemon = await collectDaemonStatus(proj, { base });
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          v: 1,
          sessions: rows,
          halt: toHaltRecord(halt),
          haltUnreadable: haltUnreadableReason(halt),
          daemon,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(statusTable(rows) + "\n");
    process.stdout.write(
      t("ops.status.daemonLine", { proj, state: daemonStateLabel(daemon.liveness) }) + "\n",
    );
    const detached = rows.filter((r) => r.status === "detached");
    if (detached.length > 0)
      process.stderr.write(`\ndetached: ${detached.map((r) => r.sid).join(", ")}\n`);
    const notice = daemonActionNotice(daemon);
    if (notice) process.stderr.write(`\n${notice}\n`);
    const haltMsg = haltNotice(halt, proj);
    if (haltMsg) process.stderr.write(`\n${haltMsg}\n`);
    await printUpdateNoticeIfAny();
  }
  return statusExitCode({
    detachedPresent: rows.some((r) => r.status === "detached"),
    halts: [halt],
    liveness: [daemon.liveness],
  });
}

export function checkSymbol(level: DoctorCheck["level"]): string {
  return level === "PASS" ? "✔" : level === "WARN" ? "▲" : level === "INFO" ? "ℹ" : "✘";
}

export async function runDoctorCli(rest: readonly string[], parsed?: ParseResult): Promise<number> {
  const p = parsed ?? parseCommand(DOCTOR_SPEC, rest);
  if (p.error) {
    process.stderr.write(`${cmdError("doctor", flagErrorText(p.error))}\n\n${USAGE.status}\n`);
    return EXIT.USAGE;
  }
  const json = p.flags.json === true;
  const proj = p.positional[0];
  let checks: DoctorCheck[];
  try {
    checks = await runDoctor(proj);
  } catch (err) {
    process.stderr.write(cmdError("doctor", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
  const fails = checks.filter((c) => c.level === "FAIL").length;
  if (json) {
    process.stdout.write(JSON.stringify({ v: 1, checks }, null, 2) + "\n");
    return fails > 0 ? EXIT.FAIL : EXIT.OK;
  }
  for (const c of checks) {
    process.stdout.write(`${checkSymbol(c.level)} [${c.level}] ${c.name}: ${c.detail}\n`);
    if (c.hint) process.stdout.write(`  → ${c.hint}\n`);
  }
  // 요약 건수는 렌더한 checks 배열에서 직접 집계한다(별도 카운터 금지 — SC-015 건수 일치 요구).
  const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const c of checks) {
    if (c.level === "PASS") counts.pass++;
    else if (c.level === "WARN") counts.warn++;
    else if (c.level === "FAIL") counts.fail++;
    else counts.info++;
  }
  process.stdout.write(t("ops.doctor.summary", counts) + "\n");
  await printUpdateNoticeIfAny();
  return fails > 0 ? EXIT.FAIL : EXIT.OK;
}

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

export const DEFAULT_LOG_LINES = 50;

export function parseLineCount(raw: string | undefined): { n: number; warn: boolean } {
  if (raw === undefined) return { n: DEFAULT_LOG_LINES, warn: false };
  if (/^\d+$/.test(raw) && Number(raw) > 0) return { n: Number(raw), warn: false };
  return { n: DEFAULT_LOG_LINES, warn: true };
}

async function runDaemonLogs(proj: string, n: number, json: boolean): Promise<number> {
  let logs;
  try {
    logs = daemonLogPaths(proj);
  } catch (err) {
    process.stderr.write(errMsg(err) + "\n");
    return EXIT.FAIL;
  }
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
  if (lines === null || lines.length === 0) {
    process.stdout.write(`(로그 없음: ${logs.err})\n`);
    return EXIT.OK;
  }
  process.stdout.write(lines.join("\n") + "\n");
  return EXIT.OK;
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
  const [proj, sid, nRaw] = p.positional;

  if (daemon) {
    if (!proj) {
      process.stderr.write(USAGE.logs + "\n");
      return EXIT.USAGE;
    }
    const { n, warn } = parseLineCount(p.positional[1]);
    if (warn) process.stderr.write(t("ops.logs.badCount", { raw: p.positional[1] }) + "\n");
    return runDaemonLogs(proj, n, json);
  }

  if (!proj || !sid) {
    process.stderr.write(USAGE.logs + "\n");
    return EXIT.USAGE;
  }
  const { n, warn } = parseLineCount(nRaw);
  if (warn) process.stderr.write(t("ops.logs.badCount", { raw: nRaw }) + "\n");
  const base = defaultBase();

  if (engine) {
    const path = engineLogPath(base, proj, sid);
    const lines = await readTail(path, n);
    if (json) {
      process.stdout.write(
        JSON.stringify(
          { v: 1, proj, sid, path, exists: lines !== null, lines: lines ?? [] },
          null,
          2,
        ) + "\n",
      );
      return EXIT.OK;
    }
    // 부재와 빈 내용을 구분한다 — 진단 명령이 정반대 두 상태를 같은 문구로 덮으면, 정상 동작
    // (어댑터가 stderr 를 남기지 않음)이 배선 실패로 오진단된다. readTail 은 부재 시 null,
    // 빈 파일 시 빈 배열을 준다.
    if (lines === null) {
      process.stdout.write(
        `(엔진 로그 없음 — 이 세션의 엔진이 아직 기동하지 않았습니다: ${path})\n`,
      );
      return EXIT.OK;
    }
    if (lines.length === 0) {
      process.stdout.write(
        `(엔진 로그가 비어 있습니다 — 엔진이 진단 출력을 남기지 않았습니다: ${path})\n`,
      );
      return EXIT.OK;
    }
    process.stdout.write(lines.join("\n") + "\n");
    if (follow) {
      const st = await stat(path).catch(() => null);
      await followFile(path, {
        onData: (chunk) => process.stdout.write(chunk),
        signal: new AbortController().signal,
        startOffset: st?.size ?? 0,
        startIno: st?.ino ?? 0,
      });
    }
    return EXIT.OK;
  }

  // 기본 — 대화 이벤트를 사람이 읽는 형태로 렌더(FR-043).
  const conf = await parseProjectConf(await readFile(projectPaths(base, proj).projectConf, "utf8"));
  const ctx = { base, vaultRoot: conf.vault, proj, sid };
  const lines = await renderSessionLog(ctx);
  const tail = lines.slice(-Math.max(1, n));
  if (json) {
    process.stdout.write(JSON.stringify({ v: 1, proj, sid, lines: tail }, null, 2) + "\n");
    return EXIT.OK;
  }
  process.stdout.write(tail.length > 0 ? tail.join("\n") + "\n" : "(이벤트 없음)\n");
  if (follow) {
    // 세대 파일 회전(events-NNNN.jsonl)은 render.ts:followSessionLog 가 재렌더-증분 방식으로
    // 흡수한다(§ record/render.ts 주석). Ctrl-C 즉시 정지는 --engine 경로와 동일하게 기본 SIGINT
    // 동작(핸들러 미등록)에 위임한다 — 프로세스가 즉시 종료되므로 별도 abort 배선이 불필요하다.
    await followSessionLog(ctx, {
      onData: (chunk) => process.stdout.write(chunk),
      signal: new AbortController().signal,
      fromLineCount: lines.length,
    });
  }
  return EXIT.OK;
}
