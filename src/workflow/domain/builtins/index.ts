/** 내장 descriptor 목록과 내장 등록부 구성. */
import type { Result } from "../result.js";
import type {
  TaskTypeDescriptor,
  TriggerDescriptor,
  ReactionDescriptor,
} from "../registry/descriptors.js";
import type { DomainRegistries, RegistryConstructionError } from "../registry/registries.js";
import { createDomainRegistries } from "../registry/registries.js";
import {
  CONFIRMATION_TASK_TYPE,
  AGENT_GOAL_TASK_TYPE,
  DELEGATION_TASK_TYPE,
  NOTIFICATION_TASK_TYPE,
} from "./task-types.js";
import {
  IMMEDIATE_TRIGGER,
  AT_TRIGGER,
  AFTER_TRIGGER,
  DEPENDENCIES_COMPLETE_TRIGGER,
  SIGNAL_TRIGGER,
} from "./triggers.js";
import {
  NOTIFY_REACTION,
  REQUEST_CONFIRMATION_REACTION,
  EXECUTE_AGENT_GOAL_REACTION,
  DELEGATE_REACTION,
  SPAWN_TASK_REACTION,
  SPAWN_WORK_REACTION,
} from "./reactions.js";

export const BUILTIN_TASK_TYPES: readonly TaskTypeDescriptor[] = [
  CONFIRMATION_TASK_TYPE,
  AGENT_GOAL_TASK_TYPE,
  DELEGATION_TASK_TYPE,
  NOTIFICATION_TASK_TYPE,
];

export const BUILTIN_TRIGGERS: readonly TriggerDescriptor[] = [
  IMMEDIATE_TRIGGER,
  AT_TRIGGER,
  AFTER_TRIGGER,
  DEPENDENCIES_COMPLETE_TRIGGER,
  SIGNAL_TRIGGER,
];

export const BUILTIN_REACTIONS: readonly ReactionDescriptor[] = [
  NOTIFY_REACTION,
  REQUEST_CONFIRMATION_REACTION,
  EXECUTE_AGENT_GOAL_REACTION,
  DELEGATE_REACTION,
  SPAWN_TASK_REACTION,
  SPAWN_WORK_REACTION,
];

/** 내장 뒤에 extra 를 이어 구성한다. */
export function createBuiltinRegistries(extra?: {
  readonly taskTypes?: readonly TaskTypeDescriptor[];
  readonly triggers?: readonly TriggerDescriptor[];
  readonly reactions?: readonly ReactionDescriptor[];
}): Result<DomainRegistries, RegistryConstructionError> {
  return createDomainRegistries({
    taskTypes: [...BUILTIN_TASK_TYPES, ...(extra?.taskTypes ?? [])],
    triggers: [...BUILTIN_TRIGGERS, ...(extra?.triggers ?? [])],
    reactions: [...BUILTIN_REACTIONS, ...(extra?.reactions ?? [])],
  });
}
