// 정의 초안 승인·개정·출처·관리 대조·활성화·템플릿·결합·필수 member 예외·대기 개정 철회.
import { describe, expect, it } from "vitest";
import {
  createWork,
  executeCommand,
  nextEntityId,
  parseProjectId,
} from "../../../src/workflow/domain/index.js";
import type {
  CommandOutcome,
  DomainDeps,
  PlanTaskDraft,
  TriggerSpec,
  WorkAggregate,
  WorkSource,
} from "../../../src/workflow/domain/index.js";
import {
  DEF_NOW,
  OCCURRENCE_CONSUMER,
  bindingTemplate,
  dailyActivation,
  dayAt,
  definitionDeps,
  definitionDraft,
  definitionInvalidReasons,
  issuesOf,
  markdownWorkInPlanning,
  occurrenceConsumerDeps,
  planInvalidIssues,
  proposeDraft,
  registerAndMaterializeFirst,
  registerDefinition,
  signalDefinitionDraft,
  templateDraft,
  templateIssues,
  typesOf,
} from "./helpers/definition-fixtures.js";
import type { WorkflowJournal } from "./helpers/definition-fixtures.js";
import { ACTION_AT, STEWARD_MEMBER, reachDefinitionState } from "./helpers/definition-row-cases.js";
import { basePolicy, committedChain, entityId, meta, mustOk } from "./helpers/fixtures.js";

function expectWaitingApproval(
  journal: WorkflowJournal,
  workId: Parameters<WorkflowJournal["work"]>[0],
  outcome: CommandOutcome,
): void {
  expect(issuesOf(outcome)).toEqual([]);
  expect(journal.work(workId).work.state).toBe("WAITING_APPROVAL");
}

/** 주어진 출처의 Work 를 계획 단계에 두고 정의 초안을 제안한다(단일 애그리거트 경로). */
function proposeFromSource(
  deps: DomainDeps,
  source: WorkSource,
  draftContent: unknown,
): CommandOutcome {
  const created = createWork(deps, {
    kind: "create_work",
    meta: meta(DEF_NOW),
    projectId: mustOk(parseProjectId(`prj_${nextEntityId(deps.ids, "work").slice("wrk_".length)}`)),
    title: "other source",
    objective: "other source",
    source,
  });
  if (created.kind !== "committed") throw new Error(`create_work ${created.kind}`);
  const planning = executeCommand(deps, created.aggregate, {
    kind: "start_planning",
    expectedRevision: created.aggregate.work.revision,
    meta: meta(DEF_NOW),
  });
  if (planning.kind !== "committed") throw new Error(`start_planning ${planning.kind}`);
  return executeCommand(deps, planning.aggregate, {
    kind: "propose_plan",
    expectedRevision: planning.aggregate.work.revision,
    meta: meta(DEF_NOW),
    plan: {
      basePlanRevision: 0,
      source: "planner",
      tasks: [],
      retain: [],
      definition: draftContent,
    },
    summary: "definition",
  });
}

function definitionReasonsOf(outcome: CommandOutcome): string[] {
  return definitionInvalidReasons(issuesOf(outcome));
}

function templateIssuesOf(outcome: CommandOutcome): readonly Record<string, unknown>[] {
  return templateIssues(issuesOf(outcome));
}

/** 관리 Work 에 개정 제안을 대기시킨 상태. */
function pendingAmendment(seed: string) {
  const registered = registerDefinition(definitionDeps(seed), { tasks: STEWARD_MEMBER });
  const { journal, stewardId, definitionId } = registered;
  const proposed = journal.proposeAmendment(definitionId, { title: "pending title" }, ACTION_AT);
  expectWaitingApproval(journal, stewardId, proposed);
  const decisionId = journal.work(stewardId).work.pendingDecision?.id;
  if (decisionId === undefined) throw new Error("expected pending plan decision");
  return { ...registered, decisionId };
}

describe("SC-006: 정의 초안은 필수 사람 승인으로 등록된다", () => {
  it("Happy: 정의 초안 제안은 승인을 기다리고 grant 커밋이 정의를 만든다 (test_SC006_definition_draft_waits_approval_then_creates)", () => {
    const { journal, workId, outcome } = proposeDraft(definitionDeps("reg006"), definitionDraft());
    expectWaitingApproval(journal, workId, outcome);
    const granted = journal.decidePlan(workId, "grant", DEF_NOW);
    expect(granted.kind).toBe("accepted");
    if (granted.kind !== "accepted") return;
    expect(typesOf(granted.commit)).toEqual([
      "signal_accepted",
      "work_plan_committed",
      "work_definition_created",
      "work_ready",
      "work_activated",
    ]);
    const definition = journal.work(workId).definition;
    expect(definition?.state).toBe("ACTIVE");
    expect(definition?.revision).toBe(1);
    expect(definition?.sourceWorkId).toBe(workId);
    expect(journal.work(workId).work.state).toBe("ACTIVE");
  });

  it("Edge: 정의 초안의 직접 커밋은 필수 승인 거절이고 커밋이 없다 (test_SC006_direct_commit_requires_mandatory_approval)", () => {
    const { journal, workId } = markdownWorkInPlanning(definitionDeps("reg006e"));
    const commitsBefore = journal.commits.length;
    const refused = journal.commitPlan(
      workId,
      {
        basePlanRevision: 0,
        source: "planner",
        tasks: [],
        retain: [],
        definition: definitionDraft(),
      },
      DEF_NOW,
    );
    expect(refused).toEqual({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "mandatory_plan_approval_required" },
    });
    expect(committedChain(refused)).toEqual([]);
    expect(journal.commits.length).toBe(commitsBefore);
    expect(journal.work(workId).definition).toBeUndefined();
    expect(journal.work(workId).work.state).toBe("PLANNING");
  });

  it("Error: 사람이 아닌 grant 는 provenance_not_human 이고 정의가 생기지 않는다 (test_SC006_non_human_grant_creates_nothing)", () => {
    const { journal, workId } = proposeDraft(definitionDeps("reg006x"), definitionDraft());
    const judged = journal.decidePlan(workId, "grant", DEF_NOW, { actorSource: "adde_self" });
    expect(judged.kind).toBe("rejected");
    if (judged.kind === "rejected") expect(judged.reason).toBe("provenance_not_human");
    expect(journal.work(workId).definition).toBeUndefined();
    expect(journal.work(workId).work.state).toBe("WAITING_APPROVAL");
    // 대조: 사람 grant 는 같은 대기 제안에서 정의를 만든다.
    expect(journal.decidePlan(workId, "grant", DEF_NOW).kind).toBe("accepted");
    expect(journal.work(workId).definition?.state).toBe("ACTIVE");
  });
});

describe("SC-007: 개정 승인은 정의를 같은 상태로 개정한다", () => {
  function atRevisionThree(seed: string) {
    const registered = registerDefinition(definitionDeps(seed), { tasks: STEWARD_MEMBER });
    const { journal, definitionId } = registered;
    expect(journal.control(definitionId, "pause", ACTION_AT).kind).toBe("accepted");
    expect(journal.control(definitionId, "resume", ACTION_AT).kind).toBe("accepted");
    expect(journal.definition(definitionId).revision).toBe(3);
    return registered;
  }

  it("Happy: revision 3 정의를 기대 revision 3 으로 개정하면 revision 4·ACTIVE 다 (test_SC007_amendment_grant_revises_definition)", () => {
    const { journal, definitionId } = atRevisionThree("reg007");
    const granted = journal.amend(definitionId, { title: "revised" }, ACTION_AT);
    expect(granted.kind).toBe("accepted");
    if (granted.kind === "accepted")
      expect(typesOf(granted.commit)).toContain("work_definition_revised");
    const definition = journal.definition(definitionId);
    expect(definition.revision).toBe(4);
    expect(definition.state).toBe("ACTIVE");
    expect(definition.title).toBe("revised");
  });

  it("Edge: 일시정지 중 개정은 PAUSED 를 유지하고 revision 을 1 올린다 (test_SC007_amendment_while_paused_keeps_paused)", () => {
    const { journal, definitionId } = reachDefinitionState("PAUSED", "reg007e");
    const before = journal.definition(definitionId).revision;
    expect(journal.amend(definitionId, { title: "paused rename" }, ACTION_AT).kind).toBe(
      "accepted",
    );
    expect(journal.definition(definitionId).state).toBe("PAUSED");
    expect(journal.definition(definitionId).revision).toBe(before + 1);
  });

  it("Error: 기대 revision 이 다르면 amends_revision_mismatch 계획 무효다 (test_SC007_amendment_revision_mismatch_invalid)", () => {
    const { journal, definitionId } = atRevisionThree("reg007x");
    const before = journal.definition(definitionId);
    const proposed = journal.proposeAmendment(definitionId, { title: "stale" }, ACTION_AT, {
      expectedRevision: 2,
    });
    expect(definitionReasonsOf(proposed)).toEqual(["amends_revision_mismatch"]);
    expect(journal.definition(definitionId)).toEqual(before);
  });
});

describe("SC-008: 정의 초안은 markdown 출처 Work 만 낸다", () => {
  it("Happy: markdown 출처의 초안은 유효하다 (test_SC008_markdown_source_valid)", () => {
    const { journal, workId, outcome } = proposeDraft(definitionDeps("reg008"), definitionDraft());
    expectWaitingApproval(journal, workId, outcome);
  });

  it("Edge: 회차 Work 재계획의 초안은 work_source_not_markdown 이다 (test_SC008_occurrence_work_source_invalid)", () => {
    const { journal, firstWorkId } = registerAndMaterializeFirst(definitionDeps("reg008e"));
    const taskId = journal.work(firstWorkId).work.memberTaskIds[0];
    if (taskId === undefined) throw new Error("expected template task");
    for (const kind of ["begin_validation", "complete_validation", "start_attempt"] as const) {
      expect(journal.onTask(firstWorkId, taskId, { kind }, dayAt(0, "07:01")).kind, kind).toBe(
        "committed",
      );
    }
    journal.ensurePlanning(firstWorkId, dayAt(0, "07:02"));
    const proposed = journal.propose(
      firstWorkId,
      journal.replanBase(firstWorkId, { definition: definitionDraft() }),
      dayAt(0, "07:02"),
    );
    expect(definitionReasonsOf(proposed)).toEqual(["work_source_not_markdown"]);
    expect(journal.work(firstWorkId).definition).toBeUndefined();
  });

  it("Error: cli·spawn 출처의 초안은 계획 무효이고 Task·정의가 없다 (test_SC008_cli_and_spawn_sources_invalid)", () => {
    const deps = definitionDeps("reg008x");
    const sources: readonly WorkSource[] = [
      { kind: "cli" },
      { kind: "spawn", causingTaskId: entityId("task", "tsk_spawncause01") },
    ];
    for (const source of sources) {
      const outcome = proposeFromSource(deps, source, definitionDraft());
      expect(outcome.kind, source.kind).toBe("committed");
      if (outcome.kind !== "committed") continue;
      expect(definitionInvalidReasons(planInvalidIssues(outcome.commit)), source.kind).toEqual([
        "work_source_not_markdown",
      ]);
      expect(typesOf(outcome.commit), source.kind).not.toContain("task_created");
      expect((outcome.aggregate as WorkAggregate).definition, source.kind).toBeUndefined();
    }
  });
});

describe("SC-009: 개정·등록은 관리 관계를 대조한다", () => {
  it("Happy: 관리 Work 의 일치 revision 개정은 유효하다 (test_SC009_matching_steward_amendment_valid)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("reg009"), {
      tasks: STEWARD_MEMBER,
    });
    expectWaitingApproval(
      journal,
      stewardId,
      journal.proposeAmendment(definitionId, {}, ACTION_AT),
    );
  });

  it("Edge: 중지된 정의를 관리했던 Work 의 신규 등록은 already_stewards_definition 이다 (test_SC009_former_steward_new_registration_invalid)", () => {
    const { journal, workId } = reachDefinitionState("STOPPED", "reg009e");
    journal.ensurePlanning(workId, ACTION_AT);
    const proposed = journal.propose(
      workId,
      journal.replanBase(workId, { definition: definitionDraft({ title: "second" }) }),
      ACTION_AT,
    );
    expect(definitionReasonsOf(proposed)).toEqual(["already_stewards_definition"]);
  });

  it("Error: 비관리 Work·중지 정의·불일치 revision 개정이 각각의 사유로 무효다 (test_SC009_amendment_conditions_each_named)", () => {
    // (a) 정의를 관리하지 않는 markdown Work 가 다른 Work 의 정의를 개정한다.
    const active = registerDefinition(definitionDeps("reg009a"), { tasks: STEWARD_MEMBER });
    const outsider = active.journal.createMarkdownWork(ACTION_AT);
    const notSteward = active.journal.propose(
      outsider,
      {
        basePlanRevision: 0,
        source: "planner",
        tasks: [],
        retain: [],
        definition: definitionDraft({
          amends: { definitionId: active.definitionId, expectedRevision: 1 },
        }),
      },
      ACTION_AT,
    );
    expect(definitionReasonsOf(notSteward)).toEqual(["amends_not_steward"]);
    // (b) 중지 정의.
    const stopped = reachDefinitionState("STOPPED", "reg009b");
    expect(
      definitionReasonsOf(stopped.journal.proposeAmendment(stopped.definitionId, {}, ACTION_AT)),
    ).toEqual(["amends_definition_stopped"]);
    // (c) 불일치 revision.
    const mismatch = registerDefinition(definitionDeps("reg009c"), { tasks: STEWARD_MEMBER });
    expect(
      definitionReasonsOf(
        mismatch.journal.proposeAmendment(mismatch.definitionId, {}, ACTION_AT, {
          expectedRevision: 7,
        }),
      ),
    ).toEqual(["amends_revision_mismatch"]);
  });
});

describe("SC-010: 활성화는 반복 일정 또는 외부 신호다", () => {
  it("Happy: 반복 at·signal·신호 상한 1 초안이 유효하다 (test_SC010_recurring_at_and_signal_with_bound_one_valid)", () => {
    const drafts = [
      definitionDraft({ maxOpenOccurrences: 1 }),
      signalDefinitionDraft({ maxOpenOccurrences: 1 }),
      signalDefinitionDraft({ maxOccurrences: 1 }),
    ];
    drafts.forEach((draftContent, i) => {
      const { journal, workId, outcome } = proposeDraft(
        definitionDeps(`reg010h${i}`),
        draftContent,
      );
      expectWaitingApproval(journal, workId, outcome);
    });
  });

  it("Edge: 상한 0·1.5, 일정 활성화의 maxOccurrences, 신호 maxOccurrences 0 이 각각의 사유로 무효다 (test_SC010_bound_and_max_occurrences_invalid)", () => {
    const cases: readonly [string, unknown, string][] = [
      ["bound 0", definitionDraft({ maxOpenOccurrences: 0 }), "max_open_occurrences_invalid"],
      ["bound 1.5", definitionDraft({ maxOpenOccurrences: 1.5 }), "max_open_occurrences_invalid"],
      ["schedule max", definitionDraft({ maxOccurrences: 3 }), "max_occurrences_not_allowed"],
      ["signal max 0", signalDefinitionDraft({ maxOccurrences: 0 }), "max_occurrences_invalid"],
    ];
    cases.forEach(([label, draftContent, reason], i) => {
      const { outcome } = proposeDraft(definitionDeps(`reg010e${i}`), draftContent);
      expect(definitionReasonsOf(outcome), label).toEqual([reason]);
    });
  });

  it("Error: immediate·after·dependencies_complete·1회성 at 은 활성화가 아니다 (test_SC010_non_activation_kinds_invalid)", () => {
    const oneShotAt = { ...dailyActivation() } as Record<string, unknown>;
    delete oneShotAt["recurrence"];
    const after = {
      kind: "after",
      version: 1,
      triggerId: "later",
      durationMs: 60_000,
      scheduledForUtc: dayAt(0),
      misfire: { kind: "skip" },
    };
    const cases: readonly [string, unknown, string][] = [
      [
        "immediate",
        { kind: "immediate", version: 1, triggerId: "now" },
        "activation_kind_not_allowed",
      ],
      ["after", after, "activation_kind_not_allowed"],
      [
        "dependencies_complete",
        { kind: "dependencies_complete", version: 1, triggerId: "deps" },
        "activation_kind_not_allowed",
      ],
      ["one-shot at", oneShotAt, "activation_kind_not_allowed"],
      [
        "after+recurrence",
        { ...after, recurrence: { rule: "test-daily 07:00", anchorUtc: dayAt(0) } },
        "activation_schema_invalid",
      ],
    ];
    cases.forEach(([label, activation, reason], i) => {
      const { outcome } = proposeDraft(
        definitionDeps(`reg010x${i}`),
        definitionDraft({ activation: activation as TriggerSpec }),
      );
      expect(definitionReasonsOf(outcome), label).toEqual([reason]);
    });
  });
});

describe("SC-011: 템플릿은 회차 Work 의 첫 계획으로 검증된다", () => {
  it("Happy: 유효 템플릿이 통과한다 (test_SC011_valid_template_passes)", () => {
    const { journal, workId, outcome } = proposeDraft(
      definitionDeps("reg011"),
      definitionDraft({
        template: [templateDraft("a"), templateDraft("b", { dependsOn: [{ draftRef: "a" }] })],
      }),
    );
    expectWaitingApproval(journal, workId, outcome);
  });

  it("Edge: 등록 Work member 를 부모로 둔 템플릿과 Trigger 반복을 단 템플릿이 무효다 (test_SC011_template_parent_and_recurrence_invalid)", () => {
    const registered = registerDefinition(definitionDeps("reg011e"), { tasks: STEWARD_MEMBER });
    const memberId = registered.journal.work(registered.stewardId).work.memberTaskIds[0];
    if (memberId === undefined) throw new Error("expected steward member");
    const parentDraft = definitionDraft({
      template: [templateDraft("child", { parent: { taskId: memberId } })],
    });
    const other = proposeDraft(definitionDeps("reg011e1"), parentDraft);
    expect(templateIssuesOf(other.outcome).map((i) => i["kind"])).toEqual(["unknown_parent"]);

    const recurring = definitionDraft({
      template: [templateDraft("tick", { trigger: dailyActivation({ triggerId: "tick" }) })],
    });
    const recurringIssues = templateIssuesOf(
      proposeDraft(definitionDeps("reg011e2"), recurring).outcome,
    );
    expect(recurringIssues.map((i) => i["kind"])).toEqual(["draft_invalid"]);
    expect(JSON.stringify(recurringIssues)).toContain("recurrence_not_allowed_on_task_trigger");
  });

  it("Error: 필수 member 없음·미등록 TaskType·의존 순환 템플릿이 무효다 (test_SC011_template_required_type_cycle_invalid)", () => {
    const noRequired = definitionDraft({
      template: [templateDraft("opt", { policy: basePolicy({ terminalRequired: false }) })],
    });
    expect(
      templateIssuesOf(proposeDraft(definitionDeps("reg011x1"), noRequired).outcome).map(
        (i) => i["kind"],
      ),
    ).toEqual(["no_terminal_required_member"]);
    const unknownType = definitionDraft({
      template: [templateDraft("ghost", { type: { id: "probe_missing", version: 1 } })],
    });
    const typeIssues = templateIssuesOf(
      proposeDraft(definitionDeps("reg011x2"), unknownType).outcome,
    );
    expect(typeIssues.map((i) => i["kind"])).toEqual(["draft_invalid"]);
    const cycle = definitionDraft({
      template: [
        templateDraft("a", { dependsOn: [{ draftRef: "b" }] }),
        templateDraft("b", { dependsOn: [{ draftRef: "a" }] }),
      ],
    });
    expect(
      templateIssuesOf(proposeDraft(definitionDeps("reg011x3"), cycle).outcome).map(
        (i) => i["kind"],
      ),
    ).toContain("dependency_cycle");
  });
});

describe("SC-012: 템플릿 회차 결합은 활성화가 제공하는 필드만 쓴다", () => {
  const scheduleDraft = (template: readonly PlanTaskDraft[]) => definitionDraft({ template });
  const signalDraft = (template: readonly PlanTaskDraft[]) => signalDefinitionDraft({ template });

  it("Happy: 일정 템플릿의 세 필드와 신호 템플릿의 signal 결합이 유효하다 (test_SC012_activation_fields_bindings_valid)", () => {
    const schedule = proposeDraft(
      occurrenceConsumerDeps("reg012h1"),
      scheduleDraft([
        templateDraft("consumer", {
          type: OCCURRENCE_CONSUMER,
          input: {},
          inputBindings: {
            when: { from: "occurrence", field: "scheduledForUtc" },
            day: { from: "occurrence", field: "localDate" },
            zone: { from: "occurrence", field: "timezone" },
          },
        } as never),
      ]),
    );
    expectWaitingApproval(schedule.journal, schedule.workId, schedule.outcome);
    const signal = proposeDraft(
      occurrenceConsumerDeps("reg012h2"),
      signalDraft([bindingTemplate("event", "signal")]),
    );
    expectWaitingApproval(signal.journal, signal.workId, signal.outcome);
  });

  it("Edge: 증명할 수 없는 소비자 스키마는 binding_schema_incompatible 이다 (test_SC012_unprovable_occurrence_binding_incompatible)", () => {
    const { outcome } = proposeDraft(
      occurrenceConsumerDeps("reg012e"),
      scheduleDraft([bindingTemplate("count", "localDate")]),
    );
    expect(templateIssuesOf(outcome).map((i) => i["kind"])).toEqual([
      "binding_schema_incompatible",
    ]);
  });

  it("Error: 활성화가 제공하지 않는 회차 필드는 binding_occurrence_field_unavailable 이다 (test_SC012_foreign_activation_field_unavailable)", () => {
    // 이슈의 field 는 제공되지 않은 회차 필드 이름이다.
    const scheduleSignal = proposeDraft(
      occurrenceConsumerDeps("reg012x1"),
      scheduleDraft([bindingTemplate("event", "signal")]),
    );
    expect(templateIssuesOf(scheduleSignal.outcome)).toEqual([
      { kind: "binding_occurrence_field_unavailable", draftRef: "consumer", field: "signal" },
    ]);
    const signalDate = proposeDraft(
      occurrenceConsumerDeps("reg012x2"),
      signalDraft([bindingTemplate("day", "localDate")]),
    );
    expect(templateIssuesOf(signalDate.outcome)).toEqual([
      { kind: "binding_occurrence_field_unavailable", draftRef: "consumer", field: "localDate" },
    ]);
  });

  it("Edge: 안전 관련 필드의 회차 결합은 제공 필드 검사보다 먼저 binding_safety_field 다 (test_SC012_occurrence_binding_to_safety_field_refused_first)", () => {
    const cases: readonly [string, unknown, string][] = [
      ["schedule string", scheduleDraft([bindingTemplate("target", "scheduledForUtc")]), "target"],
      ["signal object", signalDraft([bindingTemplate("secretEvent", "signal")]), "secretEvent"],
      ["not provided", scheduleDraft([bindingTemplate("secretEvent", "signal")]), "secretEvent"],
    ];
    cases.forEach(([label, draftContent, field], i) => {
      const { outcome } = proposeDraft(occurrenceConsumerDeps(`reg012s${i}`), draftContent);
      expect(templateIssuesOf(outcome), label).toEqual([
        { kind: "binding_safety_field", draftRef: "consumer", field },
      ]);
    });
    // 대조: 같은 결합을 안전 관련이 아닌 문자열 필드에 두면 유효하다.
    const control = proposeDraft(
      occurrenceConsumerDeps("reg012sc"),
      scheduleDraft([bindingTemplate("when", "scheduledForUtc")]),
    );
    expectWaitingApproval(control.journal, control.workId, control.outcome);
  });
});

describe("SC-013: 정의 관련 계획은 필수 member 없이 유효하다", () => {
  it("Happy: 정의 초안 제안과 관리 Work 재계획이 필수 member 없이 유효하다 (test_SC013_definition_and_steward_plans_without_required_valid)", () => {
    const { journal, workId, outcome } = proposeDraft(definitionDeps("reg013"), definitionDraft());
    expectWaitingApproval(journal, workId, outcome);
    expect(journal.decidePlan(workId, "grant", DEF_NOW).kind).toBe("accepted");
    journal.ensurePlanning(workId, ACTION_AT);
    const replanned = journal.commitPlan(
      workId,
      journal.replanBase(workId, { tasks: [] }),
      ACTION_AT,
    );
    expect(issuesOf(replanned)).toEqual([]);
    expect(typesOf((replanned as { commit: Parameters<typeof typesOf>[0] }).commit)).toContain(
      "work_plan_committed",
    );
  });

  it("Edge: 중지 정의의 관리 Work 빈 계획이 유효하다 (test_SC013_stopped_steward_empty_plan_valid)", () => {
    const { journal, workId } = reachDefinitionState("STOPPED", "reg013e");
    journal.ensurePlanning(workId, ACTION_AT);
    const proposed = journal.propose(
      workId,
      journal.replanBase(workId, { tasks: [], retain: [] }),
      ACTION_AT,
    );
    expect(issuesOf(proposed)).toEqual([]);
    expect(journal.work(workId).work.state).toBe("WAITING_APPROVAL");
  });

  it("Error: 정의와 무관한 Work 의 필수 member 없는 계획은 no_terminal_required_member 다 (test_SC013_unrelated_work_without_required_invalid)", () => {
    const { journal } = registerDefinition(definitionDeps("reg013x"));
    const unrelated = journal.createMarkdownWork(ACTION_AT);
    const outcome = journal.commitPlan(
      unrelated,
      {
        basePlanRevision: 0,
        source: "planner",
        tasks: [templateDraft("opt", { policy: basePolicy({ terminalRequired: false }) })],
        retain: [],
      },
      ACTION_AT,
    );
    expect(issuesOf(outcome)).toEqual([{ kind: "no_terminal_required_member" }]);
  });
});

describe("SC-014: 정의 revision 이 바뀐 커밋은 대기 개정 제안을 재검증한다", () => {
  it("Happy: 개정 대기 중 일시정지 수용 커밋이 제안을 철회하고 이후 grant 는 낡음이다 (test_SC014_pause_withdraws_pending_amendment_then_grant_stale)", () => {
    const { journal, stewardId, definitionId, decisionId } = pendingAmendment("reg014");
    const paused = journal.control(definitionId, "pause", ACTION_AT);
    expect(paused.kind).toBe("accepted");
    if (paused.kind === "accepted") {
      expect(typesOf(paused.commit)).toEqual(
        expect.arrayContaining(["work_definition_paused", "work_plan_withdrawn"]),
      );
      const withdrawn = paused.commit.events.find((e) => e.type === "work_plan_withdrawn");
      expect((withdrawn?.payload as { cause?: string } | undefined)?.cause).toBe(
        "no_longer_validates",
      );
    }
    expect(journal.work(stewardId).work.pendingDecision).toBeUndefined();
    const before = journal.definition(definitionId);
    const grant = journal.decidePlan(stewardId, "grant", ACTION_AT, { decisionId });
    expect(grant.kind).toBe("rejected_stale");
    expect(journal.definition(definitionId)).toEqual(before);
  });

  it("Edge: 정의 초안 없는 대기 제안은 일시정지로 철회되지 않는다 (test_SC014_pending_plain_proposal_not_withdrawn)", () => {
    const { journal, stewardId, definitionId } = registerDefinition(definitionDeps("reg014e"), {
      tasks: STEWARD_MEMBER,
    });
    journal.ensurePlanning(stewardId, ACTION_AT);
    journal.propose(
      stewardId,
      journal.replanBase(stewardId, { tasks: [templateDraft("extra")] }),
      ACTION_AT,
    );
    expect(journal.work(stewardId).work.state).toBe("WAITING_APPROVAL");
    const paused = journal.control(definitionId, "pause", ACTION_AT);
    expect(paused.kind).toBe("accepted");
    if (paused.kind === "accepted")
      expect(typesOf(paused.commit)).not.toContain("work_plan_withdrawn");
    expect(journal.work(stewardId).work.state).toBe("WAITING_APPROVAL");
  });

  it("Error: 정의 revision 을 바꾸지 않는 회차 커밋은 재검증·철회하지 않는다 (test_SC014_revision_neutral_commit_no_revalidation)", () => {
    const { journal, stewardId, definitionId } = pendingAmendment("reg014x");
    const materialized = journal.resolveDue(definitionId, dayAt(0));
    expect(materialized.kind).toBe("committed");
    const held = journal.resolveDue(definitionId, dayAt(1));
    expect(held.kind).toBe("committed");
    for (const outcome of [materialized, held]) {
      if (outcome.kind === "committed")
        expect(typesOf(outcome.commit)).not.toContain("work_plan_withdrawn");
    }
    expect(journal.work(stewardId).work.state).toBe("WAITING_APPROVAL");
  });
});

describe("SC-015: 중지는 대기 개정 제안을 철회한다", () => {
  it("Happy: 노트 중지 커밋에 정의 중지와 제안 철회가 함께 있다 (test_SC015_vault_stop_withdraws_pending_amendment)", () => {
    const { journal, definitionId } = pendingAmendment("reg015");
    const stopped = journal.control(definitionId, "stop", ACTION_AT);
    expect(stopped.kind).toBe("accepted");
    if (stopped.kind === "accepted") {
      expect(typesOf(stopped.commit)).toEqual(
        expect.arrayContaining(["work_definition_stopped", "work_plan_withdrawn"]),
      );
    }
  });

  it("Edge: 제어 요청 중지도 같다 (test_SC015_control_request_stop_withdraws)", () => {
    const { journal, definitionId } = pendingAmendment("reg015e");
    const stopped = journal.control(definitionId, "stop", ACTION_AT, {
      channel: "control_request",
    });
    expect(stopped.kind).toBe("accepted");
    if (stopped.kind === "accepted") {
      expect(typesOf(stopped.commit)).toEqual(
        expect.arrayContaining(["work_definition_stopped", "work_plan_withdrawn"]),
      );
    }
  });

  it("Error: 낡은 중지 신호는 철회하지 않고 정의가 그대로다 (test_SC015_stale_stop_no_withdrawal)", () => {
    const { journal, stewardId, definitionId } = pendingAmendment("reg015x");
    const before = journal.definition(definitionId);
    const stale = journal.control(definitionId, "stop", ACTION_AT, { expectedRevision: 0 });
    expect(stale.kind).toBe("rejected_stale");
    if (stale.kind === "rejected_stale")
      expect(typesOf(stale.commit)).toEqual(["signal_rejected_stale"]);
    expect(journal.definition(definitionId)).toEqual(before);
    expect(journal.work(stewardId).work.state).toBe("WAITING_APPROVAL");
  });
});
