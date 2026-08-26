/**
 * Surface 레지스트리(L4) — FR-024·FR-027. markdown 만 구현, telegram·discord 는 stub 로 등재된다
 * (ADR-015 — 목록·진단 노출 + 바인딩 생성 거부).
 */
import { markdownSurfaceDescriptor } from "./markdown/index.js";
import { telegramSurface, discordSurface } from "./stubs.js";
import type { SurfaceDescriptor } from "./types.js";

export const SURFACE_REGISTRY: Record<string, SurfaceDescriptor> = {
  markdown: markdownSurfaceDescriptor,
  telegram: telegramSurface,
  discord: discordSurface,
};

export const SURFACE_IDS: readonly string[] = Object.keys(SURFACE_REGISTRY);

export type {
  Surface,
  SurfaceContext,
  SurfaceDescriptor,
  Binding,
  PermRequest,
  OutboundMessage,
  TurnRef,
} from "./types.js";
