import { readVersion } from "../core/version.js";
import { COMMANDS, buildUsage } from "./usage.js";

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

  if (first === "up") {
    const proj = second;
    if (!proj) {
      process.stderr.write("사용법: adde up <proj>\n");
      return 1;
    }
    try {
      const { supervisorUp } = await import("../core/supervisor.js");
      const result = await supervisorUp(proj);
      process.stdout.write(`${result.message}\n`);
      const running = result.lanes.filter((l) => l.status === "running");
      if (running.length === 0) {
        // 기동된 레인이 없으면 상주할 이유가 없다 — 오류 레인이 있으면 1.
        return result.lanes.some((l) => l.status === "error") ? 1 : 0;
      }
      // 레인 기동 성공 → 소스 루프가 이벤트 루프를 유지하는 동안 포그라운드 상주.
      // 종료(Ctrl-C/SIGTERM)까지 resolve 하지 않아 진입점의 process.exit 를 막는다.
      await new Promise<never>(() => {});
      return 0; // 도달하지 않음
    } catch (err) {
      process.stderr.write(
        `[adde up] 오류: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  if (first === "down") {
    const proj = second;
    if (!proj) {
      process.stderr.write("사용법: adde down <proj>\n");
      return 1;
    }
    try {
      const { supervisorDown } = await import("../core/supervisor.js");
      const result = await supervisorDown(proj);
      process.stdout.write(`${result.message}\n`);
      return 0;
    } catch (err) {
      process.stderr.write(
        `[adde down] 오류: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  process.stdout.write(`${buildUsage()}\n`);
  return 0;
}
