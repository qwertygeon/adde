/**
 * 대기 결정(PendingDecision) — the workflow contract "Task state set" 의 `PendingDecision` 형태와
 * "정확히 하나의 subject" 규칙(FR-008) 그대로. 주체 허용표·거절 우선순위는 design.md §인터페이스 계약.
 */
import { type Result, ok, err } from "./result.js";
import { PENDING_DECISION_KINDS } from "./contract/index.js";
import { parseEntityId } from "./ids.js";
import type { DecisionId, TaskId, WorkId, PlanProposalId } from "./ids.js";
import { parseUtcInstant } from "./values.js";
import type { UtcInstant } from "./values.js";

export type PendingDecisionKind = (typeof PENDING_DECISION_KINDS)[number];

interface PendingDecisionCommon {
  readonly id: DecisionId;
  readonly requestedAt: UtcInstant;
  readonly summary: string;
  /** 계약의 이름만 있는 형태 — 필드를 읽지 않는다. 비어 있으면 전달 전. */
  readonly surfaceDeliveries: readonly unknown[];
}

export type PendingDecision =
  | (PendingDecisionCommon & {
      readonly kind: Exclude<PendingDecisionKind, "plan_approval_required">;
      readonly taskId: TaskId;
      readonly expiresAt?: UtcInstant;
    })
  | (PendingDecisionCommon & {
      readonly kind: "plan_approval_required";
      readonly workId: WorkId;
      readonly planProposalId: PlanProposalId;
    })
  | (PendingDecisionCommon & {
      readonly kind: "destructive_control_operation";
      readonly subject: string;
      readonly expiresAt?: UtcInstant;
    })
  | (PendingDecisionCommon & {
      readonly kind: "dead_letter_resolution_required";
      readonly subject: string;
    });

/** 구성 입력 — 주체 필드가 모두 선택. */
export interface PendingDecisionDraft {
  readonly id: string;
  readonly kind: string;
  readonly taskId?: string;
  readonly workId?: string;
  readonly planProposalId?: string;
  readonly subject?: string;
  readonly requestedAt: string;
  readonly summary: string;
  readonly surfaceDeliveries: readonly unknown[];
  readonly expiresAt?: string;
}

export interface PendingDecisionError {
  readonly kind: "pending_decision";
  readonly reason:
    | "unknown_kind"
    | "no_subject"
    | "multiple_subjects"
    | "subject_not_allowed_for_kind"
    | "expires_at_not_allowed"
    | "field_format";
  readonly field?: string;
}

const KIND_SET: ReadonlySet<string> = new Set(PENDING_DECISION_KINDS);

function isKnownKind(raw: string): raw is PendingDecisionKind {
  return KIND_SET.has(raw);
}

function fieldFormatError(field: string): PendingDecisionError {
  return { kind: "pending_decision", reason: "field_format", field };
}

export function parsePendingDecision(
  draft: PendingDecisionDraft,
): Result<PendingDecision, PendingDecisionError> {
  if (!isKnownKind(draft.kind)) {
    return err({ kind: "pending_decision", reason: "unknown_kind", field: "kind" });
  }
  const kind = draft.kind;

  const id = parseEntityId("decision", draft.id);
  if (!id.ok) return err(fieldFormatError("id"));
  const requestedAt = parseUtcInstant(draft.requestedAt);
  if (!requestedAt.ok) return err(fieldFormatError("requestedAt"));

  let taskId: TaskId | undefined;
  if (draft.taskId !== undefined) {
    const parsed = parseEntityId("task", draft.taskId);
    if (!parsed.ok) return err(fieldFormatError("taskId"));
    taskId = parsed.value;
  }
  let workId: WorkId | undefined;
  if (draft.workId !== undefined) {
    const parsed = parseEntityId("work", draft.workId);
    if (!parsed.ok) return err(fieldFormatError("workId"));
    workId = parsed.value;
  }
  let planProposalId: PlanProposalId | undefined;
  if (draft.planProposalId !== undefined) {
    const parsed = parseEntityId("planProposal", draft.planProposalId);
    if (!parsed.ok) return err(fieldFormatError("planProposalId"));
    planProposalId = parsed.value;
  }
  let expiresAt: UtcInstant | undefined;
  if (draft.expiresAt !== undefined) {
    const parsed = parseUtcInstant(draft.expiresAt);
    if (!parsed.ok) return err(fieldFormatError("expiresAt"));
    expiresAt = parsed.value;
  }
  const subject = draft.subject;

  const hasTaskSubject = taskId !== undefined;
  const hasPlanSubject = workId !== undefined && planProposalId !== undefined;
  const hasSubjectSubject = subject !== undefined;
  const subjectCount = [hasTaskSubject, hasPlanSubject, hasSubjectSubject].filter(Boolean).length;

  if (subjectCount === 0) {
    return err({ kind: "pending_decision", reason: "no_subject" });
  }
  if (subjectCount >= 2) {
    return err({ kind: "pending_decision", reason: "multiple_subjects" });
  }

  const common: PendingDecisionCommon = {
    id: id.value,
    requestedAt: requestedAt.value,
    summary: draft.summary,
    surfaceDeliveries: draft.surfaceDeliveries,
  };

  if (hasTaskSubject) {
    if (kind === "plan_approval_required") {
      return err({ kind: "pending_decision", reason: "subject_not_allowed_for_kind" });
    }
    return ok({
      ...common,
      kind,
      taskId: taskId as TaskId,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    } as PendingDecision);
  }

  if (hasPlanSubject) {
    if (kind !== "plan_approval_required") {
      return err({ kind: "pending_decision", reason: "subject_not_allowed_for_kind" });
    }
    if (expiresAt !== undefined) {
      return err({ kind: "pending_decision", reason: "expires_at_not_allowed" });
    }
    return ok({
      ...common,
      kind: "plan_approval_required",
      workId: workId as WorkId,
      planProposalId: planProposalId as PlanProposalId,
    });
  }

  // subject(string) 주체
  if (kind !== "destructive_control_operation" && kind !== "dead_letter_resolution_required") {
    return err({ kind: "pending_decision", reason: "subject_not_allowed_for_kind" });
  }
  if (kind === "dead_letter_resolution_required") {
    if (expiresAt !== undefined) {
      return err({ kind: "pending_decision", reason: "expires_at_not_allowed" });
    }
    return ok({ ...common, kind: "dead_letter_resolution_required", subject: subject as string });
  }
  return ok({
    ...common,
    kind: "destructive_control_operation",
    subject: subject as string,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  });
}

export function isTaskSubjectDecision(
  d: PendingDecision,
): d is Extract<PendingDecision, { readonly taskId: TaskId }> {
  return "taskId" in d;
}
