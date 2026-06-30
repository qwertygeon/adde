/**
 * `adde status|doctor|logs` — 운영 가시성 명령의 CLI 표면.
 * core/diagnostics 의 읽기 전용 로직을 호출하고 표/JSON/텍스트로 표면화한다.
 */
import { collectStatus, runDoctor, readLogs } from "../core/diagnostics.js";
import type { LaneStatusRow, DoctorCheck } from "../core/diagnostics.js";
import { USAGE } from "../core/messages.js";

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
  if (rows.length === 0)
    return "레인 없음 — lanes.d 에 conf 가 없습니다 (adde lane add <proj> <lane>).";
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

export async function runStatus(rest: readonly string[]): Promise<number> {
  const json = rest.includes("--json");
  const proj = rest.find((a) => !a.startsWith("--"));
  if (!proj) {
    process.stderr.write(USAGE.status + "\n");
    return 1;
  }
  const rows = await collectStatus(proj);
  if (json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
  } else {
    process.stdout.write(statusTable(rows) + "\n");
    const dead = rows.filter((r) => r.status === "dead");
    if (dead.length > 0) {
      process.stdout.write(
        `\n경고: ${dead.map((r) => r.lane).join(", ")} 레인이 비정상 종료(dead)했습니다.\n` +
          `  ↳ 조치: adde down ${proj} 로 상태를 정리한 뒤 adde up ${proj} 로 재기동하세요.\n`,
      );
    }
    const stale = rows.filter((r) => r.status === "stale");
    if (stale.length > 0) {
      process.stdout.write(
        `\n경고: ${stale.map((r) => r.lane).join(", ")} 레인이 응답 없음(stale — 프로세스는 살아있으나 하트비트 끊김).\n` +
          `  ↳ 조치: 행(hang) 가능성. adde logs ${proj} <lane> --engine 으로 진단 후 adde down/up ${proj} 로 재기동하세요.\n`,
      );
    }
  }
  // 비정상(dead 크래시·stale 행) 잔존을 종료 코드로 신호 — 모니터링 친화.
  return rows.some((r) => r.status === "dead" || r.status === "stale") ? 1 : 0;
}

function checkSymbol(level: DoctorCheck["level"]): string {
  return level === "PASS" ? "✔" : level === "WARN" ? "▲" : "✘";
}

export async function runDoctorCli(rest: readonly string[]): Promise<number> {
  const proj = rest.find((a) => !a.startsWith("--"));
  const checks = await runDoctor(proj);
  for (const c of checks) {
    process.stdout.write(`${checkSymbol(c.level)} [${c.level}] ${c.name}: ${c.detail}\n`);
    if (c.hint) process.stdout.write(`    ↳ 조치: ${c.hint}\n`);
  }
  const fails = checks.filter((c) => c.level === "FAIL").length;
  const warns = checks.filter((c) => c.level === "WARN").length;
  process.stdout.write(
    `\n요약: ${checks.length - fails - warns} PASS / ${warns} WARN / ${fails} FAIL\n`,
  );
  return fails > 0 ? 1 : 0;
}

export async function runLogs(rest: readonly string[]): Promise<number> {
  const engine = rest.includes("--engine");
  const positional = rest.filter((a) => !a.startsWith("--"));
  const [proj, lane, nRaw] = positional;
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
    process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
    return 1;
  }
  if (!result.exists) {
    const what = engine ? "engine 로그" : "transcript";
    process.stdout.write(
      `${what} 없음: ${result.path}\n` +
        `  ↳ 조치: 레인이 아직 활동하지 않았거나 기동되지 않았습니다. adde status ${proj} 로 상태를 확인하세요.\n`,
    );
    return 0;
  }
  if (result.lines.length === 0) {
    process.stdout.write(`(${result.path} 비어있음)\n`);
    return 0;
  }
  process.stdout.write(result.lines.join("\n") + "\n");
  return 0;
}
