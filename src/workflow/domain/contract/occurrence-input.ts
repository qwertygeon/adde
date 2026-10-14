/**
 * 회차 결합 필드 이름과 발화 선언별 제공 필드 — the workflow contract "Work definition and occurrence
 * contract" `OccurrenceInput` 의 선택 필드 넷. 일정 활성화는 원래 시각·현지 날짜·타임존, 외부 신호
 * 활성화는 수용한 신호를 회차 입력에 싣는다. 키가 없는 발화 선언은 제공 필드가 없다.
 */
import type { FiringMode } from "../registry/descriptors.js";

export const OCCURRENCE_INPUT_FIELDS = [
  "scheduledForUtc",
  "localDate",
  "timezone",
  "signal",
] as const;

export type OccurrenceInputField = (typeof OCCURRENCE_INPUT_FIELDS)[number];

export const OCCURRENCE_FIELDS_BY_FIRING: Readonly<
  Partial<Record<FiringMode, readonly OccurrenceInputField[]>>
> = {
  schedule: ["scheduledForUtc", "localDate", "timezone"],
  external_signal: ["signal"],
};
