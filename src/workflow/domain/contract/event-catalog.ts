/**
 * 이벤트 카탈로그 전사(FR-015, FR-023) — the workflow contract "Event type catalog" 117행(11절).
 * `producedBy` 는 도메인 표기 필드(design.md §9) — 계약 원문이 아니라 "본 차수 생산" 여부 분류다.
 */

export type EventCatalogSection =
  | "Work events"
  | "Work definition events"
  | "Task events"
  | "Trigger, signal and confirmation events"
  | "Reaction and outbox events"
  | "Agent dispatch events"
  | "Control queue events"
  | "Runtime lifecycle events"
  | "Markdown ingress events"
  | "Recommendation events"
  | "Policy and limit events";

export type EventProducer =
  | "phase1-core"
  | "phase1-registries"
  | "phase1-plans-definitions"
  | "phase2"
  | "phase3"
  | "phase4"
  | "phase6"
  | "phase9";

export interface EventCatalogRow {
  readonly name: string;
  readonly section: EventCatalogSection;
  readonly meaning: string;
  readonly affects: "P" | "Q" | "P+Q";
  readonly producedBy: EventProducer;
}

export const EVENT_CATALOG = [
  // Work events (17) — phase1-core
  {
    name: "work_created",
    section: "Work events",
    meaning:
      "Work committed; for an occurrence Work, carries `definitionId`, `definitionRevision`, `occurrenceId` and the `OccurrenceInput`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_planning_started",
    section: "Work events",
    meaning: "Accepted for planning",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_plan_proposed",
    section: "Work events",
    meaning:
      "Valid `PlanProposal` awaiting human approval; carries its id, digest and the `plan_approval_required` decision",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_plan_rejected",
    section: "Work events",
    meaning:
      "A human denied the plan approval decision; planning restarts for a Work with no committed plan, and a replan closes with the current revision kept",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_plan_withdrawn",
    section: "Work events",
    meaning:
      "The proposal awaiting approval stopped validating or the Work's source changed; its decision closed unanswered",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_plan_invalid",
    section: "Work events",
    meaning:
      "Planner output failed decode, registry, schema, policy or DAG validation; nothing executes",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_input_requested",
    section: "Work events",
    meaning: "Missing information, with `InputRequest[]`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_input_received",
    section: "Work events",
    meaning: "Answers ingested",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_plan_committed",
    section: "Work events",
    meaning:
      "Proposal committed as the next plan revision; carries the proposal id and digest, the decision that granted it when one did, the revision, the `draftRef` mapping and the retained, superseded and dropped Task ids",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "work_replanning_started",
    section: "Work events",
    meaning:
      "An accepted `replan_requested` signal reopened the plan of an `ACTIVE` or `BLOCKED` Work",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "work_ready",
    section: "Work events",
    meaning:
      "Plan committed, or a denied replan closed; the Work's derived state is evaluated in the same commit",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_activated",
    section: "Work events",
    meaning:
      "Derived state became `ACTIVE`: a member is past `VALIDATING`, the Work was `ACTIVE` or `BLOCKED` under its current plan revision, or it stewards a WorkDefinition that is not `STOPPED`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_blocked",
    section: "Work events",
    meaning:
      "Derived state became `BLOCKED`: no member progressable and a terminal-required member unsatisfied",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_unblocked",
    section: "Work events",
    meaning: "Derived state left `BLOCKED` for `ACTIVE`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_completed",
    section: "Work events",
    meaning: "Completion policy satisfied; for a steward, carries the definition's `stopOrigin`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_failed",
    section: "Work events",
    meaning: "Declared Work-level failure",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "work_canceled",
    section: "Work events",
    meaning: "Authorized cancellation; payload carries `origin: CancelOrigin`",
    affects: "P+Q",
    producedBy: "phase1-core",
  },

  // Work definition events (7) — phase1-plans-definitions
  {
    name: "work_definition_created",
    section: "Work definition events",
    meaning:
      "A committed proposal registered a WorkDefinition in `ACTIVE`; a schedule activation's first occurrence is persisted",
    affects: "P+Q",
    producedBy: "phase1-plans-definitions",
  },
  {
    name: "work_definition_revised",
    section: "Work definition events",
    meaning:
      "A committed proposal amended the definition; later occurrences use the new revision, the previous activation's pending schedule rows not yet due are canceled, its instants already due are skipped, and its next occurrence recomputed",
    affects: "P+Q",
    producedBy: "phase1-plans-definitions",
  },
  {
    name: "work_definition_paused",
    section: "Work definition events",
    meaning:
      "Entered `PAUSED`; payload carries `pauseOrigin`; schedule instants due meanwhile are resolved once when the pause ends, and signal occurrences are held",
    affects: "P",
    producedBy: "phase1-plans-definitions",
  },
  {
    name: "work_definition_resumed",
    section: "Work definition events",
    meaning:
      "Entered `ACTIVE`; the overdue schedule row is resolved as a misfire and held occurrences are released by the open-occurrence rule",
    affects: "P+Q",
    producedBy: "phase1-plans-definitions",
  },
  {
    name: "work_definition_stopped",
    section: "Work definition events",
    meaning:
      "Entered `STOPPED`; payload carries `stopOrigin`; pending schedule rows not yet due are canceled, and held occurrences and schedule instants already due are skipped",
    affects: "P+Q",
    producedBy: "phase1-plans-definitions",
  },
  {
    name: "work_definition_occurrence_held",
    section: "Work definition events",
    meaning:
      "A due occurrence was not materialized because of the open-occurrence bound, an older held occurrence, an invalid template or, for a signal occurrence, a pause",
    affects: "P+Q",
    producedBy: "phase1-plans-definitions",
  },
  {
    name: "work_definition_occurrences_skipped",
    section: "Work definition events",
    meaning:
      "Occurrences were resolved as skipped; carries count, first and last original instants and reason",
    affects: "P+Q",
    producedBy: "phase1-plans-definitions",
  },

  // Task events (23) — phase1-core
  {
    name: "task_created",
    section: "Task events",
    meaning: "Task committed in `DRAFT`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "task_validation_started",
    section: "Task events",
    meaning: "Entered `VALIDATING`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "task_validated",
    section: "Task events",
    meaning: "Validation succeeded; entered `READY`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "task_validation_failed",
    section: "Task events",
    meaning: "Structurally invalid input; entered `FAILED`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "task_input_requested",
    section: "Task events",
    meaning: "Entered `WAITING_INPUT`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "task_input_received",
    section: "Task events",
    meaning: "Answers ingested; revalidating",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "task_scheduled",
    section: "Task events",
    meaning: "Entered `SCHEDULED`; a durable occurrence exists",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "task_unscheduled",
    section: "Task events",
    meaning: "Occurrence invalidated; back to `READY`",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "task_started",
    section: "Task events",
    meaning:
      "Entered `RUNNING`; opens the attempt and carries its `attemptId`, `attemptNo`, deadline and, on the first attempt, the resolved `BoundInput[]`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "task_waiting_confirmation",
    section: "Task events",
    meaning:
      "Entered `WAITING_CONFIRMATION`; on the Task's first effect, carries the resolved `BoundInput[]`",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "task_retry_wait",
    section: "Task events",
    meaning:
      "Entered `RETRY_WAIT`; payload carries `attemptNo` of the failed attempt and the persisted retry delay",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "task_retry_ready",
    section: "Task events",
    meaning: "Retry delay elapsed; back to `READY`",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "task_awaiting_human",
    section: "Task events",
    meaning: "Entered `BLOCKED_AWAITING_HUMAN` with a `PendingDecision`",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "human_decision_granted",
    section: "Task events",
    meaning:
      "Pending decision granted; Task resumed, or a dead-letter retry authorized as a new attempt from the occurrence it causes",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "human_decision_denied",
    section: "Task events",
    meaning:
      "Pending decision denied; enters `REJECTED`, or accompanies `task_failed` when discarding the Task's only effect",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "task_blocked",
    section: "Task events",
    meaning: "Entered `BLOCKED` with a machine-readable `blockReason`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "task_unblocked",
    section: "Task events",
    meaning: "Blocking condition repaired; revalidating",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "task_completed",
    section: "Task events",
    meaning: "Entered `COMPLETED` with evidence and its `TaskResult`",
    affects: "P",
    producedBy: "phase1-core",
  },
  {
    name: "task_failed",
    section: "Task events",
    meaning: "Entered `FAILED`",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "task_expired",
    section: "Task events",
    meaning:
      "Entered `EXPIRED`: a validity or decision expiry passed, or an open attempt ended without completing after validity passed, its actual outcome carried",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "task_canceled",
    section: "Task events",
    meaning: "Entered `CANCELED`; payload carries `origin: CancelOrigin`",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "task_skipped",
    section: "Task events",
    meaning: "Entered `SKIPPED`",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "stale_transition_rejected",
    section: "Task events",
    meaning: "A command targeted a terminal Task or a stale revision and was refused",
    affects: "P",
    producedBy: "phase1-core",
  },

  // Trigger, signal and confirmation events (19)
  {
    name: "trigger_scheduled",
    section: "Trigger, signal and confirmation events",
    meaning: "Occurrence persisted with `nextFireAt`",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "trigger_fired",
    section: "Trigger, signal and confirmation events",
    meaning: "Occurrence became due and was claimed",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "trigger_canceled",
    section: "Trigger, signal and confirmation events",
    meaning: "Occurrence invalidated before firing",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "trigger_misfired",
    section: "Trigger, signal and confirmation events",
    meaning: "Occurrence was overdue at recovery; carries `misfirePolicy` and the resolved action",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "reminder_occurrence_emitted",
    section: "Trigger, signal and confirmation events",
    meaning: "A reminder occurrence produced a notify reaction",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "reminder_schedule_canceled",
    section: "Trigger, signal and confirmation events",
    meaning: "Future reminder occurrences for a Task were invalidated",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "signal_received",
    section: "Trigger, signal and confirmation events",
    meaning: "Raw signal persisted before interpretation",
    affects: "P+Q",
    producedBy: "phase4",
  },
  {
    name: "signal_accepted",
    section: "Trigger, signal and confirmation events",
    meaning: "Signal passed dedup, provenance, state and revision checks",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "signal_ignored_duplicate",
    section: "Trigger, signal and confirmation events",
    meaning:
      "Observation matched an accepted dedup key; completes only the duplicate observation without changing the accepted row or subject",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "signal_rejected_stale",
    section: "Trigger, signal and confirmation events",
    meaning:
      "Signal was refused with reason `revision_mismatch`, `token_mismatch` or `terminal_subject`; signal processing completes without changing the subject",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "signal_rejected",
    section: "Trigger, signal and confirmation events",
    meaning:
      "Non-stale refusal with reason `provenance_not_human`, `unexpected_state`, `trigger_mismatch` or `validity_passed`; signal processing completes without changing the subject",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "confirmation_requested",
    section: "Trigger, signal and confirmation events",
    meaning: "Confirmation request enqueued for delivery",
    affects: "P+Q",
    producedBy: "phase4",
  },
  {
    name: "confirmation_accepted",
    section: "Trigger, signal and confirmation events",
    meaning: "Accept decision applied; Task `COMPLETED` with its `TaskResult`",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "confirmation_rejected",
    section: "Trigger, signal and confirmation events",
    meaning: "Reject decision applied; Task `REJECTED`",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "confirmation_cancelled",
    section: "Trigger, signal and confirmation events",
    meaning: "Authorized cancel applied; Task `CANCELED`; payload carries `origin: CancelOrigin`",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "confirmation_expired",
    section: "Trigger, signal and confirmation events",
    meaning: "Deadline passed; Task `EXPIRED`",
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "confirmation_rejected_forged_provenance",
    section: "Trigger, signal and confirmation events",
    meaning:
      'Decision refused because `actorSource != "human_local"`; carries the determined `actorSource` and the evidence used; completes signal processing without changing the Task',
    affects: "P+Q",
    producedBy: "phase1-core",
  },
  {
    name: "approval_surface_refused",
    section: "Trigger, signal and confirmation events",
    meaning:
      "A declared `TaskPolicy.approvalSurface` failed the out-of-band validation check; carries the declared surface, the reason (`no_pre_execution_approval` or `effect_records_only`) and the Task. The declaration is refused and rendered, never silently downgraded",
    affects: "P",
    producedBy: "phase1-registries",
  },
  {
    name: "approval_refused_off_surface",
    section: "Trigger, signal and confirmation events",
    meaning:
      'A check was observed on the non-actionable pointer row of a `pre_execution_approval` decision whose Task\'s `approvalSurface` is `"out_of_band"`; the decision is refused and the refusal rendered in the status region, never ignored. Distinct from `confirmation_rejected_forged_provenance` and from `signal_rejected` with `provenance_not_human`, which refuse on `actorSource`: this refuses a decision taken on the wrong surface, and the writer may well be the human',
    affects: "P",
    producedBy: "phase4",
  },

  // Reaction and outbox events (13)
  {
    name: "reaction_enqueued",
    section: "Reaction and outbox events",
    meaning: "Outbox row inserted in the transition's commit",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "outbox_dispatch_attempted",
    section: "Reaction and outbox events",
    meaning:
      "Worker leased the row and is about to perform the external effect; carries `idempotencyKey`, `attemptNo` and the lease generation",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "outbox_dispatch_result",
    section: "Reaction and outbox events",
    meaning:
      "Attempt outcome: `succeeded`, `failed_retryable`, `failed_permanent` or `ambiguous`; carries `externalRef` when known",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "reaction_succeeded",
    section: "Reaction and outbox events",
    meaning: "Reaction reached an effective consumption",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "reaction_failed",
    section: "Reaction and outbox events",
    meaning: "Attempt failed; carries `errorCode`",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "reaction_retry_scheduled",
    section: "Reaction and outbox events",
    meaning: "Next attempt scheduled with `availableAt`",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "reaction_abandoned",
    section: "Reaction and outbox events",
    meaning:
      "The pre-send recheck refused the effect (`owner_terminalized`, `superseded_attempt`, `wait_ended`, `validity_passed`, `attempt_timeout`, `owner_canceled`, or `owner_not_member` for a spawn whose declaring Task is no longer a member); the row is `canceled`",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "reaction_duplicate_suppressed",
    section: "Reaction and outbox events",
    meaning: "A delivery arrived for an idempotency key already effectively consumed",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "reaction_dead_lettered",
    section: "Reaction and outbox events",
    meaning:
      "The row stopped being attempted with no human present; moved to `dead_letter`, its last outcome kept — `ambiguous` included — and surfaced; for a row subject it carries the retry-or-discard `PendingDecision` that `dead_letter_decisions` folds",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "dead_letter_resolved",
    section: "Reaction and outbox events",
    meaning:
      "A dead letter was resolved; carries `resolution`: `retried` or `discarded` by a recorded human decision, or `owner_ended` when its owner ended first",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "lease_expired_reclaimed",
    section: "Reaction and outbox events",
    meaning: "Reconciler reclaimed a stale lease",
    affects: "Q",
    producedBy: "phase2",
  },
  {
    name: "lease_released",
    section: "Reaction and outbox events",
    meaning: "A worker released a lease it still held, without waiting for TTL expiry",
    affects: "Q",
    producedBy: "phase2",
  },
  {
    name: "lease_fenced",
    section: "Reaction and outbox events",
    meaning:
      "A holder's commit was refused before any append because its lease generation was superseded under the writer lock; the holder recorded nothing for the row. It records no queue mutation, so it folds only into the diagnostic read model",
    affects: "P",
    producedBy: "phase3",
  },

  // Agent dispatch events (7) — phase6, agent_result_unmatched 만 phase1-registries
  {
    name: "agent_dispatch_accepted",
    section: "Agent dispatch events",
    meaning:
      "The dispatcher accepted an `AgentTaskRequest` and returned an `AgentTaskDispatchRef`; carries `dispatchId` and the resolved `sid`",
    affects: "P+Q",
    producedBy: "phase6",
  },
  {
    name: "agent_dispatch_refused",
    section: "Agent dispatch events",
    meaning:
      "The dispatcher refused the request before execution — contract violation, unresolvable session or binding, or refused eligibility",
    affects: "P+Q",
    producedBy: "phase6",
  },
  {
    name: "agent_result_received",
    section: "Agent dispatch events",
    meaning: "An `AgentTaskResultEnvelope` was received for a known dispatch and passed dedup",
    affects: "P+Q",
    producedBy: "phase6",
  },
  {
    name: "agent_result_ignored_duplicate",
    section: "Agent dispatch events",
    meaning:
      "A result matched an accepted dedup key; completes only the duplicate observation without changing the accepted row or Task",
    affects: "P+Q",
    producedBy: "phase6",
  },
  {
    name: "agent_result_unmatched",
    section: "Agent dispatch events",
    meaning:
      'A result arrived for an unknown dispatch, a terminal Task or an attempt that is not the current one (`unknown_dispatch`, `task_terminal`, `superseded_attempt`, `attempt_ended`); its evidence is kept as a late result; the Task\'s state is unchanged and its revision follows the workflow contract "Task state set" invariant 4',
    affects: "P+Q",
    producedBy: "phase1-registries",
  },
  {
    name: "agent_dispatch_orphaned",
    section: "Agent dispatch events",
    meaning:
      "The dispatch's turn is no longer running — its session stopped, detached or gone, or the session-layer run that accepted it ended — and no result arrived; the dispatch ended, and an attempt still open failed with `dispatch_orphaned`",
    affects: "P+Q",
    producedBy: "phase6",
  },
  {
    name: "agent_dispatch_stop_requested",
    section: "Agent dispatch events",
    meaning:
      "A stop of the dispatch's turn was requested, with reason `attempt_timeout` or `task_canceled`; proves nothing about whether it stopped",
    affects: "P+Q",
    producedBy: "phase6",
  },

  // Control queue events (7) — phase2
  {
    name: "control_request_accepted",
    section: "Control queue events",
    meaning:
      "An authenticated control-queue request was verified, its nonce consumed, and it was claimed for execution",
    affects: "P+Q",
    producedBy: "phase2",
  },
  {
    name: "control_request_refused",
    section: "Control queue events",
    meaning:
      "A control-queue request was refused without being executed; carries the refusal reason and `keyId` when one was presented, never the key",
    affects: "P",
    producedBy: "phase2",
  },
  {
    name: "control_request_completed",
    section: "Control queue events",
    meaning: "An accepted request finished; carries the outcome recorded for the requester",
    affects: "P+Q",
    producedBy: "phase2",
  },
  {
    name: "control_key_issued",
    section: "Control queue events",
    meaning:
      "The daemon issued a capability key; carries `keyId`, the issuing reason and the recorded holder label, never key material",
    affects: "Q",
    producedBy: "phase2",
  },
  {
    name: "control_key_revoked",
    section: "Control queue events",
    meaning:
      "A capability key was revoked, taking effect on the next verification; carries `keyId` and the reason, never key material",
    affects: "Q",
    producedBy: "phase2",
  },
  {
    name: "control_operation_decision_requested",
    section: "Control queue events",
    meaning:
      "A registered destructive operation was held pending a recorded human decision; carries the `PendingDecision` id, the `op` and the `target`",
    affects: "P+Q",
    producedBy: "phase2",
  },
  {
    name: "control_operation_decision_recorded",
    section: "Control queue events",
    meaning:
      "The held destructive operation's human decision was recorded as granted or denied; the operation executes only when granted",
    affects: "P+Q",
    producedBy: "phase2",
  },

  // Runtime lifecycle events (7) — phase2
  {
    name: "runtime_stop_requested",
    section: "Runtime lifecycle events",
    meaning: "A clean stop was requested through the authenticated control queue",
    affects: "P+Q",
    producedBy: "phase2",
  },
  {
    name: "runtime_stopped",
    section: "Runtime lifecycle events",
    meaning:
      "Clean stop completed: every lease this runtime held was released and no delivery was in flight",
    affects: "P",
    producedBy: "phase2",
  },
  {
    name: "runtime_stop_incomplete",
    section: "Runtime lifecycle events",
    meaning:
      "The stop deadline passed with at least one lease unreleased or one delivery in flight; the named rows follow the crash path",
    affects: "P",
    producedBy: "phase2",
  },
  {
    name: "store_set_initialized",
    section: "Runtime lifecycle events",
    meaning:
      "`workflow.init` created the project's store set; the first event of its event log, carrying the `storeSetId`",
    affects: "P",
    producedBy: "phase2",
  },
  {
    name: "workflow_disabled",
    section: "Runtime lifecycle events",
    meaning:
      "`workflow.disable`, or a start or enable that detected a restored set, put the project in maintenance as disabled; carries the reason, `requested` or `restored`; the flag survives a restart",
    affects: "P+Q",
    producedBy: "phase2",
  },
  {
    name: "workflow_enabled",
    section: "Runtime lifecycle events",
    meaning: "`workflow.enable` resumed a disabled or held project after every check passed",
    affects: "P+Q",
    producedBy: "phase2",
  },
  {
    name: "runtime_started",
    section: "Runtime lifecycle events",
    meaning: "The runtime became able to claim work; carries whether the previous stop was clean",
    affects: "P",
    producedBy: "phase2",
  },

  // Markdown ingress events (5) — phase4
  {
    name: "markdown_work_detected",
    section: "Markdown ingress events",
    meaning: "A managed Work document changed and passed debounce plus content-hash dedup",
    affects: "P",
    producedBy: "phase4",
  },
  {
    name: "markdown_ingress_ignored",
    section: "Markdown ingress events",
    meaning: "Change was a self-write, a temp-file write or an unchanged content hash",
    affects: "P",
    producedBy: "phase4",
  },
  {
    name: "markdown_region_conflict_detected",
    section: "Markdown ingress events",
    meaning: "A machine-managed region was edited by hand while ADDE also had an update for it",
    affects: "P",
    producedBy: "phase4",
  },
  {
    name: "markdown_region_conflict_resolved",
    section: "Markdown ingress events",
    meaning:
      "User content was extracted and committed, a backup was written, and the region was regenerated",
    affects: "P",
    producedBy: "phase4",
  },
  {
    name: "markdown_projection_written",
    section: "Markdown ingress events",
    meaning: "A machine-managed region was regenerated",
    affects: "P",
    producedBy: "phase4",
  },

  // Recommendation events (8) — phase9
  {
    name: "recommendation_generated",
    section: "Recommendation events",
    meaning: "Provider returned ranked recommendations, persisted with IDs",
    affects: "P",
    producedBy: "phase9",
  },
  {
    name: "recommendation_shown",
    section: "Recommendation events",
    meaning: "A recommendation was presented to the user",
    affects: "P",
    producedBy: "phase9",
  },
  {
    name: "recommendation_accepted",
    section: "Recommendation events",
    meaning: "Adopted as proposed",
    affects: "P",
    producedBy: "phase9",
  },
  {
    name: "recommendation_modified",
    section: "Recommendation events",
    meaning: "Adopted after edits",
    affects: "P",
    producedBy: "phase9",
  },
  {
    name: "recommendation_rejected",
    section: "Recommendation events",
    meaning: "Explicitly declined",
    affects: "P",
    producedBy: "phase9",
  },
  {
    name: "recommendation_ignored",
    section: "Recommendation events",
    meaning: "Shown and superseded without an explicit decision",
    affects: "P",
    producedBy: "phase9",
  },
  {
    name: "recommendation_snoozed",
    section: "Recommendation events",
    meaning: "Deferred to a stated later time",
    affects: "P",
    producedBy: "phase9",
  },
  {
    name: "recommendation_outcome_completed",
    section: "Recommendation events",
    meaning:
      "The Work or Task that adopted a recommendation reached `COMPLETED`; for a steward Work, carries the `stopOrigin` of its `work_completed`",
    affects: "P",
    producedBy: "phase9",
  },

  // Policy and limit events (4)
  {
    name: "spawn_limit_exceeded",
    section: "Policy and limit events",
    meaning:
      "Spawn depth, Tasks-per-Work or Works-per-chain limit reached; a `PendingDecision` was created",
    affects: "P+Q",
    producedBy: "phase3",
  },
  {
    name: "policy_blocked_reaction",
    section: "Policy and limit events",
    meaning: "Recommendation or reaction filtered by policy before presentation or execution",
    affects: "P",
    producedBy: "phase9",
  },
  {
    name: "permission_gate_outcome_recorded",
    section: "Policy and limit events",
    meaning:
      "A permission gate decision correlated to a Task; appended for every decision including refusals no human ever saw",
    affects: "P",
    producedBy: "phase4",
  },
  {
    name: "permission_gate_request_unattributable",
    section: "Policy and limit events",
    meaning:
      "A permission gate decision that could not be correlated to any Task, recorded against the project so it is still visible",
    affects: "P",
    producedBy: "phase4",
  },
] as const satisfies readonly EventCatalogRow[];
