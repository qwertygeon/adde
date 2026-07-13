/**
 * CLI 사용자 노출 문자열의 단일 표면 — 사용법·명령 오류 안내·도움말.
 * 문구 본문은 i18n 카탈로그(`shared/locales/`)가 소유하고, 본 모듈은 CLI API 를 유지한다.
 * presentation 계층(cli/run·lane·ops) 전용. 내부 라이브러리 throw Error(개발자 대상)는 여기서 다루지 않는다.
 * 런타임 차단·예외 포맷은 `shared/notify.ts`(formatBlock/formatException) 담당 — 역할 분리.
 */
import { t } from "../shared/i18n.js";

/** CLI 명령 표면. 최소 표면 원칙. */
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
  get laneSet(): string {
    return t("usage.laneSet");
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
  get completion(): string {
    return t("usage.completion");
  },
};

/** `adde lane` 그룹 도움말. */
export function buildLaneUsage(): string {
  return t("usage.lane");
}

/** `adde proj` 그룹 도움말. */
export function buildProjUsage(): string {
  return t("usage.proj");
}

/** 알 수 없는 proj 서브커맨드 안내(+ 사용법). */
export function unknownProjSub(sub: string): string {
  return `${t("cli.unknownSub", { sub })}\n\n${buildProjUsage()}`;
}

/** 최상위 명령 오류 — `[adde <cmd>] 오류: <detail>`. */
export function cmdError(cmd: string, detail: string): string {
  return t("cli.cmdError", { cmd, detail });
}

/** `adde lane` 하위 오류 — `[adde lane] <detail>`. */
export function laneError(detail: string): string {
  return t("cli.laneError", { detail });
}

/**
 * 파서 오류(kind+token)를 i18n 렌더링 텍스트로 변환 — 값 echo 없이 플래그/키 이름만 포함(A-P003).
 * run/ops/lane/proj 디스패치가 공유하는 미지원 플래그·값 누락 오류 문구 SSOT.
 */
export function flagErrorText(error: {
  kind: "unknown-flag" | "value-required";
  token: string;
}): string {
  return error.kind === "value-required"
    ? t("cli.valueRequired", { key: error.token })
    : t("cli.unknownFlag", { flag: error.token });
}

/** 알 수 없는 lane 서브커맨드 안내(+ 사용법). */
export function unknownLaneSub(sub: string): string {
  return `${t("cli.unknownSub", { sub })}\n\n${buildLaneUsage()}`;
}
