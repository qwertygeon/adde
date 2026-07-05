/**
 * `adde status|doctor|logs` — 운영 가시성 명령의 CLI 표면.
 * core/diagnostics 의 읽기 전용 로직을 호출하고 표/JSON/텍스트로 표면화한다.
 */
import { collectStatus, collectAllStatus, runDoctor, readLogs } from "../core/diagnostics.js";
import { checkForUpdate, formatUpdateNotice } from "../core/update-check.js";
import { errMsg } from "../shared/errors.js";
import type { LaneStatusRow, AggregatedLaneStatusRow, DoctorCheck } from "../core/diagnostics.js";
import { USAGE, cmdError } from "../core/messages.js";
import { t } from "../shared/i18n.js";
import { readLedger, formatWhen } from "../core/session-ledger.js";
import { lanePaths, defaultBase } from "../shared/paths.js";
import { daemonLogPaths } from "../core/launchd.js";
import { readFile } from "node:fs/promises";

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
function statusTableAggregate(rows: AggregatedLaneStatusRow[], all: boolean): string {
  if (rows.length === 0) {
    return all ? t("ops.status.noLanesRegistered") : t("ops.status.noRunning");
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
    if (notice) process.stdout.write("\n" + formatUpdateNotice(notice) + "\n");
  } catch {
    // 보조 기능 — 조회 실패는 흡수.
  }
}

export async function runStatus(rest: readonly string[]): Promise<number> {
  const json = rest.includes("--json");
  const all = rest.includes("--all");
  const proj = rest.find((a) => !a.startsWith("--"));

  // 인자 없음 → 전 프로젝트 집계(CCTG parity). 기본은 실행 중(정지 제외), --all 은 정지 포함 전체.
  if (!proj) {
    const allRows = await collectAllStatus();
    const rows = all ? allRows : allRows.filter((r) => r.status !== "stopped");
    if (json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else {
      process.stdout.write(statusTableAggregate(rows, all) + "\n");
      const dead = rows.filter((r) => r.status === "dead");
      if (dead.length > 0) {
        process.stdout.write(
          "\n" +
            t("ops.status.deadWarnAggregate", {
              lanes: dead.map((r) => `${r.proj}/${r.lane}`).join(", "),
            }) +
            "\n",
        );
      }
      const stale = rows.filter((r) => r.status === "stale");
      if (stale.length > 0) {
        process.stdout.write(
          "\n" +
            t("ops.status.staleWarnAggregate", {
              lanes: stale.map((r) => `${r.proj}/${r.lane}`).join(", "),
            }) +
            "\n",
        );
      }
      const errored = rows.filter((r) => r.status === "error");
      if (errored.length > 0) {
        process.stdout.write(
          "\n" +
            t("ops.status.errorWarnAggregate", {
              lanes: errored
                .map((r) => `${r.proj}/${r.lane}${r.error ? ` (${r.error})` : ""}`)
                .join(", "),
            }) +
            "\n",
        );
      }
      await printUpdateNoticeIfAny();
    }
    return rows.some((r) => r.status === "dead" || r.status === "stale" || r.status === "error")
      ? 1
      : 0;
  }

  let rows: LaneStatusRow[];
  try {
    rows = await collectStatus(proj);
  } catch (err) {
    // 잘못된 proj 이름 등 — 원시 예외 대신 명령 스코프 친절 메시지(logs/sessions 와 일관).
    process.stderr.write(cmdError("status", errMsg(err)) + "\n");
    return 1;
  }
  if (json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  } else {
    process.stdout.write(statusTable(rows) + "\n");
    const dead = rows.filter((r) => r.status === "dead");
    if (dead.length > 0) {
      process.stdout.write(
        "\n" +
          t("ops.status.deadWarnSingle", { lanes: dead.map((r) => r.lane).join(", "), proj }) +
          "\n",
      );
    }
    const stale = rows.filter((r) => r.status === "stale");
    if (stale.length > 0) {
      process.stdout.write(
        "\n" +
          t("ops.status.staleWarnSingle", { lanes: stale.map((r) => r.lane).join(", "), proj }) +
          "\n",
      );
    }
    const errored = rows.filter((r) => r.status === "error");
    if (errored.length > 0) {
      process.stdout.write(
        "\n" +
          t("ops.status.errorWarnSingle", {
            lanes: errored.map((r) => `${r.lane}${r.error ? ` (${r.error})` : ""}`).join(", "),
            proj,
          }) +
          "\n",
      );
    }
    await printUpdateNoticeIfAny();
  }
  // 비정상(error 기동실패·dead 크래시·stale 행) 잔존을 종료 코드로 신호 — 모니터링 친화.
  return rows.some((r) => r.status === "dead" || r.status === "stale" || r.status === "error")
    ? 1
    : 0;
}

function checkSymbol(level: DoctorCheck["level"]): string {
  return level === "PASS" ? "✔" : level === "WARN" ? "▲" : "✘";
}

export async function runDoctorCli(rest: readonly string[]): Promise<number> {
  const proj = rest.find((a) => !a.startsWith("--"));
  let checks: DoctorCheck[];
  try {
    checks = await runDoctor(proj);
  } catch (err) {
    // 잘못된 proj 이름 등 — 원시 예외 대신 명령 스코프 친절 메시지.
    process.stderr.write(cmdError("doctor", errMsg(err)) + "\n");
    return 1;
  }
  for (const c of checks) {
    process.stdout.write(`${checkSymbol(c.level)} [${c.level}] ${c.name}: ${c.detail}\n`);
    if (c.hint) process.stdout.write(t("ops.doctor.hint", { hint: c.hint }) + "\n");
  }
  const fails = checks.filter((c) => c.level === "FAIL").length;
  const warns = checks.filter((c) => c.level === "WARN").length;
  process.stdout.write(
    "\n" +
      t("ops.doctor.summary", { pass: checks.length - fails - warns, warn: warns, fail: fails }) +
      "\n",
  );
  await printUpdateNoticeIfAny();
  return fails > 0 ? 1 : 0;
}

/** `adde sessions <proj> <lane>` — 세션 장부 목록(read-only). 재개는 채널 명령으로 수행. */
export async function runSessions(rest: readonly string[]): Promise<number> {
  const [proj, lane] = rest;
  if (!proj || !lane) {
    process.stderr.write(USAGE.sessions + "\n");
    return 1;
  }
  let paths;
  try {
    paths = lanePaths(defaultBase(), proj, lane);
  } catch (err) {
    process.stderr.write(errMsg(err) + "\n");
    return 1;
  }
  const entries = await readLedger(paths);
  if (entries.length === 0) {
    process.stdout.write(t("injector.control.sessionsEmpty") + "\n");
    return 0;
  }
  let current: string | null = null;
  try {
    current = (await readFile(paths.sessionIdFile, "utf8")).trim() || null;
  } catch {
    // 세션 파일 부재 — 현재 표시 생략
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
  process.stdout.write(
    `${t("injector.control.sessionsHeader")}\n${lines.join("\n")}\n\n${t("injector.control.sessionsHint")}\n`,
  );
  return 0;
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

/** `adde logs <proj> --daemon [N]` — launchd 데몬 로그(기동 실패 원인 등)의 최근 N줄. */
async function runDaemonLogs(proj: string, n: number): Promise<number> {
  let logs;
  try {
    logs = daemonLogPaths(proj);
  } catch (err) {
    // 잘못된 proj 이름(경로 탈출 차단 등) — 친절 메시지.
    process.stderr.write(errMsg(err) + "\n");
    return 1;
  }
  // 실패 원인은 stderr 로그(.err.log)에 쌓인다 — 그걸 우선 표시.
  const lines = await readTail(logs.err, n);
  if (lines === null) {
    process.stdout.write(t("ops.logs.daemonNotFound", { path: logs.err, proj }) + "\n");
    return 0;
  }
  if (lines.length === 0) {
    process.stdout.write(t("ops.logs.empty", { path: logs.err }) + "\n");
    return 0;
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

export async function runLogs(rest: readonly string[]): Promise<number> {
  const engine = rest.includes("--engine");
  const daemon = rest.includes("--daemon");
  const positional = rest.filter((a) => !a.startsWith("--"));
  const [proj, lane, nRaw] = positional;

  // --daemon 은 레인 무관(프로젝트 데몬 로그) — proj 만 필요, 둘째 위치인자는 N.
  if (daemon) {
    if (!proj) {
      process.stderr.write(USAGE.logs + "\n");
      return 1;
    }
    const dRaw = positional[1];
    const dn = dRaw !== undefined && /^\d+$/.test(dRaw) ? Number(dRaw) : 50;
    return runDaemonLogs(proj, dn);
  }

  if (!proj || !lane) {
    process.stderr.write(USAGE.logs + "\n");
    return 1;
  }
  const n = nRaw !== undefined && /^\d+$/.test(nRaw) ? Number(nRaw) : 50;
  let result;
  try {
    result = await readLogs(proj, lane, n, { engine });
  } catch (err) {
    // proj/lane 검증 실패(경로 탈출 차단 등) — 친절한 메시지 후 비정상 종료코드.
    process.stderr.write(errMsg(err) + "\n");
    return 1;
  }
  if (!result.exists) {
    const what = engine ? t("ops.logs.whatEngine") : t("ops.logs.whatTranscript");
    process.stdout.write(t("ops.logs.notFound", { what, path: result.path, proj }) + "\n");
    return 0;
  }
  if (result.lines.length === 0) {
    process.stdout.write(t("ops.logs.empty", { path: result.path }) + "\n");
    return 0;
  }
  process.stdout.write(result.lines.join("\n") + "\n");
  return 0;
}
