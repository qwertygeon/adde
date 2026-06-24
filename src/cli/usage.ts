/**
 * CLI 명령 표면 정의. 최소 표면 원칙(A-P005) — 표면을 불필요하게 늘리지 않는다.
 */

export const COMMANDS = {
  /** 주 진입점. */
  primary: "adde",
  /** 단축 별칭. */
  short: "add",
} as const;

export function buildUsage(): string {
  return [
    `${COMMANDS.primary} — AI Driven Development Engine`,
    "",
    "사용법:",
    `  ${COMMANDS.primary} [command]      주 진입점`,
    `  ${COMMANDS.short} [command]       단축 별칭`,
    "",
    "옵션:",
    "  -v, --version            버전 출력",
    "  -h, --help               도움말 출력",
  ].join("\n");
}
