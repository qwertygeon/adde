/**
 * 공개 배럴 — 테스트·후속 차수의 단일 진입점(NFR-004). 기존 `src/workflow/index.ts` 는 수정하지 않는다
 * (미배선).
 */
export * from "./result.js";
export * from "./ids.js";
export * from "./values.js";
export * from "./task-state.js";
export * from "./work-state.js";
export * from "./pending-decision.js";
export * from "./trigger.js";
export * from "./task-policy.js";
export * from "./aggregate.js";
export * from "./commands.js";
export type * from "./events.js";
export {
  DEFINITION_TRANSITION_EVENT_TYPES,
  DOMAIN_EVENT_PRODUCERS,
  RECORD_ONLY_EVENT_TYPES,
  TASK_REMINDER_EVENT_TYPES,
  TASK_REVISION_EVENT_TYPES,
  WORKFLOW_EVENT_SCHEMA_VERSION,
  WORK_EVENT_TYPES,
  parseEventType,
} from "./events.js";
export * from "./plan-graph.js";
export * from "./completion.js";
export * from "./evolve.js";
export type * from "./task-decide.js";
export { evaluateTime, isActivationSatisfied, routeAttemptOutcome } from "./task-decide.js";
export type * from "./work-decide.js";
export type * from "./cascade.js";
export type * from "./engine.js";
export { createWork, executeCommand } from "./engine.js";
export { isEngineCommit } from "./entry/seal.js";
export * from "./signals.js";
export * from "./fold.js";
export * from "./derivation/occurrence-id.js";
export * from "./derivation/idempotency-key.js";
export * from "./derivation/dedup-key.js";
export * from "./contract/index.js";
export * from "./timezone.js";
export * from "./timezone-names.js";
export * from "./registry/descriptors.js";
export * from "./registry/registries.js";
export * from "./registry/outputs.js";
export * from "./builtins/index.js";
export * from "./validation/reaction-spec.js";
export * from "./validation/task-validation.js";
export * from "./policy/approval-surface.js";
export type * from "./policy/pre-execution-approval.js";
export { requiresPreExecutionApproval } from "./policy/pre-execution-approval.js";
export * from "./policy/fan-out.js";
export * from "./policy/retry.js";
export * from "./policy/misfire.js";
export * from "./policy/spawn-limits.js";
export * from "./policy/trigger-cause.js";
export type * from "./derivation/canonical-json.js";
export {
  CANONICAL_JSON_MAX_DEPTH,
  canonicalJson,
  canonicalJsonDigest,
  canonicalJsonFrozenCopy,
  canonicalJsonSnapshot,
  utf8ByteLength,
} from "./derivation/canonical-json.js";
export {
  planProposalDigest,
  planMembershipChange,
  judgeMandatoryPlanApproval,
} from "./plan/proposal.js";
export type {
  PlanProposalSource,
  PlanProposalInput,
  ProposedTaskDraft,
  PlanProposal,
  PlanMembershipChange,
  MandatoryApprovalReason,
  MandatoryApprovalJudgement,
  PlanProposalCheck,
  PlanProposalContent,
  PlanPreconditionCode,
} from "./plan/proposal.js";
export * from "./plan/replan.js";
export * from "./task-result/data-schema.js";
export * from "./task-result/schema-shape.js";
export type * from "./task-result/outputs.js";
export {
  OUTPUT_SCHEMA_VIOLATION,
  prepareAcceptanceOutputs,
  prepareReportedOutputs,
} from "./task-result/outputs.js";
export { resolveBoundInputs, bindingUnsatisfiedProducerIds } from "./task-result/binding.js";
export type {
  OccurrenceBindingField,
  InputBinding,
  BoundInput,
  BindingResolutionFailure,
} from "./task-result/binding.js";
export * from "./timezone-recompute.js";
export * from "./definition/model.js";
export {
  workflowStateOf,
  withWork,
  findSteward,
  openOccurrenceCount,
  foldWorkflowEvents,
} from "./definition/commit.js";
export type { StewardWork, WorkflowState } from "./definition/commit.js";
export { buildTemplateProposal, templateProposalDigest } from "./definition/draft.js";
export type { TemplateProposalCheck } from "./definition/draft.js";
export { materializationBlocker } from "./definition/occurrence.js";
export { executeDefinitionCommand, judgeDefinitionSignal } from "./definition/engine.js";
export type { WorkflowOutcome, WorkflowSignalJudgement } from "./definition/engine.js";
export { judgeTaskExternalSignal } from "./external-signal.js";
export { providedOccurrenceFields } from "./task-result/binding.js";
