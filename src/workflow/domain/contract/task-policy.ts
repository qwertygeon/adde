/**
 * TaskPolicy 전사 — the workflow contract "TaskPolicy": `ApprovalSurface` 값, "Approval surface" 규칙 3
 * 의 거절 사유("the first that holds of" 순서 그대로 — 순서가 판정 우선순위다), ts 블록의 정책 형태별
 * 필드 이름·선택 여부(선언 순서, 한 줄 인라인 객체는 `<부모>.<필드>` shape 로).
 */

export const APPROVAL_SURFACE_VALUES = ["markdown", "out_of_band"] as const;

export const APPROVAL_SURFACE_REFUSAL_REASONS = [
  "effect_records_only",
  "no_pre_execution_approval",
] as const;

export interface TaskPolicyFieldShape {
  readonly shape: string;
  readonly fields: readonly { readonly name: string; readonly optional: boolean }[];
}

export const TASK_POLICY_FIELD_SHAPES = [
  {
    shape: "TaskPolicy",
    fields: [
      { name: "policyVersion", optional: false },
      { name: "terminalRequired", optional: false },
      { name: "onDependencyUnsatisfied", optional: false },
      { name: "approvalRequiredBeforeExecute", optional: false },
      { name: "approvalSurface", optional: false },
      { name: "fanOutMaxConcurrent", optional: false },
      { name: "unattended", optional: false },
      { name: "retry", optional: false },
      { name: "reminder", optional: true },
      { name: "targetDueAt", optional: true },
      { name: "expiresAt", optional: true },
      { name: "attemptTimeoutMs", optional: true },
      { name: "timezone", optional: false },
      { name: "maxSpawnDepth", optional: false },
      { name: "maxTasksPerWork", optional: false },
      { name: "maxWorksPerChain", optional: false },
    ],
  },
  {
    shape: "UnattendedPolicy",
    fields: [
      { name: "eligible", optional: false },
      { name: "toolScope", optional: true },
      { name: "window", optional: true },
      { name: "onGateDenied", optional: false },
    ],
  },
  {
    shape: "UnattendedPolicy.window",
    fields: [
      { name: "fromLocal", optional: false },
      { name: "toLocal", optional: false },
      { name: "timezone", optional: false },
    ],
  },
  {
    shape: "ToolScopeRef",
    fields: [
      { name: "id", optional: false },
      { name: "configRef", optional: false },
      { name: "approvedAt", optional: false },
      { name: "approvedBy", optional: false },
    ],
  },
  {
    shape: "RetryPolicy",
    fields: [
      { name: "maxAttempts", optional: false },
      { name: "initialDelayMs", optional: false },
      { name: "maxDelayMs", optional: false },
      { name: "backoff", optional: false },
      { name: "retryableErrors", optional: true },
      { name: "jitterMs", optional: true },
    ],
  },
  {
    shape: "ReminderPolicy",
    fields: [
      { name: "intervalMs", optional: false },
      { name: "maxOccurrences", optional: false },
      { name: "quietHours", optional: true },
    ],
  },
  {
    shape: "ReminderPolicy.quietHours",
    fields: [
      { name: "fromLocal", optional: false },
      { name: "toLocal", optional: false },
      { name: "timezone", optional: false },
    ],
  },
] as const satisfies readonly TaskPolicyFieldShape[];
