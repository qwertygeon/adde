/**
 * 확장 descriptor 계약 — TaskType·Trigger·Reaction 의 선언 형태와 Reaction 실행자 인터페이스.
 * 코어는 유형·종류 식별자로 분기하지 않고 여기 선언된 값만 읽는다. 실행자는 인터페이스만 있고 구현은
 * 실행 계층이 맡는다.
 */
import type { ZodObject, ZodType } from "zod";
import type { TaskId } from "../ids.js";
import type { IdempotencyKey } from "../derivation/idempotency-key.js";

export type ExecutionEffect = "adde_credentialed" | "agent_dispatch" | "records_only";
export const EXECUTION_EFFECTS: readonly ExecutionEffect[] = [
  "adde_credentialed",
  "agent_dispatch",
  "records_only",
];

export interface InputFieldMetadata {
  /** 비어 있지 않은 질문 문구. */
  readonly question: string;
  /** 기본값·추론으로 채우면 안 되는 필드. */
  readonly safetyRelevant: boolean;
  /** 스키마상 선택이지만 조건이 참이면 필수. */
  readonly requiredWhen?: "unattended_eligible";
}

export type OutputDeclaration = ZodType | { readonly outputSchemaFromInput: string };

export interface MissingInputIssue {
  readonly field: string;
  readonly metadata: InputFieldMetadata;
}

export interface InputRequest {
  /** = field */
  readonly questionId: string;
  readonly field: string;
  readonly prompt: string;
  readonly safetyRelevant: boolean;
}

export interface TaskTypeCapabilities {
  readonly canAutoPlan: boolean;
  /** descriptor 기본값 — 실효값은 `TaskPolicy.approvalRequiredBeforeExecute`. */
  readonly requiresHumanBeforeExecute: boolean;
}

export interface TaskTypeDescriptor {
  /** `^[a-z][a-z0-9_]{0,63}$` */
  readonly id: string;
  /** 양의 안전 정수 */
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly schema: ZodObject;
  readonly inputFields: Readonly<Record<string, InputFieldMetadata>>;
  readonly outputs: Readonly<Record<string, OutputDeclaration>>;
  readonly executionEffect: ExecutionEffect;
  readonly capabilities: TaskTypeCapabilities;
  /** 선언 (a): 실행 전 승인은 질문 발송만 막고, 수락이 승인하는 것은 답이 정한다. */
  readonly approvalGatesQuestionOnly: boolean;
  /** 선언 (b): 실행이 대기 요청이다. */
  readonly executionIsWaitRequest: boolean;
  readonly describeMissingInput?: (issues: readonly MissingInputIssue[]) => readonly InputRequest[];
}

export type FiringMode = "on_ready" | "schedule" | "dependencies_satisfied" | "external_signal";
export const FIRING_MODES: readonly FiringMode[] = [
  "on_ready",
  "schedule",
  "dependencies_satisfied",
  "external_signal",
];

export type OccurrenceDerivationDeclaration =
  | { readonly kind: "none" }
  | { readonly kind: "schedule"; readonly inputs: readonly string[] }
  | { readonly kind: "event_caused"; readonly inputs: readonly string[] };

export interface TriggerDescriptor {
  /** `^[a-z][a-z0-9_]{0,63}$` */
  readonly kind: string;
  readonly version: number;
  readonly title: string;
  /** TriggerSpec 변형 전체(kind·version·triggerId 포함), strict, 기본값 없음. */
  readonly schema: ZodObject;
  readonly firing: FiringMode;
  readonly occurrenceDerivation: OccurrenceDerivationDeclaration;
}

export type ReactionDeclaredAs = "execution_effect" | "transition_reaction";

export type ReactionLogicalIdDeclaration =
  { readonly kind: "fixed"; readonly value: string } | { readonly kind: "per_declaration" };

export interface ReactionRetryClassification {
  readonly permanentErrorCodes: readonly string[];
  readonly canEndAmbiguous: boolean;
}

export interface ReactionDescriptor {
  readonly kind: string;
  readonly version: number;
  readonly title: string;
  readonly reactionLogicalId: ReactionLogicalIdDeclaration;
  readonly performsExternalEffect: boolean;
  readonly usesAddeCredentials: boolean;
  readonly dispatchesAgent: boolean;
  readonly retry: ReactionRetryClassification;
  readonly declaredAs: ReactionDeclaredAs;
  readonly paramsSchema: ZodObject;
}

export interface ReactionExecutionRequest {
  readonly taskId: TaskId;
  readonly reactionLogicalId: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly params: unknown;
}

export type ReactionExecutionOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly code: string }
  | { readonly kind: "ambiguous" };

export interface ReactionExecutor {
  readonly kind: string;
  readonly version: number;
  execute(request: ReactionExecutionRequest): Promise<ReactionExecutionOutcome>;
}
