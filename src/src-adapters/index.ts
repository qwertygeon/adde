/**
 * 소스 어댑터 — telegram(long-poll)·obsidian(fs watch). discord(Gateway WS)는 보류(design/07 DEC-03).
 * 설계: docs/_internal/design/01-architecture.md, 05-oss-prior-art.md, 09-obsidian-source-adapter.md.
 */
export { createTelegramSource } from "./telegram.js";
export type { TelegramSource, TelegramConfig, GateDecisionCallback } from "./telegram.js";
export { createObsidianSource } from "./obsidian.js";
export type { ObsidianConfig } from "./obsidian.js";
export type { Source, Decision, DecisionCallback } from "./source.js";
