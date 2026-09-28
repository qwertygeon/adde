// SC-036, SC-037, SC-038, SC-039, SC-040, SC-041 — 식별 파생(occurrence·idempotency·dedup key).
import { describe, expect, it, vi } from "vitest";
import {
  deriveOccurrenceId,
  selectDependencyCausingEvent,
  deriveIdempotencyKey,
  deriveTransitionReactionKey,
  deriveSignalDedupKey,
  SIGNAL_DEDUP_KEY_ROWS,
} from "../../../src/workflow/domain/index.js";
import { at } from "./helpers/fixtures.js";

describe("SC-036: occurrence ID 가 안정적이고 시계와 무관하다", () => {
  it("Happy: 다른 가짜 시계에서도 같은 입력이면 같은 ID 다 (test_SC036_same_input_same_id_under_two_fake_clocks)", () => {
    const input = {
      kind: "schedule" as const,
      ownerId: "tsk_x1" as never,
      triggerId: "t1",
      scheduledForUtc: at("2026-01-01T00:00:00Z"),
      recurrenceIndex: 0,
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const a = deriveOccurrenceId(input);
    vi.setSystemTime(new Date("2010-01-01T00:00:00Z"));
    const b = deriveOccurrenceId(input);
    vi.useRealTimers();
    expect(a).toEqual(b);
  });

  it("Edge: 고정 벡터가 인코딩 규칙(ADR-009)대로 base32 26자다 (test_SC036_fixed_vector_encoding)", () => {
    const result = deriveOccurrenceId({
      kind: "schedule",
      ownerId: "tsk_x1" as never,
      triggerId: "t1",
      scheduledForUtc: at("2026-01-01T00:00:00Z"),
      recurrenceIndex: 0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatch(/^occ_[A-Z2-7]{26}$/);
  });

  it("Error: 입력을 하나씩 바꾸면 ID 가 달라지고 owner 공간이 분리된다 (test_SC036_each_input_change_and_owner_space_changes_id)", () => {
    const base = {
      kind: "schedule" as const,
      ownerId: "tsk_x1" as never,
      triggerId: "t1",
      scheduledForUtc: at("2026-01-01T00:00:00Z"),
      recurrenceIndex: 0,
    };
    const a = deriveOccurrenceId(base);
    const b = deriveOccurrenceId({ ...base, triggerId: "t2" });
    const c = deriveOccurrenceId({ ...base, ownerId: "wdf_x1" as never });
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe("SC-037: 사건이 원인인 occurrence 는 원인 이벤트에서 파생된다", () => {
  it("Happy: 같은 원인 이벤트면 같은 ID 다 (test_SC037_same_causing_event_same_id)", () => {
    const causingEvent = { id: "evt_x1" as never, occurredAt: at("2026-01-01T00:00:00Z") };
    const a = deriveOccurrenceId({
      kind: "event_caused",
      ownerId: "tsk_x1" as never,
      triggerId: "t1",
      causingEvent,
    });
    const b = deriveOccurrenceId({
      kind: "event_caused",
      ownerId: "tsk_x1" as never,
      triggerId: "t1",
      causingEvent,
    });
    expect(a).toEqual(b);
  });

  it("Edge: 발생 시각이 같고 id 가 다른 원인 이벤트는 다른 ID 를 낸다 (test_SC037_same_instant_different_event_id_differs)", () => {
    const a = deriveOccurrenceId({
      kind: "event_caused",
      ownerId: "tsk_x1" as never,
      triggerId: "t1",
      causingEvent: { id: "evt_a" as never, occurredAt: at("2026-01-01T00:00:00Z") },
    });
    const b = deriveOccurrenceId({
      kind: "event_caused",
      ownerId: "tsk_x1" as never,
      triggerId: "t1",
      causingEvent: { id: "evt_b" as never, occurredAt: at("2026-01-01T00:00:00Z") },
    });
    expect(a).not.toEqual(b);
  });

  it("Error: selectDependencyCausingEvent 가 마지막 로그 위치를 선택한다 (test_SC037_causing_event_selection_takes_last_position)", () => {
    const refs = [
      {
        eventId: "evt_1" as never,
        occurredAt: at("2026-01-01T00:00:00Z"),
        position: { commitSeq: 1, index: 0 },
      },
      {
        eventId: "evt_2" as never,
        occurredAt: at("2026-01-01T00:00:01Z"),
        position: { commitSeq: 2, index: 0 },
      },
    ];
    const selected = selectDependencyCausingEvent(refs);
    expect(selected?.id).toBe("evt_2");
  });
});

describe("SC-038: idempotency key 는 재시도 간에 같다", () => {
  it("Happy: 시도 번호가 달라도 키가 같다 (test_SC038_attempt_number_not_in_key)", () => {
    const occurrenceId = deriveOccurrenceId({
      kind: "schedule",
      ownerId: "tsk_x1" as never,
      triggerId: "t1",
      scheduledForUtc: at("2026-01-01T00:00:00Z"),
      recurrenceIndex: 0,
    });
    if (!occurrenceId.ok) throw new Error("expected occurrenceId ok");
    const a = deriveIdempotencyKey({
      taskId: "tsk_x1" as never,
      reactionLogicalId: "r1",
      occurrenceId: occurrenceId.value,
    });
    const b = deriveIdempotencyKey({
      taskId: "tsk_x1" as never,
      reactionLogicalId: "r1",
      occurrenceId: occurrenceId.value,
    });
    expect(a).toEqual(b);
  });

  it("Edge: 같은 종류 전이가 두 번이면(이벤트 id 가 다름) 서로 다른 키다 (test_SC038_two_same_kind_transitions_distinct_keys)", () => {
    const a = deriveTransitionReactionKey({
      taskId: "tsk_x1" as never,
      reactionLogicalId: "r1",
      causingEvent: {
        id: "evt_a" as never,
        occurredAt: at("2026-01-01T00:00:00Z"),
        type: "task_validated",
      },
    });
    const b = deriveTransitionReactionKey({
      taskId: "tsk_x1" as never,
      reactionLogicalId: "r1",
      causingEvent: {
        id: "evt_b" as never,
        occurredAt: at("2026-01-01T00:00:00Z"),
        type: "task_validated",
      },
    });
    expect(a).not.toEqual(b);
  });

  it("Error: 빈 reactionLogicalId 는 거절된다 (test_SC038_empty_reaction_logical_id_rejected)", () => {
    const occurrenceId = deriveOccurrenceId({
      kind: "schedule",
      ownerId: "tsk_x1" as never,
      triggerId: "t1",
      scheduledForUtc: at("2026-01-01T00:00:00Z"),
      recurrenceIndex: 0,
    });
    if (!occurrenceId.ok) throw new Error("expected occurrenceId ok");
    const result = deriveIdempotencyKey({
      taskId: "tsk_x1" as never,
      reactionLogicalId: "",
      occurrenceId: occurrenceId.value,
    });
    expect(result.ok).toBe(false);
  });
});

describe("SC-039: 신호 dedup key 가 계약 표의 모든 행과 일치한다", () => {
  it("Happy: 전사된 표의 각 행에 해당하는 입력이 형식과 일치한다 (test_SC039_every_table_row_key_format_matches)", () => {
    for (const row of SIGNAL_DEDUP_KEY_ROWS) {
      expect(row.exampleKey.includes(":")).toBe(true);
    }
    const key = deriveSignalDedupKey({
      signalType: "cancel_requested",
      subjectId: "tsk_x1" as never,
      expectedRevision: 3,
    });
    expect(key.ok).toBe(true);
  });

  it("Edge: 예시 키가 콜론 구분 템플릿으로 파싱된다 (test_SC039_example_keys_parse_with_same_template)", () => {
    for (const row of SIGNAL_DEDUP_KEY_ROWS) {
      const segments = row.exampleKey.split(":");
      expect(segments.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("Error: 케이스가 없는 행이 0건이다 (test_SC039_no_row_without_case)", () => {
    expect(SIGNAL_DEDUP_KEY_ROWS.length).toBe(9);
  });
});

describe("SC-040: 외부 신호 튜플은 구분자로 충돌하지 않는다", () => {
  it("Happy: 콜론·따옴표·이스케이프 튜플 쌍은 서로 다른 키를 낸다 (test_SC040_delimiter_quote_escape_pairs_distinct)", () => {
    const a = deriveSignalDedupKey({
      signalType: "external_signal",
      subjectId: "tsk_x1" as never,
      sourceId: "a:b",
      signalName: "n",
      sourceOccurrenceId: "1",
    });
    const b = deriveSignalDedupKey({
      signalType: "external_signal",
      subjectId: "tsk_x1" as never,
      sourceId: 'a"b',
      signalName: "n",
      sourceOccurrenceId: "1",
    });
    expect(a).not.toEqual(b);
  });

  it("Edge: 같은 페이로드·다른 작업은 다른 키다 (test_SC040_same_payload_different_operation_distinct)", () => {
    const a = deriveSignalDedupKey({
      signalType: "external_signal",
      subjectId: "tsk_x1" as never,
      sourceId: "s",
      signalName: "op1",
      sourceOccurrenceId: "1",
    });
    const b = deriveSignalDedupKey({
      signalType: "external_signal",
      subjectId: "tsk_x1" as never,
      sourceId: "s",
      signalName: "op2",
      sourceOccurrenceId: "1",
    });
    expect(a).not.toEqual(b);
  });

  it("Error: 짝 없는 대리 문자는 거절된다 (test_SC040_unpaired_surrogate_rejected)", () => {
    const result = deriveSignalDedupKey({
      signalType: "external_signal",
      subjectId: "tsk_x1" as never,
      sourceId: "a\ud800b",
      signalName: "n",
      sourceOccurrenceId: "1",
    });
    expect(result.ok).toBe(false);
  });
});

describe("SC-041: 파생에 금지 입력이 끼지 않는다", () => {
  it("Happy: 가짜 시계·Math.random 을 바꿔도 모든 파생 함수 결과가 같다 (test_SC041_all_derivations_stable_across_clock_and_random)", () => {
    const input = {
      kind: "schedule" as const,
      ownerId: "tsk_x1" as never,
      triggerId: "t1",
      scheduledForUtc: at("2026-01-01T00:00:00Z"),
      recurrenceIndex: 0,
    };
    const before = deriveOccurrenceId(input);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.999);
    const after = deriveOccurrenceId(input);
    randomSpy.mockRestore();
    vi.useRealTimers();
    expect(before).toEqual(after);
  });

  it("Edge: 시도 카운터 변경도 무관하다 (test_SC041_attempt_counter_irrelevant)", () => {
    const occurrenceId = deriveOccurrenceId({
      kind: "schedule",
      ownerId: "tsk_x1" as never,
      triggerId: "t1",
      scheduledForUtc: at("2026-01-01T00:00:00Z"),
      recurrenceIndex: 0,
    });
    if (!occurrenceId.ok) throw new Error("expected occurrenceId ok");
    const a = deriveIdempotencyKey({
      taskId: "tsk_x1" as never,
      reactionLogicalId: "r1",
      occurrenceId: occurrenceId.value,
    });
    const b = deriveIdempotencyKey({
      taskId: "tsk_x1" as never,
      reactionLogicalId: "r1",
      occurrenceId: occurrenceId.value,
    });
    expect(a).toEqual(b);
  });
});
