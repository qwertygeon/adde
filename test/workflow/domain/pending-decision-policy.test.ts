// SC-015, SC-016 — 대기 결정 단일 주체·Task 정책 형태.
import { describe, expect, it } from "vitest";
import {
  parsePendingDecision,
  parseTaskPolicy,
  PENDING_DECISION_KINDS,
} from "../../../src/workflow/domain/index.js";

const TASK_SUBJECT_ONLY_KINDS = new Set([
  "plan_approval_required",
  "destructive_control_operation",
  "dead_letter_resolution_required",
]);
const taskSubjectKind = () => {
  const found = (PENDING_DECISION_KINDS as readonly string[]).find(
    (k) => !TASK_SUBJECT_ONLY_KINDS.has(k),
  );
  if (found === undefined) throw new Error("no task-subject PendingDecision.kind found");
  return found;
};

describe("SC-015: 대기 결정은 정확히 하나의 subject 를 갖는다", () => {
  it("Happy: 허용된 kind·subject 조합이 구성된다 (test_SC015_allowed_kind_subject_pairs_construct)", () => {
    const taskKind = taskSubjectKind();
    expect(
      parsePendingDecision({
        id: "dec_1",
        kind: taskKind,
        taskId: "tsk_1",
        requestedAt: "2026-01-01T00:00:00Z",
        summary: "s",
        surfaceDeliveries: [],
      }).ok,
    ).toBe(true);
    expect(
      parsePendingDecision({
        id: "dec_2",
        kind: "plan_approval_required",
        workId: "wrk_1",
        planProposalId: "pln_1",
        requestedAt: "2026-01-01T00:00:00Z",
        summary: "s",
        surfaceDeliveries: [],
      }).ok,
    ).toBe(true);
    expect(
      parsePendingDecision({
        id: "dec_3",
        kind: "destructive_control_operation",
        subject: "x",
        requestedAt: "2026-01-01T00:00:00Z",
        summary: "s",
        surfaceDeliveries: [],
      }).ok,
    ).toBe(true);
  });

  it("Edge: plan_approval_required 의 workId 만/planProposalId 만은 거절된다 (test_SC015_plan_approval_partial_subject_rejected)", () => {
    const workOnly = parsePendingDecision({
      id: "dec_4",
      kind: "plan_approval_required",
      workId: "wrk_1",
      requestedAt: "2026-01-01T00:00:00Z",
      summary: "s",
      surfaceDeliveries: [],
    });
    expect(workOnly.ok).toBe(false);
    const proposalOnly = parsePendingDecision({
      id: "dec_5",
      kind: "plan_approval_required",
      planProposalId: "pln_1",
      requestedAt: "2026-01-01T00:00:00Z",
      summary: "s",
      surfaceDeliveries: [],
    });
    expect(proposalOnly.ok).toBe(false);
  });

  it("Error: subject 0개·2개 이상, 계획 승인 expiresAt 은 거절된다 (test_SC015_zero_or_multiple_subjects_and_plan_expiry_rejected)", () => {
    const noSubject = parsePendingDecision({
      id: "dec_6",
      kind: taskSubjectKind(),
      requestedAt: "2026-01-01T00:00:00Z",
      summary: "s",
      surfaceDeliveries: [],
    });
    expect(noSubject.ok).toBe(false);
    const twoSubjects = parsePendingDecision({
      id: "dec_7",
      kind: taskSubjectKind(),
      taskId: "tsk_1",
      subject: "extra",
      requestedAt: "2026-01-01T00:00:00Z",
      summary: "s",
      surfaceDeliveries: [],
    });
    expect(twoSubjects.ok).toBe(false);
    const planWithExpiry = parsePendingDecision({
      id: "dec_8",
      kind: "plan_approval_required",
      workId: "wrk_1",
      planProposalId: "pln_1",
      requestedAt: "2026-01-01T00:00:00Z",
      summary: "s",
      surfaceDeliveries: [],
      expiresAt: "2026-01-02T00:00:00Z",
    });
    expect(planWithExpiry.ok).toBe(false);
  });
});

function fullPolicyRaw() {
  return {
    policyVersion: 1,
    terminalRequired: true,
    onDependencyUnsatisfied: "block",
    approvalRequiredBeforeExecute: false,
    confirmationSurface: "markdown",
    fanOutMaxConcurrent: 1,
    unattended: { eligible: false, onGateDenied: "block_awaiting_human" },
    retry: { maxAttempts: 3, initialDelayMs: 1_000, maxDelayMs: 60_000, backoff: "fixed" },
    timezone: "Asia/Seoul",
    maxSpawnDepth: 1,
    maxTasksPerWork: 50,
    maxWorksPerChain: 10,
  };
}

describe("SC-016: Task 정책 형태가 계약과 일치한다", () => {
  it("Happy: 계약 필드를 모두 갖춘 정책이 구성된다 (test_SC016_full_policy_constructs)", () => {
    expect(parseTaskPolicy(fullPolicyRaw()).ok).toBe(true);
  });

  it("Edge: 선택 필드 부재는 허용된다 (test_SC016_optional_fields_absent_ok)", () => {
    expect(parseTaskPolicy(fullPolicyRaw()).ok).toBe(true);
  });

  it("Error: timezone 부재·KST·+09:00 은 거절된다 (test_SC016_missing_or_non_iana_timezone_rejected)", () => {
    const { timezone, ...withoutTimezone } = fullPolicyRaw();
    void timezone;
    expect(parseTaskPolicy(withoutTimezone).ok).toBe(false);
    expect(parseTaskPolicy({ ...fullPolicyRaw(), timezone: "KST" }).ok).toBe(false);
    expect(parseTaskPolicy({ ...fullPolicyRaw(), timezone: "+09:00" }).ok).toBe(false);
  });
});
