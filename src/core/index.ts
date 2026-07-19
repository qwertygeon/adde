/**
 * 코어 — 슈퍼바이저·레인 lifecycle·큐·직렬 인젝터·transcript logger·헬스.
 */
export { readVersion } from "./version.js";
export { supervisorUp, supervisorDown } from "./supervisor.js";
export type {
  LaneStatus,
  SupervisorUpResult,
  SupervisorDownResult,
  AcpFactory,
  SupervisorUpOptions,
  SupervisorDownOptions,
} from "./supervisor.js";
export { enqueue, claimNext, scanProcessing } from "./queue.js";
export { isDone, writeOutBody } from "./out-ledger.js";
export type { OutSidecar } from "./out-ledger.js";
export { createInjector } from "./injector.js";
export { appendTranscript, renderEvent } from "./transcript.js";
export type { SessionEvent } from "./transcript.js";
