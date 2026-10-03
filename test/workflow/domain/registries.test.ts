// SC-013, SC-014, SC-019, SC-020, SC-021 — descriptor 계약 필드·출력 선언·등록 충돌·조회·식별자 불변.
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  createTaskTypeRegistry,
  createReactionRegistry,
  createTriggerRegistry,
  createDomainRegistries,
  createBuiltinRegistries,
  resolveTaskOutputs,
  resolveTaskOutput,
  BUILTIN_TASK_TYPES,
  BUILTIN_TRIGGERS,
  BUILTIN_REACTIONS,
} from "../../../src/workflow/domain/index.js";
import type {
  DescriptorRegistry,
  ReactionDescriptor,
  RegistryConstructionError,
  Result,
  TaskTypeDescriptor,
  TriggerDescriptor,
} from "../../../src/workflow/domain/index.js";
import { probeTaskType, testRegistries } from "./helpers/registry-fixtures.js";

function builtinTaskType(id: string): TaskTypeDescriptor {
  const found = BUILTIN_TASK_TYPES.find((d) => d.id === id);
  if (found === undefined) throw new Error(`builtin task type ${id} missing`);
  return found;
}

const AGENT_GOAL_INPUT = {
  goal: "Summarize the repository",
  projectId: "prj_demo",
  category: "analysis",
  completionEvidence: "summary written",
  sessionSelection: "default",
};

describe("SC-013: TaskType descriptor 가 계약 필드를 갖추지 못하면 구성되지 않는다", () => {
  it("Happy: 계약 필드를 모두 갖춘 descriptor 가 등록·조회된다 (test_SC013_valid_descriptor_registers)", () => {
    const built = createTaskTypeRegistry([probeTaskType()]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const found = built.value.get("probe_extension", 1);
    expect(found?.id).toBe("probe_extension");
    expect(found?.version).toBe(1);
    expect(found?.executionEffect).toBe("records_only");
  });

  it("Edge: 실행 효과 선언이 없으면 구성 실패다 (test_SC013_missing_execution_effect_fails_construction)", () => {
    const { executionEffect: _removed, ...rest } = probeTaskType();
    void _removed;
    const built = createTaskTypeRegistry([rest as unknown as TaskTypeDescriptor]);
    expect(built.ok).toBe(false);
    if (!built.ok)
      expect(built.error).toEqual({
        kind: "descriptor_invalid",
        axis: "task_type",
        id: "probe_extension",
        version: 1,
        defect: { code: "execution_effect_invalid" },
      });
  });

  it("Error: 필수 필드 메타데이터 누락·안전 필드 기본값은 구성 실패다 (test_SC013_required_field_without_metadata_fails_construction)", () => {
    const noMetadata = createTaskTypeRegistry([probeTaskType({ inputFields: {} })]);
    expect(noMetadata.ok).toBe(false);
    if (!noMetadata.ok && noMetadata.error.kind === "descriptor_invalid")
      expect(noMetadata.error.defect).toEqual({
        code: "required_field_without_metadata",
        field: "subject",
      });

    const safetyDefault = createTaskTypeRegistry([
      probeTaskType({
        schema: z.strictObject({ subject: z.string().default("fallback") }),
        inputFields: { subject: { question: "What is the subject?", safetyRelevant: true } },
      }),
    ]);
    expect(safetyDefault.ok).toBe(false);
    if (!safetyDefault.ok && safetyDefault.error.kind === "descriptor_invalid")
      expect(safetyDefault.error.defect).toEqual({
        code: "safety_field_has_default",
        field: "subject",
      });
  });
});

describe("SC-014: 출력은 선언된 이름만 존재하고 입력이 정하는 출력 스키마를 지원한다", () => {
  it("Happy: 입력 필드가 정하는 출력 스키마가 선언 순서로 해석된다 (test_SC014_output_schema_from_input_resolved)", () => {
    const agentGoal = builtinTaskType("agent_goal");
    const dataSchema = { type: "object", properties: { count: { type: "number" } } };
    const outputs = resolveTaskOutputs(agentGoal, { ...AGENT_GOAL_INPUT, dataSchema });
    expect(outputs.map((o) => [o.name, o.source])).toEqual([
      ["summary", "declared"],
      ["data", "input_field"],
    ]);
    const data = outputs[1];
    if (data?.source === "input_field") {
      expect(data.field).toBe("dataSchema");
      expect(data.schema).toEqual(dataSchema);
    }
  });

  it("Edge: 출력을 정하는 입력 필드가 없으면 그 출력도 없다 (test_SC014_input_field_output_absent_without_field)", () => {
    const outputs = resolveTaskOutputs(builtinTaskType("agent_goal"), AGENT_GOAL_INPUT);
    expect(outputs.map((o) => o.name)).toEqual(["summary"]);
    expect(
      resolveTaskOutput(builtinTaskType("agent_goal"), AGENT_GOAL_INPUT, "data"),
    ).toBeUndefined();
  });

  it("Error: 선언되지 않은 출력은 조회되지 않고 미지 입력 필드를 지목한 출력은 구성 실패다 (test_SC014_undeclared_output_not_resolvable)", () => {
    expect(
      resolveTaskOutput(builtinTaskType("agent_goal"), AGENT_GOAL_INPUT, "evidence"),
    ).toBeUndefined();
    const built = createTaskTypeRegistry([
      probeTaskType({ outputs: { derived: { outputSchemaFromInput: "nope" } } }),
    ]);
    expect(built.ok).toBe(false);
    if (!built.ok && built.error.kind === "descriptor_invalid")
      expect(built.error.defect).toEqual({
        code: "output_from_unknown_input",
        output: "derived",
        field: "nope",
      });
  });
});

describe("SC-019: 등록 충돌은 구성 시점에 실패한다", () => {
  it("Happy: 같은 (id, version) 의 다른 TaskType 둘은 충돌로 구성 실패다 (test_SC019_task_type_collision_fails_construction)", () => {
    const built = createTaskTypeRegistry([
      probeTaskType(),
      probeTaskType({ title: "Different content" }),
    ]);
    expect(built.ok).toBe(false);
    if (!built.ok)
      expect(built.error).toEqual({
        kind: "registration_collision",
        axis: "task_type",
        id: "probe_extension",
        version: 1,
      });
  });

  it("Edge: 같은 (kind, version) 의 Reaction 둘은 충돌로 구성 실패다 (test_SC019_reaction_collision_fails_construction)", () => {
    const notify = BUILTIN_REACTIONS.find((r) => r.kind === "notify");
    if (notify === undefined) throw new Error("builtin notify missing");
    const built = createReactionRegistry([notify, { ...notify, title: "Another notify" }]);
    expect(built.ok).toBe(false);
    if (!built.ok)
      expect(built.error).toEqual({
        kind: "registration_collision",
        axis: "reaction",
        id: "notify",
        version: 1,
      });
  });

  it("Error: 충돌이면 어떤 등록부도 돌려주지 않고 내장을 덮어쓰지 못한다 (test_SC019_no_registry_no_overwrite)", () => {
    const confirmation = builtinTaskType("confirmation");
    const overwrite = createBuiltinRegistries({
      taskTypes: [{ ...confirmation, title: "Overwritten confirmation" }],
    });
    expect(overwrite.ok).toBe(false);
    expect("value" in overwrite).toBe(false);
    if (!overwrite.ok) expect(overwrite.error.kind).toBe("registration_collision");

    const combined = createDomainRegistries({
      taskTypes: [probeTaskType(), probeTaskType({ title: "dup" })],
      triggers: BUILTIN_TRIGGERS,
      reactions: BUILTIN_REACTIONS,
    });
    expect(combined.ok).toBe(false);
    if (!combined.ok) expect(combined.error).toMatchObject({ axis: "task_type" });

    const intact = createBuiltinRegistries();
    expect(intact.ok).toBe(true);
    if (intact.ok)
      expect(intact.value.taskTypes.get("confirmation", 1)?.title).toBe(confirmation.title);
  });
});

describe("SC-020: 조회는 (id, version) 단위이고 등록 순서와 무관하다", () => {
  const v1 = probeTaskType({ title: "Probe v1" });
  const v2 = probeTaskType({ version: 2, title: "Probe v2" });

  function both() {
    const a = createTaskTypeRegistry([v1, v2]);
    const b = createTaskTypeRegistry([v2, v1]);
    if (!a.ok || !b.ok) throw new Error("expected both registries");
    return { a: a.value, b: b.value };
  }

  it("Happy: 등록 순서를 바꿔도 각 버전 조회 결과가 같다 (test_SC020_lookup_independent_of_registration_order)", () => {
    const { a, b } = both();
    expect(a.get("probe_extension", 1)?.title).toBe("Probe v1");
    expect(b.get("probe_extension", 1)?.title).toBe("Probe v1");
    expect(a.get("probe_extension", 2)?.title).toBe("Probe v2");
    expect(b.get("probe_extension", 2)?.title).toBe("Probe v2");
  });

  it("Edge: 등록되지 않은 버전은 다른 버전으로 대체되지 않는다 (test_SC020_missing_version_undefined)", () => {
    const { a, b } = both();
    expect(a.get("probe_extension", 3)).toBeUndefined();
    expect(b.get("probe_extension", 3)).toBeUndefined();
  });

  it("Error: 열거 순서가 등록 순서와 무관하게 같다 (test_SC020_list_order_identical)", () => {
    const { a, b } = both();
    const order = (list: readonly TaskTypeDescriptor[]) => list.map((d) => `${d.id}@${d.version}`);
    expect(order(a.list())).toEqual(["probe_extension@1", "probe_extension@2"]);
    expect(order(b.list())).toEqual(order(a.list()));
  });
});

describe("SC-021: 등록된 descriptor 의 식별자는 바뀌지 않는다", () => {
  function registered() {
    const input = probeTaskType();
    const built = createTaskTypeRegistry([input]);
    if (!built.ok) throw new Error("expected registry");
    const found = built.value.get("probe_extension", 1);
    if (found === undefined) throw new Error("expected descriptor");
    return { input, registry: built.value, found };
  }

  it("Happy: 조회한 descriptor 의 id 대입은 타입·실행 모두 거부된다 (test_SC021_id_assignment_rejected)", () => {
    const { found } = registered();
    expect(() => {
      // @ts-expect-error -- descriptor 식별자는 readonly 다.
      found.id = "renamed";
    }).toThrow(TypeError);
  });

  it("Edge: version 대입도 실행 시 거부된다 (test_SC021_version_assignment_rejected)", () => {
    const { found } = registered();
    expect(() => {
      // @ts-expect-error -- descriptor 버전은 readonly 다.
      found.version = 9;
    }).toThrow(TypeError);
  });

  it("Error: 재조회는 원 식별의 같은 사본을 돌려주고 입력 원본은 동결되지 않는다 (test_SC021_relookup_returns_original_identity)", () => {
    const { input, registry, found } = registered();
    const again = registry.get("probe_extension", 1);
    expect(again).toBe(found);
    expect(again?.id).toBe("probe_extension");
    expect(again?.version).toBe(1);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(found.schema)).toBe(false);
  });
});

describe("SC-021: 등록부는 한 번 읽은 분리 사본을 검사·저장하고 평범한 데이터를 깊게 동결한다", () => {
  function builtinReaction(kind: string): ReactionDescriptor {
    const found = BUILTIN_REACTIONS.find((r) => r.kind === kind && r.version === 1);
    if (found === undefined) throw new Error(`builtin reaction ${kind} missing`);
    return found;
  }

  it("Edge: getter descriptor 는 필드마다 한 번만 읽히고 저장 값이 검사한 값이다 (test_SC021_descriptor_read_once_stored_equals_checked)", () => {
    const reads = { id: 0, executionEffect: 0 };
    const base: Record<string, unknown> = { ...probeTaskType() };
    // 런타임 방어 시험: 읽을 때마다 값이 바뀌는 getter descriptor 는 타입으로 표현되지 않는다.
    Object.defineProperty(base, "id", {
      enumerable: true,
      get: () => (reads.id++ === 0 ? "probe_getter" : "probe_getter_b"),
    });
    Object.defineProperty(base, "executionEffect", {
      enumerable: true,
      get: () => (reads.executionEffect++ === 0 ? "records_only" : "not_an_effect"),
    });
    const built = createTaskTypeRegistry([base as unknown as TaskTypeDescriptor]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(reads).toEqual({ id: 1, executionEffect: 1 });
    const stored = built.value.get("probe_getter", 1);
    expect(stored?.id).toBe("probe_getter");
    expect(stored?.executionEffect).toBe("records_only");
    expect(built.value.get("probe_getter_b", 1)).toBeUndefined();
  });

  it("Error: 저장된 하위 평범한 데이터도 동결되어 대입·추가가 거부된다 (test_SC021_stored_plain_data_deeply_frozen)", () => {
    const registries = testRegistries({ taskTypes: [probeTaskType()] });
    const probe = registries.taskTypes.get("probe_extension", 1);
    const notify = registries.reactions.get("notify", 1);
    const derived = registries.triggers
      .list()
      .flatMap((t) => (t.occurrenceDerivation.kind === "none" ? [] : [t.occurrenceDerivation]));
    expect(derived.length).toBeGreaterThanOrEqual(1);
    const subject = probe?.inputFields["subject"];
    const codes = notify?.retry.permanentErrorCodes;
    if (subject === undefined || codes === undefined) throw new Error("expected stored data");

    expect(Object.isFrozen(subject)).toBe(true);
    expect(() => {
      (subject as { safetyRelevant: boolean }).safetyRelevant = true;
    }).toThrow(TypeError);
    expect(Object.isFrozen(codes)).toBe(true);
    expect(() => (codes as string[]).push("x")).toThrow(TypeError);
    for (const derivation of derived) {
      expect(Object.isFrozen(derivation.inputs)).toBe(true);
      expect(() => (derivation.inputs as string[]).push("x")).toThrow(TypeError);
    }
    expect(
      registries.taskTypes.get("probe_extension", 1)?.inputFields["subject"]?.safetyRelevant,
    ).toBe(false);
    expect(registries.reactions.get("notify", 1)?.retry.permanentErrorCodes).toEqual(codes);
    expect(codes).not.toContain("x");
  });

  it("Error: 저장 사본은 호출자 입력과 분리되고 호출자 입력은 동결되지 않는다 (test_SC021_stored_copy_detached_from_caller_input)", () => {
    const callerTaskType = probeTaskType();
    const callerSubject = callerTaskType.inputFields["subject"];
    if (callerSubject === undefined) throw new Error("expected input field");
    const callerReaction: ReactionDescriptor = {
      ...builtinReaction("notify"),
      retry: { ...builtinReaction("notify").retry, permanentErrorCodes: ["e1"] },
    };
    const taskTypes = createTaskTypeRegistry([callerTaskType]);
    const reactions = createReactionRegistry([callerReaction]);
    if (!taskTypes.ok || !reactions.ok) throw new Error("expected registries");

    (callerSubject as { safetyRelevant: boolean }).safetyRelevant = true;
    (callerReaction.retry.permanentErrorCodes as string[]).push("x");
    expect(callerSubject.safetyRelevant).toBe(true);
    expect(callerReaction.retry.permanentErrorCodes).toEqual(["e1", "x"]);

    const storedSubject = taskTypes.value.get("probe_extension", 1)?.inputFields["subject"];
    expect(storedSubject?.safetyRelevant).toBe(false);
    expect(storedSubject).not.toBe(callerSubject);
    expect(reactions.value.get("notify", 1)?.retry.permanentErrorCodes).toEqual(["e1"]);
  });

  it("Happy: 스키마 객체는 원본과 같은 참조로 공유되고 동결되지 않으며 그대로 쓸 수 있다 (test_SC021_schema_objects_shared_unfrozen_and_usable)", () => {
    const callerTaskType = probeTaskType();
    const registries = testRegistries({ taskTypes: [callerTaskType] });
    const storedTaskType = registries.taskTypes.get("probe_extension", 1);
    const builtinImmediate = BUILTIN_TRIGGERS.find((t) => t.kind === "immediate");
    const storedImmediate = registries.triggers.get("immediate", 1);
    const storedNotify = registries.reactions.get("notify", 1);
    if (
      storedTaskType === undefined ||
      builtinImmediate === undefined ||
      storedImmediate === undefined ||
      storedNotify === undefined
    )
      throw new Error("expected stored descriptors");
    const callerOutput = callerTaskType.outputs["result"];
    const storedOutput = storedTaskType.outputs["result"];

    expect(storedTaskType.schema).toBe(callerTaskType.schema);
    expect(storedOutput).toBe(callerOutput);
    expect(storedImmediate.schema).toBe(builtinImmediate.schema);
    expect(storedNotify.paramsSchema).toBe(builtinReaction("notify").paramsSchema);
    for (const schema of [
      storedTaskType.schema,
      storedOutput,
      storedImmediate.schema,
      storedNotify.paramsSchema,
    ])
      expect(Object.isFrozen(schema)).toBe(false);

    expect(storedTaskType.schema.safeParse({ subject: "x" }).success).toBe(true);
    expect((storedOutput as z.ZodType).safeParse("done").success).toBe(true);
    expect(
      storedImmediate.schema.safeParse({ kind: "immediate", version: 1, triggerId: "t" }).success,
    ).toBe(true);
    expect(storedNotify.paramsSchema.safeParse({ target: "owner", message: "done" }).success).toBe(
      true,
    );
  });

  it("Error: 순환 참조가 있는 평범한 데이터는 던지지 않고 구성 실패다 (test_SC021_cyclic_plain_data_fails_construction_without_throw)", () => {
    const cyclicSubject: Record<string, unknown> = {
      question: "What is the subject?",
      safetyRelevant: false,
    };
    cyclicSubject["self"] = cyclicSubject;
    // 런타임 방어 시험: 순환 참조 descriptor 는 타입으로 표현되지 않는다.
    const cyclic = probeTaskType({
      id: "probe_cyclic",
      inputFields: { subject: cyclicSubject } as unknown as TaskTypeDescriptor["inputFields"],
    });
    let built: ReturnType<typeof createTaskTypeRegistry> | undefined;
    expect(() => {
      built = createTaskTypeRegistry([cyclic]);
    }).not.toThrow();
    expect(built).toEqual({
      ok: false,
      error: {
        kind: "descriptor_invalid",
        axis: "task_type",
        id: "probe_cyclic",
        version: 1,
        defect: { code: "declaration_invalid", declaration: "inputFields" },
      },
    });
  });
});

describe("SC-021: 평범하지 않은 선언 데이터는 구성에서 거절되고 __proto__ 키는 일반 속성으로 저장된다", () => {
  function expectDeclarationRefused<D>(
    built: Result<DescriptorRegistry<D>, RegistryConstructionError>,
    refusal: { axis: string; id: string; declaration: string },
  ): void {
    expect(built).toEqual({
      ok: false,
      error: {
        kind: "descriptor_invalid",
        axis: refusal.axis,
        id: refusal.id,
        version: 1,
        defect: { code: "declaration_invalid", declaration: refusal.declaration },
      },
    });
  }

  function builtinOf<D extends { readonly kind: string; readonly version: number }>(
    list: readonly D[],
    kind: string,
  ): D {
    const found = list.find((d) => d.kind === kind && d.version === 1);
    if (found === undefined) throw new Error(`builtin ${kind} missing`);
    return found;
  }

  it("Error: 클래스 인스턴스 중첩 선언은 그 최상위 필드의 declaration_invalid 로 거절되고 같은 값의 평범한 객체는 등록된다 (test_SC021_class_instance_declaration_refused)", () => {
    class FieldMetadata {
      constructor(
        public question: string,
        public safetyRelevant: boolean,
      ) {}
    }
    class RetryClassification {
      permanentErrorCodes: string[] = ["e1"];
      canEndAmbiguous = false;
    }
    class LogicalId {
      constructor(
        public kind: string,
        public value: string,
      ) {}
    }
    class Derivation {
      constructor(
        public kind: string,
        public inputs: string[],
      ) {}
    }

    // 런타임 방어 시험: 클래스 인스턴스 선언은 타입이 구별하지 못한다.
    const field = new FieldMetadata("What is the subject?", false);
    expectDeclarationRefused(
      createTaskTypeRegistry([
        probeTaskType({
          inputFields: { subject: field } as unknown as TaskTypeDescriptor["inputFields"],
        }),
      ]),
      { axis: "task_type", id: "probe_extension", declaration: "inputFields" },
    );
    expect(
      createTaskTypeRegistry([probeTaskType({ inputFields: { subject: { ...field } } })]).ok,
    ).toBe(true);

    const notify = builtinOf(BUILTIN_REACTIONS, "notify");
    const retry = new RetryClassification();
    expectDeclarationRefused(createReactionRegistry([{ ...notify, retry }]), {
      axis: "reaction",
      id: "notify",
      declaration: "retry",
    });
    expect(createReactionRegistry([{ ...notify, retry: { ...retry } }]).ok).toBe(true);

    const confirm = builtinOf(BUILTIN_REACTIONS, "request_confirmation");
    const logicalId = new LogicalId(
      "fixed",
      confirm.reactionLogicalId.kind === "fixed" ? confirm.reactionLogicalId.value : "",
    );
    expectDeclarationRefused(
      createReactionRegistry([
        {
          ...confirm,
          reactionLogicalId: logicalId as unknown as ReactionDescriptor["reactionLogicalId"],
        },
      ]),
      { axis: "reaction", id: "request_confirmation", declaration: "reactionLogicalId" },
    );
    expect(
      createReactionRegistry([
        {
          ...confirm,
          reactionLogicalId: { ...logicalId } as ReactionDescriptor["reactionLogicalId"],
        },
      ]).ok,
    ).toBe(true);

    const atTrigger = builtinOf(BUILTIN_TRIGGERS, "at");
    const inputs =
      atTrigger.occurrenceDerivation.kind === "none"
        ? []
        : [...atTrigger.occurrenceDerivation.inputs];
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    const derivation = new Derivation("schedule", inputs);
    expectDeclarationRefused(
      createTriggerRegistry([
        {
          ...atTrigger,
          occurrenceDerivation: derivation as unknown as TriggerDescriptor["occurrenceDerivation"],
        },
      ]),
      { axis: "trigger", id: "at", declaration: "occurrenceDerivation" },
    );
    expect(
      createTriggerRegistry([
        {
          ...atTrigger,
          occurrenceDerivation: { ...derivation } as TriggerDescriptor["occurrenceDerivation"],
        },
      ]).ok,
    ).toBe(true);
  });

  it("Error: 자기 키 __proto__ 는 일반 동결 속성으로 저장되고 사본의 프로토타입은 바뀌지 않는다 (test_SC021_own_proto_key_stored_as_plain_property)", () => {
    // JSON.parse 는 "__proto__" 를 프로토타입 설정이 아니라 자기 속성으로 만든다.
    const parsedField = JSON.parse(
      '{"question":"What is the subject?","safetyRelevant":false,"__proto__":{"injected":true}}',
    ) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsedField, "__proto__")).toBe(true);
    const built = createTaskTypeRegistry([
      probeTaskType({
        inputFields: { subject: parsedField } as unknown as TaskTypeDescriptor["inputFields"],
      }),
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const stored = built.value.get("probe_extension", 1)?.inputFields["subject"];
    if (stored === undefined) throw new Error("expected stored field");
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(stored, "__proto__")).toBe(true);
    expect("injected" in stored).toBe(false);
    expect(Object.isFrozen(stored)).toBe(true);
    const ownProto = Object.getOwnPropertyDescriptor(stored, "__proto__")?.value as unknown;
    expect(ownProto).toEqual({ injected: true });
    expect(Object.isFrozen(ownProto)).toBe(true);
    expect(stored.safetyRelevant).toBe(false);
  });
});

describe("SC-021: zod 값은 스키마 자리에서만 허용되고 최상위 __proto__ 키도 일반 속성으로 저장된다", () => {
  function expectDeclarationRefused<D>(
    built: Result<DescriptorRegistry<D>, RegistryConstructionError>,
    refusal: { axis: string; id: string; declaration: string },
  ): void {
    expect(built).toEqual({
      ok: false,
      error: {
        kind: "descriptor_invalid",
        axis: refusal.axis,
        id: refusal.id,
        version: 1,
        defect: { code: "declaration_invalid", declaration: refusal.declaration },
      },
    });
  }

  function builtinOf<D extends { readonly kind: string; readonly version: number }>(
    list: readonly D[],
    kind: string,
  ): D {
    const found = list.find((d) => d.kind === kind && d.version === 1);
    if (found === undefined) throw new Error(`builtin ${kind} missing`);
    return found;
  }

  /** zod 4 의 instanceof 는 `_zod.traits` 덕 타이핑이다 — 열거되지 않는 `_zod` 로 스키마를 흉내 낸다. */
  function zodLookalike<T extends object>(plain: T): T {
    Object.defineProperty(plain, "_zod", {
      value: { traits: new Set(["ZodType", "$ZodType"]) },
      enumerable: false,
    });
    return plain;
  }

  it("Error: 비스키마 자리의 실제 zod 값과 _zod 위장 객체는 그 최상위 필드의 declaration_invalid 로 거절되고 내장·평범한 사본은 구성된다 (test_SC021_zod_value_outside_schema_position_refused)", () => {
    // 런타임 방어 시험: 비스키마 자리의 zod 값은 타입이 구별하지 못한다.
    const zodField = Object.assign(z.string(), {
      question: "What is the subject?",
      safetyRelevant: false,
    });
    expect(zodField instanceof z.ZodType).toBe(true);
    expectDeclarationRefused(
      createTaskTypeRegistry([
        probeTaskType({
          inputFields: { subject: zodField } as unknown as TaskTypeDescriptor["inputFields"],
        }),
      ]),
      { axis: "task_type", id: "probe_extension", declaration: "inputFields" },
    );

    const notify = builtinOf(BUILTIN_REACTIONS, "notify");
    const disguisedRetry = zodLookalike({ permanentErrorCodes: ["e1"], canEndAmbiguous: false });
    expect(disguisedRetry instanceof z.ZodType).toBe(true);
    expectDeclarationRefused(createReactionRegistry([{ ...notify, retry: disguisedRetry }]), {
      axis: "reaction",
      id: "notify",
      declaration: "retry",
    });

    // 스키마 판정 표식이 없는 `_zod` 를 가진 객체도 비스키마 자리에서는 거절된다.
    const markedRetry = { permanentErrorCodes: ["e1"], canEndAmbiguous: false };
    Object.defineProperty(markedRetry, "_zod", { value: {}, enumerable: false });
    expect(markedRetry instanceof z.ZodType).toBe(false);
    expectDeclarationRefused(createReactionRegistry([{ ...notify, retry: markedRetry }]), {
      axis: "reaction",
      id: "notify",
      declaration: "retry",
    });

    const atTrigger = builtinOf(BUILTIN_TRIGGERS, "at");
    const inputs =
      atTrigger.occurrenceDerivation.kind === "none"
        ? []
        : [...atTrigger.occurrenceDerivation.inputs];
    const disguisedDerivation = zodLookalike({ kind: "schedule", inputs });
    expectDeclarationRefused(
      createTriggerRegistry([
        {
          ...atTrigger,
          occurrenceDerivation:
            disguisedDerivation as unknown as TriggerDescriptor["occurrenceDerivation"],
        },
      ]),
      { axis: "trigger", id: "at", declaration: "occurrenceDerivation" },
    );

    expect(createBuiltinRegistries().ok).toBe(true);
    expect(
      createReactionRegistry([
        { ...notify, retry: { permanentErrorCodes: ["e1"], canEndAmbiguous: false } },
      ]).ok,
    ).toBe(true);
    expect(
      createTriggerRegistry([
        {
          ...atTrigger,
          occurrenceDerivation: {
            kind: "schedule",
            inputs,
          } as TriggerDescriptor["occurrenceDerivation"],
        },
      ]).ok,
    ).toBe(true);
  });

  it("Error: descriptor 최상위의 자기 키 __proto__ 는 일반 속성으로 저장되고 저장 descriptor 의 프로토타입은 바뀌지 않는다 (test_SC021_top_level_own_proto_key_stored_as_plain_property)", () => {
    // JSON.parse 로 만든 자기 키 "__proto__" 위에 descriptor 필드를 합친다.
    const descriptor = Object.assign(
      JSON.parse('{"__proto__":{"injected":true}}') as Record<string, unknown>,
      probeTaskType(),
    );
    expect(Object.prototype.hasOwnProperty.call(descriptor, "__proto__")).toBe(true);
    const built = createTaskTypeRegistry([descriptor as unknown as TaskTypeDescriptor]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const stored = built.value.get("probe_extension", 1);
    if (stored === undefined) throw new Error("expected stored descriptor");
    expect(Object.getPrototypeOf(stored)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(stored, "__proto__")).toBe(true);
    expect("injected" in stored).toBe(false);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(stored, "__proto__")?.value).toEqual({ injected: true });
  });
});
