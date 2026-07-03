/**
 * CLI 사용자 노출 문자열의 단일 표면 — 사용법·명령 오류 안내·도움말.
 * 문구 본문은 i18n 카탈로그(`shared/locales/`)가 소유하고, 본 모듈은 CLI API 를 유지한다.
 * presentation 계층(cli/run·lane·ops) 전용. 내부 라이브러리 throw Error(개발자 대상)는 여기서 다루지 않는다.
 * 런타임 차단·예외 포맷은 `shared/notify.ts`(formatBlock/formatException) 담당 — 역할 분리.
 */
import { t } from "../shared/i18n.js";

/** CLI 명령 표면. 최소 표면 원칙(A-P005). */
export const COMMANDS = {
  /** 주 진입점. */
  primary: "adde",
  /** 단축 별칭. */
  short: "add",
} as const;

/** 최상위 도움말(인자 없음·미지원 명령 시). */
export function buildUsage(): string {
  return t("usage.main", { primary: COMMANDS.primary, short: COMMANDS.short });
}

/** 명령별 사용법 한 줄(인자 누락 시 안내). 끝에 \n 없음 — 호출부가 개행 부여. getter 로 현재 로케일 반영. */
export const USAGE = {
  get up(): string {
    return t("usage.up");
  },
  get down(): string {
    return t("usage.down");
  },
  get restart(): string {
    return t("usage.restart");
  },
  get status(): string {
    return t("usage.status");
  },
  get logs(): string {
    return t("usage.logs");
  },
  get sessions(): string {
    return t("usage.sessions");
  },
  get laneAdd(): string {
    return t("usage.laneAdd");
  },
  get laneLs(): string {
    return t("usage.laneLs");
  },
  get laneShow(): string {
    return t("usage.laneShow");
  },
  get laneRm(): string {
    return t("usage.laneRm");
  },
};

/** `adde lane` 그룹 도움말. */
export function buildLaneUsage(): string {
  return t("usage.lane");
}

/** 최상위 명령 오류 — `[adde <cmd>] 오류: <detail>`. */
export function cmdError(cmd: string, detail: string): string {
  return t("cli.cmdError", { cmd, detail });
}

/** `adde lane` 하위 오류 — `[adde lane] <detail>`. */
export function laneError(detail: string): string {
  return t("cli.laneError", { detail });
}

/** 알 수 없는 lane 서브커맨드 안내(+ 사용법). */
export function unknownLaneSub(sub: string): string {
  return `${t("cli.unknownSub", { sub })}\n\n${buildLaneUsage()}`;
}
