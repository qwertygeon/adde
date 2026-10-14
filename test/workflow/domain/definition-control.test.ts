// 정의 제어 신호의 출처·중복·상태 판정, 일시정지·재개 해소, 중지 해소, 계열 종료, 무효 템플릿.
import { describe, expect, it } from "vitest";
import {
  findSteward,
  foldWorkflowEvents,
  judgeDefinitionSignal,
} from "../../../src/workflow/domain/index.js";
import type {
  DefinitionControlSignal,
  DomainCommit,
  WorkId,
  OccurrenceId,
  WorkDefinitionId,
} from "../../../src/workflow/domain/index.js";
import {
  DEFINITION_EVENT_TYPES,
  DEF_NOW,
  OCCURRENCE_CONSUMER,
  WorkflowJournal,
  controlSignal,
  dailyActivation,
  dayAt,
  definitionDeps,
  definitionDraft,
  occurrenceConsumerDeps,
  payloadsOf,
  registerDefinition,
  signalDefinitionDraft,
  templateDraft,
  typesOf,
} from "./helpers/definition-fixtures.js";
import type { MisfireSpec } from "./helpers/definition-fixtures.js";
import { ACTION_AT, STEWARD_MEMBER, reachDefinitionState } from "./helpers/definition-row-cases.js";
import { at, entityId } from "./helpers/fixtures.js";
import { testRegistries } from "./helpers/registry-fixtures.js";

function committed(outcome: { kind: string; commit?: DomainCommit }): DomainCommit {
  if (
    (outcome.kind !== "committed" && outcome.kind !== "accepted") ||
    outcome.commit === undefined
  ) {
    throw new Error(`expected a commit, got ${JSON.stringify(outcome)}`);
  }
  return outcome.commit;
}

function judgedLabel(judged: {
  kind: string;
  reason?: string;
  rejection?: { reason: string };
}): string {
  if (judged.kind === "not_applicable") return `not_applicable:${judged.rejection?.reason ?? ""}`;
  if (judged.kind === "rejected" || judged.kind === "rejected_stale")
    return `${judged.kind}:${judged.reason ?? ""}`;
  return judged.kind;
}

function scheduled(
  seed: string,
  misfire: MisfireSpec = { kind: "fire_once_now" },
  maxOpenOccurrences = 1,
) {
  return registerDefinition(definitionDeps(seed), {
    draft: definitionDraft({ maxOpenOccurrences, activation: dailyActivation({ misfire }) }),
    tasks: STEWARD_MEMBER,
  });
}

function skips(commit: DomainCommit): Record<string, unknown>[] {
  return payloadsOf(commit, "work_definition_occurrences_skipped");
}

describe("SC-034: 정의 제어 신호의 출처·상태 판정", () => {
  it("Happy: 노트 사람 세 동작과 제어 요청 일시정지·중지가 수용되고 출처가 기록된다 (test_SC034_accepted_provenance_actions)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("ctl034"), {
      tasks: STEWARD_MEMBER,
    });
    committed(journal.control(definitionId, "pause", ACTION_AT));
    expect(journal.definition(definitionId).pauseOrigin).toMatchObject({
      kind: "vault_signal",
      actorSource: "human_local",
    });
    committed(journal.control(definitionId, "resume", ACTION_AT));
    expect(journal.definition(definitionId).pauseOrigin).toBeUndefined();
    committed(journal.control(definitionId, "pause", ACTION_AT, { channel: "control_request" }));
    expect(journal.definition(definitionId).pauseOrigin).toMatchObject({
      kind: "control_request",
      actorSource: "unknown",
      keyId: "fixture-key",
    });
    committed(journal.control(definitionId, "resume", ACTION_AT));
    committed(journal.control(definitionId, "stop", ACTION_AT, { channel: "control_request" }));
    expect(journal.definition(definitionId).stopOrigin).toMatchObject({
      kind: "control_request",
      actorSource: "unknown",
    });

    const vaultStop = registerDefinition(definitionDeps("ctl034v"));
    committed(vaultStop.journal.control(vaultStop.definitionId, "stop", ACTION_AT));
    expect(vaultStop.journal.definition(vaultStop.definitionId).stopOrigin).toMatchObject({
      kind: "vault_signal",
      actorSource: "human_local",
    });
  });

  it("Edge: 낡은 revision·STOPPED·PAUSED 일시정지·ACTIVE 재개가 각각 거절된다 (test_SC034_stale_terminal_unexpected_state)", () => {
    const active = reachDefinitionState("ACTIVE", "ctl034ea");
    const stale = active.journal.control(active.definitionId, "pause", ACTION_AT, {
      expectedRevision: 0,
    });
    expect(judgedLabel(stale)).toBe("rejected_stale:revision_mismatch");
    expect(judgedLabel(active.journal.control(active.definitionId, "resume", ACTION_AT))).toBe(
      "rejected:unexpected_state",
    );
    const paused = reachDefinitionState("PAUSED", "ctl034ep");
    expect(judgedLabel(paused.journal.control(paused.definitionId, "pause", ACTION_AT))).toBe(
      "rejected:unexpected_state",
    );
    const stopped = reachDefinitionState("STOPPED", "ctl034es");
    expect(judgedLabel(stopped.journal.control(stopped.definitionId, "stop", ACTION_AT))).toBe(
      "rejected_stale:terminal_subject",
    );
  });

  it("Error: 제어 요청 재개와 그 밖 출처의 세 동작은 provenance_not_human 이고 정의가 그대로다 (test_SC034_provenance_not_human_unchanged)", () => {
    const cases: readonly [
      string,
      "pause" | "resume" | "stop",
      "ACTIVE" | "PAUSED",
      Parameters<WorkflowJournal["control"]>[3],
    ][] = [
      ["control request resume", "resume", "PAUSED", { channel: "control_request" }],
      ["vault agent pause", "pause", "ACTIVE", { actorSource: "agent_session" }],
      ["vault agent resume", "resume", "PAUSED", { actorSource: "agent_session" }],
      ["vault self stop", "stop", "ACTIVE", { actorSource: "adde_self" }],
      [
        "control request human pause",
        "pause",
        "ACTIVE",
        { channel: "control_request", actorSource: "human_local" },
      ],
    ];
    cases.forEach(([label, action, state, options], i) => {
      const { journal, definitionId } = reachDefinitionState(state, `ctl034x${i}`);
      const before = journal.definition(definitionId);
      const judged = journal.control(definitionId, action, ACTION_AT, options);
      expect(judgedLabel(judged), label).toBe("rejected:provenance_not_human");
      expect(journal.definition(definitionId), label).toEqual(before);
    });
  });

  it("Error: keyId 없는 제어 요청은 인증된 요청이 아니다 (test_SC034_control_request_without_key_id_not_human)", () => {
    for (const action of ["pause", "stop"] as const) {
      for (const [label, channel] of [
        [
          "empty keyId",
          {
            kind: "control_request",
            controlRequestId: entityId("controlRequest", "ctl_fixture000001"),
            keyId: "",
          },
        ],
        [
          "missing keyId",
          {
            kind: "control_request",
            controlRequestId: entityId("controlRequest", "ctl_fixture000002"),
          },
        ],
      ] as const) {
        const { journal, definitionId } = reachDefinitionState(
          "ACTIVE",
          `ctl034k${action}${label.length}`,
        );
        const before = journal.definition(definitionId);
        const judged = journal.control(definitionId, action, ACTION_AT, {
          channel: channel as never,
          actorSource: "unknown",
        });
        expect(judgedLabel(judged), `${action} ${label}`).toBe("rejected:provenance_not_human");
        expect(journal.definition(definitionId)).toEqual(before);
      }
      // 대조: keyId 가 있는 같은 요청은 수용된다.
      const control = reachDefinitionState("ACTIVE", `ctl034kc${action}`);
      expect(
        judgedLabel(
          control.journal.control(control.definitionId, action, ACTION_AT, {
            channel: "control_request",
          }),
        ),
      ).toBe("accepted");
    }
  });
});

describe("SC-035: 수용된 제어 신호의 재관측은 중복이다", () => {
  it("Happy: 수용된 일시정지를 다시 관측하면 signal_ignored_duplicate 이고 정의가 그대로다 (test_SC035_accepted_pause_reobserved_duplicate)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("ctl035"));
    committed(journal.control(definitionId, "pause", ACTION_AT, { expectedRevision: 1 }));
    const before = journal.definition(definitionId);
    const again = journal.control(definitionId, "pause", ACTION_AT, { expectedRevision: 1 });
    expect(judgedLabel(again)).toBe("duplicate");
    if (again.kind === "duplicate")
      expect(typesOf(again.commit)).toEqual(["signal_ignored_duplicate"]);
    expect(journal.definition(definitionId)).toEqual(before);
  });

  it("Edge: revision 이 바뀐 뒤에도 같은 키는 중복이다 — 중복 검사가 revision 보다 먼저다 (test_SC035_duplicate_precedes_revision_check)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("ctl035e"));
    committed(journal.control(definitionId, "pause", ACTION_AT, { expectedRevision: 1 }));
    committed(journal.control(definitionId, "resume", ACTION_AT));
    expect(journal.definition(definitionId).revision).toBe(3);
    expect(
      judgedLabel(journal.control(definitionId, "pause", ACTION_AT, { expectedRevision: 1 })),
    ).toBe("duplicate");
  });

  it("Error: 같은 revision 의 다른 동작은 중복이 아니고 정상 판정을 받는다 (test_SC035_other_action_not_duplicate)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("ctl035x"));
    committed(journal.control(definitionId, "pause", ACTION_AT, { expectedRevision: 1 }));
    expect(
      judgedLabel(journal.control(definitionId, "stop", ACTION_AT, { expectedRevision: 1 })),
    ).toBe("rejected_stale:revision_mismatch");
  });
});

describe("SC-036: 일시정지 중 도래한 회차는 재개 뒤 한 번 해소된다", () => {
  function pausedThenResumed(seed: string, misfire: MisfireSpec, resumeAt: string) {
    const registered = scheduled(seed, misfire);
    const { journal, definitionId } = registered;
    committed(journal.control(definitionId, "pause", DEF_NOW));
    const commitsBefore = journal.commits.length;
    expect(journal.resolveDue(definitionId, dayAt(0))).toEqual({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "definition_paused" },
    });
    expect(journal.commits.length).toBe(commitsBefore);
    const resumed = committed(journal.control(definitionId, "resume", at(resumeAt)));
    return { ...registered, resumed };
  }

  it("Happy: fire_once_now 일시정지 중 두 시각이 지나면 재개 뒤 하나 materialize·나머지 건너뜀 하나다 (test_SC036_pause_resolved_once_after_resume)", () => {
    const { journal, definitionId, resumed } = pausedThenResumed(
      "ctl036",
      { kind: "fire_once_now" },
      dayAt(1, "08:00"),
    );
    expect(payloadsOf(resumed, "work_definition_resumed")[0]?.["pendingScheduleOverdue"]).toBe(
      true,
    );
    const commit = committed(journal.resolveDue(definitionId, dayAt(1, "08:00")));
    expect(payloadsOf(commit, "trigger_fired").map((f) => f["originalInstant"])).toEqual([
      dayAt(1),
    ]);
    expect(skips(commit).map((s) => [s["count"], s["firstOriginalInstant"]])).toEqual([
      [1, dayAt(0)],
    ]);
  });

  it("Edge: 한 시각만 지나면 재개 표식으로 지연 해소되어 materialize 하나·건너뜀 없음이다 (test_SC036_single_missed_instant_resume_marked)", () => {
    const { journal, definitionId } = pausedThenResumed(
      "ctl036e",
      { kind: "fire_once_now" },
      dayAt(0, "08:00"),
    );
    const commit = committed(journal.resolveDue(definitionId, dayAt(0, "08:00")));
    expect(payloadsOf(commit, "trigger_fired").map((f) => f["originalInstant"])).toEqual([
      dayAt(0),
    ]);
    expect(skips(commit)).toEqual([]);
  });

  it("Error: skip 정책이면 같은 흐름에서 전부 건너뛰고 materialize 가 없다 (test_SC036_skip_policy_resume_skips_all)", () => {
    const { journal, definitionId } = pausedThenResumed(
      "ctl036x",
      { kind: "skip" },
      dayAt(1, "08:00"),
    );
    const commit = committed(journal.resolveDue(definitionId, dayAt(1, "08:00")));
    expect(typesOf(commit)).not.toContain("trigger_fired");
    expect(skips(commit).map((s) => [s["reason"], s["count"]])).toEqual([["misfire_skip", 2]]);
  });
});

describe("SC-037: 일시정지 중 신호 회차는 보류되고 재개 뒤 순서대로 해제된다", () => {
  function pausedSignals(seed: string) {
    const registered = registerDefinition(definitionDeps(seed), {
      draft: signalDefinitionDraft({ maxOpenOccurrences: 3 }),
      tasks: STEWARD_MEMBER,
    });
    const { journal, definitionId } = registered;
    committed(journal.control(definitionId, "pause", DEF_NOW));
    const commits = ["s1", "s2", "s3"].map((s, i) =>
      committed(journal.external(definitionId, s, dayAt(0, `0${i + 7}:00`))),
    );
    return { ...registered, commits };
  }

  it("Happy: 일시정지 중 신호 셋은 보류되고 재개 뒤 수용 순으로 materialize 된다 (test_SC037_paused_signal_holds_release_in_order)", () => {
    const { journal, definitionId, commits } = pausedSignals("ctl037");
    expect(
      commits
        .flatMap((c) => payloadsOf(c, "work_definition_occurrence_held"))
        .map((h) => h["cause"]),
    ).toEqual(["definition_paused", "definition_paused", "definition_paused"]);
    committed(journal.control(definitionId, "resume", dayAt(0, "10:00")));
    const released = [1, 2, 3].map(() =>
      committed(journal.release(definitionId, dayAt(0, "10:01"))),
    );
    expect(
      journal
        .occurrenceWorkIds(definitionId)
        .map(
          (w) =>
            (journal.work(w).work.source as { input: { signal: { sourceOccurrenceId: string } } })
              .input.signal.sourceOccurrenceId,
        ),
    ).toEqual(["s1", "s2", "s3"]);
    expect(released.flatMap(skips)).toEqual([]);
  });

  it("Edge: 일시정지 중 해제는 definition_not_active 다 (test_SC037_release_while_paused_refused)", () => {
    const { journal, definitionId } = pausedSignals("ctl037e");
    expect(journal.release(definitionId, dayAt(0, "10:00"))).toEqual({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "definition_not_active" },
    });
  });

  it("Error: 일시정지 중 중지는 보류 셋을 definition_stopped 로 건너뛴다 (test_SC037_stop_while_paused_skips_holds)", () => {
    const { journal, definitionId } = pausedSignals("ctl037x");
    const stop = committed(journal.control(definitionId, "stop", dayAt(0, "10:00")));
    expect(skips(stop).map((s) => [s["reason"], s["count"]])).toEqual([["definition_stopped", 3]]);
    expect(journal.definition(definitionId).held).toEqual([]);
  });
});

describe("SC-038: 중지는 대기 행을 취소하고 보류를 건너뛰며 회차 Work 를 남긴다", () => {
  function openAndHeld(seed: string) {
    const registered = scheduled(seed);
    const { journal, definitionId } = registered;
    committed(journal.resolveDue(definitionId, dayAt(0)));
    committed(journal.resolveDue(definitionId, dayAt(1)));
    return registered;
  }

  it("Happy: 미도래 행·보류 하나·열린 회차 하나의 중지는 trigger_canceled 와 건너뜀 하나이고 회차 Work 는 그대로다 (test_SC038_stop_cancels_row_and_skips_held)", () => {
    const { journal, definitionId } = openAndHeld("ctl038");
    const occurrence = journal.occurrenceWorkIds(definitionId)[0];
    const before = occurrence === undefined ? undefined : journal.work(occurrence);
    const stop = committed(journal.control(definitionId, "stop", dayAt(1, "08:00")));
    expect(
      payloadsOf(stop, "trigger_canceled").map((c) => [c["scheduledForUtc"], c["reason"]]),
    ).toEqual([[dayAt(2), "definition_stopped"]]);
    expect(skips(stop).map((s) => [s["reason"], s["count"]])).toEqual([["definition_stopped", 1]]);
    if (occurrence !== undefined) expect(journal.work(occurrence)).toEqual(before);
  });

  it("Edge: 이미 도래한 대기 행은 건너뜀에 포함되고 중지 뒤 대기 행이 없다 — 직접 적용과 fold 둘 다 (test_SC038_due_row_included_in_skip)", () => {
    const { journal, definitionId } = openAndHeld("ctl038e");
    const stop = committed(journal.control(definitionId, "stop", dayAt(2, "08:00")));
    expect(typesOf(stop)).not.toContain("trigger_canceled");
    const skipped = skips(stop);
    expect(
      skipped.map((s) => [s["count"], s["firstOriginalInstant"], s["lastOriginalInstant"]]),
    ).toEqual([[2, dayAt(1), dayAt(2)]]);
    expect(Object.hasOwn(skipped[0] ?? {}, "nextSchedule")).toBe(false);
    expect(journal.definition(definitionId).pendingSchedule).toBeUndefined();
    const folded = journal.folded();
    const steward = Object.values(folded.works).find((w) => w.definition?.id === definitionId);
    expect(steward?.definition?.pendingSchedule).toBeUndefined();
  });

  it("Error: 중지된 정의의 중지는 terminal_subject 다 (test_SC038_stop_on_stopped_terminal)", () => {
    const { journal, definitionId } = reachDefinitionState("STOPPED", "ctl038x");
    expect(judgedLabel(journal.control(definitionId, "stop", ACTION_AT))).toBe(
      "rejected_stale:terminal_subject",
    );
  });
});

describe("SC-039: 계열이 끝나면 같은 커밋에서 정의가 중지된다", () => {
  function stoppedSeriesEnd(commit: DomainCommit): boolean {
    return payloadsOf(commit, "work_definition_stopped").some(
      (s) => (s["stopOrigin"] as { kind?: string }).kind === "series_exhausted",
    );
  }

  it("Happy: 신호 상한 2 는 둘째 materialize 커밋에서 중지하고 추가 신호는 terminal_subject 다 (test_SC039_signal_max_occurrences_stops_series)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("ctl039"), {
      draft: signalDefinitionDraft({ maxOpenOccurrences: 2, maxOccurrences: 2 }),
      tasks: STEWARD_MEMBER,
    });
    expect(stoppedSeriesEnd(committed(journal.external(definitionId, "s1", dayAt(0))))).toBe(false);
    expect(
      stoppedSeriesEnd(committed(journal.external(definitionId, "s2", dayAt(0, "08:00")))),
    ).toBe(true);
    expect(judgedLabel(journal.external(definitionId, "s3", dayAt(0, "09:00")))).toBe(
      "rejected_stale:terminal_subject",
    );
  });

  it("Edge: 반복 상한 2 는 둘째 회차 커밋에서 중지한다 (test_SC039_recurrence_max_occurrences_stops_series)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("ctl039e"), {
      draft: definitionDraft({
        maxOpenOccurrences: 2,
        activation: dailyActivation({ maxOccurrences: 2 }),
      }),
      tasks: STEWARD_MEMBER,
    });
    expect(stoppedSeriesEnd(committed(journal.resolveDue(definitionId, dayAt(0))))).toBe(false);
    expect(stoppedSeriesEnd(committed(journal.resolveDue(definitionId, dayAt(1))))).toBe(true);
  });

  it("Error: until 시각의 회차는 존재하고 그 materialize 커밋에서 중지한다 (test_SC039_until_inclusive_boundary_stops)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("ctl039x"), {
      draft: definitionDraft({
        maxOpenOccurrences: 2,
        activation: dailyActivation({ until: dayAt(1) }),
      }),
      tasks: STEWARD_MEMBER,
    });
    expect(stoppedSeriesEnd(committed(journal.resolveDue(definitionId, dayAt(0))))).toBe(false);
    const last = committed(journal.resolveDue(definitionId, dayAt(1)));
    expect(payloadsOf(last, "trigger_fired").map((f) => f["originalInstant"])).toEqual([dayAt(1)]);
    expect(stoppedSeriesEnd(last)).toBe(true);
  });

  it("Edge: 끝난 일정 계열로 개정하면 개정 커밋에서 중지한다 (test_SC039_amendment_to_ended_schedule_stops_in_amendment_commit)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("ctl039f"), {
      tasks: STEWARD_MEMBER,
    });
    const pendingId = journal.definition(definitionId).pendingSchedule
      ?.occurrenceId as OccurrenceId;
    const ended = dailyActivation({
      anchorUtc: at("2026-02-01T07:00:00Z"),
      until: at("2026-02-10T07:00:00Z"),
    });
    const granted = committed(journal.amend(definitionId, { activation: ended }, ACTION_AT));
    expect(payloadsOf(granted, "work_definition_revised")[0]?.["nextSchedule"]).toBeNull();
    expect(stoppedSeriesEnd(granted)).toBe(true);
    expect(journal.definition(definitionId).revision).toBe(2);
    expect(journal.resolveDue(definitionId, dayAt(0), { occurrenceId: pendingId })).toEqual({
      kind: "rejected",
      rejection: { reason: "terminal_subject" },
    });
    // 대조: until 이 미래면 중지가 없다.
    const live = registerDefinition(definitionDeps("ctl039h"), { tasks: STEWARD_MEMBER });
    const liveGrant = committed(
      live.journal.amend(
        live.definitionId,
        { activation: dailyActivation({ until: dayAt(5) }) },
        ACTION_AT,
      ),
    );
    expect(stoppedSeriesEnd(liveGrant)).toBe(false);
  });

  it("Error: 신호 상한을 일생 누적 수 이하로 낮춘 개정은 개정 커밋에서 중지하고 예산을 다시 채우지 않는다 (test_SC039_signal_max_lowered_to_lifetime_count_stops)", () => {
    const lowered = registerDefinition(definitionDeps("ctl039l"), {
      draft: signalDefinitionDraft({ maxOpenOccurrences: 3, maxOccurrences: 5 }),
      tasks: STEWARD_MEMBER,
    });
    for (const s of ["s1", "s2", "s3", "s4"])
      committed(lowered.journal.external(lowered.definitionId, s, dayAt(0)));
    expect(lowered.journal.definition(lowered.definitionId).held).toHaveLength(1);
    const grant = committed(
      lowered.journal.amend(lowered.definitionId, { maxOccurrences: 3 }, ACTION_AT),
    );
    expect(stoppedSeriesEnd(grant)).toBe(true);
    expect(skips(grant).map((s) => s["reason"])).toEqual(["definition_stopped"]);

    const room = registerDefinition(definitionDeps("ctl039m"), {
      draft: signalDefinitionDraft({ maxOpenOccurrences: 3, maxOccurrences: 5 }),
      tasks: STEWARD_MEMBER,
    });
    for (const s of ["s1", "s2"]) committed(room.journal.external(room.definitionId, s, dayAt(0)));
    expect(
      stoppedSeriesEnd(
        committed(room.journal.amend(room.definitionId, { maxOccurrences: 3 }, ACTION_AT)),
      ),
    ).toBe(false);
    expect(
      stoppedSeriesEnd(
        committed(room.journal.external(room.definitionId, "s3", dayAt(0, "08:00"))),
      ),
    ).toBe(true);
    expect(room.journal.definition(room.definitionId).materialized).toHaveLength(3);
  });
});

describe("SC-040: 무효 템플릿 회차는 Work 를 만들지 않고 정의를 일시정지한다", () => {
  /** 소비자 유형을 템플릿에 쓴 정의를 등록한 뒤 그 유형이 빠진 등록부(등록부 drift 대용)로 진행한다. */
  function drifted(seed: string, misfire: MisfireSpec) {
    const registered = registerDefinition(occurrenceConsumerDeps(seed), {
      draft: definitionDraft({
        activation: dailyActivation({ misfire }),
        template: [templateDraft("consumer", { type: OCCURRENCE_CONSUMER, input: {} })],
      }),
      tasks: STEWARD_MEMBER,
    });
    const journal = new WorkflowJournal(
      { ...registered.journal.deps, registries: testRegistries() },
      registered.journal.state,
      registered.journal.commits,
    );
    return { journal, definitionId: registered.definitionId as WorkDefinitionId };
  }

  it("Happy: fire_once_now 무효 템플릿 회차는 보류되고 template_invalid 일시정지와 이슈가 붙는다 (test_SC040_invalid_template_holds_and_pauses)", () => {
    const { journal, definitionId } = drifted("ctl040", { kind: "fire_once_now" });
    const commit = committed(journal.resolveDue(definitionId, dayAt(0)));
    expect(typesOf(commit)).not.toContain("work_created");
    expect(payloadsOf(commit, "work_definition_occurrence_held").map((h) => h["cause"])).toEqual([
      "template_invalid",
    ]);
    const paused = payloadsOf(commit, "work_definition_paused")[0];
    expect(paused?.["pauseOrigin"]).toEqual({ kind: "template_invalid", actorSource: "adde_self" });
    expect((paused?.["templateIssues"] as unknown[]).length).toBeGreaterThan(0);
    expect(journal.definition(definitionId).state).toBe("PAUSED");
  });

  it("Edge: skip 정책이면 건너뛰고 일시정지한다 (test_SC040_invalid_template_skip_policy_skips_and_pauses)", () => {
    const { journal, definitionId } = drifted("ctl040e", { kind: "skip" });
    const commit = committed(journal.resolveDue(definitionId, dayAt(0)));
    expect(skips(commit).map((s) => s["reason"])).toEqual(["misfire_skip"]);
    expect(typesOf(commit)).toContain("work_definition_paused");
    expect(journal.definition(definitionId).held).toEqual([]);
  });

  it("Error: 재개 뒤에도 무효면 해제가 다시 일시정지하고 보류를 유지한다 (test_SC040_still_invalid_after_resume_pauses_again)", () => {
    const { journal, definitionId } = drifted("ctl040x", { kind: "fire_once_now" });
    committed(journal.resolveDue(definitionId, dayAt(0)));
    committed(journal.control(definitionId, "resume", dayAt(0, "08:00")));
    const release = committed(journal.release(definitionId, dayAt(0, "08:01")));
    expect(typesOf(release)).toEqual(["work_definition_paused"]);
    expect(journal.definition(definitionId).held).toHaveLength(1);
    expect(journal.definition(definitionId).state).toBe("PAUSED");
  });
});

describe("SC-034: 정의 제어 진입 형 위반", () => {
  it("Error: 형이 틀린 정의 제어는 기록 없이 무시하거나 출처 거절로 기록하고 정의는 그대로다 (test_SC034_control_entry_shape_refused)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("ctl034shape"));
    const deps = journal.deps;
    const revision = journal.definition(definitionId).revision;
    const before = journal.definition(definitionId);
    const base = controlSignal(deps, {
      definitionId,
      expectedRevision: revision,
      action: "pause",
      channel: "control_request",
    });
    const judge = (signal: Record<string, unknown>) =>
      judgeDefinitionSignal(
        deps,
        journal.state,
        signal as unknown as DefinitionControlSignal,
        ACTION_AT,
      );
    const unchanged = (outcome: ReturnType<typeof judge>, label: string) => {
      if ("state" in outcome)
        expect(findSteward(outcome.state, definitionId)?.definition, label).toEqual(before);
    };

    const ignored: readonly [string, Record<string, unknown>][] = [
      ["(a) numeric definitionId", { ...base, definitionId: 42 }],
      ["(a) missing definitionId", { ...base, definitionId: undefined }],
      ["(a) unknown action", { ...base, action: "halt" }],
      ["(d) revision -1", { ...base, expectedRevision: -1 }],
      ["(d) revision 1.5", { ...base, expectedRevision: 1.5 }],
      ["(d) revision string", { ...base, expectedRevision: String(revision) }],
      ["(d) revision NaN", { ...base, expectedRevision: Number.NaN }],
    ];
    for (const [label, signal] of ignored) {
      expect(judge(signal), label).toEqual({
        kind: "not_applicable",
        rejection: { reason: "invalid_input" },
      });
    }

    const nonHuman = { ...base, actorSource: "agent_session" };
    const recorded: readonly [string, Record<string, unknown>][] = [
      ["(b) revision string", { ...nonHuman, expectedRevision: String(revision) }],
      ["(b) revision 1.5", { ...nonHuman, expectedRevision: 1.5 }],
      ["(b) revision array", { ...nonHuman, expectedRevision: [revision] }],
      ["(b) revision missing", { ...nonHuman, expectedRevision: undefined }],
      ["(c) channel missing, unknown", { ...base, channel: undefined }],
      ["(c) channel null, unknown", { ...base, channel: null }],
      ["(c) channel string, unknown", { ...base, channel: "control_request" }],
      ["(c) channel missing, human", { ...base, channel: undefined, actorSource: "human_local" }],
      ["(c) channel null, human", { ...base, channel: null, actorSource: "human_local" }],
      ["(c) channel string, human", { ...base, channel: "vault", actorSource: "human_local" }],
    ];
    for (const [label, signal] of recorded) {
      const first = judge(signal);
      const second = judge(signal);
      expect(first.kind, label).toBe("rejected");
      if (first.kind !== "rejected" || second.kind !== "rejected") continue;
      expect(first.reason, label).toBe("provenance_not_human");
      expect(typesOf(first.commit), label).toEqual(["signal_rejected"]);
      expect(payloadsOf(first.commit, "signal_rejected")[0]?.["candidateKey"], label).toBeDefined();
      expect(
        first.commit.events.map((e) => e.payload),
        label,
      ).toEqual(second.commit.events.map((e) => e.payload));
      unchanged(first, label);
    }

    // 대조: 형만 맞춘 같은 신호는 수용된다.
    expect(judge({ ...base }).kind).toBe("accepted");
    expect(
      judge({ ...base, actorSource: "human_local", channel: { kind: "vault_signal" } }).kind,
    ).toBe("accepted");
  });
});

describe("SC-063: 정의 이벤트는 관리 Work 에 귀속된다", () => {
  it("Error: 정의의 sourceWorkId 가 관리 Work 와 달라도 정의 이벤트는 관리 Work 로 가고 fold 가 직접 적용과 같다 (test_SC063_definition_events_follow_steward_not_source_work_id)", () => {
    const registered = registerDefinition(definitionDeps("ctl063src"));
    const { definitionId, stewardId } = registered;
    const other = registered.journal.createMarkdownWork(dayAt(0, "00:30"));
    const commits = registered.journal.commits.map((c) => ({
      ...c,
      events: c.events.map((e) => {
        if (e.type !== "work_definition_created") return e;
        const payload = e.payload as unknown as { definition: Record<string, unknown> };
        return {
          ...e,
          payload: { ...payload, definition: { ...payload.definition, sourceWorkId: other } },
        } as unknown as typeof e;
      }),
    })) as DomainCommit[];
    const folded = foldWorkflowEvents(commits.flatMap((c) => c.events));
    if (!folded.ok) throw new Error(`fold failed ${JSON.stringify(folded.error)}`);
    const journal = new WorkflowJournal(registered.journal.deps, folded.value, commits);
    expect(journal.definition(definitionId).sourceWorkId).toBe(other);

    const steps: readonly [string, () => { kind: string; commit?: DomainCommit }][] = [
      ["pause", () => journal.control(definitionId, "pause", dayAt(0, "01:00"))],
      ["resume", () => journal.control(definitionId, "resume", dayAt(0, "02:00"))],
      ["resolve", () => journal.resolveDue(definitionId, dayAt(0))],
      [
        "amend",
        () =>
          journal.amend(
            definitionId,
            { activation: dailyActivation({ localTime: "08:00" }) },
            dayAt(0, "07:30"),
          ),
      ],
      ["stop", () => journal.control(definitionId, "stop", dayAt(0, "09:00"))],
    ];
    for (const [label, step] of steps) {
      const commit = committed(step());
      const definitionEvents = commit.events.filter((e) =>
        (DEFINITION_EVENT_TYPES as readonly string[]).includes(e.type),
      );
      expect(definitionEvents.length, label).toBeGreaterThan(0);
      for (const e of definitionEvents)
        expect(e.workId as WorkId | undefined, label).toBe(stewardId);
      expect(
        commit.events.some((e) => e.workId === other),
        label,
      ).toBe(false);
      expect(journal.folded(), label).toEqual(journal.state);
    }
  });
});
