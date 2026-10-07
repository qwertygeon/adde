/**
 * 내장 TaskType 네 종. 입력 스키마는 strict, 안전 관련 필드에 기본값이 없다. 기한·만료·리마인더는
 * 입력이 아니라 TaskPolicy 필드가 맡는다.
 */
import * as z from "zod";
import type { TaskTypeDescriptor } from "../registry/descriptors.js";
import { actorRefSchema, utcInstantSchema } from "./schemas.js";
import { checkDataSchema } from "../task-result/data-schema.js";

const nonEmptyString = z.string().min(1);

export const CONFIRMATION_TASK_TYPE: TaskTypeDescriptor = {
  id: "confirmation",
  version: 1,
  title: "Confirmation",
  description: "Ask a human to accept, reject or cancel a stated next step.",
  schema: z.strictObject({
    prompt: nonEmptyString,
    targetActor: actorRefSchema,
    allowedDecisions: z
      .array(z.enum(["accept", "reject", "cancel"]))
      .min(1)
      .refine((values) => new Set(values).size === values.length, {
        message: "duplicate_decision",
      }),
    nextStep: z.string().optional(),
  }),
  inputFields: {
    prompt: { question: "What should the human be asked to confirm?", safetyRelevant: false },
    targetActor: { question: "Who must answer this confirmation?", safetyRelevant: true },
    allowedDecisions: {
      question: "Which decisions may the human choose from?",
      safetyRelevant: true,
    },
  },
  outputs: { decision: z.literal("accept"), decidedAt: utcInstantSchema },
  acceptanceOutputs: { decision: "decision", decidedAt: "decidedAt" },
  executionEffect: "records_only",
  capabilities: { canAutoPlan: true, requiresHumanBeforeExecute: false },
  approvalGatesQuestionOnly: true,
  executionIsWaitRequest: true,
};

export const AGENT_GOAL_TASK_TYPE: TaskTypeDescriptor = {
  id: "agent_goal",
  version: 1,
  title: "Agent goal",
  description: "Dispatch a goal to an agent session and collect its result.",
  schema: z.strictObject({
    goal: nonEmptyString,
    projectId: nonEmptyString,
    category: z.enum(["development", "analysis", "research", "review", "other"]),
    completionEvidence: nonEmptyString,
    sessionSelection: nonEmptyString,
    contextRef: z.string().optional(),
    toolScope: nonEmptyString.optional(),
    // 원본을 그대로 검사한다 — 레코드 파싱은 새 객체에 대입하며 최상위 `__proto__` 키를 잃는다.
    // 비객체는 허용 목록 검사의 루트 검사가 거절한다.
    dataSchema: z
      .unknown()
      .superRefine((value, ctx) => {
        for (const issue of checkDataSchema(value)) {
          ctx.addIssue({ code: "custom", message: issue.code, path: [...issue.path] });
        }
      })
      .optional(),
  }),
  inputFields: {
    goal: { question: "What goal should the agent accomplish?", safetyRelevant: false },
    projectId: { question: "Which project should the agent work in?", safetyRelevant: false },
    category: { question: "What category of work is this goal?", safetyRelevant: false },
    completionEvidence: {
      question: "What evidence shows that the goal is complete?",
      safetyRelevant: false,
    },
    sessionSelection: {
      question: "Which agent session should receive this goal?",
      safetyRelevant: false,
    },
    toolScope: {
      question: "Which approved tool scope may the agent use while unattended?",
      safetyRelevant: true,
      requiredWhen: "unattended_eligible",
    },
  },
  // 빈 요약은 알릴 내용이 없는 결과라 출력 위반이다 — 요약을 알림 메시지에 결합하는 증명도 이로써 성립한다.
  outputs: {
    summary: nonEmptyString,
    data: { outputSchemaFromInput: "dataSchema", optional: true },
  },
  executionEffect: "agent_dispatch",
  capabilities: { canAutoPlan: true, requiresHumanBeforeExecute: false },
  approvalGatesQuestionOnly: false,
  executionIsWaitRequest: false,
};

export const DELEGATION_TASK_TYPE: TaskTypeDescriptor = {
  id: "delegation",
  version: 1,
  title: "Delegation",
  description: "Hand a request to another person and wait for their response.",
  schema: z.strictObject({
    assignee: actorRefSchema,
    request: nonEmptyString,
    responseType: z.enum(["none", "acknowledgement", "completion"]),
  }),
  inputFields: {
    assignee: { question: "Who should receive this request?", safetyRelevant: true },
    request: { question: "What is being requested of the assignee?", safetyRelevant: false },
    responseType: {
      question: "What kind of response is expected from the assignee?",
      safetyRelevant: false,
    },
  },
  outputs: { response: z.string() },
  executionEffect: "adde_credentialed",
  capabilities: { canAutoPlan: true, requiresHumanBeforeExecute: true },
  approvalGatesQuestionOnly: false,
  executionIsWaitRequest: true,
};

export const NOTIFICATION_TASK_TYPE: TaskTypeDescriptor = {
  id: "notification",
  version: 1,
  title: "Notification",
  description: "Send a message to a target.",
  schema: z.strictObject({
    target: nonEmptyString,
    message: nonEmptyString,
    importance: z.enum(["low", "normal", "high"]),
  }),
  inputFields: {
    target: { question: "Where should the notification be sent?", safetyRelevant: true },
    message: { question: "What message should be sent?", safetyRelevant: false },
    importance: { question: "How important is this notification?", safetyRelevant: false },
  },
  outputs: {},
  executionEffect: "adde_credentialed",
  capabilities: { canAutoPlan: true, requiresHumanBeforeExecute: true },
  approvalGatesQuestionOnly: false,
  executionIsWaitRequest: false,
};
