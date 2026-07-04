/**
 * 소스 어댑터 — telegram(long-poll)·markdown(fs watch, 예: Obsidian). discord(Gateway WS)는 보류.
 */
export { createTelegramSource } from "./telegram.js";
export type { TelegramSource, TelegramConfig, GateDecisionCallback } from "./telegram.js";
export { createMarkdownSource } from "./markdown.js";
export type { MarkdownConfig } from "./markdown.js";
export type { Source, Decision, DecisionCallback } from "./source.js";
