/**
 * `adde status|doctor|logs` — 운영 가시성 명령의 CLI 표면.
 * core/diagnostics 의 읽기 전용 로직을 호출하고 표/JSON/텍스트로 표면화한다.
 */
import { collectStatus, collectAllStatus, runDoctor, readLogs, readHalt } from "../core/diagnostics.js";
import { checkForUpdate, formatUpdateNotice } from "../core/update-check.js";
import { errMsg } from "../shared/errors.js";
import type { LaneStatusRow, AggregatedLaneStatusRow, DoctorCheck } from "../core/diagnostics.js";
import type { HaltRecord } from "../core/crash-loop.js";
import { USAGE, cmdError } from "../core/messages.js";
import { t } from "../shared/i18n.js";
import { readLedger, formatWhen } from "../core/session-ledger.js";
import { lanePaths, defaultBase } from "../shared/paths.js";
import { daemonLogPaths } from "../core/launchd.js";
import { readFile, stat } from "node:fs/promises";
import { followFile } from "../core/log-follow.js";

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
    // halt 조회를 json/text 분기 밖으로 리프트 — 두 모드·종료 코드 모두 halt 를 반영한다.
    const base = defaultBase();
    const haltMap: Record<string, HaltRecord | null> = {};
    for (const p of [...new Set(rows.map((r) => r.proj))]) {
      haltMap[p] = await readHalt(base, p);
    }
    if (json) {
      // BREAKING — 최상위 배열 대신 {lanes, halt} 객체(halt 는 프로젝트별 상태를 담는 자리).
      process.stdout.write(JSON.stringify({ lanes: rows, halt: haltMap }, null, 2) + "\n");
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
      // 크래시루프 자가 정지 표면화 — 집계 뷰에 등장한 프로젝트마다 halt 기록.
      for (const [p, halt] of Object.entries(haltMap)) {
        if (halt) process.stdout.write("\n" + t("ops.status.haltWarn", { proj: p }) + "\n");
      }
      await printUpdateNoticeIfAny();
    }
    const laneBad = rows.some(
      (r) => r.status === "dead" || r.status === "stale" || r.status === "error",
    );
    // halt(크래시루프 자가정지) 존재도 exit 1 신호에 반영 — 기존 laneBad 판정에 더함.
    return laneBad || Object.values(haltMap).some((h) => h !== null) ? 1 : 0;
  }

  let rows: LaneStatusRow[];
  try {
    rows = await collectStatus(proj);
  } catch (err) {
    // 잘못된 proj 이름 등 — 원시 예외 대신 명령 스코프 친절 메시지(logs/sessions 와 일관).
    process.stderr.write(cmdError("status", errMsg(err)) + "\n");
    return 1;
  }
  // halt 조회를 json/text 분기 밖으로 리프트(중복 조회 없음) — 두 모드·종료 코드 모두 반영.
  const halt = await readHalt(defaultBase(), proj);
  if (json) {
    // BREAKING — 최상위 배열 대신 {lanes, halt} 객체.
    process.stdout.write(JSON.stringify({ lanes: rows, halt }, null, 2) + "\n");
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
    // 크래시루프 자가 정지 표면화(경고 텍스트 유지).
    if (halt) {
      process.stdout.write("\n" + t("ops.status.haltWarn", { proj }) + "\n");
    }
    await printUpdateNoticeIfAny();
  }
  // 비정상(error 기동실패·dead 크래시·stale 행) 또는 halt 잔존을 종료 코드로 신호 — 모니터링 친화.
  const laneBad = rows.some(
    (r) => r.status === "dead" || r.status === "stale" || r.status === "error",
  );
  return laneBad || halt !== null ? 1 : 0;
}

function checkSymbol(level: DoctorCheck["level"]): string {
  return level === "PASS" ? "✔" : level === "WARN" ? "▲" : "✘";
}

export async function runDoctorCli(rest: readonly string[]): Promise<number> {
  const json = rest.includes("--json");
  const proj = rest.find((a) => !a.startsWith("--"));
  let checks: DoctorCheck[];
  try {
    checks = await runDoctor(proj);
  } catch (err) {
    // 잘못된 proj 이름 등 — 원시 예외 대신 명령 스코프 친절 메시지.
    process.stderr.write(cmdError("doctor", errMsg(err)) + "\n");
    return 1;
  }
  const fails = checks.filter((c) => c.level === "FAIL").length;
  if (json) {
    // 기계가독 모드 — 사람용 심볼 루프·요약·업데이트 알림은 억제(텍스트 미혼입).
    process.stdout.write(JSON.stringify(checks, null, 2) + "\n");
    return fails > 0 ? 1 : 0;
  }
  for (const c of checks) {
    process.stdout.write(`${checkSymbol(c.level)} [${c.level}] ${c.name}: ${c.detail}\n`);
    if (c.hint) process.stdout.write(t("ops.doctor.hint", { hint: c.hint }) + "\n");
  }
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
  const json = rest.includes("--json");
  // `--json` 등 플래그를 proj/lane 값으로 오인하지 않도록 위치인자만 분리해 해석한다.
  const positional = rest.filter((a) => !a.startsWith("--"));
  const [proj, lane] = positional;
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
    if (json) {
      process.stdout.write(JSON.stringify([], null, 2) + "\n");
    } else {
      process.stdout.write(t("injector.control.sessionsEmpty") + "\n");
    }
    return 0;
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
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    return 0;
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

/**
 * `logs` 줄수 인자 파싱 — 미지정(undefined)은 무경고 기본 50(불변). 지정됐으나 비숫자·0·음수면
 * 경고(warn=true)와 함께 기본 50 폴백. 유효(정수>0)면 그 값을 그대로 쓴다.
 */
export function parseLineCount(raw: string | undefined): { n: number; warn: boolean } {
  if (raw === undefined) return { n: 50, warn: false };
  if (/^\d+$/.test(raw) && Number(raw) > 0) return { n: Number(raw), warn: false };
  return { n: 50, warn: true };
}

export async function runLogs(rest: readonly string[]): Promise<number> {
  const engine = rest.includes("--engine");
  const daemon = rest.includes("--daemon");
  const follow = rest.includes("--follow") || rest.includes("-f");
  // "-f"(단축 follow 플래그)도 "--"로 시작하지 않아 위치인자로 잘못 남을 수 있으므로 함께 제외한다
  // (미제외 시 `logs <proj> <lane> -f`(N 미지정)가 "-f" 를 줄수로 오인해 spurious 경고 발생).
  const positional = rest.filter((a) => !a.startsWith("--") && a !== "-f");
  const [proj, lane, nRaw] = positional;

  // --daemon 은 레인 무관(프로젝트 데몬 로그) — proj 만 필요, 둘째 위치인자는 N.
  // daemon 로그는 launchd 소유·제자리 트림이라 follow 대상이 아니다(-f 는 무시하고 스냅샷만 출력).
  if (daemon) {
    if (!proj) {
      process.stderr.write(USAGE.logs + "\n");
      return 1;
    }
    // N 은 proj 뒤 첫 숫자 위치인자 — `logs proj --daemon 100` / `logs proj lane --daemon 100` 모두 수용.
    const dRaw = positional.slice(1).find((p) => /^\d+$/.test(p));
    const dn = dRaw !== undefined ? Number(dRaw) : 50;
    return runDaemonLogs(proj, dn);
  }

  if (!proj || !lane) {
    process.stderr.write(USAGE.logs + "\n");
    return 1;
  }
  const { n, warn } = parseLineCount(nRaw);
  if (warn && nRaw !== undefined) {
    process.stderr.write(t("ops.logs.badCount", { raw: nRaw }) + "\n");
  }
  let result;
  try {
    result = await readLogs(proj, lane, n, { engine });
  } catch (err) {
    // proj/lane 검증 실패(경로 탈출 차단 등) — 친절한 메시지 후 비정상 종료코드.
    process.stderr.write(errMsg(err) + "\n");
    return 1;
  }
  if (!result.exists) {
    // follow 요청이어도 시작 시 부재면 생성 대기 상주하지 않는다.
    const what = engine ? t("ops.logs.whatEngine") : t("ops.logs.whatTranscript");
    process.stdout.write(t("ops.logs.notFound", { what, path: result.path, proj }) + "\n");
    return 0;
  }
  if (result.lines.length === 0) {
    process.stdout.write(t("ops.logs.empty", { path: result.path }) + "\n");
  } else {
    process.stdout.write(result.lines.join("\n") + "\n");
  }
  if (!follow) return 0;

  // follow 진입 — 스냅샷 직후 파일 끝을 시작 오프셋으로(신규 추가 라인만 방출).
  // 스냅샷·이 stat 사이 극단적 경합으로 파일이 사라지면 상주하지 않고 조용히 종료(재시도는 사용자 몫).
  let st;
  try {
    st = await stat(result.path);
  } catch {
    return 0;
  }
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  await followFile(result.path, {
    onData: (chunk) => process.stdout.write(chunk),
    signal: ac.signal,
    startOffset: st.size,
    startIno: st.ino,
  });
  return 0;
}
