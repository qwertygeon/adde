/**
 * 날짜 폴더명(`YYYY-MM-DD`) 파생 헬퍼 — markdown.ts(Part A 파티셔닝 write)와 markdown-retention.ts
 * (마이그레이션) 양쪽이 참조한다. 순환 import 회피를 위해 중립 모듈로 분리(둘 다 이 모듈만 의존).
 */

/** 로컬 날짜 폴더명(`YYYY-MM-DD`) — 결정(이관)·아카이브 등 write-time 파티션에 사용. */
export function formatDateFolder(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 전송 스탬프(`YYYYMMDD-HHmmss`)에서 날짜 폴더명(`YYYY-MM-DD`) 파생 — write-time(오늘)이 아닌
 * stamp(origin_ts) 파생이라 재렌더해도 같은 폴더로 귀결한다(재렌더 멱등).
 */
export function dateFolderFromStamp(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-\d{6}$/.exec(stamp);
  if (!m) throw new Error(`invalid stamp: ${stamp}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}
