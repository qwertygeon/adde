/**
 * WorkDefinition 상태 집합·전이 표 전사 — the workflow contract "Work definition and occurrence contract"
 * 코드 블록(`type WorkDefinitionState`)과 전이 표 6행. 서술 열(`fromText`·`condition`)은 계약 셀 원문 그대로
 * (백틱 포함), 행 ID 는 Task·Work 전이 표와 같은 규칙(`fromKey + ">" + to + ":" + event`)이다.
 */
import type { TransitionRowData } from "./task-transitions.js";

export const DEFINITION_STATE_NAMES = ["ACTIVE", "PAUSED", "STOPPED"] as const;

export const DEFINITION_TERMINAL_STATE_NAMES = ["STOPPED"] as const;

export type DefinitionStateName = (typeof DEFINITION_STATE_NAMES)[number];

export const DEFINITION_TRANSITION_ROWS = [
  {
    id: "NONE>ACTIVE:work_definition_created",
    fromText: "—",
    from: [],
    to: "ACTIVE",
    event: "work_definition_created",
    condition: "A committed proposal carried a definition draft without `amends`",
    companions: [],
  },
  {
    id: "ACTIVE>ACTIVE:work_definition_revised",
    fromText: "`ACTIVE`",
    from: ["ACTIVE"],
    to: "ACTIVE",
    event: "work_definition_revised",
    condition: "A committed proposal amended the definition and `amends.expectedRevision` matched",
    companions: [],
  },
  {
    id: "PAUSED>PAUSED:work_definition_revised",
    fromText: "`PAUSED`",
    from: ["PAUSED"],
    to: "PAUSED",
    event: "work_definition_revised",
    condition: "The same, while paused",
    companions: [],
  },
  {
    id: "ACTIVE>PAUSED:work_definition_paused",
    fromText: "`ACTIVE`",
    from: ["ACTIVE"],
    to: "PAUSED",
    event: "work_definition_paused",
    condition:
      "An accepted `definition_control` pause signal, an authenticated `definition.pause` control request, or a template that no longer validates at materialization",
    companions: [],
  },
  {
    id: "PAUSED>ACTIVE:work_definition_resumed",
    fromText: "`PAUSED`",
    from: ["PAUSED"],
    to: "ACTIVE",
    event: "work_definition_resumed",
    condition: "An accepted `definition_control` resume signal with `human_local` provenance",
    companions: [],
  },
  {
    id: "ACTIVE|PAUSED>STOPPED:work_definition_stopped",
    fromText: "`ACTIVE` or `PAUSED`",
    from: ["ACTIVE", "PAUSED"],
    to: "STOPPED",
    event: "work_definition_stopped",
    condition:
      "An accepted `definition_control` stop signal, an authenticated `definition.stop` control request, cancellation of the steward Work, or the series exhausted: a recurrence by `until` or `maxOccurrences`, a signal activation by `maxOccurrences`",
    companions: [],
  },
] as const satisfies readonly TransitionRowData<DefinitionStateName>[];
