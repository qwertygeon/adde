/**
 * 엔진 레지스트리(L2) — 지원 엔진 목록·검증·진단이 전부 이 집합에서 파생된다(FR-020·SC-020).
 * 새 엔진 지원 추가 = 등록 항목 1개 + doctorChecks 1개(코어 변경 불요).
 */
import { acpDriver } from "./acp/driver.js";
import type { EngineDriverDescriptor } from "./types.js";

export const ENGINE_REGISTRY: Record<string, EngineDriverDescriptor> = {
  acp: acpDriver,
};

export const ENGINE_IDS: readonly string[] = Object.keys(ENGINE_REGISTRY);

export type {
  EngineCaps,
  EngineDriverDescriptor,
  EngineEvent,
  EngineSession,
  OpenCtx,
  PermPolicy,
} from "./types.js";
