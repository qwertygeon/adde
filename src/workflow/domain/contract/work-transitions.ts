/**
 * Work 전이 표 전사(FR-010, FR-023) — the workflow contract "Work state set and transitions" 23행.
 */
import type { WorkStateName } from "../work-state.js";
import type { TransitionRowData } from "./task-transitions.js";

const ALL_NONTERMINAL_WORK_STATES: readonly WorkStateName[] = [
  "DRAFT",
  "PLANNING",
  "WAITING_INPUT",
  "WAITING_APPROVAL",
  "READY",
  "ACTIVE",
  "BLOCKED",
];

export const WORK_TRANSITION_ROWS = [
  {
    id: "NONE>DRAFT:work_created",
    fromText: "—",
    from: [],
    to: "DRAFT",
    event: "work_created",
    condition:
      'Work ingested from Markdown or CLI, created by a spawn reaction, or materialized from a WorkDefinition occurrence ("Work definition and occurrence contract")',
    companions: [],
  },
  {
    id: "DRAFT>PLANNING:work_planning_started",
    fromText: "`DRAFT`",
    from: ["DRAFT"],
    to: "PLANNING",
    event: "work_planning_started",
    condition: "Work accepted for planning",
    companions: [],
  },
  {
    id: "PLANNING>WAITING_INPUT:work_input_requested",
    fromText: "`PLANNING`",
    from: ["PLANNING"],
    to: "WAITING_INPUT",
    event: "work_input_requested",
    condition: "Plan requires information the Work does not contain",
    companions: [],
  },
  {
    id: "PLANNING>WAITING_APPROVAL:work_plan_proposed",
    fromText: "`PLANNING`",
    from: ["PLANNING"],
    to: "WAITING_APPROVAL",
    event: "work_plan_proposed",
    condition:
      'A valid proposal exists and approval is required, by policy or by the mandatory approval rule of "Plan proposal, approval and membership"',
    companions: [],
  },
  {
    id: "PLANNING>READY:work_plan_committed",
    fromText: "`PLANNING`",
    from: ["PLANNING"],
    to: "READY",
    event: "work_plan_committed",
    condition:
      "A valid proposal was committed without required approval, including a plan instantiated from a WorkDefinition template",
    companions: [],
  },
  {
    id: "PLANNING>FAILED:work_failed",
    fromText: "`PLANNING`",
    from: ["PLANNING"],
    to: "FAILED",
    event: "work_failed",
    condition: "Planning cannot produce a valid plan and policy declares Work-level failure",
    companions: [],
  },
  {
    id: "WAITING_INPUT>PLANNING:work_input_received",
    fromText: "`WAITING_INPUT`",
    from: ["WAITING_INPUT"],
    to: "PLANNING",
    event: "work_input_received",
    condition: "Answers ingested; replan and revalidate",
    companions: [],
  },
  {
    id: "WAITING_APPROVAL>PLANNING:work_plan_rejected",
    fromText: "`WAITING_APPROVAL`",
    from: ["WAITING_APPROVAL"],
    to: "PLANNING",
    event: "work_plan_rejected",
    condition:
      "A `human_local` actor denied the plan approval decision of a Work that has no committed plan; planning restarts from the Work's current source",
    companions: [],
  },
  {
    id: "WAITING_APPROVAL>READY:work_plan_rejected",
    fromText: "`WAITING_APPROVAL`",
    from: ["WAITING_APPROVAL"],
    to: "READY",
    event: "work_plan_rejected",
    condition:
      "A `human_local` actor denied the plan approval decision of a replan; the replan closes and the Work returns to its current plan revision, unchanged",
    companions: [],
  },
  {
    id: "WAITING_APPROVAL>PLANNING:work_plan_withdrawn",
    fromText: "`WAITING_APPROVAL`",
    from: ["WAITING_APPROVAL"],
    to: "PLANNING",
    event: "work_plan_withdrawn",
    condition:
      "The proposal awaiting approval no longer validates against the Work's current Tasks, or the Work's user-authored source changed; the pending decision closes unanswered",
    companions: [],
  },
  {
    id: "WAITING_APPROVAL>READY:work_plan_committed",
    fromText: "`WAITING_APPROVAL`",
    from: ["WAITING_APPROVAL"],
    to: "READY",
    event: "work_plan_committed",
    condition:
      "A `human_local` actor granted the plan approval decision and the proposal still validates",
    companions: [],
  },
  {
    id: "WAITING_APPROVAL>CANCELED:work_canceled",
    fromText: "`WAITING_APPROVAL`",
    from: ["WAITING_APPROVAL"],
    to: "CANCELED",
    event: "work_canceled",
    condition: "Authorized cancellation",
    companions: [],
  },
  {
    id: "READY>ACTIVE:work_activated",
    fromText: "`READY`",
    from: ["READY"],
    to: "ACTIVE",
    event: "work_activated",
    condition:
      "Derived state `ACTIVE`: a member is past `VALIDATING`, the Work was `ACTIVE` or `BLOCKED` under its current plan revision, or it stewards a WorkDefinition that is not `STOPPED`",
    companions: [],
  },
  {
    id: "READY>COMPLETED:work_completed",
    fromText: "`READY`",
    from: ["READY"],
    to: "COMPLETED",
    event: "work_completed",
    condition:
      "Derived state `COMPLETED`: the completion policy is satisfied, for example by a revision that retains only satisfied members",
    companions: [],
  },
  {
    id: "READY>BLOCKED:work_blocked",
    fromText: "`READY`",
    from: ["READY"],
    to: "BLOCKED",
    event: "work_blocked",
    condition:
      "Derived state `BLOCKED`: no member is progressable and a terminal-required member is unsatisfied",
    companions: [],
  },
  {
    id: "ACTIVE>BLOCKED:work_blocked",
    fromText: "`ACTIVE`",
    from: ["ACTIVE"],
    to: "BLOCKED",
    event: "work_blocked",
    condition:
      "Derived state `BLOCKED`: no member is progressable and a terminal-required member is unsatisfied",
    companions: [],
  },
  {
    id: "BLOCKED>ACTIVE:work_unblocked",
    fromText: "`BLOCKED`",
    from: ["BLOCKED"],
    to: "ACTIVE",
    event: "work_unblocked",
    condition:
      "Derived state `ACTIVE`: a member became progressable again, including a repaired member revalidating and a member a spawn added",
    companions: [],
  },
  {
    id: "BLOCKED>COMPLETED:work_completed",
    fromText: "`BLOCKED`",
    from: ["BLOCKED"],
    to: "COMPLETED",
    event: "work_completed",
    condition:
      "Derived state `COMPLETED`: the completion policy is satisfied, for example because the blocking terminal-required member was withdrawn by a `vault_signal` cancel",
    companions: [],
  },
  {
    id: "ACTIVE>PLANNING:work_replanning_started",
    fromText: "`ACTIVE`",
    from: ["ACTIVE"],
    to: "PLANNING",
    event: "work_replanning_started",
    condition:
      "A `replan_requested` signal was accepted: `human_local` provenance, revision matched, Work non-terminal",
    companions: [],
  },
  {
    id: "BLOCKED>PLANNING:work_replanning_started",
    fromText: "`BLOCKED`",
    from: ["BLOCKED"],
    to: "PLANNING",
    event: "work_replanning_started",
    condition:
      "The same accepted signal, from `BLOCKED`. This is the exit a Work blocked by a rejected, expired or failed terminal-required member has other than cancellation",
    companions: [],
  },
  {
    id: "ACTIVE>COMPLETED:work_completed",
    fromText: "`ACTIVE`",
    from: ["ACTIVE"],
    to: "COMPLETED",
    event: "work_completed",
    condition: "Derived state `COMPLETED`: the completion policy is satisfied",
    companions: [],
  },
  {
    id: "ACTIVE>FAILED:work_failed",
    fromText: "`ACTIVE`",
    from: ["ACTIVE"],
    to: "FAILED",
    event: "work_failed",
    condition: "Declared Work-level failure policy triggered",
    companions: [],
  },
  {
    id: "ANY_NONTERMINAL>CANCELED:work_canceled",
    fromText: "any non-terminal",
    from: ALL_NONTERMINAL_WORK_STATES,
    to: "CANCELED",
    event: "work_canceled",
    condition: "Authorized cancellation",
    companions: [],
  },
] as const satisfies readonly TransitionRowData<WorkStateName>[];
