/**
 * ACP 백엔드 — 범용 ACP(JSON-RPC/stdio) 클라이언트 어댑터. 엔진 차이는 기동 프로필로 흡수.
 */
export { AcpBackendImpl } from "./client.js";
export type { AcpBackend } from "./client.js";
export { spawnEngine, cleanEnv } from "./spawn.js";
export { comparePerm, formatWarn } from "./perm-diff.js";
export type { AddePolicy, EngineEffective, PermDiffResult } from "./perm-diff.js";
