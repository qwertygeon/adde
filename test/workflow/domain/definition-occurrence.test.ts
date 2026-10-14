// 회차 ID 파생·신호 회차 중복·materialize 커밋·템플릿 digest·재요청·독립성·대기 행 등록.
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  BUILTIN_REACTIONS,
  BUILTIN_TASK_TYPES,
  BUILTIN_TRIGGERS,
  DomainInvariantError,
  buildTemplateProposal,
  canonicalJson,
  createDomainRegistries,
  deriveOccurrenceId,
  executeDefinitionCommand,
  openOccurrenceCount,
} from "../../../src/workflow/domain/index.js";
import type {
  CommandOutcome,
  DomainCommit,
  DomainDeps,
  OccurrenceId,
  TaskId,
  TriggerDescriptor,
  WorkId,
} from "../../../src/workflow/domain/index.js";
import {
  DEF_NOW,
  dailyActivation,
  dayAt,
  definitionDeps,
  definitionDraft,
  firstTaskOf,
  payloadsOf,
  registerAndMaterializeFirst,
  registerDefinition,
  signalDefinitionDraft,
  templateDraft,
  typesOf,
} from "./helpers/definition-fixtures.js";
import type { WorkflowJournal } from "./helpers/definition-fixtures.js";
import { WorkflowJournal as Journal } from "./helpers/definition-fixtures.js";
import {
  at,
  basePolicy,
  entityId,
  meta,
  mustOk,
  patchTask,
  taskSubjectPendingDecision,
} from "./helpers/fixtures.js";
import { GENERIC_TASK_TYPE } from "./helpers/registry-fixtures.js";

const OCC_FORMAT = /^occ_[A-Z2-7]{26}$/;

function committedCommit(
  outcome: CommandOutcome | { kind: string; commit?: DomainCommit },
): DomainCommit {
  if (outcome.kind !== "committed" || outcome.commit === undefined) {
    throw new Error(`expected committed, got ${outcome.kind}`);
  }
  return outcome.commit;
}

/** 열린 회차 상한 2 일일 정의에 회차 Work 둘(03-01·03-02)을 둔다. */
function twoOpenOccurrences(seed: string) {
  const registered = registerDefinition(definitionDeps(seed), {
    draft: definitionDraft({ maxOpenOccurrences: 2 }),
  });
  const { journal, definitionId } = registered;
  committedCommit(journal.resolveDue(definitionId, dayAt(0)));
  committedCommit(journal.resolveDue(definitionId, dayAt(1)));
  const [a, b] = journal.occurrenceWorkIds(definitionId);
  if (a === undefined || b === undefined) throw new Error("expected two occurrence works");
  return { ...registered, a, b };
}

describe("SC-021: 정의 소유 occurrence ID 는 결정적이고 Task 소유와 분리된다", () => {
  const input = {
    kind: "schedule" as const,
    ownerId: entityId("workDefinition", "wdf_fixture000001"),
    triggerId: "daily",
    scheduledForUtc: dayAt(0),
    recurrenceIndex: 0,
  };

  it("Happy: 같은 입력의 정의 소유 파생은 같은 ID 이고 형식을 지킨다 (test_SC021_definition_owned_occurrence_id_stable)", () => {
    const first = mustOk(deriveOccurrenceId(input));
    expect(mustOk(deriveOccurrenceId({ ...input }))).toBe(first);
    expect(first).toMatch(OCC_FORMAT);
    const { journal, definitionId } = registerDefinition(definitionDeps("occ021"));
    expect(journal.definition(definitionId).pendingSchedule?.occurrenceId).toBe(
      mustOk(deriveOccurrenceId({ ...input, ownerId: definitionId })),
    );
  });

  it("Edge: 같은 값의 Task 소유 파생은 다른 ID 다 (test_SC021_task_owner_same_values_different_id)", () => {
    const taskOwned = mustOk(
      deriveOccurrenceId({ ...input, ownerId: entityId("task", "tsk_fixture000001") }),
    );
    expect(taskOwned).not.toBe(mustOk(deriveOccurrenceId(input)));
  });

  it("Error: 단위 구분자를 담은 triggerId 는 파생 오류다 (test_SC021_separator_in_trigger_id_refused)", () => {
    expect(deriveOccurrenceId({ ...input, triggerId: "dai\u001fly" })).toEqual({
      ok: false,
      error: { kind: "derivation_input", field: "triggerId", reason: "contains_unit_separator" },
    });
  });
});

describe("SC-022: 같은 출처 회차의 재전달은 중복이다", () => {
  it("Happy: 같은 출처 회차의 둘째 신호는 signal_ignored_duplicate 이고 회차가 늘지 않는다 (test_SC022_same_source_occurrence_duplicate)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ022"), {
      draft: signalDefinitionDraft(),
    });
    expect(journal.external(definitionId, "src-1", dayAt(0)).kind).toBe("accepted");
    const second = journal.external(definitionId, "src-1", dayAt(0, "07:05"));
    expect(second.kind).toBe("duplicate");
    if (second.kind === "duplicate")
      expect(typesOf(second.commit)).toEqual(["signal_ignored_duplicate"]);
    expect(journal.definition(definitionId).materialized).toHaveLength(1);
    expect(journal.definition(definitionId).held).toHaveLength(0);
  });

  it("Edge: 같은 내용·다른 출처 회차는 다른 occurrence ID 회차다 (test_SC022_different_source_occurrence_new_occurrence)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ022e"), {
      draft: signalDefinitionDraft({ maxOpenOccurrences: 2 }),
    });
    for (const source of ["src-1", "src-2"]) {
      expect(
        journal.external(definitionId, source, dayAt(0), { payload: { same: true } }).kind,
      ).toBe("accepted");
    }
    const ids = journal.definition(definitionId).materialized.map((m) => m.occurrenceId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("Error: 짝 없는 서로게이트 출처 ID 는 not_applicable 이고 기록이 없다 (test_SC022_unpaired_surrogate_not_applicable)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ022x"), {
      draft: signalDefinitionDraft(),
    });
    const commitsBefore = journal.commits.length;
    const judged = journal.external(definitionId, "src-\uD800", dayAt(0));
    expect(judged.kind).toBe("not_applicable");
    if (judged.kind === "not_applicable") expect(judged.rejection.reason).toBe("invalid_input");
    expect(journal.commits.length).toBe(commitsBefore);
  });
});

describe("SC-023: materialize 커밋", () => {
  it("Happy: materialize 커밋의 이벤트 순서가 정해져 있고 결정이 없다 (test_SC023_materialize_commit_event_order)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ023"));
    const commit = committedCommit(journal.resolveDue(definitionId, dayAt(0)));
    expect(typesOf(commit)).toEqual([
      "trigger_fired",
      "work_created",
      "work_planning_started",
      "task_created",
      "work_plan_committed",
      "work_ready",
    ]);
    expect(payloadsOf(commit, "work_plan_committed")[0]?.["source"]).toBe("definition_template");
    const workId = journal.occurrenceWorkIds(definitionId)[0] as WorkId;
    expect(journal.work(workId).work.pendingDecision).toBeUndefined();
    expect(journal.work(workId).work.state).toBe("READY");
  });

  it("Edge: work_created 가 회차 출처와 회차 입력을 싣는다 (test_SC023_work_created_carries_occurrence_input)", () => {
    // 서울 07:00 = 전날 22:00Z — 현지 날짜가 UTC 날짜와 달라 localDate 계산을 가른다.
    const anchor = at("2026-02-28T22:00:00Z");
    const { journal, definitionId } = registerDefinition(definitionDeps("occ023e"), {
      draft: definitionDraft({
        activation: dailyActivation({ timezone: "Asia/Seoul", anchorUtc: anchor }),
      }),
    });
    const occurrenceId = journal.definition(definitionId).pendingSchedule?.occurrenceId;
    const commit = committedCommit(journal.resolveDue(definitionId, anchor));
    expect(payloadsOf(commit, "work_created")[0]?.["source"]).toEqual({
      kind: "definition_occurrence",
      definitionId,
      definitionRevision: 1,
      occurrenceId,
      input: {
        occurrenceId,
        definitionId,
        definitionRevision: 1,
        scheduledForUtc: anchor,
        localDate: "2026-03-01",
        timezone: "Asia/Seoul",
      },
    });
  });

  it("Edge: materialize 는 재정규화 결과가 아니라 승인된 정의 템플릿 스냅숏을 커밋한다 (test_SC023_materialize_commits_definition_template_snapshot)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ023s"));
    const snapshot = journal.definition(definitionId).template;
    // 등록부 drift 대용: 내장 immediate@1 의 스키마가 triggerId 를 바꿔 정규화하는 등록부.
    const immediate = BUILTIN_TRIGGERS.find((t) => t.kind === "immediate") as TriggerDescriptor;
    const renormalizing: TriggerDescriptor = {
      ...immediate,
      schema: z.strictObject({
        kind: z.literal("immediate"),
        version: z.literal(1),
        triggerId: z
          .string()
          .min(1)
          .transform((id) => `${id}renorm`),
      }),
    };
    const variant = mustOk(
      createDomainRegistries({
        taskTypes: [...BUILTIN_TASK_TYPES, GENERIC_TASK_TYPE],
        triggers: BUILTIN_TRIGGERS.map((t) => (t.kind === "immediate" ? renormalizing : t)),
        reactions: BUILTIN_REACTIONS,
      }),
    );
    // 자기 점검: 변형 등록부는 템플릿 Trigger 를 실제로 다르게 정규화한다.
    const templateTrigger = snapshot[0]?.trigger;
    const reparsed = renormalizing.schema.parse(templateTrigger) as { triggerId: string };
    expect(reparsed.triggerId).not.toBe(templateTrigger?.triggerId);
    const drifted = new Journal(
      { ...journal.deps, registries: variant },
      journal.state,
      journal.commits,
    );
    const commit = committedCommit(drifted.resolveDue(definitionId, dayAt(0)));
    const created = payloadsOf(commit, "task_created");
    expect(created).toHaveLength(snapshot.length);
    expect(canonicalJson(created[0]?.["trigger"])).toEqual(canonicalJson(templateTrigger));
  });

  it("Error: 도래하지 않은 회차 처리는 occurrence_not_due 이고 커밋이 없다 (test_SC023_not_due_occurrence_refused)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ023x"));
    const commitsBefore = journal.commits.length;
    expect(journal.resolveDue(definitionId, dayAt(0, "06:59:59.999"))).toEqual({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "occurrence_not_due" },
    });
    expect(journal.commits.length).toBe(commitsBefore);
    // 대조: 그 시각에는 커밋된다.
    expect(journal.resolveDue(definitionId, dayAt(0)).kind).toBe("committed");
  });
});

describe("SC-024: 템플릿 제안 digest 는 정의 revision·회차에 묶인다", () => {
  function inputFor(
    journal: WorkflowJournal,
    definitionId: Parameters<WorkflowJournal["definition"]>[0],
    k: number,
  ) {
    const definition = journal.definition(definitionId);
    const occurrenceId = mustOk(
      deriveOccurrenceId({
        kind: "schedule",
        ownerId: definitionId,
        triggerId: "daily",
        scheduledForUtc: dayAt(k),
        recurrenceIndex: k,
      }),
    );
    return {
      definition,
      occurrence: {
        occurrenceId,
        input: {
          occurrenceId,
          definitionId,
          definitionRevision: definition.revision,
          scheduledForUtc: dayAt(k),
          localDate: dayAt(k).slice(0, 10),
          timezone: "UTC",
        },
      },
    };
  }
  function digestOf(deps: DomainDeps, view: ReturnType<typeof inputFor>): string {
    const check = buildTemplateProposal(deps, view.definition, view.occurrence as never);
    if (!check.valid) throw new Error(`template invalid ${JSON.stringify(check.issues)}`);
    return check.digest;
  }

  it("Happy: 같은 revision·회차는 digest 가 같다 (test_SC024_template_digest_deterministic)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ024"));
    const view = inputFor(journal, definitionId, 0);
    expect(digestOf(journal.deps, view)).toBe(
      digestOf(journal.deps, inputFor(journal, definitionId, 0)),
    );
  });

  it("Edge: 같은 revision·다른 회차는 digest 가 다르다 (test_SC024_other_occurrence_digest_differs)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ024e"));
    expect(digestOf(journal.deps, inputFor(journal, definitionId, 0))).not.toBe(
      digestOf(journal.deps, inputFor(journal, definitionId, 1)),
    );
  });

  it("Error: 다른 revision 은 digest 가 다르다 (test_SC024_other_revision_digest_differs)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ024x"));
    const before = digestOf(journal.deps, inputFor(journal, definitionId, 0));
    expect(journal.control(definitionId, "pause", DEF_NOW).kind).toBe("accepted");
    expect(journal.definition(definitionId).revision).toBe(2);
    expect(digestOf(journal.deps, inputFor(journal, definitionId, 0))).not.toBe(before);
  });
});

describe("SC-025: 같은 회차는 두 번 materialize 되지 않는다", () => {
  it("Happy: materialize 된 회차의 재요청은 occurrence_already_materialized 다 (test_SC025_second_materialize_request_commits_nothing)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ025"));
    const occurrenceId = journal.definition(definitionId).pendingSchedule
      ?.occurrenceId as OccurrenceId;
    committedCommit(journal.resolveDue(definitionId, dayAt(0)));
    const commitsBefore = journal.commits.length;
    expect(journal.resolveDue(definitionId, dayAt(0, "07:01"), { occurrenceId })).toEqual({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "occurrence_already_materialized" },
    });
    expect(journal.release(definitionId, dayAt(0, "07:01"), { occurrenceId })).toEqual({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "occurrence_already_materialized" },
    });
    expect(journal.commits.length).toBe(commitsBefore);
  });

  it("Edge: 개정 뒤에도 기존 회차 Work 는 materialize 때의 정의 revision 을 유지한다 (test_SC025_occurrence_work_keeps_materialized_revision)", () => {
    const { journal, definitionId, firstWorkId } = registerAndMaterializeFirst(
      definitionDeps("occ025e"),
    );
    expect(journal.amend(definitionId, { title: "revised" }, dayAt(0, "08:00")).kind).toBe(
      "accepted",
    );
    expect(journal.definition(definitionId).revision).toBe(2);
    const source = journal.work(firstWorkId).work.source as { definitionRevision?: number };
    expect(source.definitionRevision).toBe(1);
    expect(journal.definition(definitionId).materialized[0]?.definitionRevision).toBe(1);
  });

  it("Error: 가장 오래되지 않은 보류의 해제는 occurrence_not_oldest_held 다 (test_SC025_non_oldest_held_release_refused)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ025x"), {
      draft: definitionDraft({
        activation: dailyActivation({ misfire: { kind: "catch_up_bounded", maxCatchUp: 2 } }),
      }),
    });
    committedCommit(journal.resolveDue(definitionId, dayAt(0)));
    committedCommit(journal.resolveDue(definitionId, dayAt(1)));
    committedCommit(journal.resolveDue(definitionId, dayAt(2)));
    const held = journal.definition(definitionId).held;
    expect(held).toHaveLength(2);
    journal.completeWork(journal.occurrenceWorkIds(definitionId)[0] as WorkId, dayAt(2, "08:00"));
    expect(
      journal.release(definitionId, dayAt(2, "08:00"), {
        occurrenceId: held[1]?.occurrenceId as OccurrenceId,
      }),
    ).toEqual({
      kind: "rejected",
      rejection: { reason: "condition_not_met", detail: "occurrence_not_oldest_held" },
    });
    // 대조: 가장 오래된 보류는 해제된다.
    expect(journal.release(definitionId, dayAt(2, "08:00")).kind).toBe("committed");
  });
});

describe("SC-026: 정의 변경은 회차 Work 를 바꾸지 않는다", () => {
  it("Happy: 열린 회차 Work 둘은 개정·일시정지·중지 뒤에도 그대로다 (test_SC026_definition_changes_leave_occurrence_works)", () => {
    const { journal, definitionId, a, b } = twoOpenOccurrences("occ026");
    const before = [journal.work(a), journal.work(b)];
    expect(journal.amend(definitionId, { title: "revised" }, dayAt(1, "08:00")).kind).toBe(
      "accepted",
    );
    expect(journal.control(definitionId, "pause", dayAt(1, "09:00")).kind).toBe("accepted");
    expect(journal.control(definitionId, "stop", dayAt(1, "10:00")).kind).toBe("accepted");
    expect([journal.work(a), journal.work(b)]).toEqual(before);
  });

  it("Edge: 중지 뒤에도 회차 Work 의 Task 명령은 정상 커밋된다 (test_SC026_occurrence_work_continues_after_stop)", () => {
    const { journal, definitionId, firstWorkId } = registerAndMaterializeFirst(
      definitionDeps("occ026e"),
    );
    expect(journal.control(definitionId, "stop", dayAt(0, "08:00")).kind).toBe("accepted");
    journal.completeWork(firstWorkId, dayAt(0, "09:00"));
    expect(journal.work(firstWorkId).work.state).toBe("COMPLETED");
  });

  it("Error: 관리 Work 취소는 회차 Work 를 바꾸지 않는다 (test_SC026_steward_cancel_leaves_occurrence_works)", () => {
    const { journal, stewardId, a, b } = twoOpenOccurrences("occ026x");
    const before = [journal.work(a), journal.work(b)];
    committedCommit(journal.cancelWork(stewardId, dayAt(1, "08:00")));
    expect([journal.work(a), journal.work(b)]).toEqual(before);
  });
});

describe("SC-027: 회차 Work 의 결과는 정의·다른 회차를 바꾸지 않는다", () => {
  function makeActive(journal: WorkflowJournal, workId: WorkId): TaskId {
    const taskId = firstTaskOf(journal, workId);
    for (const kind of ["begin_validation", "complete_validation", "start_attempt"] as const) {
      committedCommit(journal.onTask(workId, taskId, { kind }, dayAt(1, "07:30")));
    }
    return taskId;
  }

  it("Happy: A 의 실패·취소·재계획·완료가 정의와 B 를 바꾸지 않는다 (test_SC027_occurrence_outcomes_leave_definition_and_sibling)", () => {
    const outcomes: readonly [string, (journal: WorkflowJournal, a: WorkId) => void][] = [
      ["fail", (journal, a) => journal.failMember(a, firstTaskOf(journal, a), dayAt(1, "08:00"))],
      ["cancel", (journal, a) => void committedCommit(journal.cancelWork(a, dayAt(1, "08:00")))],
      [
        "replan",
        (journal, a) => {
          makeActive(journal, a);
          journal.ensurePlanning(a, dayAt(1, "08:00"));
        },
      ],
      ["complete", (journal, a) => journal.completeWork(a, dayAt(1, "08:00"))],
    ];
    outcomes.forEach(([label, run], i) => {
      const { journal, definitionId, a, b } = twoOpenOccurrences(`occ027h${i}`);
      const definitionBefore = journal.definition(definitionId);
      const siblingBefore = journal.work(b);
      const commitsBefore = journal.commits.length;
      run(journal, a);
      expect(journal.definition(definitionId), label).toEqual(definitionBefore);
      expect(journal.work(b), label).toEqual(siblingBefore);
      const types = journal.commits.slice(commitsBefore).flatMap(typesOf);
      expect(
        types.filter((t) => t.startsWith("work_definition_") || t.startsWith("trigger_")),
        label,
      ).toEqual([]);
    });
  });

  it("Edge: 열린 회차 수는 A 가 종결일 때만 줄고 재계획으로는 줄지 않는다 (test_SC027_only_terminal_frees_slot)", () => {
    const replanned = twoOpenOccurrences("occ027e1");
    makeActive(replanned.journal, replanned.a);
    replanned.journal.ensurePlanning(replanned.a, dayAt(1, "08:00"));
    expect(
      openOccurrenceCount(
        replanned.journal.state,
        replanned.journal.definition(replanned.definitionId),
      ),
    ).toBe(2);
    const completed = twoOpenOccurrences("occ027e2");
    completed.journal.completeWork(completed.a, dayAt(1, "08:00"));
    expect(
      openOccurrenceCount(
        completed.journal.state,
        completed.journal.definition(completed.definitionId),
      ),
    ).toBe(1);
  });

  it("Error: A 취소 커밋에 정의 이벤트가 없다 (test_SC027_occurrence_cancel_has_no_definition_event)", () => {
    const { journal, a } = twoOpenOccurrences("occ027x");
    const commit = committedCommit(journal.cancelWork(a, dayAt(1, "08:00")));
    expect(typesOf(commit)).toContain("work_canceled");
    expect(
      typesOf(commit).filter((t) => t.startsWith("work_definition_") || t.startsWith("trigger_")),
    ).toEqual([]);
  });
});

describe("SC-028: 회차 Work 의 Task 는 사람 Work 의 Task 와 같은 판정을 받는다", () => {
  /** 같은 초안을 템플릿으로 가진 정의의 회차 Work Task 와 사람 Work Task. */
  function pair(seed: string, policy: ReturnType<typeof basePolicy>) {
    const template = [templateDraft("t", { policy })];
    const { journal, firstWorkId } = registerAndMaterializeFirst(
      definitionDeps(seed),
      definitionDraft({ template }),
    );
    const human = journal.createMarkdownWork(dayAt(0, "07:00"), "doc-human");
    committedCommit(
      journal.commitPlan(
        human,
        { basePlanRevision: 0, source: "planner", tasks: template, retain: [] },
        dayAt(0),
      ),
    );
    return { journal, works: [firstWorkId, human] as const };
  }
  function sequence(
    journal: WorkflowJournal,
    workId: WorkId,
    steps: readonly ((taskId: TaskId) => Parameters<WorkflowJournal["onTask"]>[2])[],
  ): string[] {
    const taskId = firstTaskOf(journal, workId);
    return steps.map((step) => {
      const outcome = journal.onTask(workId, taskId, step(taskId), dayAt(0, "07:10"));
      return outcome.kind === "committed"
        ? `${typesOf(outcome.commit).join(",")}→${journal.task(workId, taskId).state}`
        : `${outcome.kind}:${outcome.kind === "rejected" ? outcome.rejection.reason : ""}`;
    });
  }

  it("Happy: 실행 전 승인 정책 Task 는 두 Work 에서 같은 주차 이벤트를 낸다 (test_SC028_occurrence_task_same_pre_execution_park)", () => {
    const { journal, works } = pair("occ028", basePolicy({ approvalRequiredBeforeExecute: true }));
    const steps = [
      () => ({ kind: "begin_validation" as const }),
      () => ({ kind: "complete_validation" as const }),
      () => ({ kind: "start_attempt" as const }),
    ];
    const [occurrence, human] = works.map((w) => sequence(journal, w, steps));
    expect(occurrence).toEqual(human);
    expect(occurrence?.join(" ")).toContain("task_awaiting_human");
  });

  it("Edge: 무인 적격이 아닌 주차 원인이 두 Work 에서 같다 (test_SC028_occurrence_task_same_unattended_refusal)", () => {
    const { journal, works } = pair("occ028e", basePolicy());
    const steps = [
      () => ({ kind: "begin_validation" as const }),
      () => ({ kind: "complete_validation" as const }),
      (taskId: TaskId) => ({
        kind: "park_awaiting_human" as const,
        cause: "unattended_eligibility_refused" as const,
        decision: taskSubjectPendingDecision(journal.deps, taskId, dayAt(0, "07:10")),
      }),
    ];
    const [occurrence, human] = works.map((w) => sequence(journal, w, steps));
    expect(occurrence).toEqual(human);
    expect(occurrence?.[2]).toContain("BLOCKED_AWAITING_HUMAN");
  });

  it("Error: 승인 채널 거절 정책이 두 Work 에서 같은 거절 기록을 낸다 (test_SC028_occurrence_task_same_surface_refusal)", () => {
    const { journal, works } = pair("occ028x", basePolicy());
    const observed = works.map((workId) => {
      const taskId = firstTaskOf(journal, workId);
      committedCommit(
        journal.onTask(workId, taskId, { kind: "begin_validation" }, dayAt(0, "07:10")),
      );
      // 레코드 패치: 같은 등록부로는 계획 커밋이 막는 승인 채널 정책(다른 생성 경로 대용).
      journal.patchWork(workId, (aggregate) =>
        patchTask(aggregate, taskId, {
          policy: basePolicy({
            approvalSurface: "out_of_band",
            approvalRequiredBeforeExecute: true,
          }),
        }),
      );
      const outcome = journal.onTask(
        workId,
        taskId,
        { kind: "complete_validation" },
        dayAt(0, "07:11"),
      );
      return outcome.kind === "committed"
        ? [typesOf(outcome.commit), payloadsOf(outcome.commit, "approval_surface_refused")]
        : [outcome.kind];
    });
    expect(observed[0]).toEqual(observed[1]);
    expect(JSON.stringify(observed[0])).toContain("approval_surface_refused");
  });
});

describe("SC-041: 해소 커밋마다 다음 회차 대기 행이 하나 등록된다", () => {
  it("Happy: 생성·materialize·보류·건너뜀 커밋 뒤 다음 회차가 하나씩, 번호가 1 씩 오른다 (test_SC041_each_resolution_registers_next_index)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ041"));
    const indexes = [journal.definition(definitionId).pendingSchedule?.recurrenceIndex];
    for (const k of [0, 1, 2]) {
      committedCommit(journal.resolveDue(definitionId, dayAt(k)));
      indexes.push(journal.definition(definitionId).pendingSchedule?.recurrenceIndex);
    }
    expect(indexes).toEqual([0, 1, 2, 3]);
    expect(journal.definition(definitionId).pendingSchedule?.scheduledForUtc).toBe(dayAt(3));
    const lastTypes = typesOf(journal.lastCommit());
    expect(lastTypes).toEqual(
      expect.arrayContaining([
        "work_definition_occurrences_skipped",
        "work_definition_occurrence_held",
      ]),
    );
  });

  it("Edge: 계열 끝 회차 뒤에는 대기 행이 없다 (test_SC041_series_end_no_next_row)", () => {
    const { journal, definitionId } = registerDefinition(definitionDeps("occ041e"), {
      draft: definitionDraft({
        maxOpenOccurrences: 2,
        activation: dailyActivation({ maxOccurrences: 2 }),
      }),
    });
    committedCommit(journal.resolveDue(definitionId, dayAt(0)));
    expect(journal.definition(definitionId).pendingSchedule?.recurrenceIndex).toBe(1);
    committedCommit(journal.resolveDue(definitionId, dayAt(1)));
    expect(journal.definition(definitionId).pendingSchedule).toBeUndefined();
  });

  it("Error: 반복 전개 포트 없이 일정 정의를 만들면 DomainInvariantError 다 (test_SC041_missing_recurrence_port_invariant_error)", () => {
    expect(() => registerDefinition(definitionDeps("occ041x", undefined, null))).toThrow(
      DomainInvariantError,
    );
    // 대조: 포트가 없어도 신호 정의는 만들어진다.
    expect(
      registerDefinition(definitionDeps("occ041y", undefined, null), {
        draft: signalDefinitionDraft(),
      }).journal,
    ).toBeDefined();
  });
});

describe("SC-023: 회차 명령 진입 형 위반", () => {
  it("Error: 정의 ID·회차 ID·late 의 형이 틀린 회차 명령은 detail 없는 invalid_input 이고 커밋이 없다 (test_SC023_occurrence_command_shape_refused)", () => {
    const r = registerAndMaterializeFirst(definitionDeps("occ023shape"));
    const { journal, definitionId } = r;
    committedCommit(journal.resolveDue(definitionId, dayAt(1)));
    const held = journal.definition(definitionId).held[0]?.occurrenceId;
    const pending = journal.definition(definitionId).pendingSchedule?.occurrenceId;
    const now = dayAt(1, "08:00");
    const resolve = {
      kind: "resolve_due_schedule",
      definitionId,
      occurrenceId: pending,
      meta: meta(now),
    };
    const release = {
      kind: "release_held_occurrence",
      definitionId,
      occurrenceId: held,
      meta: meta(now),
    };
    const run = (command: Record<string, unknown>) =>
      executeDefinitionCommand(journal.deps, journal.state, command as never);
    const shapeCases: readonly [string, Record<string, unknown>][] = [
      ["resolve: missing definitionId", { ...resolve, definitionId: undefined }],
      ["resolve: numeric definitionId", { ...resolve, definitionId: 42 }],
      ["resolve: numeric occurrenceId", { ...resolve, occurrenceId: 42 }],
      ["resolve: string late", { ...resolve, late: "yes" }],
      ["release: missing definitionId", { ...release, definitionId: undefined }],
      ["release: numeric definitionId", { ...release, definitionId: 42 }],
      ["release: numeric occurrenceId", { ...release, occurrenceId: 42 }],
    ];
    const commitsBefore = journal.commits.length;
    for (const [label, command] of shapeCases) {
      const outcome = run(command);
      expect(outcome, label).toEqual({ kind: "rejected", rejection: { reason: "invalid_input" } });
      expect("detail" in (outcome as { rejection: object }).rejection, label).toBe(false);
    }
    expect(journal.commits).toHaveLength(commitsBefore);

    // 대조: 모르는 종류는 detail 이 있고 형을 맞춘 명령은 커밋된다.
    expect(run({ ...resolve, kind: "resolve_everything" })).toEqual({
      kind: "rejected",
      rejection: { reason: "invalid_input", detail: "unknown_command" },
    });
    journal.completeWork(r.firstWorkId, now);
    expect(run(release).kind).toBe("committed");
    const fresh = registerDefinition(definitionDeps("occ023shapeok"));
    const freshPending = fresh.journal.definition(fresh.definitionId).pendingSchedule?.occurrenceId;
    expect(
      executeDefinitionCommand(fresh.journal.deps, fresh.journal.state, {
        kind: "resolve_due_schedule",
        definitionId: fresh.definitionId,
        occurrenceId: freshPending,
        late: false,
        meta: meta(dayAt(0)),
      } as never).kind,
    ).toBe("committed");
  });
});
