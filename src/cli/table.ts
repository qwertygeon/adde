/**
 * CLI 표 렌더 — 헤더 행 + 컬럼 폭 자동 정렬. `status`·`session ls` 등 목록 출력이 공유한다
 * (같은 개념에 다른 표기·정렬을 쓰지 않도록 단일 헬퍼로 둔다).
 */
export function table(header: string[], body: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => (row[i] ?? "").length)),
  );
  const fmt = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  return [fmt(header), ...body.map(fmt)].join("\n");
}
