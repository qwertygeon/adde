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
    "명령:",
    "  up <proj>                프로젝트의 모든 레인 기동",
    "  down <proj>              레인 종료",
    "  status <proj> [--json]   레인 상태(running/dead/stopped) 조회",
    "  doctor [<proj>]          환경·설정 정적 점검(상태 비의존)",
    "  logs <proj> <lane> [N]   레인 transcript 최근 N줄(기본 50)",
    "  lane add <proj> <lane>   레인 conf 생성",
    "  lane ls <proj>           레인 목록",
    "  lane show <proj> <lane>  레인 conf 출력",
    "  lane rm <proj> <lane>    레인 conf 삭제",
    "",
    "옵션:",
    "  -v, --version            버전 출력",
    "  -h, --help               도움말 출력",
    "",
    "레인 옵션은 `adde lane help` 참조.",
  ].join("\n");
}
