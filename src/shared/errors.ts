/** unknown 오류 표시 공통 헬퍼 — 인라인 관용구의 단일화(표류 방지). */

/**
 * unknown 오류를 사람이 읽을 수 있는 문자열로.
 * ACP 오류 등 Error 가 아닌 객체가 올 수 있어 객체는 JSON 으로 펼친다.
 */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** Node fs 오류 코드 추출(없으면 undefined). */
export function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}
