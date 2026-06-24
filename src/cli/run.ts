import { readVersion } from "../core/version.js";
import { COMMANDS, buildUsage } from "./usage.js";

/**
 * CLI 진입 로직. adde / add 양쪽 진입점이 공유한다.
 * @returns 프로세스 종료 코드.
 */
export function run(argv: readonly string[]): number {
  const [first] = argv;

  if (first === "--version" || first === "-v") {
    process.stdout.write(`${COMMANDS.primary} ${readVersion()}\n`);
    return 0;
  }

  process.stdout.write(`${buildUsage()}\n`);
  return 0;
}
