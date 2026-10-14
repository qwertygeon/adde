// 관리 Work 파생 상태·중지 뒤 완료·관리 Work 취소 연쇄·취소 출처 검증·재계획 독립.
import { describe, expect, it } from "vitest";
import {
  assembleCommit,
  judgeSignal,
  mkEvent,
  nextEntityId,
} from "../../../src/workflow/domain/index.js";
import type {
  ActorSource,
  CancelOrigin,
  CommandOutcome,
  DecisionSignal,
  DomainCommit,
} from "../../../src/workflow/domain/index.js";
import {
  dayAt,
  definitionDeps,
  payloadsOf,
  registerAndMaterializeFirst,
  registerDefinition,
  typesOf,
  vaultOrigin,
} from "./helpers/definition-fixtures.js";
import { ACTION_AT, STEWARD_MEMBER, reachDefinitionState } from "./helpers/definition-row-cases.js";
import { committedChain, controlRequestCancelOrigin, meta } from "./helpers/fixtures.js";

function commitOfOutcome(outcome: CommandOutcome): DomainCommit {
  if (outcome.kind !== "committed") throw new Error(`expected committed, got ${outcome.kind}`);
  return outcome.commit;
}

/** 필수 member 하나를 둔 관리 Work 와 그 member. */
function stewardWithMember(seed: string) {
  const registered = registerDefinition(definitionDeps(seed), { tasks: STEWARD_MEMBER });
  const memberId = registered.journal.work(registered.stewardId).work.memberTaskIds[0];
  if (memberId === undefined) throw new Error("expected steward member");
  return { ...registered, memberId };
}

describe("SC-016: 정의가 멈추지 않은 관리 Work 는 완료하지 않는다", () => {
  it("Happy: member 가 만족이고 정의가 ACTIVE 면 관리 Work 는 ACTIVE 이고 완료가 없다 (test_SC016_active_definition_keeps_steward_active)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("stw016"));
    expect(journal.work(stewardId).work.state).toBe("ACTIVE");
    const resolved = journal.resolveDue(definitionId, dayAt(0));
    expect(resolved.kind).toBe("committed");
    if (resolved.kind === "committed")
      expect(typesOf(resolved.commit)).not.toContain("work_completed");
    expect(journal.work(stewardId).work.state).toBe("ACTIVE");
  });

  it("Edge: 정의가 PAUSED 여도 관리 Work 는 ACTIVE 다 (test_SC016_paused_definition_keeps_steward_active)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("stw016e"));
    const paused = journal.control(definitionId, "pause", ACTION_AT);
    expect(paused.kind).toBe("accepted");
    if (paused.kind === "accepted") expect(typesOf(paused.commit)).not.toContain("work_completed");
    expect(journal.work(stewardId).work.state).toBe("ACTIVE");
  });

  it("Error: 필수 member 가 FAILED 면 관리 Work 는 BLOCKED 다 (test_SC016_failed_required_member_blocks_steward)", () => {
    const { journal, stewardId, memberId } = stewardWithMember("stw016x");
    journal.failMember(stewardId, memberId, ACTION_AT);
    expect(journal.work(stewardId).work.state).toBe("BLOCKED");
  });
});

describe("SC-017: 정의 중지가 관리 Work 를 완료시키고 중지 출처를 싣는다", () => {
  it("Happy: 노트 중지는 vault_signal·human_local 중지 출처로 완료한다 (test_SC017_vault_stop_completes_with_stop_origin)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("stw017"));
    const stopped = journal.control(definitionId, "stop", ACTION_AT);
    expect(stopped.kind).toBe("accepted");
    if (stopped.kind !== "accepted") return;
    const completed = payloadsOf(stopped.commit, "work_completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.["stopOrigin"]).toMatchObject({
      kind: "vault_signal",
      actorSource: "human_local",
    });
    expect(journal.work(stewardId).work.state).toBe("COMPLETED");
  });

  it("Edge: 제어 요청 중지는 control_request·unknown 중지 출처를 싣는다 (test_SC017_control_request_stop_origin_unknown)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("stw017e"));
    const stopped = journal.control(definitionId, "stop", ACTION_AT, {
      channel: "control_request",
    });
    expect(stopped.kind).toBe("accepted");
    if (stopped.kind !== "accepted") return;
    const origin = payloadsOf(stopped.commit, "work_completed")[0]?.["stopOrigin"] as Record<
      string,
      unknown
    >;
    expect(origin).toMatchObject({
      kind: "control_request",
      actorSource: "unknown",
      keyId: "fixture-key",
    });
    expect(String(origin["controlRequestId"])).toMatch(/^ctl_/);
  });

  it("Error: member 가 불만족(BLOCKED)이면 중지해도 완료하지 않는다 (test_SC017_unsatisfied_steward_not_completed)", () => {
    const { journal, stewardId, definitionId, memberId } = stewardWithMember("stw017x");
    journal.failMember(stewardId, memberId, ACTION_AT);
    const stopped = journal.control(definitionId, "stop", ACTION_AT);
    expect(stopped.kind).toBe("accepted");
    if (stopped.kind === "accepted")
      expect(typesOf(stopped.commit)).not.toContain("work_completed");
    expect(journal.work(stewardId).work.state).toBe("BLOCKED");
  });
});

describe("SC-018: 계획 중에 중지된 관리 Work 는 다음 계획 커밋에서 완료한다", () => {
  it("Happy: PLANNING 관리 Work 는 중지 커밋이 아니라 빈 계획 커밋에서 완료한다 (test_SC018_planning_steward_completes_at_empty_plan_commit)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("stw018"));
    journal.ensurePlanning(stewardId, ACTION_AT);
    const stopped = journal.control(definitionId, "stop", ACTION_AT);
    expect(stopped.kind).toBe("accepted");
    if (stopped.kind === "accepted")
      expect(typesOf(stopped.commit)).not.toContain("work_completed");
    expect(journal.work(stewardId).work.state).toBe("PLANNING");
    const committed = commitOfOutcome(
      journal.commitPlan(
        stewardId,
        journal.replanBase(stewardId, { tasks: [], retain: [] }),
        ACTION_AT,
      ),
    );
    expect(typesOf(committed)).toContain("work_completed");
    expect(journal.work(stewardId).work.state).toBe("COMPLETED");
  });

  it("Edge: 입력 대기 관리 Work 는 입력 뒤 계획 커밋에서 완료한다 (test_SC018_waiting_input_steward_completes_at_next_plan)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("stw018e"));
    journal.ensurePlanning(stewardId, ACTION_AT);
    expect(
      journal.onWork(stewardId, { kind: "request_work_input", requests: [] }, ACTION_AT).kind,
    ).toBe("committed");
    expect(journal.work(stewardId).work.state).toBe("WAITING_INPUT");
    const stopped = journal.control(definitionId, "stop", ACTION_AT);
    expect(stopped.kind).toBe("accepted");
    if (stopped.kind === "accepted")
      expect(typesOf(stopped.commit)).not.toContain("work_completed");
    expect(journal.onWork(stewardId, { kind: "receive_work_input" }, ACTION_AT).kind).toBe(
      "committed",
    );
    const committed = commitOfOutcome(
      journal.commitPlan(
        stewardId,
        journal.replanBase(stewardId, { tasks: [], retain: [] }),
        ACTION_AT,
      ),
    );
    expect(typesOf(committed)).toContain("work_completed");
  });

  it("Error: 비종결 필수 member 를 보존한 계획 커밋은 완료하지 않는다 (test_SC018_retained_required_member_blocks_completion)", () => {
    const { journal, stewardId, definitionId } = stewardWithMember("stw018x");
    journal.ensurePlanning(stewardId, ACTION_AT);
    expect(journal.control(definitionId, "stop", ACTION_AT).kind).toBe("accepted");
    const committed = commitOfOutcome(
      journal.commitPlan(stewardId, journal.replanBase(stewardId), ACTION_AT),
    );
    expect(typesOf(committed)).not.toContain("work_completed");
    expect(journal.work(stewardId).work.state).not.toBe("COMPLETED");
  });
});

describe("SC-019: 관리 Work 취소는 정의를 중지하고 회차 Work 를 남긴다", () => {
  it("Happy: 제어 요청·노트 취소가 같은 커밋에 work_cascade 중지를 붙이고 회차 Work 는 그대로다 (test_SC019_steward_cancel_stops_definition_work_cascade)", () => {
    const channels = ["control_request", "vault"] as const;
    for (const channel of channels) {
      const { journal, stewardId, definitionId, firstWorkId } = registerAndMaterializeFirst(
        definitionDeps(`stw019${channel === "vault" ? "v" : "c"}`),
      );
      const occurrenceBefore = journal.work(firstWorkId);
      const actorSource = channel === "vault" ? "human_local" : "unknown";
      const origin: CancelOrigin =
        channel === "vault" ? vaultOrigin(journal.deps) : controlRequestCancelOrigin(journal.deps);
      const outcome = journal.onWork(stewardId, { kind: "cancel_work", origin }, ACTION_AT, {
        actorSource,
      });
      const commit = commitOfOutcome(outcome);
      const types = typesOf(commit);
      expect(types, channel).toEqual(
        expect.arrayContaining(["work_canceled", "work_definition_stopped"]),
      );
      expect(types.indexOf("work_canceled"), channel).toBeLessThan(
        types.indexOf("work_definition_stopped"),
      );
      const stopOrigin = payloadsOf(commit, "work_definition_stopped")[0]?.["stopOrigin"] as Record<
        string,
        unknown
      >;
      expect(stopOrigin["kind"], channel).toBe("work_cascade");
      expect(stopOrigin["actorSource"], channel).toBe(actorSource);
      if (channel === "vault")
        expect(stopOrigin["signalId"]).toBe((origin as { signalId?: string }).signalId);
      else
        expect(stopOrigin["controlRequestId"]).toBe(
          (origin as { controlRequestId?: string }).controlRequestId,
        );
      expect(journal.definition(definitionId).state, channel).toBe("STOPPED");
      expect(journal.work(firstWorkId), channel).toEqual(occurrenceBefore);
    }
  });

  it("Edge: PAUSED 정의는 취소에 중지가 붙고 이미 STOPPED 인 정의는 붙지 않는다 (test_SC019_paused_and_stopped_definition_cancel)", () => {
    const paused = reachDefinitionState("PAUSED", "stw019p");
    const pausedCommit = commitOfOutcome(paused.journal.cancelWork(paused.workId, ACTION_AT));
    expect(typesOf(pausedCommit)).toContain("work_definition_stopped");
    expect(paused.journal.definition(paused.definitionId).state).toBe("STOPPED");

    const stopped = reachDefinitionState("STOPPED", "stw019s");
    const before = stopped.journal.definition(stopped.definitionId);
    const stoppedCommit = commitOfOutcome(stopped.journal.cancelWork(stopped.workId, ACTION_AT));
    expect(typesOf(stoppedCommit)).toContain("work_canceled");
    expect(typesOf(stoppedCommit)).not.toContain("work_definition_stopped");
    expect(stopped.journal.definition(stopped.definitionId)).toEqual(before);
  });

  it("Error: 낡은 취소 명령은 거절되고 정의가 그대로다 (test_SC019_stale_cancel_leaves_definition)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("stw019x"));
    const before = journal.definition(definitionId);
    const stale = journal.onWork(
      stewardId,
      { kind: "cancel_work", origin: controlRequestCancelOrigin(journal.deps) },
      ACTION_AT,
      { actorSource: "unknown", expectedRevision: journal.work(stewardId).work.revision - 1 },
    );
    expect(stale.kind).toBe("rejected");
    expect(committedChain(stale).flatMap(typesOf)).not.toContain("work_definition_stopped");
    expect(journal.definition(definitionId)).toEqual(before);
    expect(journal.work(stewardId).work.state).toBe("ACTIVE");
  });

  it("Error: 취소 출처 위반은 각각의 사유로 invalid_input 이고 정의 중지가 없다 (test_SC019_cancel_origin_violations_refused_without_stop)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("stw019o"));
    const before = journal.definition(definitionId);
    const commitsBefore = journal.commits.length;
    const ctl = () => nextEntityId(journal.deps.ids, "controlRequest");
    const evt = () => nextEntityId(journal.deps.ids, "event");
    const cases: readonly [string, unknown, "unknown" | "human_local", string][] = [
      [
        "human control request",
        { kind: "control_request", actorSource: "human_local", controlRequestId: ctl() },
        "unknown",
        "cancel_origin_invalid",
      ],
      [
        "replan_dropped",
        { kind: "replan_dropped", actorSource: "unknown", workEventId: evt() },
        "unknown",
        "cancel_origin_kind_not_allowed",
      ],
      [
        "work_cascade",
        { kind: "work_cascade", actorSource: "unknown", workEventId: evt() },
        "unknown",
        "cancel_origin_kind_not_allowed",
      ],
      [
        "source mismatch",
        {
          kind: "control_request",
          actorSource: "unknown",
          controlRequestId: ctl(),
          keyId: "fixture-key",
        },
        "human_local",
        "cancel_origin_actor_source_mismatch",
      ],
    ];
    for (const [label, origin, actorSource, detail] of cases) {
      const outcome = journal.onWork(
        stewardId,
        { kind: "cancel_work", origin: origin as CancelOrigin },
        ACTION_AT,
        { actorSource },
      );
      expect(outcome, label).toEqual({
        kind: "rejected",
        rejection: { reason: "invalid_input", detail },
      });
    }
    expect(journal.commits.length).toBe(commitsBefore);
    expect(journal.definition(definitionId)).toEqual(before);
    // 대조: 출처를 맞춘 같은 취소는 커밋되고 중지 출처는 meta 출처다.
    const accepted = commitOfOutcome(
      journal.onWork(
        stewardId,
        { kind: "cancel_work", origin: controlRequestCancelOrigin(journal.deps) },
        ACTION_AT,
        { actorSource: "unknown" },
      ),
    );
    expect(
      (
        payloadsOf(accepted, "work_definition_stopped")[0]?.["stopOrigin"] as Record<
          string,
          unknown
        >
      )["actorSource"],
    ).toBe("unknown");
  });
});

function keysOf(value: unknown): string[] {
  return Object.keys(value as object).sort();
}

function stopOriginOf(commit: DomainCommit): Record<string, unknown> {
  return payloadsOf(commit, "work_definition_stopped")[0]?.["stopOrigin"] as Record<
    string,
    unknown
  >;
}

describe("SC-019: 취소 출처는 인증 형태·종류 필드를 검사하고 중지 출처는 종류 필드만 옮긴다", () => {
  it("Error: 인증 형태를 갖추지 못한 제어 요청·종류 밖 필드의 관리 Work 취소는 거절된다 (test_SC019_unshaped_or_out_of_kind_cancel_origin_refused)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("stw019u"));
    const before = journal.definition(definitionId);
    const stewardBefore = journal.work(stewardId);
    const commitsBefore = journal.commits.length;
    const ctl = () => nextEntityId(journal.deps.ids, "controlRequest");
    const sig = () => nextEntityId(journal.deps.ids, "signal");
    const cases: readonly [string, Record<string, unknown>, ActorSource][] = [
      [
        "(a) keyId missing",
        { kind: "control_request", actorSource: "unknown", controlRequestId: ctl() },
        "unknown",
      ],
      [
        "(b) keyId empty",
        { kind: "control_request", actorSource: "unknown", controlRequestId: ctl(), keyId: "" },
        "unknown",
      ],
      [
        "(c) not ctl_ id",
        { kind: "control_request", actorSource: "unknown", controlRequestId: "req-1", keyId: "k" },
        "unknown",
      ],
      [
        "(d) vault + keyId",
        { kind: "vault_signal", actorSource: "human_local", signalId: sig(), keyId: "k" },
        "human_local",
      ],
      [
        "(e) vault + controlRequestId",
        {
          kind: "vault_signal",
          actorSource: "human_local",
          signalId: sig(),
          controlRequestId: ctl(),
        },
        "human_local",
      ],
      [
        "(f) numeric reason",
        {
          kind: "control_request",
          actorSource: "unknown",
          controlRequestId: ctl(),
          keyId: "k",
          reason: 42,
        },
        "unknown",
      ],
    ];
    for (const [label, origin, actorSource] of cases) {
      const outcome = journal.onWork(
        stewardId,
        { kind: "cancel_work", origin: origin as unknown as CancelOrigin },
        ACTION_AT,
        { actorSource },
      );
      expect(outcome, label).toEqual({
        kind: "rejected",
        rejection: { reason: "invalid_input", detail: "cancel_origin_invalid" },
      });
    }
    expect(journal.commits).toHaveLength(commitsBefore);
    expect(journal.definition(definitionId)).toEqual(before);
    expect(journal.work(stewardId)).toEqual(stewardBefore);

    // 대조: 갖춘 제어 요청 취소는 커밋되고 이벤트에는 검사한 필드만 실린다(덧붙인 note 없음).
    const controlRequestId = ctl();
    const accepted = commitOfOutcome(
      journal.onWork(
        stewardId,
        {
          kind: "cancel_work",
          origin: {
            kind: "control_request",
            actorSource: "unknown",
            controlRequestId,
            keyId: "k1",
            note: "x",
          } as unknown as CancelOrigin,
        },
        ACTION_AT,
        { actorSource: "unknown" },
      ),
    );
    const origin = payloadsOf(accepted, "work_canceled")[0]?.["origin"];
    expect(keysOf(origin)).toEqual(["actorSource", "controlRequestId", "keyId", "kind"]);
    expect(stopOriginOf(accepted)).toEqual({
      kind: "work_cascade",
      actorSource: "unknown",
      controlRequestId,
      keyId: "k1",
    });

    // 대조: 노트 취소의 중지 출처에는 제어 요청 필드가 없다.
    const vault = registerDefinition(definitionDeps("stw019uv"));
    const vaultCommit = commitOfOutcome(
      vault.journal.onWork(
        vault.stewardId,
        { kind: "cancel_work", origin: vaultOrigin(vault.journal.deps) },
        ACTION_AT,
        { actorSource: "human_local" },
      ),
    );
    expect(keysOf(stopOriginOf(vaultCommit))).toEqual(["actorSource", "kind", "signalId"]);
  });

  it("Error: 정의 제어와 Work 취소는 같은 인증 형태 검사로 판정한다 (test_SC019_control_and_cancel_share_auth_shape_check)", () => {
    const rows: readonly [string, ActorSource, string | undefined, string | undefined, boolean][] =
      [
        ["shaped", "unknown", "ctl", "k", true],
        ["keyId missing", "unknown", "ctl", undefined, false],
        ["keyId empty", "unknown", "ctl", "", false],
        ["not ctl_ id", "unknown", "req-1", "k", false],
        ["human_local", "human_local", "ctl", "k", false],
      ];
    rows.forEach(([label, actorSource, idSpec, keyId, shaped], i) => {
      const { journal, definitionId } = registerDefinition(definitionDeps(`stw019sh${i}`));
      const controlRequestId =
        idSpec === "ctl" ? nextEntityId(journal.deps.ids, "controlRequest") : idSpec;
      const channel = {
        kind: "control_request",
        controlRequestId,
        ...(keyId !== undefined ? { keyId } : {}),
      } as never;
      const paused = journal.control(definitionId, "pause", ACTION_AT, { channel, actorSource });
      const markdown = journal.createMarkdownWork(ACTION_AT);
      const canceled = journal.onWork(
        markdown,
        {
          kind: "cancel_work",
          origin: {
            kind: "control_request",
            actorSource,
            controlRequestId,
            ...(keyId !== undefined ? { keyId } : {}),
          } as unknown as CancelOrigin,
        },
        ACTION_AT,
        { actorSource },
      );
      if (shaped) {
        expect(paused.kind, label).toBe("accepted");
        expect(canceled.kind, label).toBe("committed");
      } else {
        expect(paused.kind, label).toBe("rejected");
        if (paused.kind === "rejected") expect(paused.reason, label).toBe("provenance_not_human");
        expect(canceled, label).toEqual({
          kind: "rejected",
          rejection: { reason: "invalid_input", detail: "cancel_origin_invalid" },
        });
      }
    });
  });

  it("Edge: 노트 취소 신호는 관리 Work 를 취소하고 신호 ID 만 실은 중지 출처로 정의를 멈춘다 (test_SC019_note_cancel_signal_stops_with_signal_origin)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("stw019n"));
    const signal: DecisionSignal = {
      type: "cancel_requested",
      subject: { workId: stewardId },
      signalId: nextEntityId(journal.deps.ids, "signal"),
      expectedRevision: journal.work(stewardId).work.revision,
      actorSource: "human_local",
      receivedAt: ACTION_AT,
    };
    const judged = judgeSignal(
      journal.deps,
      journal.work(stewardId),
      signal,
      { kind: "none" },
      ACTION_AT,
    );
    expect(judged.kind).toBe("accepted");
    if (judged.kind !== "accepted") return;
    expect(typesOf(judged.commit)).toEqual([
      "signal_accepted",
      "work_canceled",
      "work_definition_stopped",
      "trigger_canceled",
    ]);
    expect(payloadsOf(judged.commit, "work_canceled")[0]?.["origin"]).toEqual({
      kind: "vault_signal",
      actorSource: "human_local",
      signalId: signal.signalId,
    });
    expect(judged.aggregate.definition?.id).toBe(definitionId);
    expect(judged.aggregate.definition?.state).toBe("STOPPED");
    expect(stopOriginOf(judged.commit)).toEqual({
      kind: "work_cascade",
      actorSource: "human_local",
      signalId: signal.signalId,
    });

    // 대조: 사람이 아닌 출처의 같은 신호는 출처 거절이고 정의는 그대로다.
    const other = registerDefinition(definitionDeps("stw019na"));
    const before = other.journal.definition(other.definitionId);
    const refused = judgeSignal(
      other.journal.deps,
      other.journal.work(other.stewardId),
      {
        type: "cancel_requested",
        subject: { workId: other.stewardId },
        signalId: nextEntityId(other.journal.deps.ids, "signal"),
        expectedRevision: other.journal.work(other.stewardId).work.revision,
        actorSource: "agent_session",
        receivedAt: ACTION_AT,
      },
      { kind: "none" },
      ACTION_AT,
    );
    expect(refused.kind).toBe("rejected");
    if (refused.kind === "rejected") expect(refused.reason).toBe("provenance_not_human");
    expect(other.journal.definition(other.definitionId)).toEqual(before);
  });

  it("Error: 공개 조립에 넘긴 취소 결정 이벤트의 중지 출처는 그 종류의 필드만 옮긴다 (test_SC019_public_cascade_stop_origin_takes_kind_fields)", () => {
    const cases: readonly [string, Record<string, unknown>, Record<string, unknown>, string[]][] = [
      [
        "(a) vault + control request fields",
        {
          kind: "vault_signal",
          actorSource: "human_local",
          signalId: "sig_x1",
          controlRequestId: "ctl_x1",
          keyId: "k",
        },
        { kind: "vault_signal", actorSource: "human_local", signalId: "sig_x1" },
        ["actorSource", "kind", "signalId"],
      ],
      [
        "(b) control request + signalId",
        {
          kind: "control_request",
          actorSource: "unknown",
          controlRequestId: "ctl_x2",
          keyId: "k",
          signalId: "sig_x2",
        },
        { kind: "control_request", actorSource: "unknown", controlRequestId: "ctl_x2", keyId: "k" },
        ["actorSource", "controlRequestId", "keyId", "kind"],
      ],
      [
        "(c) work cascade + all",
        {
          kind: "work_cascade",
          actorSource: "adde_self",
          workEventId: "evt_x3",
          signalId: "sig_x3",
          controlRequestId: "ctl_x3",
          keyId: "k",
        },
        { kind: "work_cascade", actorSource: "adde_self", workEventId: "evt_x3" },
        ["actorSource", "kind"],
      ],
    ];
    cases.forEach(([label, mixed, kindOnly, keys], i) => {
      const stopOriginFor = (origin: Record<string, unknown>, seed: string) => {
        const r = registerDefinition(definitionDeps(seed));
        const { commit } = assembleCommit(
          r.journal.deps,
          r.journal.work(r.stewardId),
          [mkEvent("work_canceled", { origin } as never, { workId: r.stewardId })],
          meta(ACTION_AT, origin["actorSource"] as ActorSource),
        );
        return stopOriginOf(commit);
      };
      const mixedStop = stopOriginFor(mixed, `stw019pa${i}`);
      expect(keysOf(mixedStop), label).toEqual(keys);
      expect(mixedStop["kind"], label).toBe("work_cascade");
      expect(mixedStop["actorSource"], label).toBe(mixed["actorSource"]);
      expect(stopOriginFor(kindOnly, `stw019pb${i}`), label).toEqual(mixedStop);
    });
  });
});

describe("SC-020: 관리 Work 재계획은 정의·회차를 건드리지 않는다", () => {
  it("Happy: 초안 없는 재계획 커밋은 정의·회차 Work 를 바꾸지 않는다 (test_SC020_steward_replan_leaves_definition_and_occurrences)", () => {
    const registered = registerAndMaterializeFirst(definitionDeps("stw020"));
    const { journal, stewardId, definitionId, firstWorkId } = registered;
    const definitionBefore = journal.definition(definitionId);
    const occurrenceBefore = journal.work(firstWorkId);
    journal.ensurePlanning(stewardId, ACTION_AT);
    commitOfOutcome(journal.commitPlan(stewardId, journal.replanBase(stewardId), ACTION_AT));
    expect(journal.definition(definitionId)).toEqual(definitionBefore);
    expect(journal.work(firstWorkId)).toEqual(occurrenceBefore);
  });

  it("Edge: 재계획이 열린 동안에도 회차가 materialize 된다 (test_SC020_occurrence_materializes_during_steward_replan)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("stw020e"));
    journal.ensurePlanning(stewardId, ACTION_AT);
    expect(journal.work(stewardId).work.state).toBe("PLANNING");
    const resolved = journal.resolveDue(definitionId, dayAt(0));
    expect(resolved.kind).toBe("committed");
    if (resolved.kind === "committed") expect(typesOf(resolved.commit)).toContain("trigger_fired");
    expect(journal.occurrenceWorkIds(definitionId)).toHaveLength(1);
  });

  it("Error: 개정을 실은 재계획을 거부하면 정의가 그대로다 (test_SC020_denied_amendment_replan_no_change)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("stw020x"));
    const before = journal.definition(definitionId);
    journal.proposeAmendment(definitionId, { title: "rejected" }, ACTION_AT);
    expect(journal.decidePlan(stewardId, "deny", ACTION_AT).kind).toBe("accepted");
    expect(journal.definition(definitionId)).toEqual(before);
  });
});
