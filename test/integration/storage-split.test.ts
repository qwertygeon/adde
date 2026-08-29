import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  listFilesRecursive,
  makeRecordCtx,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeSessionRecordFixture } from "../helpers/session-record-fixture.js";

// SC-029 (FR-029): 설정 루트에는 설정·시크릿·런타임 상태만, 저장소 루트에는 이벤트 기록·노트·
// 첨부·중복판정 기록만 존재한다.

const PROJ = "p1";
const SID = "sess-1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

describe("SC-029: 설정·시크릿과 대화 데이터의 저장 위치가 분리된다", () => {
  it("Happy: 턴 1건 처리 후 설정 루트·저장소 루트 파일이 각자 허용 집합만 포함한다", async () => {
    const events = await import("../../src/record/events.js");
    const sessionStore = await import("../../src/core/session-store.js");
    const now = new Date().toISOString();

    await sessionStore.saveSession(roots.base, PROJ, makeSessionRecordFixture(SID));

    await events.appendEvent(
      makeRecordCtx(roots, PROJ, SID) as never,
      {
        v: 1,
        sid: SID,
        turn: 1,
        seq: 0,
        ts: now,
        t: "turn_start",
        envelopeId: "e1",
        input: { text: "hi" },
      } as never,
    );

    const baseFiles = listFilesRecursive(roots.base);
    const vaultFiles = listFilesRecursive(roots.vaultRoot);

    // 설정 루트: sessions.d/*.json·project.conf 류만
    for (const f of baseFiles) {
      expect(/sessions\.d[\\/].*\.json$|project\.conf$|\.env$|runtime[\\/]/.test(f)).toBe(true);
    }
    // 저장소 루트: 이벤트·노트·첨부·중복판정만(.adde/ 하위 events, blobs, ledger)
    for (const f of vaultFiles) {
      expect(/events-\d+\.jsonl$|\.md$|blobs[\\/]|dedup\.jsonl$/.test(f)).toBe(true);
    }
  });

  it("Edge: 첨부(blob)가 포함된 턴이어도 blob 은 vault 에만 존재한다", async () => {
    const blobs = await import("../../src/record/blobs.js");
    await blobs.putBlob(makeRecordCtx(roots, PROJ, SID) as never, Buffer.from("attachment"));
    const baseFiles = listFilesRecursive(roots.base);
    expect(baseFiles.some((f) => f.includes("blobs"))).toBe(false);
  });

  it("Error: 시크릿을 포함한 설정이 있어도 vault 로 유입되지 않는다", async () => {
    const projDir = path.join(roots.base, "projects", PROJ);
    const fsMod = await import("node:fs");
    fsMod.mkdirSync(projDir, { recursive: true });
    fsMod.writeFileSync(path.join(projDir, ".env"), "BOT_TOKEN=5000000000:AAAAsecretfaketoken\n");
    const vaultFiles = listFilesRecursive(roots.vaultRoot);
    for (const f of vaultFiles) {
      expect(fsMod.readFileSync(f, "utf8")).not.toContain("AAAAsecretfaketoken");
    }
  });
});
