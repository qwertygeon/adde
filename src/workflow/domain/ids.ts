/**
 * 런타임 엔티티 ID 값 타입 — the workflow contract "Identifier scheme" 그대로.
 * 브랜드는 종류별 `unique symbol` 키라 `WorkId` → `TaskId` 대입이 타입 오류가 된다(구조적 호환 차단).
 */
import { type Result, ok, err, DomainInvariantError } from "./result.js";

export const ENTITY_ID_PREFIXES = {
  work: "wrk_",
  workDefinition: "wdf_",
  planProposal: "pln_",
  task: "tsk_",
  result: "res_",
  reaction: "rct_",
  occurrence: "occ_",
  signal: "sig_",
  event: "evt_",
  attempt: "att_",
  confirmation: "cfm_",
  decision: "dec_",
  dispatch: "dsp_",
  controlRequest: "ctl_",
  commit: "cmt_",
} as const;

export type EntityIdKind = keyof typeof ENTITY_ID_PREFIXES;

declare const entityIdBrand: unique symbol;
export type EntityId<K extends EntityIdKind> = string & { readonly [entityIdBrand]: K };

export type WorkId = EntityId<"work">;
export type WorkDefinitionId = EntityId<"workDefinition">;
export type PlanProposalId = EntityId<"planProposal">;
export type TaskId = EntityId<"task">;
export type ResultId = EntityId<"result">;
export type ReactionId = EntityId<"reaction">;
export type OccurrenceId = EntityId<"occurrence">;
export type SignalId = EntityId<"signal">;
export type EventId = EntityId<"event">;
export type AttemptId = EntityId<"attempt">;
export type ConfirmationId = EntityId<"confirmation">;
export type DecisionId = EntityId<"decision">;
export type DispatchId = EntityId<"dispatch">;
export type ControlRequestId = EntityId<"controlRequest">;
export type CommitId = EntityId<"commit">;

declare const projectIdBrand: unique symbol;
export type ProjectId = string & { readonly [projectIdBrand]: true };
export const PROJECT_ID_PREFIX = "prj_";

export type GeneratedIdKind = Exclude<EntityIdKind, "occurrence">;

/** 생성형 ID 포트. 반환값은 `ENTITY_ID_PREFIXES[kind]` + 영숫자 1~64자여야 한다. */
export interface IdGenerator {
  next(kind: GeneratedIdKind): string;
}

export interface IdFormatError {
  readonly kind: "id_format";
  readonly expected: EntityIdKind | "project";
  readonly raw: string;
}

const GENERATED_BODY_RE = /^[0-9A-Za-z]{1,64}$/;
const OCCURRENCE_BODY_RE = /^[A-Z2-7]{26}$/;
const PROJECT_BODY_RE = /^[0-9A-Za-z]{1,64}$/;

function bodyPattern(kind: EntityIdKind): RegExp {
  return kind === "occurrence" ? OCCURRENCE_BODY_RE : GENERATED_BODY_RE;
}

export function parseEntityId<K extends EntityIdKind>(
  kind: K,
  raw: string,
): Result<EntityId<K>, IdFormatError> {
  const prefix = ENTITY_ID_PREFIXES[kind];
  if (!raw.startsWith(prefix)) return err({ kind: "id_format", expected: kind, raw });
  const body = raw.slice(prefix.length);
  if (!bodyPattern(kind).test(body)) return err({ kind: "id_format", expected: kind, raw });
  return ok(raw as EntityId<K>);
}

export function parseProjectId(raw: string): Result<ProjectId, IdFormatError> {
  if (!raw.startsWith(PROJECT_ID_PREFIX))
    return err({ kind: "id_format", expected: "project", raw });
  const body = raw.slice(PROJECT_ID_PREFIX.length);
  if (!PROJECT_BODY_RE.test(body)) return err({ kind: "id_format", expected: "project", raw });
  return ok(raw as ProjectId);
}

/** 생성기 출력이 형식을 어기면 DomainInvariantError. */
export function nextEntityId<K extends GeneratedIdKind>(ids: IdGenerator, kind: K): EntityId<K> {
  const raw = ids.next(kind);
  const parsed = parseEntityId(kind, raw);
  if (!parsed.ok) {
    throw new DomainInvariantError(
      `IdGenerator.next(${kind}) 이 형식을 어긴 값을 반환했다: ${raw}`,
    );
  }
  return parsed.value;
}
