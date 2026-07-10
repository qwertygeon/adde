import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  pruneOut,
  markSending,
  writeOut,
  enqueue,
  isDone,
} from "../../src/core/queue.js";
import { lanePaths } from "../../src/shared/paths.js";
import { makeEnvelope } from "../helpers/envelope.js";

// 확정 시그니처(design/tasks.md Test Authoring Contract):
// pruneOut(paths: LanePaths, safeWindowDays: number, now?: Date): Promise<{ removed: string[] }>

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

/** id 의 out 그룹 파일 존재 여부(하나라도 존재하면 true) — 원자 그룹 검증용. */
function anyOutFileExists(id: string): boolean {
  return [".out", ".out.json", ".sent", ".sending", ".aborted", ".failed"].some((ext) =>
    fs.existsSync(path.join(paths.outDir, `${id}${ext}`)),
  );
}

describe("pruneOut — 종단 그룹 id 원자 삭제·안전창 경과분만 (SC-022, FR-027)", () => {
  it("안전창(safeWindowDays) 경과한 종단(.sent) 그룹만 id 단위로 전 구성요소가 삭제된다", async () => {
    // 경과분(안전창 5일 기준 10일 지남) — 삭제 대상.
    const oldIso = "2026-06-30T00:00:00.000Z";
    fs.writeFileSync(path.join(paths.outDir, "old-done.out"), "응답");
    fs.writeFileSync(path.join(paths.outDir, "old-done.out.json"), "{}");
    fs.writeFileSync(path.join(paths.outDir, "old-done.sent"), oldIso);

    // 미경과분(안전창 이내, 최근) — 보존 대상.
    const recentIso = "2026-07-09T12:00:00.000Z";
    fs.writeFileSync(path.join(paths.outDir, "recent-done.out"), "응답");
    fs.writeFileSync(path.join(paths.outDir, "recent-done.out.json"), "{}");
    fs.writeFileSync(path.join(paths.outDir, "recent-done.sent"), recentIso);

    const result = await pruneOut(paths, 5, NOW);

    expect(anyOutFileExists("old-done")).toBe(false);
    expect(anyOutFileExists("recent-done")).toBe(true);
    expect(result.removed).toContain("old-done");
    expect(result.removed).not.toContain("recent-done");
  });

  it("경과한 .aborted·.failed 종단 그룹도 동일하게 원자 삭제된다", async () => {
    const oldIso = "2026-06-01T00:00:00.000Z";
    fs.writeFileSync(path.join(paths.outDir, "old-aborted.out"), "응답");
    fs.writeFileSync(path.join(paths.outDir, "old-aborted.aborted"), oldIso);
    fs.writeFileSync(path.join(paths.outDir, "old-failed.failed"), oldIso);

    await pruneOut(paths, 5, NOW);

    expect(anyOutFileExists("old-aborted")).toBe(false);
    expect(anyOutFileExists("old-failed")).toBe(false);
  });

  it("진행 중(.sending) 마커가 있는 id 는 안전창 경과 여부와 무관하게 삭제되지 않는다(FR-028)", async () => {
    fs.writeFileSync(path.join(paths.outDir, "inflight.out"), "응답");
    await markSending(paths, "inflight");
    // .sending 만 있고 종단 마커가 없으므로 애초에 대상이 아니지만, 방어적으로 오래된 시각을
    // 부여해도(마커 파일 mtime 조작 시도) 삭제되지 않아야 한다.
    fs.utimesSync(
      path.join(paths.outDir, "inflight.sending"),
      new Date("2020-01-01"),
      new Date("2020-01-01"),
    );

    await pruneOut(paths, 5, NOW);
    expect(anyOutFileExists("inflight")).toBe(true);
  });

  it("재실행은 오류 없이 no-op 으로 수렴한다(NFR-003 멱등)", async () => {
    const oldIso = "2026-01-01T00:00:00.000Z";
    fs.writeFileSync(path.join(paths.outDir, "old.out"), "응답");
    fs.writeFileSync(path.join(paths.outDir, "old.sent"), oldIso);

    const r1 = await pruneOut(paths, 5, NOW);
    expect(r1.removed).toContain("old");
    const r2 = await pruneOut(paths, 5, NOW);
    expect(r2.removed).toEqual([]); // 이미 삭제됨 — 2회차 no-op
  });

  it("out/ 디렉터리가 비어 있으면 no-op(removed 빈 배열)", async () => {
    const result = await pruneOut(paths, 5, NOW);
    expect(result.removed).toEqual([]);
  });
});

describe("pruneOut — dedup 앵커는 백업이 아니라 삭제 대상, 기본 off 구조 (SC-020, FR-024·FR-025)", () => {
  it("일반 큐 동작(enqueue/writeOut)은 pruneOut 을 명시적으로 호출하지 않는 한 종단 앵커를 건드리지 않는다", async () => {
    // opt-in 은 out_retention_days 설정 시에만 C-02 가 pruneOut 을 호출하는 구조(호출자 책임) —
    // 여기선 pruneOut 자체가 명시 호출 없이는 부작용이 없는 순수 함수임을 확인한다(자동 트리거 0).
    await enqueue(paths, makeEnvelope("normal-1"));
    await writeOut(paths, "normal-1", "resp", { reply_ref: { channel_msg_id: "1" } });
    expect(await isDone(paths, "normal-1")).toBe(true);
    // pruneOut 을 호출하지 않았으므로 done 상태가 그대로 유지된다.
    expect(await isDone(paths, "normal-1")).toBe(true);
  });

  it("dedup 앵커는 어떤 백업 경로로도 이동되지 않고(삭제만) — pruneOut 시그니처에 백업 목적지가 없다", async () => {
    const oldIso = "2026-01-01T00:00:00.000Z";
    fs.writeFileSync(path.join(paths.outDir, "old.out"), "응답");
    fs.writeFileSync(path.join(paths.outDir, "old.sent"), oldIso);
    await pruneOut(paths, 5, NOW);
    // 삭제(정리)만 있고 이동 대상 디렉터리 개념이 없음 — out/ 바깥 어디에도 잔존물이 생기지 않는다.
    expect(fs.existsSync(path.join(paths.stateDir, "old.out"))).toBe(false);
  });
});
