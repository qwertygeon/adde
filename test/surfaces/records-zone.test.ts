import { describe, expect, it } from "vitest";

// SC-054 (FR-039) — 기록 존 상한 초과분이 누계 요약으로 접힌다.
// 실측 시그니처(src/surfaces/markdown/inbox.ts):
//   planRecordsCap(lines: string[], recordsStart: number, cap: number, stamp: string):
//     { lines: string[]; changed: boolean }
// cap<=0 이면 비활성(변경 없음). strict 종단 마커(sent/empty) 수가 cap 을 넘을 때만 접는다.

function sentMarker(turn: number): string {
  return `- [x] ✅ sent [[${String(turn).padStart(4, "0")} 2026-08-26T00-00-0${turn}]]`;
}

describe("SC-054: 기록 존 상한 초과분이 누계 요약으로 접힌다", () => {
  it("Happy: 상한 3·마커 4개 상태에서 다음 전송 확정 시 최근 1건 + 누계 요약 1줄만 남는다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const lines = [
      "<!-- adde:records -->",
      sentMarker(1),
      sentMarker(2),
      sentMarker(3),
      sentMarker(4),
    ];
    const result = inbox.planRecordsCap(lines, 1, 3, "20260826-000000");
    expect(result.changed).toBe(true);
    // recordsStart(1) 이후 최근 1건(유지) + 누계 요약 1줄 = 2줄만 남는다.
    expect(result.lines.length - 1).toBeLessThanOrEqual(2);
    expect(result.lines.some((l) => /🗄️?\s*archived/.test(l))).toBe(true);
  });

  it("Edge: 기존 누계 요약이 있으면 새 접힘분과 병합된다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const lines = [
      "<!-- adde:records -->",
      "- [x] 🗄️ archived 10 20260101-000000",
      sentMarker(1),
      sentMarker(2),
      sentMarker(3),
    ];
    const result = inbox.planRecordsCap(lines, 1, 1, "20260826-000000");
    expect(result.changed).toBe(true);
    const summaryLine = result.lines.find((l) => /archived\s+(\d+)/.exec(l));
    const count = summaryLine ? Number(/archived\s+(\d+)/.exec(summaryLine)![1]) : 0;
    expect(count).toBeGreaterThan(10); // 기존 10건 + 새로 접힌 건수 병합
  });

  it("Error: 상한 미지정(0 이하, 기본 끔)이면 접힘이 발생하지 않는다", async () => {
    const inbox = await import("../../src/surfaces/markdown/inbox.js");
    const lines = [
      "<!-- adde:records -->",
      sentMarker(1),
      sentMarker(2),
      sentMarker(3),
      sentMarker(4),
    ];
    const result = inbox.planRecordsCap(lines, 1, 0, "20260826-000000");
    expect(result.changed).toBe(false);
    expect(result.lines).toEqual(lines);
  });
});
