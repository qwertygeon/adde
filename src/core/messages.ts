/**
 * CLI 사용자 노출 문자열의 단일 출처(SoT) — 사용법·명령 오류 안내·도움말.
 * presentation 계층(cli/run·lane·ops) 전용. 내부 라이브러리 throw Error(개발자 대상)는 여기서 다루지 않는다.
 * 런타임 차단·예외 포맷은 `shared/notify.ts`(formatBlock/formatException) 담당 — 역할 분리.
 */

/** CLI 명령 표면. 최소 표면 원칙(A-P005). */
export const COMMANDS = {
  /** 주 진입점. */
  primary: "adde",
  /** 단축 별칭. */
  short: "add",
} as const;

/** 최상위 도움말(인자 없음·미지원 명령 시). */
export function buildUsage(): string {
  return [
    `${COMMANDS.primary} — AI Driven Development Engine`,
    "",
    "사용법:",
    `  ${COMMANDS.primary} [command]      주 진입점`,
    `  ${COMMANDS.short} [command]       단축 별칭`,
    "",
    "명령:",
    "  up <proj>                프로젝트의 모든 레인 백그라운드 데몬으로 기동",
    "  down <proj>              데몬 종료 (어느 터미널에서든 동작)",
    "  restart <proj>           데몬 재기동 (down + up)",
    "  status [<proj>] [--all]  레인 상태 조회 (<proj> 생략 시 실행 중 전체, --all 정지 포함)",
    "  doctor [<proj>]          환경·설정 정적 점검(상태 비의존)",
    "  logs <proj> <lane> [N]   레인 transcript 최근 N줄(기본 50, --engine 시 엔진 stderr)",
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

/** 명령별 사용법 한 줄(인자 누락 시 안내). 끝에 \n 없음 — 호출부가 개행 부여. */
export const USAGE = {
  up: "사용법: adde up <proj>",
  down: "사용법: adde down <proj>",
  restart: "사용법: adde restart <proj>",
  status: "사용법: adde status [<proj>] [--all] [--json]",
  logs: "사용법: adde logs <proj> <lane> [N] [--engine]",
  laneAdd: "사용법: adde lane add <proj> <lane> [옵션]",
  laneLs: "사용법: adde lane ls <proj>",
  laneShow: "사용법: adde lane show <proj> <lane>",
  laneRm: "사용법: adde lane rm <proj> <lane>",
} as const;

/** `adde lane` 그룹 도움말. */
export const LANE_USAGE = [
  "사용법:",
  "  adde lane add <proj> <lane> [옵션]   레인 conf 생성",
  "  adde lane ls <proj>                  레인 목록",
  "  adde lane show <proj> <lane>         레인 conf 출력",
  "  adde lane rm <proj> <lane>           레인 conf 삭제",
  "",
  "lane add 옵션:",
  "  --source <telegram|markdown>  (기본 telegram)",
  "  --engine <name>               (기본 claude-code-acp)",
  "  --backend <name>              (기본 acp)",
  "  --channel <name>              (기본 source 값)",
  "  --perm-tier <acp|autopass>    (기본 acp — 전 도구 채널 승인 / autopass — denylist 외 자동 허용)",
  "  --acp-version <v>             (기본 v1)",
  "  --cwd <abs-path>              레인 작업 폴더(프로젝트 매핑)",
  "  --allowlist <a,b,c>           자동 허용 도구(게이트 유지, perm_tier=acp 용)",
  "  --denylist <항목,...>         autopass 에서 채널 승인으로 폴백할 도구·패턴",
  '                                (예: "Bash,Write(/etc/*)" · 미지정 시 내장 기본 목록: sudo·rm -rf·git 강제 변경·자격증명 읽기 차단)',
  "  --chat-id <id>                telegram 회신 대상",
  "  --token-stdin                 telegram 봇 토큰을 stdin 에서 읽어 .env(0600) 기록",
  "  --root <abs-path>             markdown 루트(예: Obsidian vault)",
  "  --inbox <rel> --approvals <rel> --outbox <rel>   markdown 노트 경로",
  "  --force                       기존 conf 덮어쓰기",
  "  --interactive                 대화형으로 필드 입력(TTY 전용, 토큰 제외)",
].join("\n");

/** 최상위 명령 오류 — `[adde <cmd>] 오류: <detail>`. */
export function cmdError(cmd: string, detail: string): string {
  return `[adde ${cmd}] 오류: ${detail}`;
}

/** `adde lane` 하위 오류 — `[adde lane] <detail>`. */
export function laneError(detail: string): string {
  return `[adde lane] ${detail}`;
}

/** 알 수 없는 lane 서브커맨드 안내(+ 사용법). */
export function unknownLaneSub(sub: string): string {
  return `알 수 없는 lane 서브커맨드: ${sub}\n\n${LANE_USAGE}`;
}
