// cancel_task 취소 출처 — cancel_work 와 같은 명령 규칙(모르는 키 거절·파서·종류 허용·vault 는 사람·meta 출처 일치).
import { describe, expect, it } from "vitest";
import {
  evaluateCompletion,
  executeCommand,
  memberSnapshots,
  nextEntityId,
  parseCancelOrigin,
} from "../../../src/workflow/domain/index.js";
import type {
  ActorSource,
  CancelOrigin,
  CommandOutcome,
  DomainDeps,
  TaskId,
  TaskStateName,
  WorkAggregate,
} from "../../../src/workflow/domain/index.js";
import { at, meta, reachTaskState, requireTaskFor } from "./helpers/fixtures.js";
import { payloadOf } from "./helpers/commits.js";

const NOW = at("2026-01-01T00:00:00Z");

interface Fixture {
  readonly deps: DomainDeps;
  readonly aggregate: WorkAggregate;
  readonly taskId: TaskId;
}

function fixture(state: TaskStateName): Fixture {
  return reachTaskState(state);
}

/** 형 검사를 거치지 않은 호출자 출처 값으로 cancel_task 를 실행한다. */
function cancel(f: Fixture, origin: unknown, actorSource: ActorSource): CommandOutcome {
  return executeCommand(f.deps, f.aggregate, {
    kind: "cancel_task",
    taskId: f.taskId,
    expectedRevision: requireTaskFor(f.aggregate, f.taskId).revision,
    meta: meta(NOW, actorSource),
    origin: origin as CancelOrigin,
  });
}

function vault(f: Fixture, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "vault_signal",
    actorSource: "human_local",
    signalId: nextEntityId(f.deps.ids, "signal"),
    ...extra,
  };
}

function controlRequest(f: Fixture, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "control_request",
    actorSource: "unknown",
    controlRequestId: nextEntityId(f.deps.ids, "controlRequest"),
    keyId: "fixture-key",
    ...extra,
  };
}

function invalid(detail: string): CommandOutcome {
  return { kind: "rejected", rejection: { reason: "invalid_input", detail } };
}

function committedAggregate(outcome: CommandOutcome): WorkAggregate {
  if (outcome.kind !== "committed") throw new Error(`expected committed, got ${outcome.kind}`);
  return outcome.aggregate;
}

describe("SC-026: cancel_task 출처는 명령 meta 출처와 같아야 한다", () => {
  it("Happy: meta unknown 에 vault_signal(human_local) 출처는 커밋 없이 거절된다 (test_SC026_meta_unknown_vault_human_rejected)", () => {
    const f = fixture("READY");
    const outcome = cancel(f, vault(f), "unknown");
    expect(outcome).toEqual(invalid("cancel_origin_actor_source_mismatch"));
    expect(requireTaskFor(f.aggregate, f.taskId).state).toBe("READY");
  });

  it("Edge: meta human_local 에 인증 형태를 갖춘 control_request 출처는 출처 불일치로 거절된다 (test_SC026_meta_human_control_request_rejected)", () => {
    const f = fixture("READY");
    expect(cancel(f, controlRequest(f), "human_local")).toEqual(
      invalid("cancel_origin_actor_source_mismatch"),
    );
  });

  it("Error: 대조 — meta human_local 에 vault 출처는 CANCELED 로 커밋된다 (test_SC026_matching_sources_cancel)", () => {
    const f = fixture("READY");
    const after = committedAggregate(cancel(f, vault(f), "human_local"));
    expect(requireTaskFor(after, f.taskId).state).toBe("CANCELED");
  });
});

describe("SC-027: 연쇄 전용·열거 밖 종류는 명령 경로에서 거절된다", () => {
  it("Happy: 위조 work_cascade 출처는 거절된다 (test_SC027_work_cascade_origin_rejected)", () => {
    const f = fixture("READY");
    const origin = { kind: "work_cascade", actorSource: "adde_self", workEventId: "evt_forged1" };
    expect(parseCancelOrigin(origin).ok).toBe(true);
    expect(cancel(f, origin, "adde_self")).toEqual(invalid("cancel_origin_kind_not_allowed"));
  });

  it("Edge: 위조 replan_dropped 출처는 거절된다 (test_SC027_replan_dropped_origin_rejected)", () => {
    const f = fixture("READY");
    const origin = { kind: "replan_dropped", actorSource: "adde_self", workEventId: "evt_forged2" };
    expect(parseCancelOrigin(origin).ok).toBe(true);
    expect(cancel(f, origin, "adde_self")).toEqual(invalid("cancel_origin_kind_not_allowed"));
  });

  it("Error: 열거 밖 종류 admin 은 출처 파싱 실패로 거절된다 (test_SC027_unknown_kind_rejected)", () => {
    const f = fixture("READY");
    expect(cancel(f, { kind: "admin", actorSource: "human_local" }, "human_local")).toEqual(
      invalid("cancel_origin_invalid"),
    );
  });
});

describe("SC-028: control_request 출처는 정의 제어와 같은 인증 형태여야 한다", () => {
  it("Happy: 빈 keyId 는 거절된다 (test_SC028_empty_key_id_rejected)", () => {
    const f = fixture("READY");
    expect(cancel(f, controlRequest(f, { keyId: "" }), "unknown")).toEqual(
      invalid("cancel_origin_invalid"),
    );
  });

  it("Edge: ctl_ 형식이 아닌 요청 ID·keyId 누락은 거절된다 (test_SC028_bad_request_id_or_missing_key_rejected)", () => {
    const f = fixture("READY");
    expect(cancel(f, controlRequest(f, { controlRequestId: "req_1" }), "unknown")).toEqual(
      invalid("cancel_origin_invalid"),
    );
    const missingKey = controlRequest(f);
    delete missingKey["keyId"];
    expect(cancel(f, missingKey, "unknown")).toEqual(invalid("cancel_origin_invalid"));
  });

  it("Error: 출처가 unknown 이 아닌 제어 요청은 거절된다 (test_SC028_non_unknown_control_request_rejected)", () => {
    const f = fixture("READY");
    expect(cancel(f, controlRequest(f, { actorSource: "human_local" }), "human_local")).toEqual(
      invalid("cancel_origin_invalid"),
    );
  });
});

describe("SC-029: 취소 기록은 파싱 결과만 싣고 종류 밖 키는 거절한다", () => {
  it("Happy: 확인 대기 Task 에 종류 밖 키 extra 를 단 vault 출처는 거절된다 (test_SC029_out_of_kind_key_rejected)", () => {
    const f = fixture("WAITING_CONFIRMATION");
    expect(cancel(f, vault(f, { extra: 1 }), "human_local")).toEqual(
      invalid("cancel_origin_invalid"),
    );
    expect(requireTaskFor(f.aggregate, f.taskId).state).toBe("WAITING_CONFIRMATION");
  });

  it("Edge: 키 없는 같은 출처는 confirmation_cancelled 에 호출자와 다른 참조의 파싱 결과로 실린다 (test_SC029_confirmation_cancel_records_parsed_copy)", () => {
    const f = fixture("WAITING_CONFIRMATION");
    const origin = vault(f);
    const outcome = cancel(f, origin, "human_local");
    if (outcome.kind !== "committed") throw new Error(`expected committed, got ${outcome.kind}`);
    const recorded = payloadOf(outcome.commit, "confirmation_cancelled")["origin"];
    expect(recorded).toEqual(origin);
    expect(recorded).not.toBe(origin);
    expect(Object.isFrozen(recorded)).toBe(true);
    origin["signalId"] = "sig_changedlater";
    expect((recorded as Record<string, unknown>)["signalId"]).not.toBe("sig_changedlater");
  });

  it("Error: 다른 종류 전용 필드(keyId)를 단 vault 출처는 거절된다 (test_SC029_other_kind_field_rejected)", () => {
    const f = fixture("WAITING_CONFIRMATION");
    expect(cancel(f, vault(f, { keyId: "fixture-key" }), "human_local")).toEqual(
      invalid("cancel_origin_invalid"),
    );
  });

  it("Edge: 공개 파서는 모르는 키를 버리고 성공하지만 명령 규칙은 거절한다 (test_SC029_public_parser_drops_key_command_rejects)", () => {
    const f = fixture("READY");
    const origin = vault(f, { extra: "dropped by parser" });
    const parsed = parseCancelOrigin(origin);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).not.toHaveProperty("extra");
    expect(cancel(f, origin, "human_local")).toEqual(invalid("cancel_origin_invalid"));
  });
});

describe("SC-030: 제어 요청 취소는 기록되고 완료 정책은 사람 vault 취소만 철회로 센다", () => {
  it("Happy: meta unknown 의 유효 제어 요청 취소는 task_canceled 에 control_request 출처로 기록된다 (test_SC030_control_request_cancel_recorded)", () => {
    const f = fixture("READY");
    expect(requireTaskFor(f.aggregate, f.taskId).policy.terminalRequired).toBe(true);
    const outcome = cancel(f, controlRequest(f), "unknown");
    if (outcome.kind !== "committed") throw new Error(`expected committed, got ${outcome.kind}`);
    const origin = payloadOf(outcome.commit, "task_canceled")["origin"] as Record<string, unknown>;
    expect(origin["kind"]).toBe("control_request");
    expect(origin["actorSource"]).toBe("unknown");
  });

  it("Edge: 같은 커밋을 적용한 Work 의 완료 평가는 그 member 를 철회로 세지 않는다 (test_SC030_completion_not_withdrawal)", () => {
    const f = fixture("READY");
    const after = committedAggregate(cancel(f, controlRequest(f), "unknown"));
    const evaluation = evaluateCompletion({
      ownedTasks: memberSnapshots(after),
      memberTaskIds: after.work.memberTaskIds,
    });
    expect(evaluation.withdrawnTaskIds).toEqual([]);
    expect(evaluation.unsatisfiedRequiredTaskIds).toEqual([f.taskId]);
    expect(evaluation.completed).toBe(false);
  });

  it("Error: 대조 — meta human_local 의 vault 사람 취소는 철회로 센다 (test_SC030_vault_human_cancel_is_withdrawal)", () => {
    const f = fixture("READY");
    const after = committedAggregate(cancel(f, vault(f), "human_local"));
    const evaluation = evaluateCompletion({
      ownedTasks: memberSnapshots(after),
      memberTaskIds: after.work.memberTaskIds,
    });
    expect(evaluation.withdrawnTaskIds).toEqual([f.taskId]);
  });
});
