// SC-015, SC-017, SC-018, SC-022, SC-023, SC-024 — 내장 descriptor 15종의 선언·집합·필수 입력.
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  BUILTIN_TASK_TYPES,
  BUILTIN_TRIGGERS,
  BUILTIN_REACTIONS,
  EXTENSION_REGISTERED_SETS,
  TRIGGER_SPEC_KINDS,
  createBuiltinRegistries,
  judgeApprovalSurface,
  validateTask,
} from "../../../src/workflow/domain/index.js";
import type { ReactionDescriptor, TaskTypeDescriptor } from "../../../src/workflow/domain/index.js";
import { basePolicy } from "./helpers/fixtures.js";
import { testRegistries } from "./helpers/registry-fixtures.js";

function ref(
  d: { readonly version: number } & ({ readonly id: string } | { readonly kind: string }),
) {
  return `${"id" in d ? d.id : d.kind}@${d.version}`;
}

function registeredSet(extensionPoint: string): readonly string[] {
  const row = EXTENSION_REGISTERED_SETS.find((r) => r.extensionPoint === extensionPoint);
  if (row === undefined) throw new Error(`no transcribed row ${extensionPoint}`);
  return row.registeredSet;
}

function taskType(id: string): TaskTypeDescriptor {
  const found = BUILTIN_TASK_TYPES.find((d) => d.id === id);
  if (found === undefined) throw new Error(`builtin ${id} missing`);
  return found;
}

function reaction(kind: string): ReactionDescriptor {
  const found = BUILTIN_REACTIONS.find((d) => d.kind === kind);
  if (found === undefined) throw new Error(`builtin reaction ${kind} missing`);
  return found;
}

const ACTOR = { kind: "user", id: "u1" };

/** 내장 유형별 필수 입력을 모두 채운 입력(선택 필드 제외). */
const COMPLETE_INPUTS: Readonly<Record<string, Record<string, unknown>>> = {
  confirmation: {
    prompt: "Ship the release?",
    targetActor: ACTOR,
    allowedDecisions: ["accept", "reject"],
  },
  agent_goal: {
    goal: "Summarize the repository",
    projectId: "prj_demo",
    category: "analysis",
    completionEvidence: "summary written",
    sessionSelection: "default",
  },
  delegation: { assignee: ACTOR, request: "Review the plan", responseType: "acknowledgement" },
  notification: { target: "owner", message: "Done", importance: "normal" },
};

function validate(id: string, input: unknown) {
  return validateTask(testRegistries(), {
    type: { id, version: 1 },
    input,
    trigger: { kind: "immediate", version: 1, triggerId: "builtin" },
    policy: basePolicy(),
  });
}

describe("SC-015: 선언 둘이 계약 규칙 2~4 와 같은 결과를 낸다", () => {
  it("Happy: 선언 (a) 가 참인 내장 유형은 확인 유형뿐이다 (test_SC015_declaration_a_only_confirmation)", () => {
    expect(BUILTIN_TASK_TYPES.filter((d) => d.approvalGatesQuestionOnly).map(ref)).toEqual([
      "confirmation@1",
    ]);
  });

  it("Edge: 선언 (b) 가 참인 내장 유형은 확인·위임 유형이다 (test_SC015_declaration_b_confirmation_and_delegation)", () => {
    expect(
      BUILTIN_TASK_TYPES.filter((d) => d.executionIsWaitRequest)
        .map(ref)
        .sort(),
    ).toEqual(["confirmation@1", "delegation@1"]);
  });

  it("Error: 판정 결과가 계약 규칙 2~4 와 같다 (test_SC015_results_match_contract_rules)", () => {
    const outOfBandApproved = {
      approvalSurface: "out_of_band",
      approvalRequiredBeforeExecute: true,
    } as const;
    expect(
      judgeApprovalSurface({
        taskType: taskType("confirmation"),
        policy: outOfBandApproved,
        declaredReactions: [reaction("notify")],
      }),
    ).toEqual({ accepted: false, reason: "effect_records_only" });
    expect(
      judgeApprovalSurface({
        taskType: taskType("delegation"),
        policy: outOfBandApproved,
        declaredReactions: [],
      }),
    ).toEqual({ accepted: true });
    expect(
      judgeApprovalSurface({
        taskType: taskType("agent_goal"),
        policy: outOfBandApproved,
        declaredReactions: [],
      }),
    ).toEqual({ accepted: true });
    expect(
      judgeApprovalSurface({
        taskType: taskType("notification"),
        policy: { approvalSurface: "out_of_band", approvalRequiredBeforeExecute: false },
        declaredReactions: [],
      }),
    ).toEqual({ accepted: false, reason: "no_pre_execution_approval" });
  });
});

describe("SC-017: 등록된 Trigger 종류는 TriggerSpec 종류와 1:1 이다", () => {
  it("Happy: 내장 Trigger 종류 집합이 TriggerSpec 종류 집합과 같다 (test_SC017_builtin_trigger_kinds_equal_trigger_spec_kinds)", () => {
    expect(new Set(BUILTIN_TRIGGERS.map((t) => t.kind))).toEqual(new Set(TRIGGER_SPEC_KINDS));
  });

  it("Edge: 각 descriptor 가 occurrence 파생을 선언한다 (test_SC017_each_descriptor_declares_occurrence_derivation)", () => {
    const declared = Object.fromEntries(
      BUILTIN_TRIGGERS.map((t) => [t.kind, [t.firing, t.occurrenceDerivation]]),
    );
    const schedule = {
      kind: "schedule",
      inputs: ["ownerId", "triggerId", "scheduledForUtc", "recurrenceIndex"],
    };
    const eventCaused = {
      kind: "event_caused",
      inputs: ["ownerId", "triggerId", "causingEvent.id"],
    };
    expect(declared).toEqual({
      immediate: ["on_ready", { kind: "none" }],
      at: ["schedule", schedule],
      after: ["schedule", schedule],
      dependencies_complete: ["dependencies_satisfied", eventCaused],
      signal: ["external_signal", eventCaused],
    });
  });

  it("Error: 다섯 종류·버전 1·중복 없음 (test_SC017_five_kinds_version_one_no_duplicates)", () => {
    expect(BUILTIN_TRIGGERS).toHaveLength(5);
    expect(BUILTIN_TRIGGERS.every((t) => t.version === 1)).toBe(true);
    expect(new Set(BUILTIN_TRIGGERS.map(ref)).size).toBe(5);
  });
});

describe("SC-018: Reaction descriptor 가 계약 선언 항목을 갖춘다", () => {
  it("Happy: 모든 선언 값이 있고 알림·확인 요청은 외부 효과·ADDE 자격증명이다 (test_SC018_all_declarations_present_credentialed_notify_and_request)", () => {
    for (const r of BUILTIN_REACTIONS) {
      expect(["fixed", "per_declaration"], r.kind).toContain(r.reactionLogicalId.kind);
      expect(typeof r.performsExternalEffect, r.kind).toBe("boolean");
      expect(typeof r.usesAddeCredentials, r.kind).toBe("boolean");
      expect(typeof r.dispatchesAgent, r.kind).toBe("boolean");
      expect(Array.isArray(r.retry.permanentErrorCodes), r.kind).toBe(true);
      expect(typeof r.retry.canEndAmbiguous, r.kind).toBe("boolean");
      expect(["execution_effect", "transition_reaction"], r.kind).toContain(r.declaredAs);
      expect(r.paramsSchema instanceof z.ZodObject, r.kind).toBe(true);
    }
    for (const kind of ["notify", "request_confirmation"]) {
      expect(reaction(kind).performsExternalEffect, kind).toBe(true);
      expect(reaction(kind).usesAddeCredentials, kind).toBe(true);
    }
  });

  it("Edge: 에이전트 목표 실행은 에이전트 dispatch 이고 ADDE 자격증명이 아니다 (test_SC018_execute_agent_goal_is_agent_dispatch_not_credentialed)", () => {
    const r = reaction("execute_agent_goal");
    expect(r.dispatchesAgent).toBe(true);
    expect(r.usesAddeCredentials).toBe(false);
    expect(r.performsExternalEffect).toBe(true);
  });

  it("Error: 여섯 종류의 선언 값이 표와 같다 (test_SC018_remaining_values_match_design_table)", () => {
    const projected = Object.fromEntries(
      BUILTIN_REACTIONS.map((r) => [
        r.kind,
        {
          logicalId:
            r.reactionLogicalId.kind === "fixed" ? r.reactionLogicalId.value : "per_declaration",
          external: r.performsExternalEffect,
          credentials: r.usesAddeCredentials,
          agent: r.dispatchesAgent,
          declaredAs: r.declaredAs,
          permanent: r.retry.permanentErrorCodes,
          ambiguous: r.retry.canEndAmbiguous,
        },
      ]),
    );
    const row = (
      logicalId: string,
      external: boolean,
      credentials: boolean,
      agent: boolean,
      declaredAs: string,
      ambiguous: boolean,
    ) => ({ logicalId, external, credentials, agent, declaredAs, permanent: [], ambiguous });
    expect(projected).toEqual({
      notify: row("per_declaration", true, true, false, "transition_reaction", true),
      request_confirmation: row(
        "confirmation_request",
        true,
        true,
        false,
        "execution_effect",
        true,
      ),
      execute_agent_goal: row("agent_dispatch", true, false, true, "execution_effect", true),
      delegate: row("delegation_request", true, true, false, "execution_effect", true),
      spawn_task: row("per_declaration", false, false, false, "transition_reaction", false),
      spawn_work: row("per_declaration", false, false, false, "transition_reaction", false),
    });
  });
});

describe("SC-022: 내장 등록 집합이 계약과 같다", () => {
  it("Happy: 내장 TaskType 집합이 전사된 등록 집합과 같다 (test_SC022_builtin_task_types_equal_transcribed_set)", () => {
    expect(BUILTIN_TASK_TYPES.map(ref).sort()).toEqual([...registeredSet("TaskType")].sort());
  });

  it("Edge: 내장 Trigger 집합이 전사된 등록 집합과 같다 (test_SC022_builtin_triggers_equal_transcribed_set)", () => {
    expect(BUILTIN_TRIGGERS.map(ref).sort()).toEqual([...registeredSet("Trigger kind")].sort());
  });

  it("Error: 내장 Reaction 집합이 전사된 등록 집합과 같고 크기가 4·5·6 이다 (test_SC022_builtin_reactions_equal_transcribed_set_sizes)", () => {
    expect(BUILTIN_REACTIONS.map(ref).sort()).toEqual([...registeredSet("Reaction kind")].sort());
    expect([BUILTIN_TASK_TYPES.length, BUILTIN_TRIGGERS.length, BUILTIN_REACTIONS.length]).toEqual([
      4, 5, 6,
    ]);
    const built = createBuiltinRegistries();
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value.taskTypes.list().map(ref).sort()).toEqual(
        [...registeredSet("TaskType")].sort(),
      );
      expect(built.value.triggers.list().map(ref).sort()).toEqual(
        [...registeredSet("Trigger kind")].sort(),
      );
      expect(built.value.reactions.list().map(ref).sort()).toEqual(
        [...registeredSet("Reaction kind")].sort(),
      );
    }
  });
});

describe("SC-023: 내장 유형 입력 스키마가 필수 입력을 요구한다", () => {
  it("Happy: 유형별 완전 입력은 누락 없이 통과한다 (test_SC023_complete_inputs_pass)", () => {
    for (const [id, input] of Object.entries(COMPLETE_INPUTS)) {
      expect(validate(id, input).exit, id).toBe("valid");
    }
  });

  it("Edge: 필수 필드를 하나씩 빼면 그 필드 하나만 요청된다 (test_SC023_each_required_field_removed_requested)", () => {
    for (const [id, input] of Object.entries(COMPLETE_INPUTS)) {
      for (const field of Object.keys(input)) {
        const { [field]: _removed, ...rest } = input;
        void _removed;
        const result = validate(id, rest);
        expect(result.exit, `${id}.${field}`).toBe("input_requested");
        if (result.exit === "input_requested")
          expect(
            result.requests.map((r) => r.field),
            `${id}.${field}`,
          ).toEqual([field]);
      }
    }
  });

  it("Error: 필수 필드의 잘못된 형은 누락이 아니라 구조 오류다 (test_SC023_wrong_type_is_structural_not_missing)", () => {
    for (const [id, input] of Object.entries(COMPLETE_INPUTS)) {
      for (const field of Object.keys(input)) {
        const result = validate(id, { ...input, [field]: 42 });
        expect(result.exit, `${id}.${field}`).toBe("validation_failed");
        if (result.exit === "validation_failed")
          expect(
            result.issues.map((i) => [i.code, i.path]),
            `${id}.${field}`,
          ).toContainEqual(["input_field_invalid", [field]]);
      }
    }
  });
});

describe("SC-024: 직접 명령 실행 반응 종류는 등록되어 있지 않다", () => {
  it("Happy: 등록된 반응 여섯이 계약 집합과 같다 (test_SC024_six_registered_equal_contract)", () => {
    expect(BUILTIN_REACTIONS).toHaveLength(6);
    expect(new Set(BUILTIN_REACTIONS.map(ref))).toEqual(new Set(registeredSet("Reaction kind")));
  });

  it("Edge: 계약 집합 밖 반응 종류가 0 이다 (test_SC024_no_kind_outside_contract_set)", () => {
    const contract = new Set(registeredSet("Reaction kind"));
    expect(BUILTIN_REACTIONS.map(ref).filter((r) => !contract.has(r))).toEqual([]);
  });

  it("Error: 명령·스크립트·프로세스 실행을 뜻하는 반응 종류가 없다 (test_SC024_no_command_execution_kind)", () => {
    const executionLike = /command|script|shell|process|exec_|run_/;
    expect(BUILTIN_REACTIONS.map((r) => r.kind).filter((k) => executionLike.test(k))).toEqual([]);
    const built = createBuiltinRegistries();
    if (!built.ok) throw new Error("expected builtin registries");
    expect(
      built.value.reactions
        .list()
        .map((r) => r.kind)
        .filter((k) => executionLike.test(k)),
    ).toEqual([]);
  });
});
