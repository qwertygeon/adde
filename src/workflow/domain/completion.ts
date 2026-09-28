/**
 * Work 완료 정책 v1·파생 Work 상태(FR-011, FR-012) — the workflow contract "Terminal semantics and
 * completion aggregation"·design.md §6 "파생 Work 상태와 완료 정책" 그대로.
 */
import type { TaskId } from "./ids.js";
import type { CancelOrigin } from "./values.js";
import type { TaskStateName } from "./task-state.js";
import { isSatisfyingTerminal, isTerminalTaskState } from "./task-state.js";
import type { WorkStateName } from "./work-state.js";

export const COMPLETION_POLICY_VERSION = 1;

export type WorkDefinitionStateName = "ACTIVE" | "PAUSED" | "STOPPED";

export interface MemberSnapshot {
  readonly taskId: TaskId;
  readonly state: TaskStateName;
  readonly terminalRequired: boolean;
  readonly cancelOrigin?: CancelOrigin;
}

export interface CompletionInput {
  readonly ownedTasks: readonly MemberSnapshot[];
  readonly memberTaskIds: readonly TaskId[];
  readonly stewardedDefinitionState?: WorkDefinitionStateName;
}

export interface CompletionEvaluation {
  readonly completionPolicyVersion: 1;
  readonly completed: boolean;
  readonly withdrawnTaskIds: readonly TaskId[];
  readonly unsatisfiedRequiredTaskIds: readonly TaskId[];
  readonly progressableMemberIds: readonly TaskId[];
}

function isWithdrawn(snapshot: MemberSnapshot): boolean {
  const origin = snapshot.cancelOrigin;
  return (
    snapshot.state === "CANCELED" &&
    origin !== undefined &&
    origin.kind === "vault_signal" &&
    origin.actorSource === "human_local"
  );
}

function isProgressable(state: TaskStateName): boolean {
  return !isTerminalTaskState(state) && state !== "BLOCKED" && state !== "BLOCKED_AWAITING_HUMAN";
}

function currentMembers(input: CompletionInput): readonly MemberSnapshot[] {
  const memberSet = new Set<string>(input.memberTaskIds);
  return input.ownedTasks.filter((t) => memberSet.has(t.taskId));
}

export function evaluateCompletion(input: CompletionInput): CompletionEvaluation {
  const members = currentMembers(input);
  const withdrawnTaskIds: TaskId[] = [];
  const unsatisfiedRequiredTaskIds: TaskId[] = [];
  const progressableMemberIds: TaskId[] = [];

  let allRequiredSatisfied = true;
  for (const member of members) {
    if (isProgressable(member.state)) progressableMemberIds.push(member.taskId);
    if (!member.terminalRequired) continue;
    if (isWithdrawn(member)) {
      withdrawnTaskIds.push(member.taskId);
      continue;
    }
    if (isSatisfyingTerminal(member.state)) continue;
    allRequiredSatisfied = false;
    // 불충족 필수 member: 불충족 종결(REJECTED·EXPIRED·FAILED)·BLOCKED·BLOCKED_AWAITING_HUMAN·철회 아닌 CANCELED
    const isUnsatisfiedShape =
      (isTerminalTaskState(member.state) && !isSatisfyingTerminal(member.state)) ||
      member.state === "BLOCKED" ||
      member.state === "BLOCKED_AWAITING_HUMAN";
    if (isUnsatisfiedShape) unsatisfiedRequiredTaskIds.push(member.taskId);
  }

  const definitionStopped =
    input.stewardedDefinitionState === undefined || input.stewardedDefinitionState === "STOPPED";
  const completed = allRequiredSatisfied && definitionStopped;

  return {
    completionPolicyVersion: COMPLETION_POLICY_VERSION,
    completed,
    withdrawnTaskIds,
    unsatisfiedRequiredTaskIds,
    progressableMemberIds,
  };
}

export interface DerivedStateInput extends CompletionInput {
  readonly startedUnderCurrentRevision: boolean;
}

function isPastValidating(state: TaskStateName): boolean {
  return state !== "DRAFT" && state !== "VALIDATING";
}

export function deriveWorkState(
  input: DerivedStateInput,
): Extract<WorkStateName, "READY" | "ACTIVE" | "BLOCKED" | "COMPLETED"> {
  const evaluation = evaluateCompletion(input);
  if (evaluation.completed) return "COMPLETED";

  const noProgressableMember = evaluation.progressableMemberIds.length === 0;
  const hasUnsatisfiedRequired = evaluation.unsatisfiedRequiredTaskIds.length > 0;
  if (noProgressableMember && hasUnsatisfiedRequired) return "BLOCKED";

  const members = currentMembers(input);
  const memberPastValidating = members.some((m) => isPastValidating(m.state));
  const definitionNotStopped =
    input.stewardedDefinitionState !== undefined && input.stewardedDefinitionState !== "STOPPED";
  if (memberPastValidating || input.startedUnderCurrentRevision || definitionNotStopped)
    return "ACTIVE";

  return "READY";
}
