// SC-026~SC-031 — Task Trigger 1회성·미등록 차단·검증 출구·InputRequest 정규화·안전 필드 비채움.
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  validateTask,
  executeCommand,
  BUILTIN_TASK_TYPES,
  DomainInvariantError,
} from "../../../src/workflow/domain/index.js";
import type {
  TaskDeclaration,
  TaskTypeDescriptor,
  TriggerSpec,
  WorkAggregate,
  TaskId,
  DomainDeps,
} from "../../../src/workflow/domain/index.js";
import {
  at,
  meta,
  basePolicy,
  draft,
  planned,
  patchTask,
  reachTaskState,
  reachWorkState,
  requireTaskFor,
  mustCommit,
  entityId,
  testDeps,
  UNREGISTERED_TASK_TYPE,
} from "./helpers/fixtures.js";
import {
  testRegistries,
  probeTaskType,
  probeOverridePromptTaskType,
  COMPLETION_NOTIFY_REACTION,
} from "./helpers/registry-fixtures.js";
import { eventTypes, payloadOf } from "./helpers/commits.js";

const NOW = at("2026-01-01T00:00:00Z");
const ACTOR = { kind: "user", id: "u1" };
const IMMEDIATE: TriggerSpec = { kind: "immediate", version: 1, triggerId: "t" };
const AT: TriggerSpec = {
  kind: "at",
  version: 1,
  triggerId: "t",
  scheduledForUtc: at("2026-01-02T00:00:00Z"),
  timezone: "Asia/Seoul",
  expressionText: "tomorrow",
  misfire: { kind: "skip" },
};
const RECURRING_AT = {
  ...AT,
  recurrence: { rule: "FREQ=DAILY", anchorUtc: "2026-01-02T00:00:00Z" },
};

function builtin(id: string): TaskTypeDescriptor {
  const found = BUILTIN_TASK_TYPES.find((d) => d.id === id);
  if (found === undefined) throw new Error(`builtin ${id} missing`);
  return found;
}

function declaration(overrides: Partial<TaskDeclaration> = {}): TaskDeclaration {
  return {
    type: { id: "generic_task", version: 1 },
    input: {},
    trigger: IMMEDIATE,
    policy: basePolicy(),
    ...overrides,
  };
}

/** 검증 중인 Task 를 레코드 패치로 원하는 선언으로 바꾼 뒤 검증을 완료한다. */
function completeWith(patch: Parameters<typeof patchTask>[2]): {
  deps: DomainDeps;
  before: WorkAggregate;
  taskId: TaskId;
  outcome: ReturnType<typeof executeCommand>;
} {
  const { deps, aggregate, taskId } = reachTaskState("VALIDATING");
  // 레코드 패치: 같은 등록부로는 계획 커밋이 막는 선언을 다른 생성 경로·등록부 drift 대용으로 재현.
  const before = patchTask(aggregate, taskId, patch);
  const outcome = executeCommand(deps, before, {
    kind: "complete_validation",
    taskId,
    expectedRevision: requireTaskFor(before, taskId).revision,
    meta: meta(NOW),
  });
  return { deps, before, taskId, outcome };
}

describe("SC-026: 반복 규칙을 실은 Task Trigger 는 거절된다", () => {
  it("Happy: 반복 없는 at Trigger 는 통과한다 (test_SC026_at_without_recurrence_valid)", () => {
    expect(validateTask(testRegistries(), declaration({ trigger: AT })).exit).toBe("valid");
  });

  it("Edge: 반복 규칙이 있으면 구조 오류다 (test_SC026_at_with_recurrence_refused)", () => {
    const result = validateTask(testRegistries(), declaration({ trigger: RECURRING_AT }));
    expect(result.exit).toBe("validation_failed");
    if (result.exit === "validation_failed")
      expect(result.issues.map((i) => [i.area, i.code])).toContainEqual([
        "trigger",
        "recurrence_not_allowed_on_task_trigger",
      ]);
  });

  it("Error: 같은 초안을 실은 계획은 무효이고 Task 를 만들지 않는다 (test_SC026_plan_draft_with_recurrence_invalid)", () => {
    const { deps, aggregate } = reachWorkState("PLANNING");
    const outcome = executeCommand(deps, aggregate, {
      kind: "commit_plan",
      expectedRevision: aggregate.work.revision,
      meta: meta(NOW),
      proposal: {
        proposalId: entityId("planProposal", "pln_sc026recur"),
        digest: "7".repeat(64),
        basePlanRevision: aggregate.work.planRevision,
        drafts: [draft("recur", { trigger: RECURRING_AT as unknown as TriggerSpec })],
        retain: [],
      },
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(eventTypes(outcome.commit)).not.toContain("task_created");
    const issues = payloadOf(outcome.commit, "work_plan_invalid")["issues"] as readonly {
      kind: string;
      draftRef?: string;
      reason?: { kind: string; issues?: readonly { code: string }[] };
    }[];
    const invalid = issues.find((i) => i.kind === "draft_invalid" && i.draftRef === "recur");
    expect(invalid?.reason?.kind).toBe("structurally_invalid");
    expect(invalid?.reason?.issues?.map((i) => i.code)).toContain(
      "recurrence_not_allowed_on_task_trigger",
    );
  });
});

describe("SC-027: 미등록 반응·발화 종류를 선언한 Task 는 차단된다", () => {
  it("Happy: 미등록 반응 종류는 descriptor_unknown 차단이다 (test_SC027_unregistered_reaction_kind_blocked)", () => {
    const result = validateTask(
      testRegistries(),
      declaration({ reactions: [{ ...COMPLETION_NOTIFY_REACTION, kind: "unknown_kind" }] }),
    );
    expect(result).toEqual({
      exit: "blocked",
      blockReason: {
        kind: "descriptor_unknown",
        descriptors: [{ axis: "reaction", id: "unknown_kind", version: 1 }],
      },
    });
  });

  it("Edge: 등록된 종류의 미등록 버전도 차단이다 (test_SC027_unregistered_reaction_version_blocked)", () => {
    const result = validateTask(
      testRegistries(),
      declaration({ reactions: [{ ...COMPLETION_NOTIFY_REACTION, version: 2 }] }),
    );
    expect(result).toEqual({
      exit: "blocked",
      blockReason: {
        kind: "descriptor_unknown",
        descriptors: [{ axis: "reaction", id: "notify", version: 2 }],
      },
    });
  });

  it("Error: 미등록 Trigger 버전을 실은 Task 의 검증 완료는 task_blocked 로 차단된다 (test_SC027_unregistered_trigger_version_command_blocks)", () => {
    const { taskId, outcome } = completeWith({
      trigger: { ...AT, version: 2 } as unknown as TriggerSpec,
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(payloadOf(outcome.commit, "task_blocked")["blockReason"]).toEqual({
      kind: "descriptor_unknown",
      descriptors: [{ axis: "trigger", id: "at", version: 2 }],
    });
    expect(requireTaskFor(outcome.aggregate, taskId).state).toBe("BLOCKED");
  });
});

describe("SC-028: 미등록 TaskType 은 실행을 막고 task_blocked 를 기록한다", () => {
  it("Happy: 미등록 유형은 정확한 (id, version) 을 지목해 차단된다 (test_SC028_unregistered_task_type_blocked_with_identity)", () => {
    const result = validateTask(testRegistries(), declaration({ type: UNREGISTERED_TASK_TYPE }));
    expect(result).toEqual({
      exit: "blocked",
      blockReason: {
        kind: "descriptor_unknown",
        descriptors: [{ axis: "task_type", id: "probe_missing", version: 1 }],
      },
    });
  });

  it("Edge: 다른 버전만 등록돼 있으면 대체하지 않고 차단한다 (test_SC028_other_version_not_substituted)", () => {
    const registries = testRegistries({ taskTypes: [probeTaskType({ version: 2 })] });
    const result = validateTask(
      registries,
      declaration({ type: { id: "probe_extension", version: 1 }, input: { subject: "x" } }),
    );
    expect(result).toEqual({
      exit: "blocked",
      blockReason: {
        kind: "descriptor_unknown",
        descriptors: [{ axis: "task_type", id: "probe_extension", version: 1 }],
      },
    });
  });

  it("Error: 명령 경로에서 task_blocked 가 기록되고 차단 사유가 저장된다 (test_SC028_command_path_records_task_blocked)", () => {
    const { taskId, outcome } = completeWith({ type: UNREGISTERED_TASK_TYPE });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    const expected = {
      kind: "descriptor_unknown",
      descriptors: [{ axis: "task_type", id: "probe_missing", version: 1 }],
    };
    expect(payloadOf(outcome.commit, "task_blocked")["blockReason"]).toEqual(expected);
    const after = requireTaskFor(outcome.aggregate, taskId);
    expect(after.state).toBe("BLOCKED");
    expect(after.blockReason).toEqual(expected);
  });
});

describe("SC-029: 검증 출구 네 갈래가 입력대로 정해진다", () => {
  const probeType = { id: "probe_extension", version: 1 };

  it("Happy: 완전 입력은 task_validated 로 READY 다 (test_SC029_complete_input_validated)", () => {
    const { taskId, outcome } = completeWith({ type: probeType, input: { subject: "x" } });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(eventTypes(outcome.commit)).toContain("task_validated");
    expect(requireTaskFor(outcome.aggregate, taskId).state).toBe("READY");
  });

  it("Edge: 필수 입력 누락은 task_input_requested 로 WAITING_INPUT 이다 (test_SC029_missing_field_input_requested)", () => {
    const { taskId, outcome } = completeWith({ type: probeType, input: {} });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    expect(eventTypes(outcome.commit)).toContain("task_input_requested");
    expect(requireTaskFor(outcome.aggregate, taskId).state).toBe("WAITING_INPUT");
  });

  it("Error: 비객체 입력은 FAILED, 범위 밖 채널 선언은 BLOCKED 다 (test_SC029_non_object_failed_and_surface_blocked)", () => {
    const failed = completeWith({ type: probeType, input: "x" });
    expect(failed.outcome.kind).toBe("committed");
    if (failed.outcome.kind === "committed") {
      expect(eventTypes(failed.outcome.commit)).toContain("task_validation_failed");
      const issues = payloadOf(failed.outcome.commit, "task_validation_failed")[
        "issues"
      ] as readonly {
        code: string;
      }[];
      expect(issues.map((i) => i.code)).toContain("input_not_object");
      expect(requireTaskFor(failed.outcome.aggregate, failed.taskId).state).toBe("FAILED");
    }

    const refused = completeWith({
      type: { id: "confirmation", version: 1 },
      input: { prompt: "Ship?", targetActor: ACTOR, allowedDecisions: ["accept"] },
      policy: basePolicy({ approvalSurface: "out_of_band", approvalRequiredBeforeExecute: true }),
    });
    expect(refused.outcome.kind).toBe("committed");
    if (refused.outcome.kind === "committed") {
      expect(eventTypes(refused.outcome.commit)).toContain("task_blocked");
      expect(requireTaskFor(refused.outcome.aggregate, refused.taskId).state).toBe("BLOCKED");
    }
  });
});

describe("SC-030: 누락 입력은 InputRequest 값으로 정규화된다", () => {
  it("Happy: 두 필드 누락은 스키마 순서로 요청 둘이 되고 문구는 메타데이터 질문이다 (test_SC030_two_missing_fields_two_requests)", () => {
    const confirmation = builtin("confirmation");
    const result = validateTask(
      testRegistries(),
      declaration({ type: { id: "confirmation", version: 1 }, input: { prompt: "Ship?" } }),
    );
    expect(result.exit).toBe("input_requested");
    if (result.exit !== "input_requested") return;
    expect(result.requests).toEqual(
      ["targetActor", "allowedDecisions"].map((field) => ({
        questionId: field,
        field,
        prompt: confirmation.inputFields[field]?.question,
        safetyRelevant: true,
      })),
    );
  });

  it("Edge: descriptor 의 문구 재정의가 쓰인다 (test_SC030_override_wording_used)", () => {
    const registries = testRegistries({ taskTypes: [probeOverridePromptTaskType()] });
    const result = validateTask(
      registries,
      declaration({ type: { id: "probe_override_prompt", version: 1 }, input: {} }),
    );
    expect(result.exit).toBe("input_requested");
    if (result.exit !== "input_requested") return;
    expect(result.requests.map((r) => [r.field, r.prompt, r.safetyRelevant])).toEqual([
      ["first", "Override: provide first", false],
      ["second", "Override: provide second", true],
    ]);
  });

  it("Error: 요청 밖 자유 문장이 없고 필드 집합을 어긴 재정의는 DomainInvariantError 다 (test_SC030_no_free_text_and_contract_violating_override_throws)", () => {
    const { outcome } = completeWith({ type: { id: "probe_extension", version: 1 }, input: {} });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind === "committed") {
      const payload = payloadOf(outcome.commit, "task_input_requested");
      expect(Object.keys(payload)).toEqual(["requests"]);
      for (const request of payload["requests"] as readonly object[])
        expect(Object.keys(request).sort()).toEqual([
          "field",
          "prompt",
          "questionId",
          "safetyRelevant",
        ]);
    }

    const violating = probeOverridePromptTaskType((issues) =>
      issues.slice(0, 1).map((issue) => ({
        questionId: issue.field,
        field: issue.field,
        prompt: "Only one",
        safetyRelevant: issue.metadata.safetyRelevant,
      })),
    );
    const registries = testRegistries({ taskTypes: [violating] });
    expect(() =>
      validateTask(
        registries,
        declaration({ type: { id: "probe_override_prompt", version: 1 }, input: {} }),
      ),
    ).toThrow(DomainInvariantError);
  });
});

describe("SC-031: 안전 관련 필드는 채워지지 않는다", () => {
  it("Happy: 확인 유형의 안전 필드 누락은 요청되고 Task 입력에 채워지지 않는다 (test_SC031_confirmation_safety_fields_requested_not_filled)", () => {
    const deps = testDeps("sc031");
    const { aggregate, taskIds } = planned(
      [draft("confirm", { type: { id: "confirmation", version: 1 }, input: { prompt: "Ship?" } })],
      deps,
    );
    const taskId = taskIds["confirm"];
    if (taskId === undefined) throw new Error("expected task");
    const validating = mustCommit(
      executeCommand(deps, aggregate, {
        kind: "begin_validation",
        taskId,
        expectedRevision: requireTaskFor(aggregate, taskId).revision,
        meta: meta(NOW),
      }),
    ).aggregate;
    const outcome = executeCommand(deps, validating, {
      kind: "complete_validation",
      taskId,
      expectedRevision: requireTaskFor(validating, taskId).revision,
      meta: meta(NOW),
    });
    expect(outcome.kind).toBe("committed");
    if (outcome.kind !== "committed") return;
    const requests = payloadOf(outcome.commit, "task_input_requested")["requests"] as readonly {
      field: string;
      safetyRelevant: boolean;
    }[];
    expect(requests.map((r) => [r.field, r.safetyRelevant])).toEqual([
      ["targetActor", true],
      ["allowedDecisions", true],
    ]);
    const input = requireTaskFor(outcome.aggregate, taskId).input as Record<string, unknown>;
    expect(Object.keys(input)).toEqual(["prompt"]);
  });

  it("Edge: 무인 적격 에이전트 목표는 도구 범위를 요청한다 (test_SC031_unattended_agent_goal_tool_scope_requested)", () => {
    const result = validateTask(
      testRegistries(),
      declaration({
        type: { id: "agent_goal", version: 1 },
        input: {
          goal: "Summarize",
          projectId: "prj_demo",
          category: "analysis",
          completionEvidence: "summary",
          sessionSelection: "default",
        },
        policy: basePolicy({
          unattended: { eligible: true, onGateDenied: "block_awaiting_human" },
        }),
      }),
    );
    expect(result.exit).toBe("input_requested");
    if (result.exit === "input_requested")
      expect(result.requests.map((r) => [r.field, r.safetyRelevant])).toEqual([
        ["toolScope", true],
      ]);
  });

  it("Error: 비적격이면 요청이 없고 내장 안전 필드에는 기본값이 없다 (test_SC031_no_request_when_not_eligible_and_no_safety_defaults)", () => {
    const result = validateTask(
      testRegistries(),
      declaration({
        type: { id: "agent_goal", version: 1 },
        input: {
          goal: "Summarize",
          projectId: "prj_demo",
          category: "analysis",
          completionEvidence: "summary",
          sessionSelection: "default",
        },
      }),
    );
    expect(result.exit).toBe("valid");

    const defaulted: string[] = [];
    let safetyFields = 0;
    for (const descriptor of BUILTIN_TASK_TYPES) {
      for (const [field, metadata] of Object.entries(descriptor.inputFields)) {
        if (!metadata.safetyRelevant) continue;
        safetyFields += 1;
        const shape = descriptor.schema.shape as Record<
          string,
          { safeParse(v: unknown): { success: boolean; data?: unknown } }
        >;
        const parsed = shape[field]?.safeParse(undefined);
        if (parsed?.success === true && parsed.data !== undefined)
          defaulted.push(`${descriptor.id}.${field}`);
      }
    }
    // 내장 안전 필드: confirmation 둘·agent_goal 하나·delegation 하나·notification 하나.
    expect(safetyFields).toBe(5);
    expect(defaulted).toEqual([]);
  });
});

describe("SC-027: 실행 효과로 선언되는 반응은 Task 의 반응 목록에 올 수 없다", () => {
  it("Error: 확인 요청 반응을 선언한 Task 는 reaction_not_transition 하나로 검증 실패이고 알림 반응은 통과한다 (test_SC027_execution_effect_reaction_declared_on_task_refused)", () => {
    const result = validateTask(
      testRegistries(),
      declaration({
        reactions: [
          {
            kind: "request_confirmation",
            version: 1,
            reactionLogicalId: "confirm_again",
            on: ["task_completed"],
            params: {},
          },
        ],
      }),
    );
    expect(result.exit).toBe("validation_failed");
    if (result.exit !== "validation_failed") return;
    const reactionIssues = result.issues.filter((issue) => issue.area === "reactions");
    expect(reactionIssues).toHaveLength(1);
    expect(reactionIssues[0]).toMatchObject({
      area: "reactions",
      code: "reaction_not_transition",
      path: ["reactions", 0],
    });

    const transition = validateTask(
      testRegistries(),
      declaration({ reactions: [COMPLETION_NOTIFY_REACTION] }),
    );
    expect(transition.exit).toBe("valid");
  });
});

describe("SC-030: 문구 재정의는 안전 표시와 질문 식별을 바꾸지 못한다", () => {
  it("Edge: 재정의가 safetyRelevant 를 뒤집고 questionId 를 바꿔도 요청은 메타데이터 값과 필드명을 쓰고 문구만 재정의를 따른다 (test_SC030_override_cannot_change_safety_flag_or_question_id)", () => {
    const flip = probeTaskType({
      id: "probe_override_flip",
      schema: z.strictObject({ target: z.string().min(1), note: z.string().min(1) }),
      inputFields: {
        target: { question: "Who is the target?", safetyRelevant: true },
        note: { question: "What is the note?", safetyRelevant: false },
      },
      outputs: {},
      describeMissingInput: (issues) =>
        issues.map((issue) => ({
          questionId: `custom_${issue.field}`,
          field: issue.field,
          prompt: `Custom: ${issue.field}`,
          safetyRelevant: !issue.metadata.safetyRelevant,
        })),
    });
    const result = validateTask(
      testRegistries({ taskTypes: [flip] }),
      declaration({ type: { id: "probe_override_flip", version: 1 }, input: {} }),
    );
    expect(result.exit).toBe("input_requested");
    if (result.exit !== "input_requested") return;
    expect(result.requests.map((r) => [r.field, r.questionId, r.prompt, r.safetyRelevant])).toEqual(
      [
        ["target", "target", "Custom: target", true],
        ["note", "note", "Custom: note", false],
      ],
    );
  });
});
