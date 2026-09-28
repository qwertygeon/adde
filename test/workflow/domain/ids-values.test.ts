// SC-001, SC-002, SC-003 — 식별자·값 타입.
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  parseEntityId,
  parseProjectId,
  nextEntityId,
  parseActorSource,
  parseCancelOrigin,
  parseUtcInstant,
  DomainInvariantError,
  ACTOR_SOURCES,
  CANCEL_ORIGIN_KINDS,
} from "../../../src/workflow/domain/index.js";
import type { TaskId, WorkId, IdGenerator } from "../../../src/workflow/domain/index.js";
import { planned, draft } from "./helpers/fixtures.js";

describe("SC-001: ID 종류 분리·형식 거절", () => {
  it("Happy: 올바른 tsk_ 문자열이 TaskId 로 구성된다 (test_SC001_valid_task_id_constructs)", () => {
    const result = parseEntityId("task", "tsk_abc123");
    expect(result.ok).toBe(true);
  });

  it("Edge: WorkId 는 TaskId 타입에 대입되지 않는다 (test_SC001_work_id_not_assignable_to_task_id_type)", () => {
    const workId = "wrk_x" as unknown as WorkId;
    // @ts-expect-error -- WorkId 는 TaskId 브랜드가 아니라 대입이 타입 오류가 되어야 한다.
    const taskId: TaskId = workId;
    expectTypeOf<TaskId>().not.toEqualTypeOf<WorkId>();
    void taskId;
  });

  it("Edge: 본문 64자 경계는 통과, 65자는 거절된다 (test_SC001_body_length_64_boundary)", () => {
    const ok64 = parseEntityId("task", `tsk_${"a".repeat(64)}`);
    const fail65 = parseEntityId("task", `tsk_${"a".repeat(65)}`);
    expect(ok64.ok).toBe(true);
    expect(fail65.ok).toBe(false);
  });

  it("Error: 접두사 오류·빈 본문·콜론 포함은 거절된다 (test_SC001_wrong_prefix_empty_body_colon_rejected)", () => {
    expect(parseEntityId("task", "wrk_abc").ok).toBe(false);
    expect(parseEntityId("task", "tsk_").ok).toBe(false);
    expect(parseEntityId("task", "tsk_a:b").ok).toBe(false);
    expect(parseProjectId("not_a_project").ok).toBe(false);
  });
});

describe("SC-002: 생성형 ID 는 주입된 생성기에서만 온다", () => {
  it("Happy: 같은 시드 생성기 두 개로 같은 명령열을 적용하면 커밋 JSON 이 바이트 단위로 같다(test_SC002_same_seed_generators_yield_identical_commits)", () => {
    const a = planned([draft("t1")], {
      ids: makeCountingGenerator("seedA"),
      operationalDefaults: { agentDispatchDeadlineMs: 600_000 },
    });
    const b = planned([draft("t1")], {
      ids: makeCountingGenerator("seedA"),
      operationalDefaults: { agentDispatchDeadlineMs: 600_000 },
    });
    expect(JSON.stringify(a.aggregate)).toBe(JSON.stringify(b.aggregate));
  });

  it("Edge: 생성기 시드가 다르면 ID 만 달라진다 (test_SC002_different_seed_changes_ids_only)", () => {
    const a = planned([draft("t1")], {
      ids: makeCountingGenerator("seedA"),
      operationalDefaults: { agentDispatchDeadlineMs: 600_000 },
    });
    const b = planned([draft("t1")], {
      ids: makeCountingGenerator("seedB"),
      operationalDefaults: { agentDispatchDeadlineMs: 600_000 },
    });
    expect(a.aggregate.work.id).not.toBe(b.aggregate.work.id);
  });

  it("Error: 생성기가 형식 위반 ID 를 내면 DomainInvariantError 를 던진다 (test_SC002_malformed_generator_output_throws_invariant_error)", () => {
    const badGenerator: IdGenerator = { next: () => "not-a-valid-id" };
    expect(() => nextEntityId(badGenerator, "task")).toThrow(DomainInvariantError);
  });
});

function makeCountingGenerator(seed: string): IdGenerator {
  let n = 0;
  return {
    next: (kind) => {
      n += 1;
      const prefixes: Record<string, string> = {
        work: "wrk_",
        workDefinition: "wdf_",
        planProposal: "pln_",
        task: "tsk_",
        result: "res_",
        reaction: "rct_",
        signal: "sig_",
        event: "evt_",
        attempt: "att_",
        confirmation: "cfm_",
        decision: "dec_",
        dispatch: "dsp_",
        controlRequest: "ctl_",
        commit: "cmt_",
      };
      return `${prefixes[kind]}${seed}${String(n).padStart(6, "0")}`;
    },
  };
}

describe("SC-003: 값 타입이 계약 정의와 일치하고 정의 밖 값은 거절된다", () => {
  it("Happy: 전사된 ActorSource·CancelOriginKind 전부가 구성된다 (test_SC003_all_transcribed_actor_sources_and_cancel_kinds_construct)", () => {
    for (const source of ACTOR_SOURCES) {
      expect(parseActorSource(source).ok).toBe(true);
    }
    for (const kind of CANCEL_ORIGIN_KINDS) {
      if (kind === "control_request") {
        expect(
          parseCancelOrigin({ kind, actorSource: "unknown", controlRequestId: "ctl_x1" }).ok,
        ).toBe(true);
      } else if (kind === "vault_signal") {
        expect(parseCancelOrigin({ kind, actorSource: "human_local", signalId: "sig_x1" }).ok).toBe(
          true,
        );
      } else {
        expect(
          parseCancelOrigin({ kind, actorSource: "adde_self", workEventId: "evt_x1" }).ok,
        ).toBe(true);
      }
    }
  });

  it("Edge: 소수 1~3자리는 정규화되고 +00:00 오프셋은 거절된다 (test_SC003_fraction_normalized_and_plus_zero_offset_rejected)", () => {
    const oneDigit = parseUtcInstant("2026-01-01T00:00:00.5Z");
    expect(oneDigit.ok).toBe(true);
    if (oneDigit.ok) expect(oneDigit.value).toMatch(/^2026-01-01T00:00:00\.\d{3}Z$/);
    expect(parseUtcInstant("2026-01-01T00:00:00+00:00").ok).toBe(false);
  });

  it("Error: 목록 밖 값·+09:00 오프셋·달력 무효 시각은 거절된다 (test_SC003_unknown_value_offset_and_invalid_calendar_rejected)", () => {
    expect(parseActorSource("not_a_source").ok).toBe(false);
    expect(parseUtcInstant("2026-01-01T00:00:00+09:00").ok).toBe(false);
    expect(parseUtcInstant("2026-02-30T00:00:00Z").ok).toBe(false);
  });
});
