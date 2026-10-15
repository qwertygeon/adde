/**
 * 시험 전용 내부 진입 — 공개 배럴 전부와, 엔진 진입 검사를 거치지 않고 이벤트·커밋을 만들거나 검사를 따로
 * 조합하게 하는 함수. 도메인 밖 프로덕션 코드는 이 모듈을 import 하지 않는다(정적 시험이 지킨다). 진입 사본·
 * 커밋 표식 함수는 여기에도 내보내지 않는다.
 */
export * from "./index.js";
export { assembleCommit } from "./engine.js";
export { mkEvent } from "./events.js";
export { decideTaskCommand } from "./task-decide.js";
export { decideCreateWork, decideWorkCommand } from "./work-decide.js";
export {
  decideWorkCancellationCascade,
  decideReplanDroppedCancellations,
  decidePendingProposalRevalidation,
  decideDependencyCascadeRound,
  decideDerivedWorkStateEvent,
} from "./cascade.js";
export { preExecutionApprovalPark } from "./policy/pre-execution-approval.js";
export { checkReportedOutputs } from "./task-result/outputs.js";
export { planPreconditionRejection, validatePlanProposal } from "./plan/proposal.js";
