/**
 * 소스 어댑터 — telegram(long-poll)·markdown(fs watch, 예: Obsidian). discord(Gateway WS)는 보류(design/07 DEC-03).
 * 설계: docs/_internal/design/01-architecture.md, 05-oss-prior-art.md, 09-markdown-source-adapter.md.
 */
export { createTelegramSource } from "./telegram.js";
export type { TelegramSource, TelegramConfig, GateDecisionCallback } from "./telegram.js";
export { createMarkdownSource } from "./markdown.js";
export type { MarkdownConfig } from "./markdown.js";
export type { Source, Decision, DecisionCallback } from "./source.js";
