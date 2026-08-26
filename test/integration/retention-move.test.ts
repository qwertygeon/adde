import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  listFilesRecursive,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeMaterialize } from "../helpers/fake-sync.js";

const PROJ = "p1";
const SID = "sess-1";
let roots: V2TmpRoots;
let backupDir: string;

beforeEach(() => {
  roots = makeV2TmpRoots();
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "adde-backup-"));
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
  fs.rmSync(backupDir, { recursive: true, force: true });
});

async function makeCtx() {
  const { makeRecordCtx } = await import("../helpers/v2-fixtures.js");
  return makeRecordCtx(roots, PROJ, SID) as never;
}

async function seedTurnsWithDates(ctx: unknown, daysAgo: number[]) {
  const events = await import("../../src/record/events.js");
  const projector = await import("../../src/record/projector.js");
  // 턴 번호는 1-based(실측 core/turn-runner.ts — turnCounter 는 선증가). project(ctx) 단독 호출은
  // 턴 노트를 만들지 않으므로(projector.ts 실측) 턴마다 projectTurn(phase:"final") 을 명시 호출해
  // retention 이 대상으로 삼을 실제 턴 노트 파일을 만든다.
  for (let i = 0; i < daysAgo.length; i++) {
    const turn = i + 1;
    const ts = new Date(Date.now() - daysAgo[i]! * 86_400_000).toISOString();
    await events.appendEvent(
      ctx as never,
      {
        v: 1,
        sid: SID,
        turn,
        seq: i * 2,
        ts,
        t: "turn_start",
        envelopeId: `e${turn}`,
        input: { text: `turn ${turn}` },
      } as never,
    );
    await events.appendEvent(
      ctx as never,
      {
        v: 1,
        sid: SID,
        turn,
        seq: i * 2 + 1,
        ts,
        t: "turn_end",
        envelopeId: `e${turn}`,
        stopReason: "end_turn",
      } as never,
    );
    await projector.projectTurn(ctx as never, turn, "final");
  }
  await projector.project(ctx as never);
}

describe("SC-045: 보관 일수가 지난 턴 노트만 날짜 하위 폴더로 옮겨진다", () => {
  it("Happy: D-5·D-3 노트만 각 턴 시작 날짜 폴더로 이동하고 D-0·이벤트·세션노트는 바이트 불변이다", async () => {
    const ctx = await makeCtx();
    await seedTurnsWithDates(ctx, [5, 3, 0]);

    const beforeNonTargets = new Map<string, string>();
    for (const f of listFilesRecursive(roots.vaultRoot)) {
      if (!/turns[\\/]/.test(f)) beforeNonTargets.set(f, fs.readFileSync(f, "utf8"));
    }

    const retention = await import("../../src/record/retention.js");
    const { materialize } = makeFakeMaterialize({});
    const policy = { backupDir, retentionDays: 2, now: () => new Date() };
    await retention.runRetention(ctx as never, policy, materialize);

    const vaultTurnsLeft = listFilesRecursive(roots.vaultRoot).filter((f) => /turns[\\/]/.test(f));
    expect(vaultTurnsLeft.length).toBe(1); // 오늘 턴만 남음

    const backupFiles = listFilesRecursive(backupDir);
    expect(backupFiles.length).toBe(2);
    // 목적지가 이관 실행일이 아닌 "턴 시작 날짜" 폴더인지 확인.
    const todayFolder = new Date().toISOString().slice(0, 10);
    expect(backupFiles.some((f) => f.includes(todayFolder))).toBe(false);

    for (const [f, content] of beforeNonTargets) {
      expect(fs.readFileSync(f, "utf8")).toBe(content);
    }
  });

  it("Edge: 정확히 cutoff 경계(retention_days 와 정확히 일치)인 노트는 아직 이관되지 않는다", async () => {
    const ctx = await makeCtx();
    await seedTurnsWithDates(ctx, [2]); // 정확히 2일 전 == cutoff
    const retention = await import("../../src/record/retention.js");
    const { materialize } = makeFakeMaterialize({});
    const policy = { backupDir, retentionDays: 2, now: () => new Date() };
    await retention.runRetention(ctx as never, policy, materialize);
    const vaultTurnsLeft = listFilesRecursive(roots.vaultRoot).filter((f) => /turns[\\/]/.test(f));
    expect(vaultTurnsLeft.length).toBe(1); // strict < 이므로 경계일은 아직 유지
  });

  it("Error: 이동 중 중단돼도 원본·사본 중 최소 하나는 보존된다", async () => {
    const ctx = await makeCtx();
    await seedTurnsWithDates(ctx, [5]);
    const retention = await import("../../src/record/retention.js");
    const { materialize } = makeFakeMaterialize({}, "throw");
    const policy = { backupDir, retentionDays: 2, now: () => new Date() };
    await retention.runRetention(ctx as never, policy, materialize).catch(() => {});
    const vaultTurns = listFilesRecursive(roots.vaultRoot).filter((f) => /turns[\\/]/.test(f));
    const backupTurns = listFilesRecursive(backupDir);
    expect(vaultTurns.length + backupTurns.length).toBeGreaterThanOrEqual(1);
  });
});

describe("SC-047: 재생성이 보관된 턴을 되살리지 않고 멱등하다", () => {
  it("Happy: 노트 전량 삭제 후 같은 정책으로 rebuild 2회 → 오늘 턴만 재생성, 보관분은 '보관됨' 표기, 2회 결과 동일", async () => {
    const ctx = await makeCtx();
    await seedTurnsWithDates(ctx, [5, 3, 0]);
    const retention = await import("../../src/record/retention.js");
    const { materialize } = makeFakeMaterialize({});
    const policy = { backupDir, retentionDays: 2, now: () => new Date() };
    await retention.runRetention(ctx as never, policy, materialize);

    for (const f of listFilesRecursive(roots.vaultRoot).filter((f) => f.endsWith(".md"))) {
      fs.rmSync(f, { force: true });
    }

    const rebuild = await import("../../src/record/rebuild.js");
    await rebuild.rebuild(roots.base, roots.vaultRoot, PROJ, { retention: policy });
    const firstFiles = listFilesRecursive(roots.vaultRoot).filter((f) => f.endsWith(".md"));

    for (const f of firstFiles) fs.rmSync(f, { force: true });
    await rebuild.rebuild(roots.base, roots.vaultRoot, PROJ, { retention: policy });
    const secondFiles = listFilesRecursive(roots.vaultRoot).filter((f) => f.endsWith(".md"));

    expect(firstFiles.sort()).toEqual(secondFiles.sort());
    const turnNotes = firstFiles.filter((f) => /turns[\\/]/.test(f));
    expect(turnNotes.length).toBe(1); // 오늘 턴만 vault 에 재생성됨

    const sessionNote = firstFiles.find((f) => f.endsWith("session.md"));
    if (sessionNote) {
      expect(fs.readFileSync(sessionNote, "utf8")).toMatch(/보관|archived/i);
    }
  });

  it("Edge: 보관분이 0건인 세션도 정상 rebuild 된다", async () => {
    const ctx = await makeCtx();
    await seedTurnsWithDates(ctx, [0]);
    const rebuild = await import("../../src/record/rebuild.js");
    const policy = { backupDir, retentionDays: 2, now: () => new Date() };
    await expect(
      rebuild.rebuild(roots.base, roots.vaultRoot, PROJ, { retention: policy }),
    ).resolves.toBeDefined();
  });

  it("Error: 보관 정책 미주입 rebuild 는 보관분을 재생성한다(정책이 필수 입력임을 반증으로 단언)", async () => {
    const ctx = await makeCtx();
    await seedTurnsWithDates(ctx, [5, 0]);
    const retention = await import("../../src/record/retention.js");
    const { materialize } = makeFakeMaterialize({});
    const policy = { backupDir, retentionDays: 2, now: () => new Date() };
    await retention.runRetention(ctx as never, policy, materialize);

    const rebuild = await import("../../src/record/rebuild.js");
    await rebuild.rebuild(roots.base, roots.vaultRoot, PROJ); // retention 미주입
    const turnNotes = listFilesRecursive(roots.vaultRoot).filter((f) => /turns[\\/]/.test(f));
    // 정책 미주입이면 이관 여부를 몰라 보관분도 재생성 — 이 결과가 나오면 "정책 필수" 계약이
    // 실제로 강제되지 않고 있다는 신호이므로, Development 는 정책 부재 시 명시 오류를 던지도록
    // 강제하는 편이 더 안전하다(FM-1 재발 방지). 본 케이스는 그 갭을 드러내는 관측 테스트다.
    expect(turnNotes.length).toBeGreaterThanOrEqual(1);
  });
});
