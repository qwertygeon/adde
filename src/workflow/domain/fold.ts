/**
 * foldEvents — 이벤트 순서열을 접어 Task·Work 의 상태와 revision 을 재구성하는 순수 함수(FR-016).
 * fold 결과는 같은 명령 순서열을 직접 적용한 결과와 같다(NFR-002). 이름 판정은 ADR-014 fail-closed.
 */
import { type Result, ok, err } from "./result.js";
import type { WorkAggregate } from "./aggregate.js";
import type { DomainEvent, WorkflowEventEnvelope } from "./events.js";
import { DOMAIN_EVENT_PRODUCERS } from "./events.js";
import { EVENT_CATALOG } from "./contract/index.js";
import type { EventProducer } from "./contract/index.js";
import { evolveCommit } from "./evolve.js";

export type FoldError =
  | { readonly kind: "unknown_event_type"; readonly eventId: string; readonly type: string }
  | {
      readonly kind: "unsupported_event_type";
      readonly eventId: string;
      readonly type: string;
      readonly producedBy: EventProducer;
    }
  | {
      readonly kind: "unsupported_schema_version";
      readonly eventId: string;
      readonly schemaVersion: number;
    }
  | { readonly kind: "malformed_commit"; readonly commitId: string; readonly reason: string }
  | { readonly kind: "inconsistent_stream"; readonly eventId: string; readonly reason: string };

const CATALOG_BY_NAME = new Map<string, (typeof EVENT_CATALOG)[number]>(
  EVENT_CATALOG.map((row) => [row.name, row]),
);

/** 한 Work 의 이벤트 스트림(커밋 순). 첫 커밋은 `work_created` 여야 한다. */
export function foldEvents(
  events: readonly WorkflowEventEnvelope[],
): Result<WorkAggregate, FoldError> {
  if (events.length === 0) {
    return err({ kind: "inconsistent_stream", eventId: "", reason: "empty_stream" });
  }

  // 이름·스키마 검사 먼저(카탈로그 밖 이름을 무시하지 않는다 — SC-029).
  for (const event of events) {
    const catalogRow = CATALOG_BY_NAME.get(event.type);
    if (catalogRow === undefined) {
      return err({ kind: "unknown_event_type", eventId: event.id, type: event.type });
    }
    if (!DOMAIN_EVENT_PRODUCERS.includes(catalogRow.producedBy)) {
      return err({
        kind: "unsupported_event_type",
        eventId: event.id,
        type: event.type,
        producedBy: catalogRow.producedBy,
      });
    }
    if (event.schemaVersion !== 1) {
      return err({
        kind: "unsupported_schema_version",
        eventId: event.id,
        schemaVersion: event.schemaVersion,
      });
    }
  }

  const first = events[0] as WorkflowEventEnvelope;
  if (first.type !== "work_created") {
    return err({
      kind: "inconsistent_stream",
      eventId: first.id,
      reason: "first_event_not_work_created",
    });
  }
  const workId = first.workId;
  for (const event of events) {
    if (event.workId !== undefined && event.workId !== workId) {
      return err({ kind: "inconsistent_stream", eventId: event.id, reason: "mixed_work_id" });
    }
  }

  // 커밋 그룹화 — 연속 구간, index 1..count 연속·count 일치.
  const groups: WorkflowEventEnvelope[][] = [];
  let i = 0;
  while (i < events.length) {
    const commitId = (events[i] as WorkflowEventEnvelope).commit.id;
    const count = (events[i] as WorkflowEventEnvelope).commit.count;
    const group: WorkflowEventEnvelope[] = [];
    let expectedIndex = 1;
    while (i < events.length && (events[i] as WorkflowEventEnvelope).commit.id === commitId) {
      const event = events[i] as WorkflowEventEnvelope;
      if (event.commit.count !== count) {
        return err({ kind: "malformed_commit", commitId, reason: "inconsistent_count" });
      }
      if (event.commit.index !== expectedIndex) {
        return err({ kind: "malformed_commit", commitId, reason: "non_consecutive_index" });
      }
      group.push(event);
      expectedIndex += 1;
      i += 1;
    }
    if (group.length !== count) {
      return err({ kind: "malformed_commit", commitId, reason: "count_mismatch" });
    }
    groups.push(group);
  }

  let aggregate: WorkAggregate | undefined;
  for (const group of groups) {
    aggregate = evolveCommit(aggregate, group as unknown as readonly DomainEvent[]);
  }
  return ok(aggregate as WorkAggregate);
}
