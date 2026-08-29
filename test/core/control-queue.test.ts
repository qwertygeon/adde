import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  writeMinimalProjectConf,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { projectPaths } from "../../src/shared/paths.js";

// SC-058 (FR-022) 회귀 — control 큐 claim 스키마 검증(보안 검토 SEC-002). `JSON.parse(...) as
// ControlRequest` 는 컴파일타임 단언일 뿐 런타임 보장이 아니었다 — 미인식 op 가 소비처
// (handleControlRequest)의 가장 파괴적인 분기(remove)로 흘러들 위험이 있었다. drainControl 을
// 직접 관통시켜 스키마 위반이 handle 에 도달하기 전에 거부되는지 확인한다.

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
  writeMinimalProjectConf(roots.base, PROJ, { vault: roots.vaultRoot });
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

function writeRawRequest(controlDir: string, id: string, body: unknown): void {
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, `${id}.req.json`), JSON.stringify(body));
}

async function drainOnce(handle: (req: unknown) => Promise<{ v: 1; id: string; ok: boolean }>) {
  const { drainControl } = await import("../../src/core/control-queue.js");
  return drainControl({
    base: roots.base,
    proj: PROJ,
    handle: handle as never,
  });
}

describe("SC-058: 데몬 상주 중 CLI 중지는 폴 대상에서 이탈하고 되살아나지 않는다", () => {
  it("Edge(스키마 위반: 미인식 op): handle 에 도달하지 못하고 사유와 함께 거부된다", async () => {
    const pp = projectPaths(roots.base, PROJ);
    const id = "1000-aaaa0001";
    writeRawRequest(pp.controlDir, id, {
      v: 1,
      id,
      op: "wipe-everything", // CONTROL_OPS 밖 — 가장 파괴적인 remove 로 향하던 결함(A-P006).
      sid: "s1",
      requestedAt: new Date().toISOString(),
      requester: { pid: 1 },
    });
    let handledCalled = false;
    const handled = await drainOnce(async (req) => {
      handledCalled = true;
      return { v: 1, id: (req as { id: string }).id, ok: true };
    });
    expect(handledCalled).toBe(false);
    expect(handled).toBe(0); // 스키마 위반은 "처리 건수" 에 세지 않는다(거부이지 처리 성공이 아니다).
    const res = JSON.parse(fs.readFileSync(path.join(pp.controlDir, `${id}.res.json`), "utf8")) as {
      ok: boolean;
      reason?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/스키마/);
  });

  it("Edge(스키마 위반: v≠1): 동일하게 handle 에 도달하지 않고 거부된다", async () => {
    const pp = projectPaths(roots.base, PROJ);
    const id = "1000-aaaa0002";
    writeRawRequest(pp.controlDir, id, {
      v: 2,
      id,
      op: "stop",
      sid: "s1",
      requestedAt: new Date().toISOString(),
      requester: { pid: 1 },
    });
    let handledCalled = false;
    await drainOnce(async (req) => {
      handledCalled = true;
      return { v: 1, id: (req as { id: string }).id, ok: true };
    });
    expect(handledCalled).toBe(false);
    const res = JSON.parse(fs.readFileSync(path.join(pp.controlDir, `${id}.res.json`), "utf8")) as {
      ok: boolean;
      reason?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/스키마/);
  });

  it("Edge(스키마 위반: requester.pid 손상): 타입이 어긋난 요청도 거부된다", async () => {
    const pp = projectPaths(roots.base, PROJ);
    const id = "1000-aaaa0003";
    writeRawRequest(pp.controlDir, id, {
      v: 1,
      id,
      op: "stop",
      sid: "s1",
      requestedAt: new Date().toISOString(),
      requester: { pid: "not-a-number" },
    });
    let handledCalled = false;
    await drainOnce(async (req) => {
      handledCalled = true;
      return { v: 1, id: (req as { id: string }).id, ok: true };
    });
    expect(handledCalled).toBe(false);
    const res = JSON.parse(fs.readFileSync(path.join(pp.controlDir, `${id}.res.json`), "utf8")) as {
      ok: boolean;
    };
    expect(res.ok).toBe(false);
  });

  it("Happy(회귀 가드): 정상 스키마 요청은 handle 로 정확히 전달되고 성공 결과가 남는다", async () => {
    const pp = projectPaths(roots.base, PROJ);
    const id = "1000-aaaa0004";
    writeRawRequest(pp.controlDir, id, {
      v: 1,
      id,
      op: "stop",
      sid: "s1",
      requestedAt: new Date().toISOString(),
      requester: { pid: 1 },
    });
    let receivedOp: string | null = null;
    const handled = await drainOnce(async (req) => {
      receivedOp = (req as { op: string }).op;
      return { v: 1, id: (req as { id: string }).id, ok: true };
    });
    expect(receivedOp).toBe("stop");
    expect(handled).toBe(1);
    const res = JSON.parse(fs.readFileSync(path.join(pp.controlDir, `${id}.res.json`), "utf8")) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
  });
});
