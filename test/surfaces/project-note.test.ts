import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";

// SC-025 (FR-025) — 프로젝트 노트의 새 세션 체크박스는 SessionManager.create() 를 호출하고
// 결과(sid·입력 노트 경로)를 기록한 뒤 체크박스를 미체크로 복원한다.
// 실측(src/surfaces/markdown/project-note.ts): 실제 export 는 `handleProjectNoteTriggers(vaultRoot,
// proj, sessionManager): Promise<void>` — 문자열을 받아 문자열을 반환하는 순수 함수가 아니라, vault
// 의 project.md 파일을 직접 읽고 원자적으로 되쓰는 부수효과 함수다(반환값 없음).

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  cleanupV2TmpRoots(roots);
});

async function makeSM() {
  const sessionManagerMod = await import("../../src/core/session-manager.js");
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const sm = sessionManagerMod.createSessionManager(
    makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor }) as never,
  );
  return sm;
}

async function seedProjectNote(content: string): Promise<string> {
  const { ensureVaultLayout } = await import("../../src/record/vault-paths.js");
  const { vaultPaths } = await import("../../src/shared/paths.js");
  await ensureVaultLayout(roots.vaultRoot, PROJ);
  const notePath = vaultPaths(roots.vaultRoot, PROJ).projectNote;
  await writeFile(notePath, content, "utf8");
  return notePath;
}

describe("SC-025: 프로젝트 노트에서 새 세션이 만들어진다", () => {
  it("Happy: 체크박스 체크 → 세션 생성·식별자/입력노트 경로 기록·체크박스 복원", async () => {
    const projectNote = await import("../../src/surfaces/markdown/project-note.js");
    const sm = await makeSM();
    const notePath = await seedProjectNote("- [x] ➕ new session\n");

    await projectNote.handleProjectNoteTriggers(roots.vaultRoot, PROJ, sm);

    const after = await readFile(notePath, "utf8");
    expect(after).not.toContain("- [x] ➕ new session");
    expect(after).toContain("- [ ] ➕ new session");
    expect(after).toMatch(/세션 생성됨: `[^`]+`/);
  });

  it("Edge: 연속 2회 체크는 세션 2개를 만든다(중복 생성 방지 로직 없음 — 매 체크가 독립 요청)", async () => {
    const projectNote = await import("../../src/surfaces/markdown/project-note.js");
    const sm = await makeSM();
    const notePath = await seedProjectNote("- [x] ➕ new session\n");

    await projectNote.handleProjectNoteTriggers(roots.vaultRoot, PROJ, sm);
    const afterFirst = await readFile(notePath, "utf8");
    const firstSid = /세션 생성됨: `([^`]+)`/.exec(afterFirst)?.[1];
    expect(firstSid).toBeDefined();

    await writeFile(notePath, "- [x] ➕ new session\n", "utf8");
    await projectNote.handleProjectNoteTriggers(roots.vaultRoot, PROJ, sm);
    const afterSecond = await readFile(notePath, "utf8");
    const secondSid = /세션 생성됨: `([^`]+)`/.exec(afterSecond)?.[1];
    expect(secondSid).toBeDefined();
    expect(secondSid).not.toBe(firstSid);
  });

  it("Error: 생성 실패 시 사유가 기록되고 체크박스는 복원된다", async () => {
    const projectNote = await import("../../src/surfaces/markdown/project-note.js");
    const sm = await makeSM();
    const failingSm = {
      ...sm,
      create: async () => {
        throw new Error("boom");
      },
    } as unknown as Awaited<ReturnType<typeof makeSM>>;
    const notePath = await seedProjectNote("- [x] ➕ new session\n");

    await projectNote.handleProjectNoteTriggers(roots.vaultRoot, PROJ, failingSm);

    const after = await readFile(notePath, "utf8");
    expect(after).toContain("- [ ] ➕ new session");
    expect(after).toContain("세션 생성 실패");
    expect(after).toContain("boom");
  });
});
