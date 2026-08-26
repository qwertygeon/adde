/**
 * 미구현 채널 stub(FR-027) — 목록·진단에 노출되나 바인딩 생성은 거부된다(ADR-015).
 * factory 를 제공하지 않는다(등재 규약).
 */
import type { SurfaceDescriptor } from "./types.js";

export const telegramSurface: SurfaceDescriptor = {
  id: "telegram",
  status: "stub",
};

export const discordSurface: SurfaceDescriptor = {
  id: "discord",
  status: "stub",
};
