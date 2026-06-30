import { readVersion } from "../core/version.js";
import { COMMANDS, buildUsage, USAGE, cmdError } from "../core/messages.js";
import { formatException } from "../shared/notify.js";

/**
 * CLI 진입 로직. adde / add 양쪽 진입점이 공유한다.
 * up 은 레인 기동 후 포그라운드로 상주(소스 루프 유지)하므로 resolve 하지 않는다.
 * @returns 프로세스 종료 코드. (up 성공 시 종료하지 않음)
 */
export async function run(argv: readonly string[]): Promise<number> {
  const [first, second] = argv;

  if (first === "--version" || first === "-v") {
    process.stdout.write(`${COMMANDS.primary} ${readVersion()}\n`);
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

  if (first === "up") {
    const proj = second;
    if (!proj) {
      process.stderr.write(USAGE.up + "\n");
      return 1;
    }
    try {
      const { supervisorUp } = await import("../core/supervisor.js");
      const result = await supervisorUp(proj);
      process.stdout.write(`${result.message}\n`);

      // 기동 실패 레인은 원인 + 조치(doctor/logs)를 인라인 표면화(⑧).
      const errorLanes = result.lanes.filter((l) => l.status === "error");
      for (const l of errorLanes) {
        process.stderr.write(
          formatException({
            situation: `레인 "${l.lane}" 기동 실패: ${l.error ?? "원인 미상"}`,
            action: `adde doctor ${proj} 로 환경·설정을 점검하고, adde logs ${proj} ${l.lane} --engine 으로 엔진 출력을 확인하세요.`,
          }) + "\n",
        );
      }

      const running = result.lanes.filter((l) => l.status === "running");
      if (running.length === 0) {
        // 레인 conf 자체가 없으면 생성 단계를 안내한다(⑨).
        if (result.lanes.length === 0) {
          process.stderr.write(
            formatException({
              situation: `기동할 레인이 없습니다 — ${proj} 에 레인 설정(conf)이 없습니다`,
              action: `adde lane add ${proj} <lane> --source telegram (또는 markdown) 으로 레인을 먼저 만드세요. 옵션은 adde lane help.`,
            }) + "\n",
          );
        }
        // 기동된 레인이 없으면 상주할 이유가 없다 — 오류 레인이 있으면 1.
        return errorLanes.length > 0 ? 1 : 0;
      }
      // 종료 신호 시 graceful shutdown — supervisorDown 으로 엔진 child·소스를 정리한 뒤 종료(S1/DEC-006).
      // (그냥 죽으면 child 좀비·정리 누락. typescript 규칙: down 완료 await 후에만 exit.)
      const { supervisorDown } = await import("../core/supervisor.js");
      let shuttingDown = false;
      const shutdown = (sig: NodeJS.Signals): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.stderr.write(`\n[adde] ${sig} 수신 — 레인 종료 중...\n`);
        void supervisorDown(proj)
          .then((r) => {
            process.stdout.write(`${r.message}\n`);
            process.exit(0);
          })
          .catch((err: unknown) => {
            process.stderr.write(
              formatException({
                situation: `종료 처리 중 오류: ${err instanceof Error ? err.message : String(err)}`,
                action: "잔존 엔진 프로세스를 수동 확인/종료하세요(ps | grep claude-code-acp).",
              }) + "\n",
            );
            process.exit(1);
          });
      };
      process.once("SIGINT", () => shutdown("SIGINT"));
      process.once("SIGTERM", () => shutdown("SIGTERM"));

      // 레인 기동 성공 → 소스 루프가 이벤트 루프를 유지하는 동안 포그라운드 상주.
      // 종료(Ctrl-C/SIGTERM)까지 resolve 하지 않아 진입점의 process.exit 를 막는다.
      await new Promise<never>(() => {});
      return 0; // 도달하지 않음
    } catch (err) {
      process.stderr.write(cmdError("up", err instanceof Error ? err.message : String(err)) + "\n");
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
      const { supervisorDown } = await import("../core/supervisor.js");
      const result = await supervisorDown(proj);
      process.stdout.write(`${result.message}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(
        cmdError("down", err instanceof Error ? err.message : String(err)) + "\n",
      );
      return 1;
    }
  }

  process.stdout.write(`${buildUsage()}\n`);
  return 0;
}
