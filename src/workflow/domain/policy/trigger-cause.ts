/**
 * 예약 원인 ↔ Trigger 발화 선언. READY → SCHEDULED 는 예약 발화 Trigger 의 예약, 외부 신호 발화 Trigger 의
 * 신호로만 일어나고, 실행 재시도 occurrence 는 Trigger 와 무관한 사건 원인이다. Task 판정과 재계획 게이트가
 * 같은 표를 쓴다. 선언(firing)만 읽는다.
 */
import type { TriggerDescriptor } from "../registry/descriptors.js";

/** = schedule_task 명령의 cause */
export type ScheduleCause = "schedule" | "external_signal" | "retry";

export function scheduleCauseDeclared(
  descriptor: Pick<TriggerDescriptor, "firing">,
  cause: ScheduleCause,
): boolean {
  switch (cause) {
    case "schedule":
      return descriptor.firing === "schedule";
    case "external_signal":
      return descriptor.firing === "external_signal";
    case "retry":
      return true;
    default: {
      const exhaustive: never = cause;
      throw new Error(`scheduleCauseDeclared: 알 수 없는 예약 원인 ${String(exhaustive)}`);
    }
  }
}
