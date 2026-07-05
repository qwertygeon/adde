/**
 * `adde proj <ls|rm>` — 프로젝트 단위 조회·삭제 CLI.
 * ls: 등록된 프로젝트와 레인/실행 수 요약(레인 단위 status 와 상보적인 프로젝트 뷰).
 * rm: 프로젝트 디렉터리 전체 삭제(파괴적) — 실행 중 레인 확인·이름 확인을 선행한다.
 */
import { projRemove, LaneConfigError } from "../core/lane-config.js";
import { listRegisteredProjects, collectStatus } from "../core/diagnostics.js";
import { buildProjUsage, unknownProjSub, cmdError } from "../core/messages.js";
import { errMsg } from "../shared/errors.js";
import { t } from "../shared/i18n.js";
import { createPrompter } from "./prompt.js";

interface ProjRow {
  proj: string;
  lanes: number;
  running: number;
}

async function handleProjList(rest: readonly string[]): Promise<number> {
  const json = rest.includes("--json");
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
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write(t("proj.none") + "\n");
    return 0;
  }
  const header = ["PROJECT", "LANES", "RUNNING"];
  const body = rows.map((r) => [r.proj, String(r.lanes), String(r.running)]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => (row[i] ?? "").length)),
  );
  const fmt = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  process.stdout.write([fmt(header), ...body.map(fmt)].join("\n") + "\n");
  return 0;
}

async function handleProjRemove(rest: readonly string[]): Promise<number> {
  const force = rest.includes("--force");
  const proj = rest.find((a) => !a.startsWith("--"));
  if (!proj) {
    process.stderr.write(buildProjUsage() + "\n");
    return 1;
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
    return 1;
  }

  // 파괴적 — 확인 선행. TTY 면 프로젝트 이름 재입력으로 확인, 비-TTY 면 --force 요구.
  if (!force) {
    if (!process.stdin.isTTY) {
      process.stderr.write(cmdError("proj", t("proj.needForce")) + "\n");
      return 1;
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
      return 1;
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
  return 0;
}

/**
 * `adde proj ...` 진입. argv 는 "proj" 다음 토큰들.
 * @returns 종료 코드.
 */
export async function runProj(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== undefined && sub !== "help" && (rest.includes("--help") || rest.includes("-h"))) {
    process.stdout.write(`${buildProjUsage()}\n`);
    return 0;
  }
  try {
    switch (sub) {
      case "ls":
      case "list":
        return await handleProjList(rest);
      case "rm":
      case "remove":
        return await handleProjRemove(rest);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(`${buildProjUsage()}\n`);
        return 0;
      default:
        process.stderr.write(unknownProjSub(sub) + "\n");
        return 1;
    }
  } catch (err) {
    // LaneConfigError(검증 실패)든 예기치 못한 예외든 원시 스택 대신 명령 스코프 메시지로 표면화.
    process.stderr.write(
      cmdError("proj", err instanceof LaneConfigError ? err.message : errMsg(err)) + "\n",
    );
    return 1;
  }
}
