/**
 * TaskType 입력 필드 프로필 — 필수·조건부 필수·안전 관련 필드 목록. 등록부 구성 때 한 번 계산해
 * 동결 사본에 묶어 두고 검증이 재사용한다(검증마다 필드별 스키마 판정을 반복하지 않는다). 배럴에서
 * 내보내지 않는 내부 모듈이다.
 */
import type { TaskTypeDescriptor } from "./descriptors.js";

export interface TaskTypeFieldProfile {
  /** 스키마 키 순서. */
  readonly schemaKeys: readonly string[];
  /** 스키마상 필수(값 없음이 실패). */
  readonly requiredFields: ReadonlySet<string>;
  /** 스키마상 선택이지만 `requiredWhen: "unattended_eligible"` 인 필드. */
  readonly unattendedRequiredFields: ReadonlySet<string>;
}

const PROFILES = new WeakMap<TaskTypeDescriptor, TaskTypeFieldProfile>();

export function computeTaskTypeFieldProfile(descriptor: TaskTypeDescriptor): TaskTypeFieldProfile {
  const shape = descriptor.schema.shape as Readonly<
    Record<string, { safeParse(value: unknown): { success: boolean } }>
  >;
  const schemaKeys = Object.keys(shape);
  const requiredFields = new Set<string>();
  const unattendedRequiredFields = new Set<string>();
  for (const key of schemaKeys) {
    const field = shape[key];
    if (field !== undefined && !field.safeParse(undefined).success) requiredFields.add(key);
    if (descriptor.inputFields[key]?.requiredWhen === "unattended_eligible") {
      unattendedRequiredFields.add(key);
    }
  }
  return { schemaKeys, requiredFields, unattendedRequiredFields };
}

export function rememberTaskTypeFieldProfile(
  descriptor: TaskTypeDescriptor,
  profile: TaskTypeFieldProfile,
): void {
  PROFILES.set(descriptor, profile);
}

/** 등록부를 거치지 않은 descriptor 는 그 자리에서 계산한다. */
export function taskTypeFieldProfile(descriptor: TaskTypeDescriptor): TaskTypeFieldProfile {
  return PROFILES.get(descriptor) ?? computeTaskTypeFieldProfile(descriptor);
}
