/**
 * 신뢰 경계 밖 값의 문자열화. 템플릿 보간·`String()` 은 자기 `toString` 데이터 속성을 가진 객체
 * (`{"toString":1}`)에서 `TypeError` 를 던지므로, 후보 키·진단 메시지·이슈 기록은 이 모듈을 거친다.
 */
import { canonicalJson } from "./canonical-json.js";

/**
 * 문자열은 그대로, 수는 템플릿과 같은 십진 표기, 그 밖은 정규 JSON 텍스트, 정규 JSON 으로 표현할 수 없으면
 * `typeof` 이름. 예외를 던지지 않는다 — `null`·불리언·`undefined` 는 템플릿 보간과 같은 글자다.
 */
export function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return `${value}`;
  const json = canonicalJson(value);
  return json.ok ? json.value : typeof value;
}

const LONE_SURROGATE = /\p{Cs}/gu;

/**
 * 외톨이 surrogate 마다 U+FFFD 하나로 바꾼 텍스트 — 커밋 페이로드에 싣는 이슈가 정규 JSON 을 깨지 않게 한다.
 * 결정적이지만 단사가 아니다(서로 다른 외톨이 surrogate 가 같은 글자가 된다). 이슈 경로는 진단 위치라 그
 * 손실을 받아들인다.
 */
export function wellFormedText(text: string): string {
  return text.replace(LONE_SURROGATE, "�");
}

/** 문자열 조각만 wellFormedText 로 바꾼 경로. */
export function wellFormedPath(path: readonly (string | number)[]): readonly (string | number)[] {
  return path.map((segment) => (typeof segment === "string" ? wellFormedText(segment) : segment));
}
