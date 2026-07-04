import { readVersion } from "../core/version.js";
import { errMsg } from "../shared/errors.js";
import { COMMANDS, buildUsage, USAGE, cmdError } from "../core/messages.js";
import { formatException } from "../shared/notify.js";
import { t } from "../shared/i18n.js";
import { findCommand, suggestCommands } from "./spec.js";
import { completionScript, SUPPORTED_SHELLS } from "./completion.js";

/** -h/--help 플래그가 인자에 있는지. */
function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/**
 * 포그라운드 데몬 워커 로직 — `adde __daemon <proj>` 가 호출한다.
 * supervisorUp 후 SIGTERM/SIGINT graceful shutdown 까지 포그라운드 상주.
 * launchd KeepAlive 재기동 시에도 이 경로로 진입한다.
 */
async function runDaemonForeground(proj: string): Promise<number> {
  const { supervisorUp, supervisorDown } = await import("../core/supervisor.js");
  const result = await supervisorUp(proj);
  process.stdout.write(`${result.message}\n`);

  // 기동 실패 레인은 원인 + 조치(doctor/logs)를 인라인 표면화.
  const errorLanes = result.lanes.filter((l) => l.status === "error");
  for (const l of errorLanes) {
    process.stderr.write(
      formatException({
        situation: t("run.laneStartFailed.situation", {
          lane: l.lane,
          error: l.error ?? t("run.unknownCause"),
        }),
        action: t("run.laneStartFailed.action", { proj, lane: l.lane }),
      }) + "\n",
    );
  }

  const running = result.lanes.filter((l) => l.status === "running");
  if (running.length === 0) {
    // 레인 conf 자체가 없으면 생성 단계를 안내한다.
    if (result.lanes.length === 0) {
      process.stderr.write(
        formatException({
          situation: t("run.noLanes.situation", { proj }),
          action: t("run.noLanes.action", { proj }),
        }) + "\n",
      );
    }
    // 기동된 레인이 없으면 상주할 이유가 없다 — 오류 레인이 있으면 1.
    return errorLanes.length > 0 ? 1 : 0;
  }

  // 종료 신호 시 graceful shutdown — supervisorDown 으로 엔진 child·소스를 정리한 뒤 종료.
  // await 완료 후에만 exit(typescript 규칙: 비동기 작업이 끝나기 전에 process.exit 금지).
  let shuttingDown = false;
  const shutdown = (sig: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\n${t("run.signalShutdown", { sig })}\n`);
    void supervisorDown(proj)
      .then((r) => {
        process.stdout.write(`${r.message}\n`);
        process.exit(0);
      })
      .catch((err: unknown) => {
        process.stderr.write(
          formatException({
            situation: t("run.shutdownError.situation", {
              error: errMsg(err),
            }),
            action: t("run.shutdownError.action"),
          }) + "\n",
        );
        process.exit(1);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // 레인 기동 성공 → 소스 루프가 이벤트 루프를 유지하는 동안 포그라운드 상주.
  // 종료(SIGTERM/SIGINT) 까지 resolve 하지 않아 진입점의 process.exit 를 막는다.
  await new Promise<never>(() => {});
  return 0; // 도달하지 않음
}

/**
 * CLI 진입 로직. adde / add 양쪽 진입점이 공유한다.
 * @returns 프로세스 종료 코드.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const [first, second] = argv;

  if (first === "--version" || first === "-v") {
    process.stdout.write(`${COMMANDS.primary} ${readVersion()}\n`);
    return 0;
  }

  // 서브커맨드별 도움말 — `adde <cmd> --help`. lane 은 runLane 가 자체 처리(하위 명령 도움말).
  if (first !== undefined && first !== "lane" && wantsHelp(argv.slice(1))) {
    const spec = findCommand(first);
    if (spec?.usageKey && !spec.hidden) {
      process.stdout.write(t(spec.usageKey as never) + "\n");
      return 0;
    }
  }

  if (first === "completion") {
    const shell = second;
    if (!shell) {
      process.stderr.write(USAGE.completion + "\n");
      return 1;
    }
    const script = completionScript(shell);
    if (script === null) {
      process.stderr.write(
        cmdError(
          "completion",
          t("completion.unknownShell", { shell, supported: SUPPORTED_SHELLS.join("|") }),
        ) + "\n",
      );
      return 1;
    }
    process.stdout.write(script);
    return 0;
  }

  if (first === "lane") {
    const { runLane } = await import("./lane.js");
    return runLane(argv.slice(1));
  }

  if (first === "status") {
    const { runStatus } = await import("./ops.js");
    return runStatus(argv.slice(1));
  }

  if (first === "doctor") {
    const { runDoctorCli } = await import("./ops.js");
    return runDoctorCli(argv.slice(1));
  }

  if (first === "logs") {
    const { runLogs } = await import("./ops.js");
    return runLogs(argv.slice(1));
  }

  if (first === "sessions") {
    const { runSessions } = await import("./ops.js");
    return runSessions(argv.slice(1));
  }

  // 내부 서브커맨드 — launchd 가 데몬 워커로 기동하는 포그라운드 상주 진입점.
  // 도움말 미노출(최소 표면). 사용자가 직접 부르지 않는 내부 명령.
  if (first === "__daemon") {
    const proj = second;
    if (!proj) {
      process.stderr.write(t("usage.daemon") + "\n");
      return 1;
    }
    try {
      return await runDaemonForeground(proj);
    } catch (err) {
      process.stderr.write(cmdError("__daemon", errMsg(err)) + "\n");
      return 1;
    }
  }

  if (first === "up") {
    const proj = second;
    if (!proj) {
      process.stderr.write(USAGE.up + "\n");
      return 1;
    }
    try {
      const { loadDaemon } = await import("../core/launchd.js");
      await loadDaemon(proj);
      process.stdout.write(t("run.upDone", { proj }) + "\n");
      process.stdout.write(t("run.statusHint", { proj }) + "\n");
      return 0;
    } catch (err) {
      process.stderr.write(cmdError("up", errMsg(err)) + "\n");
      return 1;
    }
  }

  if (first === "down") {
    const proj = second;
    if (!proj) {
      process.stderr.write(USAGE.down + "\n");
      return 1;
    }
    try {
      const { unloadDaemon } = await import("../core/launchd.js");
      await unloadDaemon(proj);
      process.stdout.write(t("run.downDone", { proj }) + "\n");
      return 0;
    } catch (err) {
      process.stderr.write(cmdError("down", errMsg(err)) + "\n");
      return 1;
    }
  }

  if (first === "restart") {
    const proj = second;
    if (!proj) {
      process.stderr.write(USAGE.restart + "\n");
      return 1;
    }
    try {
      const { unloadDaemon, loadDaemon } = await import("../core/launchd.js");
      // down 완료 await 후 up — 부분 실패 시 up 오류 표면화.
      await unloadDaemon(proj);
      await loadDaemon(proj);
      process.stdout.write(t("run.restartDone", { proj }) + "\n");
      process.stdout.write(t("run.statusHint", { proj }) + "\n");
      return 0;
    } catch (err) {
      process.stderr.write(cmdError("restart", errMsg(err)) + "\n");
      return 1;
    }
  }

  // 인자 없음·명시적 도움말 → 사용법(정상 종료).
  if (first === undefined || first === "-h" || first === "--help" || first === "help") {
    process.stdout.write(`${buildUsage()}\n`);
    return 0;
  }

  // 미지원 명령 → stderr 로 오류(+오타 추정 힌트) + 사용법, 비정상 종료(스크립트 오류 은폐 방지).
  const suggestions = suggestCommands(first);
  const hint =
    suggestions.length > 0 ? " " + t("cli.didYouMean", { cmds: suggestions.join(", ") }) : "";
  process.stderr.write(`${t("cli.unknownCmd", { cmd: first })}${hint}\n\n${buildUsage()}\n`);
  return 1;
}
