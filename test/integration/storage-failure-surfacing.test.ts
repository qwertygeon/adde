import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { waitFor } from "../helpers/wait.js";

// 턴은 완결됐는데 노트 저장이 실패한 상황 — 실기기에서 vault 프로젝트 폴더 권한을 막았을 때
// 사용자 대면 동작이 완전히 정상으로 보이고 데몬 로그에만 EACCES 가 남았다. 저장 실패를 흡수하면
// 사용자는 대화가 저장된 것으로 오인하므로, **설정 루트의 세션 레코드**(vault 권한과 독립)에
// 경고가 남아야 한다.

const PROJ = "p1";
let roots: V2TmpRoots;
const chmodded: string[] = [];

beforeEach(() => {
  roots = makeV2TmpRoots();
});

afterEach(() => {
  // 권한을 되돌리지 않으면 tmp 정리가 실패한다.
  for (const dir of chmodded.splice(0)) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* 이미 삭제됨 */
    }
  }
  cleanupV2TmpRoots(roots);
});

async function makeSM() {
  const [smMod, pathsMod] = await Promise.all([
    import("../../src/core/session-manager.js"),
    import("../../src/shared/paths.js"),
  ]);
  const fakeDriver = makeFakeEngineDriver("acp", FAKE_CAPS_PRESETS.fullNative);
  const holder: { sm?: import("../../src/core/session-manager.js").SessionManagerWithLoad } = {};
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

/**
 * 큐에 지시를 넣고 TurnRunner 로 한 턴을 완결시킨다. 엔진 세션에 직접 send 하면 종료 후 투영
 * 경로(검증 대상)를 지나지 않으므로, 실제 경로인 큐→claim→턴→투영을 그대로 태운다.
 * `expectedEnds` 는 이 턴까지 누적될 turn_end 개수 — 같은 세션에 여러 턴을 태우므로 존재 여부로는
 * 완결을 판정할 수 없다.
 */
async function runOneTurn(
  sm: import("../../src/core/session-manager.js").SessionManagerWithLoad,
  sid: string,
  text: string,
  expectedEnds: number,
): Promise<void> {
  const [queue, pathsMod, events, fixtures, envelope] = await Promise.all([
    import("../../src/core/queue.js"),
    import("../../src/shared/paths.js"),
    import("../../src/record/events.js"),
    import("../helpers/v2-fixtures.js"),
    import("../helpers/envelope.js"),
  ]);
  await sm.admit(sid);
  await queue.enqueue(
    pathsMod.sessionPaths(roots.base, PROJ, sid),
    envelope.makeEnvelope(`env-${text}`, text),
  );
  sm.turnRunner(sid)?.notify();

  const ctx = fixtures.makeRecordCtx(roots, PROJ, sid) as never;
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

/**
 * 턴 종료 후 투영이 실제로 끝났음을 확인한다. `turn_end` append 는 투영보다 앞이라, 이벤트만 보고
 * 다음 단계로 넘어가면 앞 턴의 투영이 권한 차단 시점과 겹쳐 경합이 난다(부하에서 실측된 flaky).
 * 프로젝트 노트는 refreshNotes 가 마지막에 쓰므로 그 존재를 투영 완료 신호로 쓴다.
 */
async function waitForProjection(paths: typeof import("../../src/shared/paths.js")): Promise<void> {
  const projectNote = paths.vaultPaths(roots.vaultRoot, PROJ).projectNote;
  await waitFor(() => fs.existsSync(projectNote), { timeoutMs: 12_000 });
}

/** 영속된 레코드의 저장 실패 경고 유무 — in-memory 를 기다린 뒤 디스크를 읽으면 `persist()` 경계를
 * 넘는 read-after-write 경합이 된다(부하에서 실측). 판정 대상 그 자체(디스크)를 기다린다. */
async function waitForPersistedStorageWarning(
  paths: typeof import("../../src/shared/paths.js"),
  sid: string,
  present: boolean,
): Promise<string[]> {
  const recordFile = paths.sessionPaths(roots.base, PROJ, sid).recordFile;
  const read = (): string[] => {
    try {
      return (JSON.parse(fs.readFileSync(recordFile, "utf8")) as { warnings: string[] }).warnings;
    } catch {
      return [];
    }
  };
  await waitFor(() => read().some((w) => w.startsWith("storage-failed:")) === present, {
    timeoutMs: 12_000,
  });
  return read();
}

describe("노트 저장 실패의 표면화", () => {
  it("Happy: vault 프로젝트 폴더가 쓰기 불가여도 턴은 완결되고 세션 레코드에 저장 실패 경고가 남는다", async () => {
    const { sm, paths } = await makeSM();
    const created = await sm.create({ engine: "acp" });

    // 첫 턴은 정상 — 이후 재개·투영 경로가 이미 배선된 상태를 만든다.
    await runOneTurn(sm, created.sid, "first", 1);
    expect(sm.get(created.sid)?.warnings ?? []).toEqual([]);

    // 프로젝트 노트가 놓이는 디렉터리만 쓰기 금지 — 실기기 재현(하위 세션 폴더는 그대로 쓰기 가능).
    await waitForProjection(paths);

    const projectDir = paths.vaultPaths(roots.vaultRoot, PROJ).projectDir;
    fs.chmodSync(projectDir, 0o500);
    chmodded.push(projectDir);

    await runOneTurn(sm, created.sid, "second", 2);

    // 턴 자체는 실패하지 않는다(무손실 이벤트 기록은 별 경로).
    expect(sm.get(created.sid)?.status).toBe("active");

    // 저장 실패가 레코드 경고로 남아야 한다 — 조용히 흡수되면 이 단언이 깨진다. 설정 루트의 레코드
    // 파일까지 영속돼야 재기동 후에도 남는다(vault 와 독립).
    const persisted = await waitForPersistedStorageWarning(paths, created.sid, true);
    expect(persisted.some((w) => w.startsWith("storage-failed:"))).toBe(true);
    expect(sm.get(created.sid)?.warnings ?? []).toEqual(persisted);
  }, 20_000);

  it("Happy: 같은 사유의 저장 실패가 반복돼도 경고가 누적되지 않는다", async () => {
    const { sm, paths } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await runOneTurn(sm, created.sid, "first", 1);

    await waitForProjection(paths);

    const projectDir = paths.vaultPaths(roots.vaultRoot, PROJ).projectDir;
    fs.chmodSync(projectDir, 0o500);
    chmodded.push(projectDir);

    await runOneTurn(sm, created.sid, "second", 2);
    await waitForPersistedStorageWarning(paths, created.sid, true);
    await runOneTurn(sm, created.sid, "third", 3);

    const storageWarnings = (sm.get(created.sid)?.warnings ?? []).filter((w) =>
      w.startsWith("storage-failed:"),
    );
    expect(storageWarnings.length).toBe(1);
  }, 20_000);

  it("Happy: 저장이 다시 성공하면 저장 실패 경고가 자동으로 사라진다", async () => {
    const { sm, paths } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await runOneTurn(sm, created.sid, "first", 1);

    await waitForProjection(paths);

    const projectDir = paths.vaultPaths(roots.vaultRoot, PROJ).projectDir;
    fs.chmodSync(projectDir, 0o500);
    chmodded.push(projectDir);
    await runOneTurn(sm, created.sid, "second", 2);
    await waitForPersistedStorageWarning(paths, created.sid, true);

    // 권한 복구 — 사용자가 설정을 고친 상황.
    fs.chmodSync(projectDir, 0o700);
    await runOneTurn(sm, created.sid, "third", 3);

    // 남아 있으면 다음 실패를 가리므로 성공 시 제거돼야 한다.
    const persisted = await waitForPersistedStorageWarning(paths, created.sid, false);
    expect(persisted.some((w) => w.startsWith("storage-failed:"))).toBe(false);
  }, 20_000);
});

describe("경고 수명 — 누적 방지와 성공 시 해소", () => {
  it("Happy: 재개 실패가 반복돼도 같은 종류 경고는 1건만 유지된다", async () => {
    const { sm, fakeDriver } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    // 재개 경로를 타려면 재개 핸들이 있어야 한다(턴 0회 세션은 신규 기동으로 취급).
    // 실제 턴을 태우지 않고 핸들만 주입한다 — 턴이 진행 중이면 TurnRunner 가 자체적으로 admit 을
    // 호출해 더블의 1회성 실패 예약을 먼저 소비하고, 이 테스트가 부하에서 flaky 해진다(실측).
    const rec = sm.get(created.sid)!;

    // 데몬 재기동마다 1건씩 늘던 경로 재현 — 재개 실패를 두 번 유발한다.
    for (const attempt of ["첫", "두번째"]) {
      rec.engineRef = "prior-turn-engine-ref";
      rec.status = "hibernated";
      fakeDriver.control.failNextOpen(`${attempt} 실패`);
      await expect(sm.admit(created.sid)).rejects.toThrow();
      expect(rec.status).toBe("detached"); // 재개 실패는 새 세션 폴백 없이 detached 확정
    }

    const resumeWarnings = rec.warnings.filter((w) => w.startsWith("resume-failed:"));
    expect(resumeWarnings.length).toBe(1);
    expect(resumeWarnings[0]).toContain("두번째"); // 최신 사유를 유지한다
  }, 20_000);

  it("Happy: 기동에 성공하면 이전 재개 실패 경고가 사라진다", async () => {
    const { sm } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    const rec = sm.get(created.sid)!;
    rec.warnings = ["resume-failed: 이전 실패"];

    await sm.admit(created.sid);

    expect(rec.warnings.some((w) => w.startsWith("resume-failed:"))).toBe(false);
  });
});
