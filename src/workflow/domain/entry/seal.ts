/**
 * 커밋 표식 — 공개 진입이 돌려주는 커밋을 이 모듈 비공개 집합에 넣는다. 표식은 같은 프로세스·같은 모듈
 * 인스턴스 안에서 "공개 진입 중 하나가 이 객체를 만들었다" 만 증명한다. 커밋이 판정된 기준 애그리거트·출처의
 * 진위·envelope 필드 형은 증명하지 않고, 직렬화된 로그 변조 방어는 대상이 아니다. 표식 뒤 내용이 바뀌지
 * 않게 커밋을 깊게 동결한다.
 */
import type { DomainCommit } from "../engine.js";

const ENGINE_COMMITS = new WeakSet<object>();

/**
 * 객체 그래프를 반복(스택) 방식으로 깊게 동결한다. 이미 동결된 객체도 자식으로 내려간다 — 얕게만 동결된
 * 상태 객체를 페이로드가 공유할 수 있어 "동결됨 = 깊게 동결됨" 을 전제하지 않는다.
 */
function deepFreeze(root: object): void {
  const visited = new Set<object>();
  const stack: object[] = [root];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (visited.has(next)) continue;
    visited.add(next);
    Object.freeze(next);
    for (const member of Object.values(next)) {
      if (typeof member === "object" && member !== null) stack.push(member);
    }
  }
}

/** 커밋을 깊게 동결하고 표식한다. 이미 표식된 커밋은 그대로 돌려준다. */
export function sealCommit(commit: DomainCommit): DomainCommit {
  if (ENGINE_COMMITS.has(commit)) return commit;
  deepFreeze(commit);
  ENGINE_COMMITS.add(commit);
  return commit;
}

/**
 * 판정 결과 안의 커밋(commit·record·commits)을 모두 표식하고, commits 배열과 결과 객체를 동결한다 — 표식 뒤
 * 커밋 순서 교체·결과 필드 바꿔치기를 막는다. aggregate·state 는 다음 판정의 입력이라 동결하지 않는다.
 */
export function sealOutcome<O extends object>(outcome: O): O {
  const fields = outcome as {
    readonly commit?: unknown;
    readonly record?: unknown;
    readonly commits?: unknown;
  };
  if (fields.commit !== undefined) sealCommit(fields.commit as DomainCommit);
  if (fields.record !== undefined) sealCommit(fields.record as DomainCommit);
  if (Array.isArray(fields.commits)) {
    for (const commit of fields.commits as readonly DomainCommit[]) sealCommit(commit);
    Object.freeze(fields.commits);
  }
  Object.freeze(outcome);
  return outcome;
}

/** 공개 진입이 만든 커밋이면 참. 필드가 같은 일반 객체·펼침 사본·JSON 왕복 객체는 거짓이다. */
export function isEngineCommit(value: unknown): value is DomainCommit {
  return typeof value === "object" && value !== null && ENGINE_COMMITS.has(value);
}
