/**
 * 소스 어댑터 — telegram(long-poll)·markdown(fs watch, 예: Obsidian). discord(Gateway WS)는 보류.
 * 새 소스는 SOURCE_REGISTRY 에 id→팩토리로 등록하면 supervisor·doctor·CLI 가 자동 인식한다.
 */
import { createMarkdownSource } from "./markdown.js";
import { createTelegramSourceFromContext } from "./telegram.js";
import type { SourceFactory } from "./source.js";

export { createTelegramSource, createTelegramSourceFromContext } from "./telegram.js";
export type { TelegramSource, TelegramConfig, GateDecisionCallback } from "./telegram.js";
export { createMarkdownSource } from "./markdown.js";
export type { Source, Decision, DecisionCallback, SourceContext, SourceFactory } from "./source.js";

/**
 * source id → 어댑터 팩토리. 단일 SoT — 지원 소스 목록·기동 디스패치·doctor·CLI 완성이 여기서 파생.
 * 미등록 소스는 supervisor 가 fail-closed(status:error)로 격리한다(조용한 폴백 없음).
 */
export const SOURCE_REGISTRY: Record<string, SourceFactory> = {
  markdown: createMarkdownSource,
  telegram: createTelegramSourceFromContext,
};

/** 등록된 source id 목록(등록 순서 = markdown 우선). */
export const SOURCE_IDS: readonly string[] = Object.keys(SOURCE_REGISTRY);
