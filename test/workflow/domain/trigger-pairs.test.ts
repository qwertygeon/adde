// Trigger descriptor 의 발화 방식 ↔ occurrence 파생 짝 검사.
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  BUILTIN_TRIGGERS,
  FIRING_OCCURRENCE_DERIVATION,
  createBuiltinRegistries,
  createTriggerRegistry,
} from "../../../src/workflow/domain/index.js";
import type {
  FiringMode,
  OccurrenceDerivationDeclaration,
  TriggerDescriptor,
} from "../../../src/workflow/domain/index.js";

/** 짝 검사 전용 시험 descriptor — 내장 종류와 겹치지 않는 kind. */
function pairDescriptor(
  kind: string,
  firing: FiringMode,
  derivation: OccurrenceDerivationDeclaration,
): TriggerDescriptor {
  return {
    kind,
    version: 1,
    title: `Pair ${kind}`,
    schema: z.strictObject({
      kind: z.literal(kind),
      version: z.literal(1),
      triggerId: z.string().min(1),
    }),
    firing,
    occurrenceDerivation: derivation,
  };
}

describe("SC-051: Trigger 발화 방식과 occurrence 파생의 짝", () => {
  it("Happy: 내장 다섯 종으로 등록부가 구성되고 각 짝이 표와 맞는다 (test_SC051_builtin_triggers_construct)", () => {
    expect(BUILTIN_TRIGGERS).toHaveLength(5);
    expect(createBuiltinRegistries({ taskTypes: [] }).ok).toBe(true);
    for (const trigger of BUILTIN_TRIGGERS) {
      expect(trigger.occurrenceDerivation.kind, trigger.kind).toBe(
        FIRING_OCCURRENCE_DERIVATION[trigger.firing],
      );
    }
  });

  it("Edge: 다른 허용 짝의 시험 descriptor 도 구성된다 (test_SC051_other_allowed_pairs_construct)", () => {
    const allowed = [
      pairDescriptor("pair_ready", "on_ready", { kind: "none" }),
      pairDescriptor("pair_schedule", "schedule", { kind: "schedule", inputs: ["ownerId"] }),
      pairDescriptor("pair_deps", "dependencies_satisfied", {
        kind: "event_caused",
        inputs: ["ownerId"],
      }),
      pairDescriptor("pair_signal", "external_signal", {
        kind: "event_caused",
        inputs: ["ownerId"],
      }),
    ];
    for (const descriptor of allowed) {
      expect(createTriggerRegistry([descriptor]).ok, descriptor.kind).toBe(true);
    }
    expect(FIRING_OCCURRENCE_DERIVATION).toEqual({
      on_ready: "none",
      schedule: "schedule",
      dependencies_satisfied: "event_caused",
      external_signal: "event_caused",
    });
  });

  it("Error: schedule 발화 + event_caused 파생 descriptor 는 firing_derivation_mismatch 로 구성이 실패한다 (test_SC051_schedule_event_caused_pair_fails)", () => {
    const cases: readonly [TriggerDescriptor, FiringMode, string][] = [
      [
        pairDescriptor("pair_bad", "schedule", { kind: "event_caused", inputs: ["ownerId"] }),
        "schedule",
        "event_caused",
      ],
      [
        pairDescriptor("pair_bad_ready", "on_ready", { kind: "schedule", inputs: ["ownerId"] }),
        "on_ready",
        "schedule",
      ],
      [
        pairDescriptor("pair_bad_signal", "external_signal", { kind: "none" }),
        "external_signal",
        "none",
      ],
    ];
    for (const [descriptor, firing, derivation] of cases) {
      expect(createTriggerRegistry([descriptor]), descriptor.kind).toEqual({
        ok: false,
        error: {
          kind: "descriptor_invalid",
          axis: "trigger",
          id: descriptor.kind,
          version: 1,
          defect: { code: "firing_derivation_mismatch", firing, derivation },
        },
      });
    }
  });
});
