import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pruneOut, writeOutBody, setDone, setSending, isDone } from "../../src/core/out-ledger.js";
import type { OutEntry } from "../../src/core/out-ledger.js";
import { lanePaths } from "../../src/shared/paths.js";
import { enqueue } from "../../src/core/queue.js";
import { makeEnvelope } from "../helpers/envelope.js";

// 확정 시그니처(design/tasks.md Test Authoring Contract):
// pruneOut(paths: LanePaths, safeWindowDays: number, now?: Date): Promise<{ removed: string[] }>
// 013-out-state-ledger 이전: 마커 파일(fs.writeFileSync(".sent") 등) fixture → ledger entry(state+ts)
// fixture 로 대체(SC-010·SC-011). 행위 단언(원자 그룹 삭제·안전창·sending 절대제외·no-op 멱등)은 동일 유지.

let tmpBase: string;
let paths: ReturnType<typeof lanePaths>;

const NOW = new Date("2026-07-10T00:00:00.000Z");

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "adde-prune-"));
  paths = lanePaths(tmpBase, "myproj", "L");
  fs.mkdirSync(paths.outDir, { recursive: true });
  fs.mkdirSync(paths.queueDir, { recursive: true });
  fs.mkdirSync(paths.processingDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

/** ledger.json 픽스처를 직접 기록 — prune 나이 판정을 entry.ts 로 정밀 제어. */
function writeLedgerFixture(entries: Record<string, OutEntry>): void {
  fs.mkdirSync(path.dirname(paths.outLedgerFile), { recursive: true });
  fs.writeFileSync(paths.outLedgerFile, JSON.stringify({ v: 1, entries }));
}

/** id 의 ledger entry 존재 여부(원자 그룹 삭제 검증용 — entry 삭제 시 undefined). */
function ledgerEntries(): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(paths.outLedgerFile, "utf8")) as {
    entries: Record<string, unknown>;
  };
  return raw.entries;
}

describe("pruneOut — 종단 그룹 id 원자 삭제·안전창 경과분만 (SC-010, FR-010)", () => {
  it("안전창(safeWindowDays) 경과한 종단(sent) 그룹만 id 단위로 전 구성요소(entry+body)가 삭제된다", async () => {
    // 경과분(안전창 5일 기준 10일 지남) — 삭제 대상.
    const oldIso = "2026-06-30T00:00:00.000Z";
    fs.writeFileSync(path.join(paths.outDir, "old-done.out"), "응답");

    // 미경과분(안전창 이내, 최근) — 보존 대상.
    const recentIso = "2026-07-09T12:00:00.000Z";
    fs.writeFileSync(path.join(paths.outDir, "recent-done.out"), "응답");

    writeLedgerFixture({
      "old-done": { state: "sent", ts: oldIso },
      "recent-done": { state: "sent", ts: recentIso },
    });

    const result = await pruneOut(paths, 5, NOW);

    expect(ledgerEntries()["old-done"]).toBeUndefined();
    expect(fs.existsSync(path.join(paths.outDir, "old-done.out"))).toBe(false);
    expect(ledgerEntries()["recent-done"]).toBeDefined();
    expect(fs.existsSync(path.join(paths.outDir, "recent-done.out"))).toBe(true);
    expect(result.removed).toContain("old-done");
    expect(result.removed).not.toContain("recent-done");
  });

  it("경과한 aborted 종단 그룹도 동일하게 원자 삭제된다", async () => {
    const oldIso = "2026-06-01T00:00:00.000Z";
    fs.writeFileSync(path.join(paths.outDir, "old-aborted.out"), "응답");
    writeLedgerFixture({ "old-aborted": { state: "aborted", ts: oldIso } });

    await pruneOut(paths, 5, NOW);

    expect(ledgerEntries()["old-aborted"]).toBeUndefined();
    expect(fs.existsSync(path.join(paths.outDir, "old-aborted.out"))).toBe(false);
  });

  it("failed 는 종단이 아니다 — done+failed(전송 실패·재전송 대기) id 는 안전창 경과여도 보존된다", async () => {
    // findUnsent 종단 정의(sent/aborted)와 동일 집합이어야 한다 — failed 를 종단으로 오분류하면
    // 재전송 대기 중인 미전달 응답의 body(dedup 앵커)가 파괴된다(PR #44 독립 리뷰 발견 quirk 보존).
    const oldIso = "2026-06-01T00:00:00.000Z";
    fs.writeFileSync(path.join(paths.outDir, "undelivered.out"), "미전달 응답");
    writeLedgerFixture({ undelivered: { state: "failed", ts: oldIso, reason: "deliver 실패 기록" } });

    const result = await pruneOut(paths, 5, NOW);

    expect(ledgerEntries()["undelivered"]).toBeDefined(); // entry 보존(재전송 경로 유지)
    expect(fs.existsSync(path.join(paths.outDir, "undelivered.out"))).toBe(true);
    expect(result.removed).not.toContain("undelivered");
  });

  it("진행 중(sending) 상태인 id 는 안전창 경과 여부와 무관하게 삭제되지 않는다(SC-010 방어)", async () => {
    fs.writeFileSync(path.join(paths.outDir, "inflight.out"), "응답");
    await setSending(paths, "inflight");
    // ledger fixture 로 오래된 ts 를 강제 부여해도(조작 시도) 삭제되지 않아야 한다(sending 절대 제외).
    writeLedgerFixture({ inflight: { state: "sending", ts: "2020-01-01T00:00:00.000Z" } });

    await pruneOut(paths, 5, NOW);
    expect(ledgerEntries()["inflight"]).toBeDefined();
    expect(fs.existsSync(path.join(paths.outDir, "inflight.out"))).toBe(true);
  });

  it("재실행은 오류 없이 no-op 으로 수렴한다(NFR-003 멱등)", async () => {
    const oldIso = "2026-01-01T00:00:00.000Z";
    fs.writeFileSync(path.join(paths.outDir, "old.out"), "응답");
    writeLedgerFixture({ old: { state: "sent", ts: oldIso } });

    const r1 = await pruneOut(paths, 5, NOW);
    expect(r1.removed).toContain("old");
    const r2 = await pruneOut(paths, 5, NOW);
    expect(r2.removed).toEqual([]); // 이미 삭제됨 — 2회차 no-op
  });

  it("ledger entries 가 비어 있으면 no-op(removed 빈 배열)", async () => {
    const result = await pruneOut(paths, 5, NOW);
    expect(result.removed).toEqual([]);
  });
});

describe("pruneOut — dedup 앵커는 백업이 아니라 삭제 대상, 기본 off 구조 (SC-011, FR-010)", () => {
  it("일반 큐 동작(enqueue/writeOutBody+setDone)은 pruneOut 을 명시적으로 호출하지 않는 한 종단 앵커를 건드리지 않는다", async () => {
    // opt-in 은 out_retention_days 설정 시에만 C-02 가 pruneOut 을 호출하는 구조(호출자 책임) —
    // 여기선 pruneOut 자체가 명시 호출 없이는 부작용이 없는 순수 함수임을 확인한다(자동 트리거 0).
    await enqueue(paths, makeEnvelope("normal-1"));
    await writeOutBody(paths, "normal-1", "resp");
    await setDone(paths, "normal-1", { reply_ref: { channel_msg_id: "1" } });
    expect(await isDone(paths, "normal-1")).toBe(true);
    // pruneOut 을 호출하지 않았으므로 done 상태가 그대로 유지된다.
    expect(await isDone(paths, "normal-1")).toBe(true);
  });

  it("dedup 앵커는 어떤 백업 경로로도 이동되지 않고(삭제만) — pruneOut 시그니처에 백업 목적지가 없다", async () => {
    const oldIso = "2026-01-01T00:00:00.000Z";
    fs.writeFileSync(path.join(paths.outDir, "old.out"), "응답");
    writeLedgerFixture({ old: { state: "sent", ts: oldIso } });
    await pruneOut(paths, 5, NOW);
    // 삭제(정리)만 있고 이동 대상 디렉터리 개념이 없음 — out/ 바깥 어디에도 잔존물이 생기지 않는다.
    expect(fs.existsSync(path.join(paths.stateDir, "old.out"))).toBe(false);
  });
});
