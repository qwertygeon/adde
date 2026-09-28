/**
 * 신호 dedup 키 표 전사(FR-022, FR-023) — the workflow contract "Signal deduplication key" 9행.
 */

export interface SignalDedupKeyRow {
  readonly signalType: string;
  readonly subjectIdText: string;
  readonly logicalOccurrenceText: string;
  readonly exampleKey: string;
}

export const SIGNAL_DEDUP_KEY_ROWS = [
  {
    signalType: "confirmation_decision",
    subjectIdText: "`confirmationId`",
    logicalOccurrenceText: "`<expectedRevision>:<decision>`",
    exampleKey: "confirmation_decision:cfm_x:3:accept",
  },
  {
    signalType: "input_provided",
    subjectIdText: "`taskId` or `workId`",
    logicalOccurrenceText: "`<questionId>:<answerContentHash>`",
    exampleKey: "input_provided:tsk_x:completionEvidence:9f2c…",
  },
  {
    signalType: "cancel_requested",
    subjectIdText: "`taskId` or `workId`",
    logicalOccurrenceText: "`<expectedRevision>`",
    exampleKey: "cancel_requested:tsk_x:3",
  },
  {
    signalType: "human_decision",
    subjectIdText: "`PendingDecision.id`",
    logicalOccurrenceText:
      "`<expectedRevision>:<grant|deny>`, where the revision is that of the decision's subject — the Task, the Work for `plan_approval_required`, or the decision's own for a decision whose subject is `subject` (a `destructive_control_operation` without a Task, the dead letter of a wait's effect or of a transition reaction)",
    exampleKey: "human_decision:dec_x:7:grant",
  },
  {
    signalType: "delegation_response",
    subjectIdText: "`taskId`",
    logicalOccurrenceText: "`<expectedRevision>:<occurrenceId>:<responseContentHash>`",
    exampleKey: "delegation_response:tsk_x:7:occ_y:1a04…",
  },
  {
    signalType: "replan_requested",
    subjectIdText: "`workId`",
    logicalOccurrenceText: "`<expectedRevision>`",
    exampleKey: "replan_requested:wrk_x:7",
  },
  {
    signalType: "definition_control",
    subjectIdText: "`definitionId`",
    logicalOccurrenceText: "`<expectedRevision>:<pause|resume|stop>`",
    exampleKey: "definition_control:wdf_x:4:pause",
  },
  {
    signalType: "agent_result",
    subjectIdText: "`dispatchId`",
    logicalOccurrenceText: "`<resultContentHash>`",
    exampleKey: "agent_result:dsp_x:4f11…",
  },
  {
    signalType: "external_signal",
    subjectIdText: "`taskId`, or `definitionId` for a WorkDefinition's `signal` activation",
    logicalOccurrenceText: "canonical JSON tuple `[sourceId, signalName, sourceOccurrenceId]`",
    exampleKey: 'external_signal:tsk_x:["copy_adapter","copy_done","operation_42"]',
  },
] as const satisfies readonly SignalDedupKeyRow[];
