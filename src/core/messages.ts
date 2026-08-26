/**
 * CLI 사용자 노출 문자열의 단일 표면(v2) — 사용법·명령 오류 안내·도움말.
 * 문구 본문은 i18n 카탈로그(`shared/locales/`)가 소유하고, 본 모듈은 CLI API 를 유지한다.
 */
import { t } from "../shared/i18n.js";

/** CLI 종료 코드 3-계약 — 전 디스패치가 이 상수를 참조한다. */
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2 } as const;

export const COMMANDS = {
  primary: "adde",
  short: "add",
} as const;

export function buildUsage(): string {
  return t("usage.main", { primary: COMMANDS.primary, short: COMMANDS.short });
}

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
  get completion(): string {
    return t("usage.completion");
  },
  get project(): string {
    return t("usage.project");
  },
  get session(): string {
    return t("usage.session");
  },
  get bind(): string {
    return t("usage.bind");
  },
  get vault(): string {
    return t("usage.vault");
  },
};

/** 명령 그룹(project/session/bind/vault) 도움말 — usageKey 는 spec.ts 의 usageKey. */
export function buildGroupUsage(usageKey: string): string {
  return t(usageKey as never);
}

/** 알 수 없는 그룹 서브커맨드 안내(+ 사용법). */
export function unknownGroupSub(group: string, sub: string, usageKey: string): string {
  return `${t("cli.unknownSub", { sub: `${group} ${sub}` })}\n\n${buildGroupUsage(usageKey)}`;
}

/** 최상위 명령 오류 — `[adde <cmd>] 오류: <detail>`. */
export function cmdError(cmd: string, detail: string): string {
  return t("cli.cmdError", { cmd, detail });
}

/** 명령 그룹 하위 오류 — `[adde <group>] <detail>`. */
export function groupError(group: string, detail: string): string {
  return t("cli.cmdError", { cmd: group, detail });
}

/** 파서 오류(kind+token)를 i18n 렌더링 텍스트로 변환. */
export function flagErrorText(error: {
  kind: "unknown-flag" | "value-required";
  token: string;
}): string {
  return error.kind === "value-required"
    ? t("cli.valueRequired", { key: error.token })
    : t("cli.unknownFlag", { flag: error.token });
}
