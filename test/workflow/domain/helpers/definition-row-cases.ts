// 정의 전이 표 행별 케이스 생성기 — 전사 데이터(`DEFINITION_TRANSITION_ROWS`)를 런타임에 순회해 케이스를
// 만든다. 행 ID 문자열을 하드코딩하지 않고 행의 이벤트·출발 상태로 레시피를 고른다. 표 밖 (상태, 동작)
// 조합도 같은 데이터에서 파생한다.
import {
  DEFINITION_STATE_NAMES,
  DEFINITION_TRANSITION_ROWS,
  nextEntityId,
} from "../../../../src/workflow/domain/index.js";
import type {
  DefinitionRecord,
  DomainCommit,
  TransitionRowData,
  WorkDefinitionId,
  WorkId,
} from "../../../../src/workflow/domain/index.js";
import {
  DEF_NOW,
  WorkflowJournal,
  controlSignal,
  definitionDeps,
  definitionDraft,
  planInvalidIssues,
  registerDefinition,
  templateDraft,
} from "./definition-fixtures.js";
import { at } from "./fixtures.js";

/** 정의 상태 + 정의가 없는 상태. */
export type DefinitionCaseState = "NONE" | (typeof DEFINITION_STATE_NAMES)[number];
export type DefinitionAction = "create" | "revise" | "pause" | "resume" | "stop";

export const DEFINITION_ACTIONS: readonly DefinitionAction[] = [
  "create",
  "revise",
  "pause",
  "resume",
  "stop",
];

/** 행 이벤트 → 동작. */
export const ACTION_BY_EVENT: Readonly<Record<string, DefinitionAction>> = {
  work_definition_created: "create",
  work_definition_revised: "revise",
  work_definition_paused: "pause",
  work_definition_resumed: "resume",
  work_definition_stopped: "stop",
};

/** 레시피가 다루는 시각 — 등록은 DEF_NOW, 동작은 그 뒤(첫 회차 03-01 07:00Z 전). */
export const ACTION_AT = at("2026-02-28T13:00:00Z");

export interface DefinitionFixture {
  readonly journal: WorkflowJournal;
  /** 동작을 받는 Work. NONE 이면 정의를 관리하지 않는 markdown Work. */
  readonly workId: WorkId;
  /** 정의가 있는 상태면 그 정의, NONE 이면 다른 Work 가 관리하는 정의(개정 대상). */
  readonly definitionId: WorkDefinitionId;
  readonly stewarded: boolean;
}

export interface DefinitionActionResult {
  /** "accepted" 또는 거절 분류 — 예: `plan_invalid:already_stewards_definition`. */
  readonly outcome: string;
  readonly commits: readonly DomainCommit[];
  readonly before: DefinitionRecord | undefined;
  readonly after: DefinitionRecord | undefined;
}

/** 관리 Work 가 비종결로 남도록 자기 member 하나를 둔다(중지 뒤에도 재계획할 수 있다). */
export const STEWARD_MEMBER = [templateDraft("steward_member")];

/** 정의 상태에 이른 픽스처. NONE 은 같은 상태 안의 정의를 관리하지 않는 markdown Work. */
export function reachDefinitionState(
  state: DefinitionCaseState,
  seed = "defrow",
): DefinitionFixture {
  const registered = registerDefinition(definitionDeps(seed), { tasks: STEWARD_MEMBER });
  const journal = registered.journal;
  if (state === "NONE") {
    const workId = journal.createMarkdownWork(DEF_NOW);
    return { journal, workId, definitionId: registered.definitionId, stewarded: false };
  }
  if (state === "PAUSED" || state === "STOPPED") {
    const action = state === "PAUSED" ? "pause" : "stop";
    const judged = journal.control(registered.definitionId, action, ACTION_AT);
    if (judged.kind !== "accepted")
      throw new Error(`defrow: ${action} not accepted (${judged.kind})`);
  }
  return {
    journal,
    workId: registered.stewardId,
    definitionId: registered.definitionId,
    stewarded: true,
  };
}

/** 동작을 적용하고 결과를 분류한다. */
export function applyDefinitionAction(
  fixture: DefinitionFixture,
  action: DefinitionAction,
): DefinitionActionResult {
  const { journal, workId, definitionId } = fixture;
  const before = journal.work(workId).definition;
  const startCount = journal.commits.length;
  let outcome: string;
  if (action === "create" || action === "revise") {
    journal.ensurePlanning(workId, ACTION_AT);
    const draftContent = definitionDraft({
      title: action === "create" ? "another definition" : "revised title",
      ...(action === "revise"
        ? {
            amends: {
              definitionId,
              // 미관리 Work 의 개정은 대상 정의의 현재 revision 을 실어 다른 사유가 끼지 않게 한다.
              expectedRevision: (before ?? journal.definition(definitionId)).revision,
            },
          }
        : {}),
    });
    const proposed = journal.propose(
      workId,
      journal.replanBase(workId, { definition: draftContent }),
      ACTION_AT,
    );
    if (proposed.kind !== "committed") {
      outcome = `rejected:${proposed.rejection.reason}`;
    } else if (proposed.commit.events.some((e) => e.type === "work_plan_invalid")) {
      const reasons = planInvalidIssues(proposed.commit)
        .filter((i) => i["kind"] === "definition_invalid")
        .map((i) => String(i["reason"]));
      outcome = `plan_invalid:${reasons.join(",")}`;
    } else {
      const granted = journal.decidePlan(workId, "grant", ACTION_AT);
      outcome = granted.kind === "accepted" ? "accepted" : `grant:${granted.kind}`;
    }
  } else {
    // 정의를 관리하지 않는 상태의 제어는 어떤 Work 도 관리하지 않는 정의 ID 를 대상으로 한다.
    const target: WorkDefinitionId = fixture.stewarded
      ? definitionId
      : nextEntityId(journal.deps.ids, "workDefinition");
    const judged = journal.signal(
      controlSignal(journal.deps, {
        definitionId: target,
        expectedRevision: before?.revision ?? 1,
        action,
        receivedAt: ACTION_AT,
      }),
      ACTION_AT,
    );
    switch (judged.kind) {
      case "accepted":
      case "duplicate":
        outcome = judged.kind;
        break;
      case "not_applicable":
        outcome = `not_applicable:${judged.rejection.reason}`;
        break;
      case "rejected_stale":
      case "rejected":
        outcome = `${judged.kind}:${judged.reason}`;
        break;
    }
  }
  return {
    outcome,
    commits: journal.commits.slice(startCount),
    before,
    after: journal.work(workId).definition,
  };
}

export interface DefinitionRowCase {
  readonly row: TransitionRowData<string>;
  readonly fromState: DefinitionCaseState;
  build(): DefinitionFixture;
  apply(fixture: DefinitionFixture): DefinitionActionResult;
}

/** 전사 표의 각 행 × 출발 상태(빈 출발 = NONE) 케이스. */
export function buildDefinitionRowCases(): Record<string, DefinitionRowCase> {
  const out: Record<string, DefinitionRowCase> = {};
  for (const row of DEFINITION_TRANSITION_ROWS as readonly TransitionRowData<string>[]) {
    const action = ACTION_BY_EVENT[row.event];
    if (action === undefined) throw new Error(`defrow: no action for event ${row.event}`);
    const fromStates: readonly DefinitionCaseState[] =
      row.from.length > 0 ? (row.from as readonly DefinitionCaseState[]) : ["NONE"];
    for (const fromState of fromStates) {
      out[`${row.id}@${fromState}`] = {
        row,
        fromState,
        build: () => reachDefinitionState(fromState),
        apply: (fixture) => applyDefinitionAction(fixture, action),
      };
    }
  }
  return out;
}

/** 표에 있는 (상태, 동작) 쌍 — 전사 데이터에서 파생. */
export function tablePairs(): ReadonlySet<string> {
  const pairs = new Set<string>();
  for (const row of DEFINITION_TRANSITION_ROWS as readonly TransitionRowData<string>[]) {
    const action = ACTION_BY_EVENT[row.event];
    const fromStates = row.from.length > 0 ? row.from : ["NONE"];
    for (const state of fromStates) pairs.add(`${state}:${String(action)}`);
  }
  return pairs;
}

/** 표 밖 (상태, 동작) 조합 전부. */
export function offTableCombinations(): readonly {
  readonly state: DefinitionCaseState;
  readonly action: DefinitionAction;
}[] {
  const pairs = tablePairs();
  const states: readonly DefinitionCaseState[] = ["NONE", ...DEFINITION_STATE_NAMES];
  const out: { state: DefinitionCaseState; action: DefinitionAction }[] = [];
  for (const state of states) {
    for (const action of DEFINITION_ACTIONS) {
      if (!pairs.has(`${state}:${action}`)) out.push({ state, action });
    }
  }
  return out;
}
