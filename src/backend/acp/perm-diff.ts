/**
 * 설정 차이 비교·WARN.
 * ADDE 정책 ↔ 엔진 실효 설정 비교.
 * 안전망: 조회 실패 시 "확인불가=차이"로 보수적 WARN 발화.
 */
import { maskSecrets } from "../../shared/mask.js";
import { t } from "../../shared/i18n.js";

/** 로케일 고정 t (레인별 채널 로케일). 미지정 시 전역 로케일. */
type Tl = typeof t;

export interface AddePolicy {
  perm_tier: string;
  allowlist?: string[];
  /** perm_tier=autopass 에서 채널 승인으로 폴백할 도구명 목록. */
  denylist?: string[];
}

export interface EngineEffective {
  permissionMode?: string | undefined;
  bypassPermissions?: boolean | undefined;
}

export interface PermDiffResult {
  diff: boolean;
  warn?: {
    level: "WARN";
    message: string;
    adde: AddePolicy;
    engine: EngineEffective | null;
    reason: string;
  };
}

/**
 * ADDE 정책과 엔진 실효 설정을 비교한다.
 * 동일 입력에서 단일 분기 블록으로 "차이 여부 + WARN 발화" 결정(research §E).
 *
 * engineEffective 가 null 이면 조회 실패로 간주 → 보수적 "확인불가=차이" WARN.
 */
export function comparePerm(
  addePolicy: AddePolicy,
  engineEffective: EngineEffective | null,
  tl: Tl = t,
): PermDiffResult {
  if (engineEffective === null) {
    const warn = {
      level: "WARN" as const,
      message: formatWarn(addePolicy, null, tl("permDiff.queryFailedMsg"), tl),
      adde: addePolicy,
      engine: null,
      reason: "조회실패",
    };
    return { diff: true, warn };
  }

  const engineIsBypass =
    engineEffective.bypassPermissions === true ||
    engineEffective.permissionMode === "bypassPermissions";

  if (addePolicy.perm_tier === "acp" && engineIsBypass) {
    const warn = {
      level: "WARN" as const,
      message: formatWarn(addePolicy, engineEffective, tl("permDiff.looseEngine"), tl),
      adde: addePolicy,
      engine: engineEffective,
      reason: "정책차이",
    };
    return { diff: true, warn };
  }

  if (addePolicy.perm_tier === "autopass" && engineIsBypass) {
    // 엔진 bypass 는 권한 요청 자체를 발화하지 않는다 — autopass 의 denylist 폴백·자동허용
    // 기록이 전부 무력화되므로 acp 와 별도 사유로 표기한다.
    const warn = {
      level: "WARN" as const,
      message: formatWarn(addePolicy, engineEffective, tl("permDiff.bypassMsg"), tl),
      adde: addePolicy,
      engine: engineEffective,
      reason: "정책차이",
    };
    return { diff: true, warn };
  }

  return { diff: false };
}

/**
 * WARN 메시지 포맷 — 마스킹 적용.
 */
export function formatWarn(
  adde: AddePolicy,
  engine: EngineEffective | null,
  reason: string,
  tl: Tl = t,
): string {
  const engineStr = engine ? JSON.stringify(engine) : tl("permDiff.engineUnknown");
  return maskSecrets(tl("permDiff.warnLine", { reason, tier: adde.perm_tier, engine: engineStr }));
}
