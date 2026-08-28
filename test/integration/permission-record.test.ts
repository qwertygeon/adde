import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  makeRecordCtx,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { waitFor } from "../helpers/wait.js";

// 권한 세 등급(하드 차단·자동 허용·채널 승인) 기록의 코어측 배선 — 드라이버가 정책만으로 결정한
// 권한을 코어가 요청·결정 이벤트 쌍으로 남기고, 노트는 자동 허용을 접기 요약으로 보여준다.
// 기록은 재생성 불가한 원본이라 소음을 이유로 빼지 않고, 요약은 파생물인 노트에서만 한다.

const PROJ = "p1";
let roots: V2TmpRoots;

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
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
  const sm = smMod.createSessionManager(deps as never);
  holder.sm = sm;
  return { sm, paths: pathsMod, fakeDriver };
}

async function runOneTurn(sm: SM, sid: string, text: string, expectedEnds: number): Promise<void> {
  const [queue, pathsMod, events, envelope] = await Promise.all([
    import("../../src/core/queue.js"),
    import("../../src/shared/paths.js"),
    import("../../src/record/events.js"),
    import("../helpers/envelope.js"),
  ]);
  await sm.admit(sid);
  await queue.enqueue(
    pathsMod.sessionPaths(roots.base, PROJ, sid),
    envelope.makeEnvelope(`env-${text}`, text),
  );
  sm.turnRunner(sid)?.notify();
  const ctx = makeRecordCtx(roots, PROJ, sid) as never;
  await waitFor(
    async () => {
      let ends = 0;
      for await (const e of events.readEvents(ctx)) {
        if ((e as { t: string }).t === "turn_end") ends++;
      }
      return ends >= expectedEnds;
    },
    { timeoutMs: 12_000 },
  );
}

async function readEventList(sid: string): Promise<Array<Record<string, unknown>>> {
  const events = await import("../../src/record/events.js");
  const ctx = makeRecordCtx(roots, PROJ, sid) as never;
  const out: Array<Record<string, unknown>> = [];
  for await (const e of events.readEvents(ctx)) out.push(e as unknown as Record<string, unknown>);
  return out;
}

function turnNote(paths: typeof import("../../src/shared/paths.js"), sid: string, turn: number) {
  const turnsDir = paths.vaultPaths(roots.vaultRoot, PROJ, sid).turnsDir;
  const prefix = String(turn).padStart(4, "0");
  const file = fs.readdirSync(turnsDir).find((f) => f.startsWith(prefix));
  return file === undefined ? null : fs.readFileSync(`${turnsDir}/${file}`, "utf8");
}

/**
 * 최종 투영이 끝난 턴 노트를 읽는다 — `turn_end` append 는 최종 투영보다 앞이라 이벤트만 보고
 * 노트를 읽으면 선투영본("처리 중")을 읽는 경합이 난다(부하에서 실측). 판정 대상 매체 자체를 기다린다.
 */
async function waitForFinalTurnNote(
  paths: typeof import("../../src/shared/paths.js"),
  sid: string,
  turn: number,
): Promise<string> {
  await waitFor(
    () => {
      const note = turnNote(paths, sid, turn);
      return note !== null && !note.includes("status: 처리 중");
    },
    { timeoutMs: 12_000 },
  );
  return turnNote(paths, sid, turn)!;
}

describe("권한 세 등급의 이벤트 기록(코어측)", () => {
  it("Happy: 하드 차단이 요청·결정 이벤트로 남고 결정 경로가 기록된다", async () => {
    const { sm, paths, fakeDriver } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    fakeDriver.control.queueResolvedPermission({
      tool: "Bash · rm -rf 실행",
      decision: "deny",
      via: "hard_deny",
    });

    await runOneTurn(sm, created.sid, "first", 1);

    const list = await readEventList(created.sid);
    const req = list.find((e) => e["t"] === "permission" && String(e["tool"]).includes("rm -rf"));
    expect(req).toBeDefined();
    const decision = list.find(
      (e) => e["t"] === "permission_decision" && e["reqId"] === req!["reqId"],
    );
    expect(decision).toBeDefined();
    expect(decision!["decision"]).toBe("deny");
    expect(decision!["via"]).toBe("hard_deny");

    // 하드 차단은 접지 않는다 — 사용자가 인지해야 하는 차단이다.
    const note = await waitForFinalTurnNote(paths, created.sid, 1);
    expect(note).toContain("rm -rf");
    expect(note).toContain("하드 차단");
  }, 30_000);

  it("Happy: 자동 허용도 전량 기록되고 노트에서는 접기 요약으로 보인다", async () => {
    const { sm, paths, fakeDriver } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    for (const tool of ["Read · a.ts", "Read · b.ts"]) {
      fakeDriver.control.queueResolvedPermission({ tool, decision: "allow", via: "allowlist" });
    }

    await runOneTurn(sm, created.sid, "first", 1);

    const list = await readEventList(created.sid);
    const autos = list.filter((e) => e["t"] === "permission_decision" && e["via"] === "allowlist");
    expect(autos.length).toBe(2);

    const note = await waitForFinalTurnNote(paths, created.sid, 1);
    expect(note).toContain("자동 허용 2건");
    expect(note).toContain("<details>");
    // 접혀 있어도 내용은 노트에 남는다(감사성 유지).
    expect(note).toContain("a.ts");
  }, 30_000);

  it("Happy: 채널 승인 경로의 결정에도 경로가 기록된다", async () => {
    const { sm } = await makeSM();
    const created = await sm.create({ engine: "acp" });

    await runOneTurn(sm, created.sid, "first", 1);

    const list = await readEventList(created.sid);
    const channel = list.filter((e) => e["t"] === "permission_decision" && e["via"] === "channel");
    expect(channel.length).toBeGreaterThan(0);
    expect(channel[0]!["decision"]).toBe("allow");
  }, 30_000);

  it("Edge: autopass 유래 자동 허용은 허용 목록 유래와 구분되어 남는다", async () => {
    const { sm, fakeDriver } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    fakeDriver.control.queueResolvedPermission({
      tool: "Bash · ls",
      decision: "allow",
      via: "autopass",
    });

    await runOneTurn(sm, created.sid, "first", 1);

    const list = await readEventList(created.sid);
    expect(list.some((e) => e["t"] === "permission_decision" && e["via"] === "autopass")).toBe(
      true,
    );
  }, 30_000);
});
