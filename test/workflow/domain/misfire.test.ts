// SC-046, SC-047, SC-048 — Task Trigger 지연 발화 정책·occurrence ID 의 시각 독립·사건 원인 제외.
import { describe, expect, it } from "vitest";
import {
  decideTaskTriggerMisfire,
  deriveOccurrenceId,
} from "../../../src/workflow/domain/index.js";
import type { MisfirePolicy, TriggerSpec, UtcInstant } from "../../../src/workflow/domain/index.js";
import { at, entityId, mustOk } from "./helpers/fixtures.js";
import { testRegistries } from "./helpers/registry-fixtures.js";

const TRIGGERS = testRegistries().triggers;
const TASK_ID = entityId("task", "tsk_misfire0001");
const SCHEDULED = at("2026-01-01T00:00:00Z");
const LATE = at("2026-01-01T06:00:00Z");
const LATER = at("2026-01-02T00:00:00Z");
const EARLY = at("2025-12-31T23:00:00Z");

function atTrigger(misfire: MisfirePolicy): TriggerSpec {
  return {
    kind: "at",
    version: 1,
    triggerId: "nightly",
    scheduledForUtc: SCHEDULED,
    timezone: "Asia/Seoul",
    expressionText: "midnight",
    misfire,
  };
}

function afterTrigger(misfire: MisfirePolicy): TriggerSpec {
  return {
    kind: "after",
    version: 1,
    triggerId: "delay",
    durationMs: 60_000,
    scheduledForUtc: SCHEDULED,
    misfire,
  };
}

function scheduleId(triggerId: string) {
  return mustOk(
    deriveOccurrenceId({
      kind: "schedule",
      ownerId: TASK_ID,
      triggerId,
      scheduledForUtc: SCHEDULED,
      recurrenceIndex: 0,
    }),
  );
}

function eventCausedId(triggerId: string) {
  return mustOk(
    deriveOccurrenceId({
      kind: "event_caused",
      ownerId: TASK_ID,
      triggerId,
      causingEvent: { id: entityId("event", "evt_cause0001"), occurredAt: SCHEDULED },
    }),
  );
}

function decide(trigger: TriggerSpec, now: UtcInstant) {
  return decideTaskTriggerMisfire(TRIGGERS, {
    taskId: TASK_ID,
    trigger,
    occurrence: { kind: "schedule" },
    now,
  });
}

describe("SC-046: Task Trigger 의 지연 발화가 정책대로 처리된다", () => {
  it("Happy: fire_once_now 는 원 예약 시각의 occurrence 로 한 번 발화한다 (test_SC046_fire_once_now_original_instant)", () => {
    expect(decide(atTrigger({ kind: "fire_once_now" }), LATE)).toEqual({
      ok: true,
      value: {
        kind: "fire",
        occurrenceId: scheduleId("nightly"),
        policyApplied: true,
        scheduledForUtc: SCHEDULED,
      },
    });
  });

  it("Edge: skip 은 같은 ID 로 건너뛰고 catch_up_bounded 1 은 발화한다 (test_SC046_skip_and_catch_up)", () => {
    expect(decide(atTrigger({ kind: "skip" }), LATE)).toEqual({
      ok: true,
      value: { kind: "skip", occurrenceId: scheduleId("nightly"), scheduledForUtc: SCHEDULED },
    });
    const caught = decide(atTrigger({ kind: "catch_up_bounded", maxCatchUp: 1 }), LATE);
    expect(caught.ok && caught.value.kind).toBe("fire");
  });

  it("Error: 따라잡기 상한 0 은 건너뛰기, 예약 전이면 not_due 다 (test_SC046_catch_up_zero_skip_and_not_due)", () => {
    const zero = decide(atTrigger({ kind: "catch_up_bounded", maxCatchUp: 0 }), LATE);
    expect(zero.ok && zero.value.kind).toBe("skip");
    expect(decide(atTrigger({ kind: "fire_once_now" }), EARLY)).toEqual({
      ok: true,
      value: { kind: "not_due", occurrenceId: scheduleId("nightly"), scheduledForUtc: SCHEDULED },
    });
  });
});

describe("SC-047: 지연 발화 occurrence ID 에 현재 시각이 끼지 않는다", () => {
  it("Happy: 같은 Trigger 를 다른 현재 시각에 판정해도 ID 가 같다 (test_SC047_same_id_for_different_now)", () => {
    const first = decide(atTrigger({ kind: "fire_once_now" }), LATE);
    const second = decide(atTrigger({ kind: "fire_once_now" }), LATER);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.occurrenceId).toBe(second.value.occurrenceId);
  });

  it("Edge: after Trigger 도 같다 (test_SC047_after_trigger_same_id)", () => {
    const first = decide(afterTrigger({ kind: "skip" }), LATE);
    const second = decide(afterTrigger({ kind: "skip" }), LATER);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.occurrenceId).toBe(second.value.occurrenceId);
  });

  it("Error: 결과 ID 는 현재 시각 없는 파생 함수 직접 호출 값과 같다 (test_SC047_id_equals_direct_derivation)", () => {
    for (const [trigger, triggerId] of [
      [atTrigger({ kind: "fire_once_now" }), "nightly"],
      [afterTrigger({ kind: "fire_once_now" }), "delay"],
    ] as const) {
      const result = decide(trigger, LATER);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.occurrenceId).toBe(scheduleId(triggerId));
    }
  });
});

describe("SC-048: 사건이 원인인 occurrence 는 지연 발화 정책을 거치지 않는다", () => {
  it("Happy: 의존 충족 occurrence 는 정책 없이 발화한다 (test_SC048_dependency_occurrence_fires_without_policy)", () => {
    const occurrenceId = eventCausedId("deps");
    expect(
      decideTaskTriggerMisfire(TRIGGERS, {
        taskId: TASK_ID,
        trigger: { kind: "dependencies_complete", version: 1, triggerId: "deps" },
        occurrence: { kind: "event_caused", occurrenceId },
        now: LATER,
      }),
    ).toEqual({ ok: true, value: { kind: "fire", occurrenceId, policyApplied: false } });
  });

  it("Edge: skip 정책 Trigger 의 실행 재시도 occurrence 도 정책 없이 발화한다 (test_SC048_execution_retry_occurrence_fires_without_policy)", () => {
    const occurrenceId = eventCausedId("delay");
    const result = decideTaskTriggerMisfire(TRIGGERS, {
      taskId: TASK_ID,
      trigger: afterTrigger({ kind: "skip" }),
      occurrence: { kind: "event_caused", occurrenceId },
      now: LATER,
    });
    expect(result).toEqual({
      ok: true,
      value: { kind: "fire", occurrenceId, policyApplied: false },
    });
  });

  it("Error: 예약 occurrence 를 예약 파생이 아닌 Trigger 에 쓰면 오류다 (test_SC048_schedule_occurrence_on_non_schedule_trigger_error)", () => {
    expect(
      decideTaskTriggerMisfire(TRIGGERS, {
        taskId: TASK_ID,
        trigger: { kind: "immediate", version: 1, triggerId: "now" },
        occurrence: { kind: "schedule" },
        now: LATER,
      }),
    ).toEqual({ ok: false, error: { kind: "not_schedule_trigger" } });
    expect(
      decideTaskTriggerMisfire(TRIGGERS, {
        taskId: TASK_ID,
        trigger: { ...atTrigger({ kind: "skip" }), version: 2 } as unknown as TriggerSpec,
        occurrence: { kind: "schedule" },
        now: LATER,
      }),
    ).toEqual({ ok: false, error: { kind: "trigger_descriptor_unknown" } });
  });
});
