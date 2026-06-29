/**
 * 설정 차이 비교·WARN.
 * FR-012/013/ADR-007: ADDE 정책 ↔ 엔진 실효 설정 비교.
 * GAP-001 안전망: 조회 실패 시 "확인불가=차이"로 보수적 WARN 발화.
 */
import { maskSecrets } from "../../shared/mask.js";

export interface AddePolicy {
  perm_tier: string;
  allowlist?: string[];
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
): PermDiffResult {
  if (engineEffective === null) {
    const warn = {
      level: "WARN" as const,
      message: formatWarn(
        addePolicy,
        null,
        "엔진 실효 설정 조회 실패 — 확인불가(보수적 차이 간주)",
      ),
      adde: addePolicy,
      engine: null,
      reason: "조회실패",
    };
    return { diff: true, warn };
  }

  const addeIsStrict = addePolicy.perm_tier === "acp";
  const engineIsBypass =
    engineEffective.bypassPermissions === true ||
    engineEffective.permissionMode === "bypassPermissions";

  if (addeIsStrict && engineIsBypass) {
    const warn = {
      level: "WARN" as const,
      message: formatWarn(addePolicy, engineEffective, "ADDE 정책(acp) 보다 느슨한 엔진 설정 감지"),
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
): string {
  const engineStr = engine ? JSON.stringify(engine) : "(조회실패)";
  const raw = `[ADDE WARN] 권한 설정 차이: ${reason} | adde.perm_tier=${adde.perm_tier} | engine=${engineStr}`;
  return maskSecrets(raw);
}
