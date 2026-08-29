import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  makeRecordCtx,
  type V2TmpRoots,
  bindSessionManager,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { waitFor } from "../helpers/wait.js";

// 턴이 중단되는 5경로(턴시작 기록·선투영·엔진 투입·응답 기록·턴종료 기록)는 이전에 전부
// console.error 로만 끝났다 — 사용자에게는 "보낸 지시에 응답이 영원히 오지 않는" 것으로만 보였고
// 턴 노트는 선투영이 쓴 "처리 중" 에 영구 고착했다. 배선 결함은 함수 단언으로 잡히지 않으므로
// (conventions CV-3) 큐→claim→턴 실경로를 태우고 **디스크의 레코드·노트 파일**로 관측한다.
//
// 기록 실패 주입은 node:fs/promises 를 목해 특정 이벤트 종류의 append 만 실패시킨다
// (record-failure.test.ts 선례 — ESM 네임스페이스 직접 spyOn 불가). 실패 지점만 바꾸고
// 그 외 경로(투영·경고 영속·노트 렌더)는 모두 실제 구현을 통과한다.
const fsCtl = vi.hoisted(() => ({ failEventType: null as string | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      const data = args[1];
      if (
        fsCtl.failEventType !== null &&
        typeof data === "string" &&
        data.includes(`"t":"${fsCtl.failEventType}"`)
      ) {
        const err = new Error("injected append failure") as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return actual.appendFile(...args);
    },
  };
});

const PROJ = "p1";
let roots: V2TmpRoots;
const chmodded: string[] = [];

beforeEach(() => {
  roots = makeV2TmpRoots();
  fsCtl.failEventType = null;
});

afterEach(() => {
  for (const dir of chmodded.splice(0)) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* 이미 삭제됨 */
    }
  }
  cleanupV2TmpRoots(roots);
});

type SM = import("../../src/core/session-manager.js").SessionManagerWithLoad;

async function makeSM() {
  const [smMod, pathsMod] = await Promise.all([
    import("../../src/core/session-manager.js"),
    import("../../src/shared/paths.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const holder: { sm?: SM } = {};
  const deps = makeSessionManagerDeps(
    roots,
    PROJ,
    { acp: fakeDriver.descriptor },
    {
      askPermission: async (sid: string, req: { reqId: string }) => {
        holder.sm?.resolvePermissionDecision(sid, req.reqId, "allow");
      },
    },
  );
  const sm = smMod.createSessionManager(deps);
  bindSessionManager(deps, sm);
  holder.sm = sm;
  return { sm, paths: pathsMod, fakeDriver };
}

/** 큐에 지시를 넣고 런너를 깨운다 — 실제 경로(claim→turn_start→선투영→admit→send→turn_end). */
async function enqueueTurn(sm: SM, sid: string, text: string): Promise<void> {
  const [queue, pathsMod, envelope] = await Promise.all([
    import("../../src/core/queue.js"),
    import("../../src/shared/paths.js"),
    import("../helpers/envelope.js"),
  ]);
  await queue.enqueue(
    pathsMod.sessionPaths(roots.base, PROJ, sid),
    envelope.makeEnvelope(`env-${text}`, text),
  );
  sm.turnRunner(sid)?.notify();
}

/** 영속된 레코드 경고 — 판정 대상 매체(디스크) 자체를 기다린다(메모리 대기 후 디스크 읽기 금지). */
async function waitForWarning(sid: string, prefix: string, present = true): Promise<string[]> {
  const pathsMod = await import("../../src/shared/paths.js");
  const recordFile = pathsMod.sessionPaths(roots.base, PROJ, sid).recordFile;
  const read = (): string[] => {
    try {
      return (JSON.parse(fs.readFileSync(recordFile, "utf8")) as { warnings: string[] }).warnings;
    } catch {
      return [];
    }
  };
  await waitFor(() => read().some((w) => w.startsWith(prefix)) === present, { timeoutMs: 12_000 });
  return read();
}

/** 완결된 턴 수(turn_end 이벤트) — 성공 턴 대기용. */
async function waitForTurnEnds(sid: string, count: number): Promise<void> {
  const events = await import("../../src/record/events.js");
  const ctx = makeRecordCtx(roots, PROJ, sid) as never;
  await waitFor(
    async () => {
      let ends = 0;
      for await (const e of events.readEvents(ctx)) {
        if ((e as { t: string }).t === "turn_end") ends++;
      }
      return ends >= count;
    },
    { timeoutMs: 12_000 },
  );
}

function turnNoteBody(
  paths: typeof import("../../src/shared/paths.js"),
  sid: string,
  turn: number,
) {
  const turnsDir = paths.vaultPaths(roots.vaultRoot, PROJ, sid).turnsDir;
  const prefix = String(turn).padStart(4, "0");
  const file = fs.readdirSync(turnsDir).find((f) => f.startsWith(prefix));
  return file === undefined ? null : fs.readFileSync(`${turnsDir}/${file}`, "utf8");
}

/** 첫 턴을 정상 완결시켜 재개·투영 경로가 배선된 상태를 만든다(2번째 턴에 실패를 주입). */
async function runFirstTurn(sm: SM, sid: string): Promise<void> {
  await sm.admit(sid);
  await enqueueTurn(sm, sid, "first");
  await waitForTurnEnds(sid, 1);
}

describe("턴 중단 5경로의 표면화", () => {
  it("Happy(1/5 턴시작 기록): append 실패가 세션 레코드 경고로 남는다", async () => {
    const { sm } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await runFirstTurn(sm, created.sid);

    fsCtl.failEventType = "turn_start";
    await enqueueTurn(sm, created.sid, "second");

    const warnings = await waitForWarning(created.sid, "turn-failed:");
    expect(warnings.some((w) => w.includes("턴 시작 기록 실패"))).toBe(true);
  }, 20_000);

  it("Happy(2/5 선투영): 턴 노트 선생성 실패가 경고로 남는다", async () => {
    const { sm, paths } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await runFirstTurn(sm, created.sid);

    const turnsDir = paths.vaultPaths(roots.vaultRoot, PROJ, created.sid).turnsDir;
    fs.chmodSync(turnsDir, 0o500);
    chmodded.push(turnsDir);

    await enqueueTurn(sm, created.sid, "second");

    const warnings = await waitForWarning(created.sid, "turn-failed:");
    expect(warnings.some((w) => w.includes("턴 노트 선생성 실패"))).toBe(true);
  }, 20_000);

  it("Happy(3/5 엔진 투입): admit 실패가 경고로 남고 턴 노트가 오류로 종결된다", async () => {
    const { sm, paths, fakeDriver } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await runFirstTurn(sm, created.sid);

    // 상주 엔진이 죽은 뒤 재투입이 실패하는 상황 — 캐시된 세션이 살아 있으면 open 이 불리지 않는다.
    const engineRef = sm.get(created.sid)!.engineRef!;
    fakeDriver.control.crash(engineRef);
    fakeDriver.control.failNextOpen("엔진 기동 거부");

    await enqueueTurn(sm, created.sid, "second");

    const warnings = await waitForWarning(created.sid, "turn-failed:");
    expect(warnings.some((w) => w.includes("엔진 투입 실패"))).toBe(true);

    // 선투영이 쓴 "처리 중" 에 고착하지 않고 오류로 종결돼야 한다.
    await waitFor(() => (turnNoteBody(paths, created.sid, 2) ?? "").includes("status: 오류"), {
      timeoutMs: 12_000,
    });
    const note = turnNoteBody(paths, created.sid, 2)!;
    expect(note).toContain("status: 오류");
    expect(note).toContain("턴 중단");
    expect(note).not.toContain("status: 처리 중");
  }, 20_000);

  it("Happy(4/5 응답 기록): 스트림 append 실패가 경고로 남고 턴 노트가 오류로 종결된다", async () => {
    const { sm, paths } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await runFirstTurn(sm, created.sid);

    fsCtl.failEventType = "text_final";
    await enqueueTurn(sm, created.sid, "second");

    const warnings = await waitForWarning(created.sid, "turn-failed:");
    expect(warnings.some((w) => w.includes("응답 기록 실패"))).toBe(true);

    fsCtl.failEventType = null; // 중단 사유(error 이벤트) 기록은 막지 않는다.
    await waitFor(() => (turnNoteBody(paths, created.sid, 2) ?? "").includes("status: 오류"), {
      timeoutMs: 12_000,
    });
  }, 20_000);

  it("Happy(5/5 턴종료 기록): turn_end append 실패가 경고로 남고 턴 노트가 오류로 종결된다", async () => {
    const { sm, paths } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await runFirstTurn(sm, created.sid);

    fsCtl.failEventType = "turn_end";
    await enqueueTurn(sm, created.sid, "second");

    const warnings = await waitForWarning(created.sid, "turn-failed:");
    expect(warnings.some((w) => w.includes("턴 종료 기록 실패"))).toBe(true);

    fsCtl.failEventType = null;
    await waitFor(() => (turnNoteBody(paths, created.sid, 2) ?? "").includes("status: 오류"), {
      timeoutMs: 12_000,
    });
  }, 20_000);

  it("Happy: 다음 턴이 성공하면 턴 중단 경고가 사라진다", async () => {
    const { sm } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await runFirstTurn(sm, created.sid);

    fsCtl.failEventType = "turn_start";
    await enqueueTurn(sm, created.sid, "second");
    await waitForWarning(created.sid, "turn-failed:");

    // 실패 원인이 사라진 뒤의 다음 턴 — 중단된 턴 자체는 processing 에 남아 다음 기동의 회수
    // 대상이다(부팅 재적재 계약). 경고 해소는 "이후 턴이 완결됐다" 는 사실에 걸린다.
    fsCtl.failEventType = null;
    await enqueueTurn(sm, created.sid, "third");
    await waitForTurnEnds(created.sid, 2);

    const warnings = await waitForWarning(created.sid, "turn-failed:", false);
    expect(warnings.some((w) => w.startsWith("turn-failed:"))).toBe(false);
  }, 20_000);
});
