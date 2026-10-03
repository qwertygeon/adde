// SC-055 — property: 같은 선언·같은 등록 집합은 순서와 무관하게 같은 검증 결과를 낸다.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  validateTask,
  createDomainRegistries,
  BUILTIN_TASK_TYPES,
  BUILTIN_TRIGGERS,
  BUILTIN_REACTIONS,
} from "../../../../src/workflow/domain/index.js";
import type { DomainRegistries, TaskDeclaration } from "../../../../src/workflow/domain/index.js";
import { basePolicy, at } from "../helpers/fixtures.js";
import {
  GENERIC_TASK_TYPE,
  probeTaskType,
  probeOverridePromptTaskType,
  COMPLETION_NOTIFY_REACTION,
} from "../helpers/registry-fixtures.js";

const ACTOR = { kind: "user", id: "u1" };
const TASK_TYPES = [
  ...BUILTIN_TASK_TYPES,
  GENERIC_TASK_TYPE,
  probeTaskType(),
  probeOverridePromptTaskType(),
];

function registries(reverse: boolean): DomainRegistries {
  const order = <T>(list: readonly T[]) => (reverse ? [...list].reverse() : [...list]);
  const built = createDomainRegistries({
    taskTypes: order(TASK_TYPES),
    triggers: order(BUILTIN_TRIGGERS),
    reactions: order(BUILTIN_REACTIONS),
  });
  if (!built.ok) throw new Error("expected registries");
  return built.value;
}

const FORWARD = registries(false);
const REVERSED = registries(true);

const typeArb = fc.constantFrom(
  { id: "confirmation", version: 1 },
  { id: "notification", version: 1 },
  { id: "agent_goal", version: 1 },
  { id: "probe_override_prompt", version: 1 },
  { id: "probe_extension", version: 1 },
  { id: "probe_missing", version: 1 },
  { id: "generic_task", version: 2 },
);

const inputArb = fc.oneof(
  fc.constant<unknown>("not-an-object"),
  fc.dictionary(
    fc.constantFrom(
      "prompt",
      "targetActor",
      "allowedDecisions",
      "target",
      "message",
      "importance",
      "goal",
      "subject",
      "first",
      "second",
      "unexpected",
    ),
    fc.constantFrom<unknown>("value", 42, ACTOR, ["accept"], "normal", undefined),
    { maxKeys: 6 },
  ),
);

const triggerArb = fc.constantFrom<unknown>(
  { kind: "immediate", version: 1, triggerId: "t" },
  { kind: "immediate", version: 3, triggerId: "t" },
  {
    kind: "at",
    version: 1,
    triggerId: "t",
    scheduledForUtc: at("2026-01-02T00:00:00Z"),
    timezone: "asia/seoul",
    expressionText: "x",
    misfire: { kind: "skip" },
  },
  {
    kind: "at",
    version: 1,
    triggerId: "t",
    scheduledForUtc: at("2026-01-02T00:00:00Z"),
    timezone: "Asia/Seoul",
    expressionText: "x",
    recurrence: { rule: "FREQ=DAILY", anchorUtc: "2026-01-02T00:00:00Z" },
    misfire: { kind: "skip" },
  },
);

const policyArb = fc
  .record({
    approvalSurface: fc.constantFrom<"markdown" | "out_of_band">("markdown", "out_of_band"),
    approvalRequiredBeforeExecute: fc.boolean(),
    eligible: fc.boolean(),
  })
  .map((p) =>
    basePolicy({
      approvalSurface: p.approvalSurface,
      approvalRequiredBeforeExecute: p.approvalRequiredBeforeExecute,
      unattended: { eligible: p.eligible, onGateDenied: "block_awaiting_human" },
    }),
  );

const reactionsArb = fc.constantFrom<unknown>(
  undefined,
  [],
  [COMPLETION_NOTIFY_REACTION],
  [{ ...COMPLETION_NOTIFY_REACTION, version: 2 }],
  [COMPLETION_NOTIFY_REACTION, COMPLETION_NOTIFY_REACTION],
);

const declarationArb = fc
  .record({
    type: typeArb,
    input: inputArb,
    trigger: triggerArb,
    policy: policyArb,
    reactions: reactionsArb,
  })
  .map((d): TaskDeclaration => ({
    type: d.type,
    input: d.input,
    trigger: d.trigger,
    policy: d.policy,
    ...(d.reactions !== undefined ? { reactions: d.reactions } : {}),
  }));

describe("SC-055: property — 검증의 출구·사유·요청이 결정적이다", () => {
  it("test_SC055_property_validation_deterministic_exit_reason_requests", () => {
    fc.assert(
      fc.property(declarationArb, (declaration) => {
        const snapshot = structuredClone(declaration);
        const first = validateTask(FORWARD, declaration);
        expect(validateTask(FORWARD, declaration)).toEqual(first);
        expect(validateTask(REVERSED, declaration)).toEqual(first);
        expect(declaration).toEqual(snapshot);
      }),
    );
  });
});
