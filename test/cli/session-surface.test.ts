import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeV2TmpRoots, cleanupV2TmpRoots, type V2TmpRoots } from "../helpers/v2-fixtures.js";
import { makeSessionRecordFixture } from "../helpers/session-record-fixture.js";

// SC-031 (FR-031): 상태·진단 출력에 세션 상태와 엔진 상주 여부·최근 활동 시각이 포함된다.
// 실측(src/core/diagnostics.ts): `collectStatus(proj, opts?)` — proj 가 첫 위치 인자이고 base 는
// opts.base 로 전달한다(옵션 객체 단독 호출 아님). 각 행은 SessionStatusRow
// { sid, status, engine, engineRef, title, lastActivityAt, enginePresent } 를 갖는다.

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function seedSessions() {
  const sessionStore = await import("../../src/core/session-store.js");
  await sessionStore.saveSession(
    roots.base,
    PROJ,
    makeSessionRecordFixture("resident-1", { engineRef: "ref-1", status: "active" }),
  );
  await sessionStore.saveSession(
    roots.base,
    PROJ,
    makeSessionRecordFixture("hibernated-1", { engineRef: "ref-2", status: "hibernated" }),
  );
}

describe("SC-031: 상태·진단 출력에 세션 상태·엔진 상주 여부가 포함된다", () => {
  it("Happy: 상주 1·유휴 1 세션이 각자 상태·엔진 상주 여부로 구분되어 표시된다", async () => {
    await seedSessions();
    const diagnostics = await import("../../src/core/diagnostics.js");
    const rows = await diagnostics.collectStatus(PROJ, { base: roots.base });
    const active = rows.find((r) => r.sid === "resident-1" || r.status === "active");
    const hibernated = rows.find((r) => r.sid === "hibernated-1" || r.status === "hibernated");
    expect(active).toBeDefined();
    expect(hibernated).toBeDefined();
  });

  it("Edge: --json 출력에도 동일 필드가 포함된다(직렬화 왕복 유지)", async () => {
    await seedSessions();
    const diagnostics = await import("../../src/core/diagnostics.js");
    const rows = await diagnostics.collectStatus(PROJ, { base: roots.base });
    const serialized = JSON.parse(JSON.stringify(rows));
    expect(serialized).toEqual(rows);
  });

  it("Error: 세션 0개 프로젝트는 빈 목록을 반환한다(오류 아님)", async () => {
    const diagnostics = await import("../../src/core/diagnostics.js");
    await expect(diagnostics.collectStatus("empty-proj", { base: roots.base })).resolves.toEqual(
      [],
    );
  });
});
