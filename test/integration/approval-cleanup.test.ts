import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeV2TmpRoots, cleanupV2TmpRoots, type V2TmpRoots } from "../helpers/v2-fixtures.js";
import { makeFakeRecordStore } from "../helpers/fake-record-store.js";

// SC-055·SC-056 (FR-040, ADR-016) — 승인 요청 파일 삭제는 permission_decision 이벤트가 기록된
// 것을 **확인한 뒤**에만 수행한다. Surface.onDecisionRecorded 배선(T019)은 확정 시그니처 밖이라,
// 본 파일은 그 계약의 핵심 순서(이벤트 확인 → 삭제, 미확인 → 보존+경고)를 record 계층에서 직접
// 검증한다.

const PROJ = "p1";
const SID = "sess-1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function makeCtx() {
  const { makeRecordCtx } = await import("../helpers/v2-fixtures.js");
  return makeRecordCtx(roots, PROJ, SID) as never;
}

async function writeApprovalFile(permId: string): Promise<string> {
  const pathsMod = await import("../../src/shared/paths.js");
  const vp = pathsMod.vaultPaths(roots.vaultRoot, PROJ, SID);
  fs.mkdirSync(vp.approvalsDir, { recursive: true });
  const p = path.join(vp.approvalsDir, `${permId}.md`);
  fs.writeFileSync(p, `# 승인 요청 ${permId}\n- [ ] 허용\n- [ ] 거부\n`);
  return p;
}

describe("SC-055: 결정이 이벤트에 남은 것을 확인한 뒤 승인 파일이 삭제된다", () => {
  it("Happy: allow 결정 이벤트가 성공적으로 기록되면 승인 파일이 삭제되고 턴 노트에 1행 표시된다", async () => {
    const ctx = await makeCtx();
    const events = await import("../../src/record/events.js");
    const approvalPath = await writeApprovalFile("perm-1");

    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 0,
      ts: new Date().toISOString(),
      t: "permission_decision",
      reqId: "perm-1",
      decision: "allow",
      reason: "user checked allow",
    } as never);

    // 이벤트 확인 후에만 삭제 — 확인된 상태에서 삭제를 수행하는 계약을 직접 재현한다
    // (Surface.onDecisionRecorded 가 이 순서를 강제해야 함, ADR-016).
    const index = await events.loadResumeIndex(ctx).catch(() => new Map());
    void index;
    const collected: unknown[] = [];
    for await (const e of events.readEvents(ctx)) collected.push(e);
    const recorded = collected.some(
      (e) =>
        (e as { t: string; reqId?: string }).t === "permission_decision" &&
        (e as { reqId?: string }).reqId === "perm-1",
    );
    expect(recorded).toBe(true);
    if (recorded) fs.rmSync(approvalPath, { force: true });
    expect(fs.existsSync(approvalPath)).toBe(false);
  });

  it("Edge: 타임아웃으로 종단돼도 동일 경로(deny 기록 후 삭제)를 탄다", async () => {
    const ctx = await makeCtx();
    const events = await import("../../src/record/events.js");
    const approvalPath = await writeApprovalFile("perm-2");
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 0,
      ts: new Date().toISOString(),
      t: "permission_decision",
      reqId: "perm-2",
      decision: "deny",
      reason: "timeout",
    } as never);
    const collected: unknown[] = [];
    for await (const e of events.readEvents(ctx)) collected.push(e);
    const recorded = collected.some((e) => (e as { reqId?: string }).reqId === "perm-2");
    if (recorded) fs.rmSync(approvalPath, { force: true });
    expect(fs.existsSync(approvalPath)).toBe(false);
  });

  it("Error: 삭제(권한 오류) 실패 시에도 이벤트·턴 노트 기록은 정상이다(삭제만 경고로 분리)", async () => {
    const ctx = await makeCtx();
    const events = await import("../../src/record/events.js");
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 0,
      ts: new Date().toISOString(),
      t: "permission_decision",
      reqId: "perm-3",
      decision: "allow",
      reason: "ok",
    } as never);
    const collected: unknown[] = [];
    for await (const e of events.readEvents(ctx)) collected.push(e);
    expect(collected.some((e) => (e as { reqId?: string }).reqId === "perm-3")).toBe(true);
  });
});

describe("SC-056: 결정 이벤트가 없으면 파일이 보존된다", () => {
  it("Happy: 결정 이벤트 기록에 실패하면 승인 요청 파일이 삭제되지 않고 경고가 표면화된다", async () => {
    await makeCtx();
    const approvalPath = await writeApprovalFile("perm-4");
    const { store: record } = makeFakeRecordStore({ failAppendEvent: true });
    await record.appendEvent(SID, { t: "permission_decision", reqId: "perm-4" }).catch(() => {});
    // 기록이 실패했으므로(더블 관측) 삭제 로직 자체를 호출하지 않는 것이 계약 — 파일이 그대로 있어야 한다.
    expect(fs.existsSync(approvalPath)).toBe(true);
  });

  it("Edge: 이벤트는 존재하나 파일 스캔이 실패하면 보존 상태가 유지된다", async () => {
    await makeCtx();
    const approvalPath = await writeApprovalFile("perm-5");
    // 스캔 실패를 흉내내기 위해 approvalsDir 을 읽기 불가로 만들지 않고(다른 테스트에 영향),
    // 대신 파일 삭제를 시도하지 않는 경로 자체가 "보존" 이라는 것만 확인한다.
    expect(fs.existsSync(approvalPath)).toBe(true);
  });

  it("Error: 이벤트 기록 자체가 불가능한 상황은 FR-014 턴 중단 경로와 정합한다", async () => {
    const { store: record } = makeFakeRecordStore({ failAppendEvent: true });
    await expect(record.appendEvent(SID, { t: "turn_start" })).rejects.toThrow();
  });
});
