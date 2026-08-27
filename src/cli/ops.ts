/**
 * `adde status|doctor|logs` — 운영 가시성 명령의 CLI 표면(v2, 세션 스코프).
 * core/diagnostics 의 읽기 전용 로직을 호출하고 표/JSON/텍스트로 표면화한다.
 */
import { collectStatus, collectAllStatus, runDoctor, readHalt } from "../core/diagnostics.js";
import type {
  SessionStatusRow,
  AggregatedSessionStatusRow,
  DoctorCheck,
} from "../core/diagnostics.js";
import { checkForUpdate, formatUpdateNotice } from "../core/update-check.js";
import { errMsg } from "../shared/errors.js";
import type { HaltRecord } from "../core/crash-loop.js";
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
    const allRows = await collectAllStatus();
    const rows = all
      ? allRows
      : allRows.filter((r) => r.status === "active" || r.status === "hibernated");
    const haltMap: Record<string, HaltRecord | null> = {};
    for (const pname of [...new Set(allRows.map((r) => r.proj))])
      haltMap[pname] = await readHalt(base, pname);
    if (json) {
      process.stdout.write(JSON.stringify({ v: 1, sessions: rows, halt: haltMap }, null, 2) + "\n");
    } else {
      process.stdout.write(statusTableAggregate(rows) + "\n");
      const detached = rows.filter((r) => r.status === "detached");
      if (detached.length > 0) {
        process.stderr.write(
          `\ndetached: ${detached.map((r) => `${r.proj}/${r.sid}`).join(", ")}\n`,
        );
      }
      for (const [pname, halt] of Object.entries(haltMap)) {
        if (halt) process.stderr.write(`\n크래시루프 자가 정지: ${pname}\n`);
      }
      await printUpdateNoticeIfAny();
    }
    const bad =
      rows.some((r) => r.status === "detached") || Object.values(haltMap).some((h) => h !== null);
    return bad ? EXIT.FAIL : EXIT.OK;
  }

  let rows: SessionStatusRow[];
  try {
    rows = await collectStatus(proj);
  } catch (err) {
    process.stderr.write(cmdError("status", errMsg(err)) + "\n");
    return EXIT.FAIL;
  }
  const halt = await readHalt(base, proj);
  if (json) {
    process.stdout.write(JSON.stringify({ v: 1, sessions: rows, halt }, null, 2) + "\n");
  } else {
    process.stdout.write(statusTable(rows) + "\n");
    const detached = rows.filter((r) => r.status === "detached");
    if (detached.length > 0)
      process.stderr.write(`\ndetached: ${detached.map((r) => r.sid).join(", ")}\n`);
    if (halt) process.stderr.write(`\n크래시루프 자가 정지: ${proj}\n`);
    await printUpdateNoticeIfAny();
  }
  const bad = rows.some((r) => r.status === "detached") || halt !== null;
  return bad ? EXIT.FAIL : EXIT.OK;
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

function parseLineCount(raw: string | undefined): { n: number; warn: boolean } {
  if (raw === undefined) return { n: 50, warn: false };
  if (/^\d+$/.test(raw) && Number(raw) > 0) return { n: Number(raw), warn: false };
  return { n: 50, warn: true };
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
    const { n } = parseLineCount(p.positional[1]);
    return runDaemonLogs(proj, n, json);
  }

  if (!proj || !sid) {
    process.stderr.write(USAGE.logs + "\n");
    return EXIT.USAGE;
  }
  const { n } = parseLineCount(nRaw);
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
