// 회차 결합의 형태(네 필드 이름)와 첫 효과 해석·재시도·누락 필드·안전 관련 필드 순서.
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest, resolveBoundInputs } from "../../../src/workflow/domain/index.js";
import type {
  DomainCommit,
  TaskId,
  WorkAggregate,
  WorkId,
} from "../../../src/workflow/domain/index.js";
import {
  OCCURRENCE_CONSUMER_DAY_SAFETY_TASK_TYPE,
  bindingTemplate,
  dayAt,
  definitionDraft,
  firstTaskOf,
  issuesOf,
  occurrenceConsumerDeps,
  payloadsOf,
  proposeDraft,
  registerAndMaterializeFirst,
  signalDefinitionDraft,
  templateIssues,
} from "./helpers/definition-fixtures.js";
import type { WorkflowJournal } from "./helpers/definition-fixtures.js";
import { RETRYABLE_FIXTURE_CODE, mustOk, patchWork } from "./helpers/fixtures.js";
import { testRegistries } from "./helpers/registry-fixtures.js";

function committed(outcome: { kind: string; commit?: DomainCommit }): DomainCommit {
  if (outcome.kind !== "committed" || outcome.commit === undefined) {
    throw new Error(`expected committed, got ${JSON.stringify(outcome)}`);
  }
  return outcome.commit;
}

function templateKinds(draftContent: unknown, seed: string): unknown[] {
  return templateIssues(
    issuesOf(proposeDraft(occurrenceConsumerDeps(seed), draftContent).outcome),
  ).map((i) => i["kind"]);
}

/** `day` 에 `localDate` 를 결합한 템플릿의 첫 회차 Work 와 그 Task. */
function boundOccurrence(seed: string): {
  journal: WorkflowJournal;
  workId: WorkId;
  taskId: TaskId;
} {
  const { journal, firstWorkId } = registerAndMaterializeFirst(
    occurrenceConsumerDeps(seed),
    definitionDraft({ template: [bindingTemplate("day", "localDate")] }),
  );
  const taskId = firstTaskOf(journal, firstWorkId);
  for (const kind of ["begin_validation", "complete_validation"] as const) {
    committed(journal.onTask(firstWorkId, taskId, { kind }, dayAt(0, "07:01")));
  }
  return { journal, workId: firstWorkId, taskId };
}

/** 회차 입력에서 `localDate` 를 뺀 회차 Work — 입력 누락 회차(다른 생성 경로 대용 레코드 패치). */
function withoutLocalDate(aggregate: WorkAggregate): WorkAggregate {
  const source = aggregate.work.source as unknown as { input: Record<string, unknown> };
  const { localDate: _dropped, ...input } = source.input;
  void _dropped;
  return patchWork(aggregate, { source: { ...(aggregate.work.source as object), input } as never });
}

describe("SC-049: 회차 결합 형태는 네 필드 이름만 받는다", () => {
  it("Happy: 네 이름의 결합이 형태 검사를 통과한다 (test_SC049_four_field_names_pass_shape)", () => {
    for (const [field, name] of [
      ["when", "scheduledForUtc"],
      ["day", "localDate"],
      ["zone", "timezone"],
    ] as const) {
      expect(
        templateKinds(
          definitionDraft({ template: [bindingTemplate(field, name)] }),
          `bnd049${field}`,
        ),
        name,
      ).toEqual([]);
    }
    expect(
      templateKinds(
        signalDefinitionDraft({ template: [bindingTemplate("event", "signal")] }),
        "bnd049sig",
      ),
    ).toEqual([]);
  });

  it("Edge: 대소문자가 다른 이름은 binding_malformed 다 (test_SC049_case_variant_malformed)", () => {
    expect(
      templateKinds(
        definitionDraft({ template: [bindingTemplate("day", "LocalDate")] }),
        "bnd049e",
      ),
    ).toEqual(["binding_malformed"]);
  });

  it("Error: 네 이름 밖의 이름은 binding_malformed 다 (test_SC049_unknown_field_malformed)", () => {
    expect(
      templateKinds(
        signalDefinitionDraft({ template: [bindingTemplate("event", "payload")] }),
        "bnd049x",
      ),
    ).toEqual(["binding_malformed"]);
  });
});

describe("SC-050: 회차 결합은 첫 효과에서 한 번 해석된다", () => {
  it("Happy: 첫 attempt 가 회차 입력 localDate 의 digest 로 결합을 기록한다 (test_SC050_first_effect_records_occurrence_digest)", () => {
    const { journal, workId, taskId } = boundOccurrence("bnd050");
    const started = committed(
      journal.onTask(workId, taskId, { kind: "start_attempt" }, dayAt(0, "07:02")),
    );
    expect(payloadsOf(started, "task_started")[0]?.["boundInputs"]).toEqual([
      {
        field: "day",
        binding: { from: "occurrence", field: "localDate" },
        digest: mustOk(canonicalJsonDigest("2026-03-01")),
      },
    ]);
  });

  it("Edge: 재시도 attempt 는 새 결합 기록을 만들지 않는다 (test_SC050_retry_attempt_no_new_binding_record)", () => {
    const { journal, workId, taskId } = boundOccurrence("bnd050e");
    committed(journal.onTask(workId, taskId, { kind: "start_attempt" }, dayAt(0, "07:02")));
    const attemptId = journal.task(workId, taskId).openAttempt?.attemptId;
    if (attemptId === undefined) throw new Error("expected open attempt");
    committed(
      journal.onTask(
        workId,
        taskId,
        {
          kind: "record_attempt_outcome",
          attemptId,
          outcome: { kind: "failed", code: RETRYABLE_FIXTURE_CODE },
        },
        dayAt(0, "07:03"),
      ),
    );
    expect(journal.task(workId, taskId).state).toBe("RETRY_WAIT");
    committed(journal.onTask(workId, taskId, { kind: "retry_ready" }, dayAt(0, "08:00")));
    const retried = committed(
      journal.onTask(workId, taskId, { kind: "start_attempt" }, dayAt(0, "08:01")),
    );
    const payload = payloadsOf(retried, "task_started")[0] ?? {};
    expect(payload["attemptNo"]).toBe(2);
    expect(Object.hasOwn(payload, "boundInputs")).toBe(false);
  });

  it("Error: 입력에 결합 필드가 없는 회차 Work 는 occurrence_input_unavailable 이다 (test_SC050_missing_input_field_unavailable)", () => {
    const { journal, workId, taskId } = boundOccurrence("bnd050x");
    const patched = withoutLocalDate(journal.work(workId));
    expect(
      resolveBoundInputs(journal.deps.registries, patched, journal.task(workId, taskId)),
    ).toEqual({
      ok: false,
      error: { kind: "occurrence_input_unavailable", field: "day" },
    });
  });

  it("Error: 커밋 뒤 안전 관련 필드가 된 회차 결합은 회차 값 조회보다 먼저 safety_field_bound 다 (test_SC050_safety_field_checked_before_occurrence_value)", () => {
    const { journal, workId, taskId } = boundOccurrence("bnd050s");
    // 등록부 drift 대용: 같은 소비자에서 day 를 안전 관련으로 선언한 판.
    const drifted = testRegistries({ taskTypes: [OCCURRENCE_CONSUMER_DAY_SAFETY_TASK_TYPE] });
    const task = journal.task(workId, taskId);
    expect(resolveBoundInputs(drifted, withoutLocalDate(journal.work(workId)), task)).toEqual({
      ok: false,
      error: { kind: "safety_field_bound", field: "day" },
    });
    expect(resolveBoundInputs(drifted, journal.work(workId), task)).toEqual({
      ok: false,
      error: { kind: "safety_field_bound", field: "day" },
    });
    // 대조: 원래 등록부면 결합이 기록된다.
    expect(resolveBoundInputs(journal.deps.registries, journal.work(workId), task)).toEqual({
      ok: true,
      value: [
        {
          field: "day",
          binding: { from: "occurrence", field: "localDate" },
          digest: mustOk(canonicalJsonDigest("2026-03-01")),
        },
      ],
    });
  });
});
