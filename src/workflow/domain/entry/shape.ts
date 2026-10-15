/**
 * 공개 진입의 형 술어. 진입 사본(정규 JSON 동결 사본) 위에서만 부른다 — 사본에는 평범한 객체·배열·원시값만
 * 남으므로 프로토타입·접근자 검사가 필요 없다. 판정 모듈을 import 하지 않는다(판정 모듈이 이 모듈을 쓴다).
 */
import { type Result, ok, err } from "../result.js";
import { ACTOR_SOURCES } from "../contract/index.js";
import { parseEntityId } from "../ids.js";
import type { EntityIdKind } from "../ids.js";
import { parseCancelOrigin, parseUtcInstant } from "../values.js";
import type { ActorSource, CancelOrigin, UtcInstant } from "../values.js";
import { parsePendingDecision } from "../pending-decision.js";
import type { PendingDecision, PendingDecisionDraft } from "../pending-decision.js";
import type { AttemptOutcome, CommandMeta, DecisionSignal } from "../commands.js";

/** 배열·null 이 아닌 객체. */
export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 표의 자기 소유 키인 문자열. 프로토타입 이름(`constructor`·`toString`·`__proto__`)이 표 조회에서 상속
 * 속성으로 적중하지 않게 한다.
 */
export function isOwnMember(table: object, value: unknown): value is string {
  return typeof value === "string" && Object.hasOwn(table, value);
}

/** 조회에 쓰는 ID 의 형식 — 형식이 맞는 ID 는 일반 객체 조회에서 상속 속성 이름이 될 수 없다. */
export function isEntityIdText(kind: EntityIdKind, value: unknown): boolean {
  return typeof value === "string" && parseEntityId(kind, value).ok;
}

/** UTC 시각 문자열이면 그 정규 표기(밀리초 세 자리), 아니면 undefined. */
export function canonicalInstant(value: unknown): UtcInstant | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = parseUtcInstant(value);
  return parsed.ok ? parsed.value : undefined;
}

export function isActorSourceValue(value: unknown): value is ActorSource {
  return typeof value === "string" && (ACTOR_SOURCES as readonly string[]).includes(value);
}

/** 명령 meta — 평범한 객체, now 는 UTC 시각, actorSource 는 출처 열거값. */
export function isCommandMetaShape(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    canonicalInstant(value["now"]) !== undefined &&
    isActorSourceValue(value["actorSource"])
  );
}

/**
 * meta.now 를 정규 표기로 바꾼 동결 명령. isCommandMetaShape 를 통과한 사본에만 부른다 — 판정 본체와
 * 커밋 envelope 이 같은 표기의 시각을 쓴다.
 */
export function withCanonicalNow<C extends { readonly meta: CommandMeta }>(command: C): C {
  const now = canonicalInstant(command.meta.now) as UtcInstant;
  return Object.freeze({ ...command, meta: Object.freeze({ ...command.meta, now }) });
}

const DECISION_SIGNAL_TYPES = Object.freeze({
  confirmation_decision: true,
  human_decision: true,
  cancel_requested: true,
  replan_requested: true,
} as const satisfies DecisionSignalTypeTable);

/** 결정 신호 네 종류 중 하나. */
export function isDecisionSignalType(value: unknown): value is DecisionSignal["type"] {
  return isOwnMember(DECISION_SIGNAL_TYPES, value);
}

const ATTEMPT_OUTCOME_KINDS = Object.freeze({
  completed: true,
  failed: true,
  attempt_timeout: true,
  dispatch_orphaned: true,
  dispatch_withdrawn: true,
  blocked: true,
  effect_dead_lettered: true,
  abandoned_for_validity: true,
} as const satisfies AttemptOutcomeKindTable);

/** 시도 결과 여덟 종류 중 하나. */
export function isAttemptOutcomeKind(value: unknown): value is AttemptOutcome["kind"] {
  return isOwnMember(ATTEMPT_OUTCOME_KINDS, value);
}

const PENDING_DECISION_TEXT_FIELDS = ["id", "kind", "requestedAt", "summary"] as const;
const PENDING_DECISION_OPTIONAL_TEXT_FIELDS = [
  "taskId",
  "workId",
  "planProposalId",
  "subject",
  "expiresAt",
] as const;

/**
 * 대기 결정의 형 — 필수 문자열 필드·전달 기록 배열·선택 문자열 필드, 그리고 도메인 파서가 받아들이는 값.
 * 파서가 거절하는 결정을 상태에 넣으면 뒤 명령의 만료 비교·결정 ID 조회가 예외를 낸다.
 */
export function isPendingDecisionShape(value: unknown): boolean {
  return pendingDecisionOf(value) !== undefined;
}

/**
 * 대기 결정의 형을 통과하면 파싱 결과(검사한 필드만의 새 객체, 시각은 정규 표기), 아니면 undefined. 커밋에는
 * 이 파싱 결과를 싣는다 — 파서가 버리는 모르는 키가 상태에 남지 않는다.
 */
export function pendingDecisionOf(value: unknown): PendingDecision | undefined {
  if (!isPlainRecord(value)) return undefined;
  for (const field of PENDING_DECISION_TEXT_FIELDS) {
    if (typeof value[field] !== "string") return undefined;
  }
  if (!Array.isArray(value["surfaceDeliveries"])) return undefined;
  for (const field of PENDING_DECISION_OPTIONAL_TEXT_FIELDS) {
    if (value[field] !== undefined && typeof value[field] !== "string") return undefined;
  }
  const parsed = parsePendingDecision(value as unknown as PendingDecisionDraft);
  return parsed.ok ? parsed.value : undefined;
}

function isTaskRefShape(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    (typeof value["draftRef"] === "string" || typeof value["taskId"] === "string")
  );
}

/**
 * 계획 초안 틀 — 검증·결합 검사가 역참조하는 골격과 커밋 이벤트에 그대로 실리는 title·draftRef 문자열. 나머지
 * 필드(input·policy·reactions·inputBindings)는 Task 검증·결합 검증이 이슈로 다룬다.
 */
export function isPlanDraftFrame(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (typeof value["title"] !== "string" || typeof value["draftRef"] !== "string") return false;
  const type = value["type"];
  if (
    !isPlainRecord(type) ||
    typeof type["id"] !== "string" ||
    typeof type["version"] !== "number"
  ) {
    return false;
  }
  const dependsOn = value["dependsOn"];
  if (!Array.isArray(dependsOn)) return false;
  for (const ref of dependsOn) {
    if (!isTaskRefShape(ref)) return false;
  }
  const parent = value["parent"];
  if (parent !== undefined && !isTaskRefShape(parent)) return false;
  return isPlainRecord(value["trigger"]);
}

/**
 * 외부 신호 subject 의 유일한 자기 키와 그 문자열 값. 평범한 객체가 아니거나 자기 키가 하나가 아니거나 값이
 * 문자열이 아니면 undefined. 사본 위에서 부르므로 값이 undefined 인 키는 없는 키다.
 */
export function soleSubjectKey(
  subject: unknown,
): { readonly key: string; readonly value: string } | undefined {
  if (!isPlainRecord(subject)) return undefined;
  const keys = Object.keys(subject);
  if (keys.length !== 1) return undefined;
  const key = keys[0] as string;
  const value = subject[key];
  return typeof value === "string" ? { key, value } : undefined;
}

type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type CancelOriginField = KeysOfUnion<CancelOrigin>;

/** 취소 출처의 허용 최상위 키. CancelOrigin 의 필드가 늘거나 줄면 컴파일 오류가 난다. */
const CANCEL_ORIGIN_FIELDS = Object.freeze({
  kind: true,
  actorSource: true,
  actor: true,
  reason: true,
  signalId: true,
  provenance: true,
  workEventId: true,
  controlRequestId: true,
  keyId: true,
} as const satisfies CancelOriginFieldTable);

/**
 * 명령(`cancel_task`·`cancel_work`)의 취소 출처 규칙. 거절은 detail 문자열이다. 모르는 최상위 키는 거절한다
 * — 공개 파서는 모르는 키를 버리고 성공하므로 파서 성공이 명령 수용을 뜻하지 않는다. 명령으로 낼 수 있는
 * 출처는 노트 신호(사람 출처)와 제어 요청뿐이고, 기록되는 출처는 명령 출처와 같아야 한다(키 보유자의 취소가
 * 사람 결정으로 남지 않게). 통과하면 파싱 결과(검사한 필드만의 새 객체)를 돌려준다.
 */
export function commandCancelOrigin(
  raw: unknown,
  metaActorSource: ActorSource,
): Result<CancelOrigin, string> {
  if (isPlainRecord(raw)) {
    for (const key of Object.keys(raw)) {
      if (!Object.hasOwn(CANCEL_ORIGIN_FIELDS, key)) return err("cancel_origin_invalid");
    }
  }
  const parsed = parseCancelOrigin(raw);
  if (!parsed.ok) return err("cancel_origin_invalid");
  const origin = parsed.value;
  if (origin.kind !== "vault_signal" && origin.kind !== "control_request") {
    return err("cancel_origin_kind_not_allowed");
  }
  if (origin.kind === "vault_signal" && origin.actorSource !== "human_local") {
    return err("vault_signal 취소는 human_local 필수");
  }
  if (origin.actorSource !== metaActorSource) return err("cancel_origin_actor_source_mismatch");
  return ok(origin);
}

/**
 * 표의 키 집합을 유니온과 맞추는 타입. satisfies 자리에 사상 타입을 직접 쓰면 변이 계측기(Stryker)가 타입
 * 자리의 `true` 를 변이 자리로 잡고 계측을 멈추므로 별칭으로 둔다.
 */
type DecisionSignalTypeTable = { readonly [K in DecisionSignal["type"]]: true };
type AttemptOutcomeKindTable = { readonly [K in AttemptOutcome["kind"]]: true };
type CancelOriginFieldTable = { readonly [K in CancelOriginField]: true };
