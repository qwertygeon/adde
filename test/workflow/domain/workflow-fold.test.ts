// 정의 이벤트 아홉 타입의 도메인 생산 표기·다중 Work fold = 직접 적용·fold 실패 경로.
import { describe, expect, it } from "vitest";
import {
  DOMAIN_EVENT_PRODUCERS,
  EVENT_CATALOG,
  foldWorkflowEvents,
} from "../../../src/workflow/domain/index.js";
import {
  DEFINITION_EVENT_TYPES,
  dayAt,
  definitionDeps,
  definitionTour,
  registerAndMaterializeFirst,
} from "./helpers/definition-fixtures.js";

const DOMAIN_PRODUCERS: ReadonlySet<string> = new Set(DOMAIN_EVENT_PRODUCERS);

describe("SC-005: 정의 이벤트는 도메인이 생산하고 fold 가 직접 적용과 같다", () => {
  it("Happy: 아홉 타입이 카탈로그에서 도메인 생산 표기다 (test_SC005_nine_types_domain_produced)", () => {
    expect(DEFINITION_EVENT_TYPES).toHaveLength(9);
    for (const name of DEFINITION_EVENT_TYPES) {
      const entry = EVENT_CATALOG.find((e) => e.name === name);
      expect(entry, name).toBeDefined();
      expect(DOMAIN_PRODUCERS.has(entry?.producedBy ?? ""), name).toBe(true);
    }
  });

  it("Edge: 아홉 타입을 담은 다중 Work 이력의 fold 가 직접 적용 상태와 같다 (test_SC005_fold_equals_direct_with_definition_events)", () => {
    const tour = definitionTour(definitionDeps("fold005"), definitionDeps("fold005s"));
    expect(tour.failures).toEqual([]);
    const produced = new Set<string>();
    for (const journal of tour.journals) {
      for (const commit of journal.commits) for (const e of commit.events) produced.add(e.type);
      const folded = foldWorkflowEvents(journal.commits.flatMap((c) => c.events));
      expect(folded.ok).toBe(true);
      if (folded.ok) expect(folded.value).toEqual(journal.state);
    }
    expect(DEFINITION_EVENT_TYPES.filter((t) => !produced.has(t))).toEqual([]);
  });

  it("Error: 후속 차수 표기 타입과 index 가 빠진 다중 Work 커밋은 fold 가 실패한다 (test_SC005_later_phase_and_broken_commit_fold_fail)", () => {
    const { journal } = registerAndMaterializeFirst(definitionDeps("fold005e"));
    const events = journal.commits.flatMap((c) => c.events);
    const first = events[0];
    if (first === undefined) throw new Error("expected events");
    const later = EVENT_CATALOG.find((e) => e.name === "trigger_scheduled");
    expect(later !== undefined && !DOMAIN_PRODUCERS.has(later.producedBy)).toBe(true);
    // 다른 생성 경로 대용: 후속 차수 이벤트 하나를 단독 커밋으로 덧붙인 로그.
    const withLater = [
      ...events,
      {
        ...first,
        id: "evt_later0000001",
        type: "trigger_scheduled",
        occurredAt: dayAt(0, "08:00"),
        commit: { id: "cmt_later0000001", index: 1, count: 1 },
        payload: {},
      },
    ];
    const laterFold = foldWorkflowEvents(withLater as never);
    expect(laterFold.ok).toBe(false);
    if (!laterFold.ok) expect(laterFold.error.kind).toBe("unsupported_event_type");

    // materialize 커밋(관리 Work + 회차 Work 이벤트)에서 가운데 이벤트 하나를 뺀다.
    const multiWork = journal.commits.find((c) => new Set(c.events.map((e) => e.workId)).size > 1);
    if (multiWork === undefined) throw new Error("expected a multi-work commit");
    const dropIndex = Math.floor(multiWork.events.length / 2);
    const broken = journal.commits.flatMap((c) =>
      c === multiWork ? c.events.filter((_, i) => i !== dropIndex) : c.events,
    );
    const brokenFold = foldWorkflowEvents(broken);
    expect(brokenFold.ok).toBe(false);
    if (!brokenFold.ok) expect(brokenFold.error.kind).toBe("malformed_commit");
    // 대조: 같은 로그 전체는 fold 된다.
    expect(foldWorkflowEvents(events).ok).toBe(true);
  });
});
