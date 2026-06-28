import { readVersion } from "../core/version.js";
import { COMMANDS, buildUsage } from "./usage.js";

/**
 * CLI 진입 로직. adde / add 양쪽 진입점이 공유한다.
 * @returns 프로세스 종료 코드.
 */
export function run(argv: readonly string[]): number {
  const [first, second] = argv;

  if (first === "--version" || first === "-v") {
    process.stdout.write(`${COMMANDS.primary} ${readVersion()}\n`);
    return 0;
  }

  if (first === "up") {
    const proj = second;
    if (!proj) {
      process.stderr.write("사용법: adde up <proj>\n");
      return 1;
    }
    import("../core/supervisor.js")
      .then(({ supervisorUp }) => supervisorUp(proj))
      .catch((err: unknown) => {
        process.stderr.write(
          `[adde up] 오류: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      });
    return 0;
  }

  if (first === "down") {
    const proj = second;
    if (!proj) {
      process.stderr.write("사용법: adde down <proj>\n");
      return 1;
    }
    import("../core/supervisor.js")
      .then(({ supervisorDown }) => supervisorDown(proj))
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(
          `[adde down] 오류: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      });
    return 0;
  }

  process.stdout.write(`${buildUsage()}\n`);
  return 0;
}
