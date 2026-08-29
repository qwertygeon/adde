import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  writeMinimalProjectConf,
  type V2TmpRoots,
  bindSessionManager,
} from "../helpers/v2-fixtures.js";
import { captureSink, queuedLineInput } from "../helpers/prompt-fixtures.js";
import { installAddeHomeGuard } from "../helpers/adde-home-guard.js";

// SC-073·SC-074 (FR-029·NFR-013) — 배치 변경 이전 데이터(legacy blob·원장)는 기동·운영 중
// 무이관·무변경(NFR-013)이고, legacy 세션 완전 제거는 legacy 원장에서 그 sid 라인만 제거한다
// (다른 라인 바이트 불변).
//
// rename 실패 주입은 node:fs/promises 를 통째로 목해야 한다(ESM 네임스페이스 직접 spyOn 은
// read-only 바인딩이라 실패).
const renameCtl = vi.hoisted(() => ({ failWith: null as (() => Error) | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (renameCtl.failWith) {
        const err = renameCtl.failWith();
        renameCtl.failWith = null;
        throw err;
      }
      return actual.rename(...args);
    },
  };
});

const PROJ = "p1";
let roots: V2TmpRoots;
const addeHomeGuard = installAddeHomeGuard(() => roots.base);

beforeEach(() => {
  roots = makeV2TmpRoots();
  writeMinimalProjectConf(roots.base, PROJ, { vault: roots.vaultRoot });
  addeHomeGuard.before();
});

afterEach(() => {
  renameCtl.failWith = null;
  addeHomeGuard.after();
  cleanupV2TmpRoots(roots);
});

async function seedLegacyData(): Promise<{ legacyBlob: string; legacyLedger: string }> {
  const pathsMod = await import("../../src/shared/paths.js");
  const vp = pathsMod.vaultPaths(roots.vaultRoot, PROJ);
  fs.mkdirSync(path.join(vp.legacyBlobsDir, "ab"), { recursive: true });
  const legacyBlob = path.join(vp.legacyBlobsDir, "ab", "abcdef1234");
  fs.writeFileSync(legacyBlob, "legacy blob content");
  fs.mkdirSync(path.dirname(vp.legacyDedupFile), { recursive: true });
  const legacyLedger = vp.legacyDedupFile;
  fs.writeFileSync(legacyLedger, `${JSON.stringify({ hash: "sha256:x", turn: 1 })}\n`);
  return { legacyBlob, legacyLedger };
}

// legacy(v1) 원장 라인의 실제 스키마(레코드는 `first`/`dup` 중첩에 sid 를 담는다 — 4779aae
// `record/dedup.ts:118-119` classify() 의 appendLedgerLine 인자 실측)를 그대로 재현한다. 최상위
// `sid` 필드로 표기한 이전 픽스처는 실제 v1 라인 형태가 아니어서 `filterLegacyLedgerLine`(session
// -removal.ts) 이 항상 무매치로 판정해 SC-074 의 제거 단언이 공허해졌었다(test(EXECUTION) 발견).
function v1LedgerLine(sid: string, hash: string): string {
  return JSON.stringify({
    v: 1,
    hash,
    kind: "user_input",
    first: { sid, turn: 1 },
    dup: { sid: `${sid}-dup-source`, turn: 2 },
    ts: new Date().toISOString(),
  });
}

async function seedLegacySession(sid: string) {
  const sessionStore = await import("../../src/core/session-store.js");
  const now = new Date().toISOString();
  await sessionStore.saveSession(roots.base, PROJ, {
    v: 1,
    sid,
    engine: "acp",
    engineRef: null,
    status: "active",
    title: null,
    createdAt: now,
    lastActivityAt: now,
    successorOf: null,
    engineArgs: [],
    warnings: [],
    bindings: [],
    rev: 0,
    stopReason: null,
    stoppedAt: null,
    stopPending: null,
    stopNotePending: false,
    notices: [],
    // storageLayout 부재 = legacy 구간.
  } as never);
}

describe("SC-073: 배치 변경 이전 데이터는 기동·운영 중 무변경이다", () => {
  it("Happy: legacy blob·원장이 있는 상태로 신규 세션을 기동·운영해도 legacy 파일이 바이트·mtime 동일하다", async () => {
    const { legacyBlob, legacyLedger } = await seedLegacyData();
    const beforeBlob = fs.statSync(legacyBlob);
    const beforeBlobContent = fs.readFileSync(legacyBlob);
    const beforeLedger = fs.readFileSync(legacyLedger);

    const sessionManagerMod = await import("../../src/core/session-manager.js");
    const { makeSessionManagerDeps } = await import("../helpers/v2-fixtures.js");
    const { makeFakeEngineDriver, FAKE_CAPS_PRESETS } = await import("../helpers/fake-engine.js");
    const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
    const deps = makeSessionManagerDeps(roots, PROJ, { acp: fakeDriver.descriptor });
    const sm = sessionManagerMod.createSessionManager(deps);
    bindSessionManager(deps, sm);
    const created = await sm.create({ engine: "acp" });
    const engine = await sm.admit(created.sid);
    for await (const _ of engine.send({ text: "새 세션 턴" })) void _;

    expect(fs.readFileSync(legacyBlob).equals(beforeBlobContent)).toBe(true);
    expect(fs.readFileSync(legacyLedger).equals(beforeLedger)).toBe(true);
    expect(fs.statSync(legacyBlob).mtimeMs).toBe(beforeBlob.mtimeMs);
  });

  it("Edge: legacy 와 신규 배치가 한 세션 안에서 공존해도 legacy 쪽은 무변경이다", async () => {
    const { legacyLedger } = await seedLegacyData();
    const before = fs.readFileSync(legacyLedger);
    const dedup = await import("../../src/record/dedup.js");
    const { makeRecordCtx } = await import("../helpers/v2-fixtures.js");
    await dedup.classify(
      makeRecordCtx(roots, PROJ, "sess-coexist") as never,
      "user_input",
      "신규 배치 본문",
    );
    expect(fs.readFileSync(legacyLedger).equals(before)).toBe(true);
  });

  it("Error: 신규 경로 생성이 실패해도 legacy 는 여전히 무변경이다", async () => {
    const { legacyLedger } = await seedLegacyData();
    const before = fs.readFileSync(legacyLedger);
    const blobs = await import("../../src/record/blobs.js");
    const { makeRecordCtx } = await import("../helpers/v2-fixtures.js");
    await expect(
      blobs.putBlob(makeRecordCtx(roots, PROJ, "") as never, Buffer.from("x")),
    ).rejects.toThrow();
    expect(fs.readFileSync(legacyLedger).equals(before)).toBe(true);
  });
});

describe("SC-074: legacy 세션 완전 제거는 legacy 원장에서 그 sid 라인만 제거한다", () => {
  it("Happy: legacy 세션 완전 제거 → 확인 문구·결과 안내에 한계 표기 + 그 sid 라인만 제거", async () => {
    await seedLegacySession("legacy-1");
    const pathsMod = await import("../../src/shared/paths.js");
    const vp = pathsMod.vaultPaths(roots.vaultRoot, PROJ);
    fs.mkdirSync(path.dirname(vp.legacyDedupFile), { recursive: true });
    fs.writeFileSync(
      vp.legacyDedupFile,
      `${v1LedgerLine("legacy-1", "sha256:a")}\n${v1LedgerLine("legacy-2", "sha256:b")}\n`,
    );
    const { createPrompter } = await import("../../src/cli/prompt.js");
    const { output } = captureSink();
    const __q = queuedLineInput(["1"]); // 1=완전 제거
    const prompter = createPrompter({ input: __q.stream, output });
    __q.arm(prompter);
    const mod = await import("../../src/cli/session.js");
    // legacy 한계 문구("한계: 배치 변경 이전 세션이라…")는 프롬프터 output 이 아니라 process.stdout
    // 으로 직접 나간다(handleRemove/removeConfirmed) — cli-stop-resume.test.ts 선례대로 실측한다.
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => {
      chunks.push(String(c));
      return true;
    }) as never;
    let code: number;
    try {
      code = await (
        mod as unknown as {
          runSession: (a: readonly string[], d?: Record<string, unknown>) => Promise<number>;
        }
      ).runSession(["rm", PROJ, "legacy-1"], { base: roots.base, prompter, interactive: true });
    } finally {
      process.stdout.write = origWrite;
    }
    prompter.close();
    expect(code).toBe(0);
    expect(chunks.join("")).toMatch(/이전 배치|legacy|한계/i);
    const remaining = fs.readFileSync(vp.legacyDedupFile, "utf8");
    expect(remaining).not.toContain("legacy-1");
    expect(remaining).toContain("legacy-2");
  });

  it("Edge: 다른 sid 라인은 바이트 동일하게 보존된다", async () => {
    await seedLegacySession("legacy-a");
    const pathsMod = await import("../../src/shared/paths.js");
    const vp = pathsMod.vaultPaths(roots.vaultRoot, PROJ);
    fs.mkdirSync(path.dirname(vp.legacyDedupFile), { recursive: true });
    const otherLine = v1LedgerLine("legacy-b", "sha256:kept");
    fs.writeFileSync(vp.legacyDedupFile, `${v1LedgerLine("legacy-a", "sha256:a")}\n${otherLine}\n`);
    const mod = await import("../../src/cli/session.js");
    await (
      mod as unknown as {
        runSession: (a: readonly string[], d?: Record<string, unknown>) => Promise<number>;
      }
    ).runSession(["rm", PROJ, "legacy-a", "--purge"], { base: roots.base, interactive: false });
    const remaining = fs.readFileSync(vp.legacyDedupFile, "utf8");
    expect(remaining).toContain(otherLine); // 바이트 그대로.
    expect(remaining).not.toContain('"sid":"legacy-a"'); // 대상 sid 라인은 실제로 제거됐다(공허 단언 방지).
  });

  it("Error: 원장 필터 실패는 경고 + exit 1(성공 위장 금지)", async () => {
    await seedLegacySession("legacy-fail");
    const pathsMod = await import("../../src/shared/paths.js");
    const vp = pathsMod.vaultPaths(roots.vaultRoot, PROJ);
    fs.mkdirSync(path.dirname(vp.legacyDedupFile), { recursive: true });
    fs.writeFileSync(vp.legacyDedupFile, `${JSON.stringify({ sid: "legacy-fail" })}\n`);
    renameCtl.failWith = () => new Error("simulated filter fail");
    const mod = await import("../../src/cli/session.js");
    const code = await (
      mod as unknown as {
        runSession: (a: readonly string[], d?: Record<string, unknown>) => Promise<number>;
      }
    ).runSession(["rm", PROJ, "legacy-fail", "--purge"], { base: roots.base, interactive: false });
    expect(code).not.toBe(0);
  });
});
