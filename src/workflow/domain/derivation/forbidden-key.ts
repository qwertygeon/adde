/**
 * 값 안 own `__proto__` 키의 첫 위치. 보고 출력 검사와 Task 입력 검증이 같이 쓴다.
 */

const FORBIDDEN_KEY = "__proto__";

function search(
  value: unknown,
  path: (string | number)[],
): readonly (string | number)[] | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      path.push(index);
      const found = search(value[index], path);
      if (found !== undefined) return found;
      path.pop();
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    path.push(key);
    if (key === FORBIDDEN_KEY) return [...path];
    const found = search(record[key], path);
    if (found !== undefined) return found;
    path.pop();
  }
  return undefined;
}

/**
 * 값 안 own "__proto__" 키의 첫 위치(객체 키 정렬·배열 순서의 깊이 우선, 마지막 조각이 "__proto__"). zod
 * 객체 파싱은 그 키를 알 수 없는 키로 보고하지 않고 출력에서 버리므로, 스키마가 막는 키를 실은 값이 위반
 * 없이 통과하지 않게 한다. 경로 조각은 원래 키다 — 이슈에 실을 때 정규화는 이슈를 만드는 쪽이 한다.
 */
export function forbiddenKeyPath(value: unknown): readonly (string | number)[] | undefined {
  return search(value, []);
}
