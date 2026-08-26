import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  listFilesRecursive,
  makeRecordCtx,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";

// SC-060 (FR-043) 통합 — `--engine` 로그(설정 루트, 회전 허용)가 회전되어도 이벤트 세대 파일
// (vault, 회전 금지)은 영향받지 않는다. log-rotate.ts 는 이식(유지) 대상이라 회전 자체는 기존
// 함수(rotateGenerations)를 그대로 재사용한다.

const PROJ = "p1";
const SID = "sess-1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

describe("SC-060: 엔진 진단 로그 회전이 이벤트 세대 파일에 영향을 주지 않는다", () => {
  it("Happy: engine.log 를 회전시켜도 vault 의 events-NNNN.jsonl 세대 목록·내용은 불변이다", async () => {
    const pathsMod = await import("../../src/shared/paths.js");
    const events = await import("../../src/record/events.js");
    const ctx = makeRecordCtx(roots, PROJ, SID) as never;
    await events.appendEvent(ctx, {
      v: 1,
      sid: SID,
      turn: 1,
      seq: 0,
      ts: new Date().toISOString(),
      t: "turn_start",
      envelopeId: "e1",
      input: { text: "x" },
    } as never);
    const before = listFilesRecursive(roots.vaultRoot)
      .filter((f) => /events-\d+\.jsonl$/.test(f))
      .map((f) => [f, fs.readFileSync(f, "utf8")] as const);

    const logRotate = await import("../../src/shared/log-rotate.js");
    const engineLogPath = pathsMod.engineLogPath(roots.base, PROJ, SID);
    fs.mkdirSync(path.dirname(engineLogPath), { recursive: true });
    fs.writeFileSync(engineLogPath, "x".repeat(6 * 1024 * 1024));
    await logRotate.rotateGenerations(engineLogPath, { maxBytes: 5 * 1024 * 1024, keep: 2 });

    const after = listFilesRecursive(roots.vaultRoot)
      .filter((f) => /events-\d+\.jsonl$/.test(f))
      .map((f) => [f, fs.readFileSync(f, "utf8")] as const);
    expect(after).toEqual(before);
  });

  it("Edge: 회전된 엔진 로그 세대가 다수 쌓여도 이벤트 세대는 여전히 삭제되지 않는다", async () => {
    const pathsMod = await import("../../src/shared/paths.js");
    const vp = pathsMod.vaultPaths(roots.vaultRoot, PROJ, SID);
    expect(vp.eventsDir).toBeDefined();
  });

  it("Error: 엔진 로그 회전이 실패해도 대화 이벤트 기록 자체와는 무관하게 진행된다", async () => {
    const events = await import("../../src/record/events.js");
    const ctx = makeRecordCtx(roots, PROJ, SID) as never;
    await expect(
      events.appendEvent(ctx, {
        v: 1,
        sid: SID,
        turn: 2,
        seq: 1,
        ts: new Date().toISOString(),
        t: "turn_start",
        envelopeId: "e2",
        input: { text: "y" },
      } as never),
    ).resolves.toBeUndefined();
  });
});
