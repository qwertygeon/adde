// 커밋·판정 결과 읽기 헬퍼 — 이벤트 `type` 목록과 `payload` 만 읽는다(문자열 메시지 단언 없음).
import type {
  CommandOutcome,
  DomainCommit,
  SignalJudgement,
} from "../../../../src/workflow/domain/index.js";

export function eventTypes(commit: DomainCommit): string[] {
  return commit.events.map((e) => e.type);
}

/** 커밋에서 첫 `type` 이벤트의 payload. 없으면 던진다. */
export function payloadOf(commit: DomainCommit, type: string): Record<string, unknown> {
  const event = commit.events.find((e) => e.type === type);
  if (event === undefined)
    throw new Error(`expected event "${type}" in commit, got [${eventTypes(commit).join(", ")}]`);
  return event.payload as unknown as Record<string, unknown>;
}

/** 판정·명령 결과가 남긴 커밋(상태 변이 커밋 또는 기록 커밋). 없으면 undefined. */
export function recordedCommit(
  outcome: CommandOutcome | SignalJudgement,
): DomainCommit | undefined {
  switch (outcome.kind) {
    case "committed":
    case "accepted":
    case "duplicate":
    case "rejected_stale":
    case "forged_provenance":
      return outcome.commit;
    case "rejected":
      return "commit" in outcome ? outcome.commit : outcome.record;
    case "not_applicable":
      return undefined;
  }
}
