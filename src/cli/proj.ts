/**
 * `adde proj <ls|rm>` — 프로젝트 단위 조회·삭제 CLI.
 * ls: 등록된 프로젝트와 레인/실행 수 요약(레인 단위 status 와 상보적인 프로젝트 뷰).
 * rm: 프로젝트 디렉터리 전체 삭제(파괴적) — 실행 중 레인 확인·이름 확인을 선행한다.
 */
import { projRemove, LaneConfigError } from "../core/lane-config.js";
import { listRegisteredProjects, collectStatus } from "../core/diagnostics.js";
import { buildProjUsage, unknownProjSub, cmdError, flagErrorText, EXIT } from "../core/messages.js";
import { errMsg } from "../shared/errors.js";
import { t } from "../shared/i18n.js";
import { defaultBase, assertSafeSegment } from "../shared/paths.js";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createPrompter } from "./prompt.js";
import { findSub } from "./spec.js";
import { parseCommand } from "./parse.js";
import type { ParseResult } from "./parse.js";

/** 경로 존재 여부(throw 없이). */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface ProjRow {
  proj: string;
  lanes: number;
  running: number;
}

async function handleProjList(p: ParseResult): Promise<number> {
  const json = p.flags.json === true;
  const projs = await listRegisteredProjects();
  const rows: ProjRow[] = [];
  for (const proj of projs) {
    const statuses = await collectStatus(proj);
    rows.push({
      proj,
      lanes: statuses.length,
      running: statuses.filter((s) => s.status === "running").length,
    });
  }
  if (json) {
    // 최상위 배열 대신 {v, projects} 객체(BREAKING — 기존 배열 소비자). `v` = 스키마 버전.
    process.stdout.write(JSON.stringify({ v: 1, projects: rows }, null, 2) + "\n");
    return EXIT.OK;
  }
  if (rows.length === 0) {
    process.stdout.write(t("proj.none") + "\n");
    return EXIT.OK;
  }
  const header = ["PROJECT", "LANES", "RUNNING"];
  const body = rows.map((r) => [r.proj, String(r.lanes), String(r.running)]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => (row[i] ?? "").length)),
  );
  const fmt = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  process.stdout.write([fmt(header), ...body.map(fmt)].join("\n") + "\n");
  return EXIT.OK;
}

async function handleProjRemove(p: ParseResult): Promise<number> {
  const force = p.flags.force === true;
  const proj = p.positional[0];
  if (!proj) {
    process.stderr.write(buildProjUsage() + "\n");
    return EXIT.USAGE;
  }

  // 존재 확인을 프롬프트보다 먼저 — 없는 프로젝트에 이름 재입력을 요구하는 혼란 방지.
  // 이름 형식은 assertSafeSegment 로 먼저 검증(경로 탈출 차단; 잘못된 이름은 throw → runProj 가 처리).
  assertSafeSegment("proj", proj);
  const projDir = join(defaultBase(), proj);
  if (!(await pathExists(projDir))) {
    process.stderr.write(cmdError("proj", t("proj.notFound", { proj, path: projDir })) + "\n");
    return EXIT.FAIL;
  }

  // 실행 중(또는 크래시 잔존)인 레인이 있으면 삭제를 거부한다 — 먼저 데몬을 내리게 안내(--force 로 우회).
  const statuses = await collectStatus(proj);
  const active = statuses.filter(
    (s) => s.status === "running" || s.status === "dead" || s.status === "stale",
  );
  if (active.length > 0 && !force) {
    process.stderr.write(
      cmdError("proj", t("proj.running", { proj, lanes: active.map((r) => r.lane).join(", ") })) +
        "\n",
    );
    return EXIT.FAIL;
  }

  // 파괴적 — 확인 선행. TTY 면 프로젝트 이름 재입력으로 확인, 비-TTY 면 --force 요구.
  if (!force) {
    if (!process.stdin.isTTY) {
      process.stderr.write(cmdError("proj", t("proj.needForce")) + "\n");
      return EXIT.FAIL;
    }
    const prompter = createPrompter();
    let typed: string;
    try {
      typed = await prompter.ask(t("proj.confirmPrompt", { proj }), "");
    } finally {
      prompter.close();
    }
    if (typed.trim() !== proj) {
      process.stdout.write(t("proj.aborted") + "\n");
      return EXIT.FAIL;
    }
  }

  // 삭제 전 launchd 등록 해제 — 안 하면 plist 가 남아 고아 등록(없는 폴더로 KeepAlive 재기동 반복).
  // macOS 에서만 데몬이 존재하며 unloadDaemon 은 멱등(미등록·plist 부재 흡수).
  if (process.platform === "darwin") {
    const { unloadDaemon } = await import("../core/launchd.js");
    await unloadDaemon(proj).catch(() => {
      // 등록 해제 실패는 흡수 — 디렉터리 삭제는 계속 진행(고아 plist 는 adde down 으로 정리 가능).
    });
  }

  const result = await projRemove(proj);
  process.stdout.write(t("proj.removed", { proj: result.proj, path: result.path }) + "\n");
  return EXIT.OK;
}

/**
 * `adde proj ...` 진입. argv 는 "proj" 다음 토큰들.
 * @returns 종료 코드.
 */
export async function runProj(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== undefined && sub !== "help" && parseCommand({ flags: [] }, rest).help) {
    process.stdout.write(`${buildProjUsage()}\n`);
    return EXIT.OK;
  }
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(`${buildProjUsage()}\n`);
    return EXIT.OK;
  }
  const subSpec = findSub("proj", sub);
  if (!subSpec) {
    // 미지원 *서브커맨드* — "미지원 명령" 계열로 보아 exit 1 유지.
    process.stderr.write(unknownProjSub(sub) + "\n");
    return EXIT.FAIL;
  }
  try {
    const p = parseCommand(subSpec, rest);
    if (p.error) {
      process.stderr.write(`${cmdError("proj", flagErrorText(p.error))}\n\n${buildProjUsage()}\n`);
      return EXIT.USAGE;
    }
    switch (subSpec.name) {
      case "ls":
        return await handleProjList(p);
      case "rm":
        return await handleProjRemove(p);
      default:
        // 도달하지 않음(proj subs 는 ls/rm/help 로 한정) — 방어.
        process.stderr.write(unknownProjSub(sub) + "\n");
        return EXIT.FAIL;
    }
  } catch (err) {
    // LaneConfigError(검증 실패)든 예기치 못한 예외든 원시 스택 대신 명령 스코프 메시지로 표면화.
    process.stderr.write(
      cmdError("proj", err instanceof LaneConfigError ? err.message : errMsg(err)) + "\n",
    );
    return EXIT.FAIL;
  }
}
