// 시험용 TaskType descriptor 와 등록부 구성. 공개 배럴만 import 한다.
import * as z from "zod";
import { createBuiltinRegistries } from "../../../../src/workflow/domain/index.js";
import type {
  TaskTypeDescriptor,
  DomainRegistries,
  MissingInputIssue,
  InputRequest,
} from "../../../../src/workflow/domain/index.js";

/** 시험 유형 id 전부 — 정적 검사(코어 식별자 분기)의 식별자 목록에 들어간다. */
export const FIXTURE_TASK_TYPE_IDS: readonly string[] = [
  "generic_task",
  "probe_extension",
  "probe_question_only",
  "probe_records_notify",
  "probe_override_prompt",
  "probe_missing",
  "probe_override_flip",
  "probe_getter",
  "probe_getter_b",
  "probe_cyclic",
];

const NO_CAPABILITY = { canAutoPlan: true, requiresHumanBeforeExecute: false } as const;

/** 픽스처의 기본 초안이 쓰는 유형 — 입력 `{}` 가 그대로 통과한다. */
export const GENERIC_TASK_TYPE: TaskTypeDescriptor = {
  id: "generic_task",
  version: 1,
  title: "Generic task",
  description: "Test-only task type with no required input.",
  schema: z.strictObject({ note: z.string().optional() }),
  inputFields: {},
  outputs: {},
  executionEffect: "records_only",
  capabilities: NO_CAPABILITY,
  approvalGatesQuestionOnly: false,
  executionIsWaitRequest: false,
};

/** 등록만으로 도입하는 새 유형(확장성 수용) — 필수 입력 `subject` 하나와 출력 `result`. */
export function probeTaskType(overrides?: Partial<TaskTypeDescriptor>): TaskTypeDescriptor {
  return {
    id: "probe_extension",
    version: 1,
    title: "Probe extension",
    description: "Test-only task type introduced by registration alone.",
    schema: z.strictObject({ subject: z.string().min(1) }),
    inputFields: { subject: { question: "What is the subject?", safetyRelevant: false } },
    outputs: { result: z.string() },
    executionEffect: "records_only",
    capabilities: NO_CAPABILITY,
    approvalGatesQuestionOnly: false,
    executionIsWaitRequest: false,
    ...overrides,
  };
}

/** 선언 (a) 를 가진 자격증명 효과 유형 — 식별자는 확인 유형과 무관. */
export function probeQuestionOnlyTaskType(
  overrides?: Partial<TaskTypeDescriptor>,
): TaskTypeDescriptor {
  return probeTaskType({
    id: "probe_question_only",
    title: "Probe question only",
    description: "Test-only task type whose pre-execution approval gates only the question.",
    executionEffect: "adde_credentialed",
    approvalGatesQuestionOnly: true,
    ...overrides,
  });
}

/** 기록만 하는 유형 — 자격증명 효과는 Task 가 선언한 전이 반응에서만 온다. */
export function probeRecordsNotifyTaskType(): TaskTypeDescriptor {
  return {
    ...GENERIC_TASK_TYPE,
    id: "probe_records_notify",
    title: "Probe records notify",
    description: "Test-only records-only task type used with a declared notify reaction.",
  };
}

/** 필수 입력 둘과 문구 재정의. `describe` 로 재정의 함수를 바꿀 수 있다. */
export function probeOverridePromptTaskType(
  describe?: (issues: readonly MissingInputIssue[]) => readonly InputRequest[],
): TaskTypeDescriptor {
  return {
    id: "probe_override_prompt",
    version: 1,
    title: "Probe override prompt",
    description: "Test-only task type that rewords its missing-input questions.",
    schema: z.strictObject({ first: z.string().min(1), second: z.string().min(1) }),
    inputFields: {
      first: { question: "What is the first value?", safetyRelevant: false },
      second: { question: "What is the second value?", safetyRelevant: true },
    },
    outputs: {},
    executionEffect: "records_only",
    capabilities: NO_CAPABILITY,
    approvalGatesQuestionOnly: false,
    executionIsWaitRequest: false,
    describeMissingInput:
      describe ??
      ((issues) =>
        issues.map((issue) => ({
          questionId: issue.field,
          field: issue.field,
          prompt: `Override: provide ${issue.field}`,
          safetyRelevant: issue.metadata.safetyRelevant,
        }))),
  };
}

/** 같은 Task 가 선언하는 `notify@1` 전이 반응. */
export const COMPLETION_NOTIFY_REACTION = {
  kind: "notify",
  version: 1,
  reactionLogicalId: "completion_notify",
  on: ["task_completed"],
  params: { target: "owner", message: "done" },
} as const;

/** 내장 + GENERIC_TASK_TYPE + extra. 구성 실패는 픽스처 결함으로 던진다. */
export function testRegistries(extra?: {
  readonly taskTypes?: readonly TaskTypeDescriptor[];
}): DomainRegistries {
  const built = createBuiltinRegistries({
    taskTypes: [GENERIC_TASK_TYPE, ...(extra?.taskTypes ?? [])],
  });
  if (!built.ok)
    throw new Error(`fixture: registry construction failed ${JSON.stringify(built.error)}`);
  return built.value;
}

/** 픽스처가 상태 도달에 쓰는 시험 유형까지 등록한 등록부. */
export function fixtureRegistries(): DomainRegistries {
  return testRegistries({
    taskTypes: [
      probeTaskType(),
      probeQuestionOnlyTaskType(),
      probeRecordsNotifyTaskType(),
      probeOverridePromptTaskType(),
    ],
  });
}
