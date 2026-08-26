/**
 * 설정 차이 비교·WARN(현행 `backend/acp/perm-diff.ts` 그대로 이식) — ADDE 정책 ↔ 엔진 실효 설정 비교.
 * 안전망: 조회 실패 시 "확인불가=차이"로 보수적 WARN 발화(A-P006 설정 차이 표기, ADR-022).
 */
import { maskSecrets } from "../../shared/mask.js";
import { t } from "../../shared/i18n.js";

type Tl = typeof t;

export interface AddePolicy {
  perm_tier: string;
  allowlist?: readonly string[];
  denylist?: readonly string[];
  hard_deny?: readonly string[];
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
 * ADDE 정책과 엔진 실효 설정을 비교한다. engineEffective 가 null 이면 조회 실패로 간주 →
 * 보수적 "확인불가=차이" WARN.
 */
export function comparePerm(
  addePolicy: AddePolicy,
  engineEffective: EngineEffective | null,
  tl: Tl = t,
): PermDiffResult {
  if (engineEffective === null) {
    return {
      diff: true,
      warn: {
        level: "WARN",
        message: formatWarn(addePolicy, null, tl("permDiff.queryFailedMsg"), tl),
        adde: addePolicy,
        engine: null,
        reason: "조회실패",
      },
    };
  }

  const engineIsBypass =
    engineEffective.bypassPermissions === true ||
    engineEffective.permissionMode === "bypassPermissions";

  if (addePolicy.perm_tier === "acp" && engineIsBypass) {
    return {
      diff: true,
      warn: {
        level: "WARN",
        message: formatWarn(addePolicy, engineEffective, tl("permDiff.looseEngine"), tl),
        adde: addePolicy,
        engine: engineEffective,
        reason: "정책차이",
      },
    };
  }

  if (addePolicy.perm_tier === "autopass" && engineIsBypass) {
    return {
      diff: true,
      warn: {
        level: "WARN",
        message: formatWarn(addePolicy, engineEffective, tl("permDiff.bypassMsg"), tl),
        adde: addePolicy,
        engine: engineEffective,
        reason: "정책차이",
      },
    };
  }

  return { diff: false };
}

/** WARN 메시지 포맷 — 마스킹 적용. */
export function formatWarn(
  adde: AddePolicy,
  engine: EngineEffective | null,
  reason: string,
  tl: Tl = t,
): string {
  const engineStr = engine ? JSON.stringify(engine) : tl("permDiff.engineUnknown");
  return maskSecrets(tl("permDiff.warnLine", { reason, tier: adde.perm_tier, engine: engineStr }));
}
