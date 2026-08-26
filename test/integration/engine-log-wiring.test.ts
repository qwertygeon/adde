/**
 * 엔진 진단 로그 배선 — 코어가 세션별 `engine.log` 경로를 드라이버에 실제로 넘기는지 검증한다.
 *
 * `logs --engine` 이 읽는 경로(`engineLogPath`)와 드라이버가 stderr 를 흘려보내는 경로는 서로
 * 합의해야 하지만, 그 합의는 오직 `admit()` → `driver.open(ctx)` 의 인자 전달로만 성립한다.
 * 전달이 빠지면 로그 파일이 만들어지지 않고 `logs --engine` 은 언제나 비어 보인다 — 순수 함수
 * 단언이나 no-op 더블로는 잡히지 않는 미배선 결함이라(CV-3) 더블이 받은 ctx 를 직접 본다.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  makeV2TmpRoots,
  cleanupV2TmpRoots,
  makeSessionManagerDeps,
  type V2TmpRoots,
} from "../helpers/v2-fixtures.js";
import { makeFakeEngineDriver, FAKE_CAPS_PRESETS } from "../helpers/fake-engine.js";
import { engineLogPath } from "../../src/shared/paths.js";

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
  return { sm, fakeDriver };
}

describe("엔진 진단 로그 경로 배선", () => {
  it("신규 기동 시 세션별 engine.log 경로를 드라이버에 넘긴다", async () => {
    const { sm, fakeDriver } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);

    // `adde logs --engine` 이 읽는 경로와 동일 함수로 도출한 값이어야 한다(양쪽 경로 합의).
    expect(fakeDriver.control.lastOpenCtx()?.stderrLogPath).toBe(
      engineLogPath(roots.base, PROJ, created.sid),
    );
  });

  it("재개 기동 시에도 같은 경로를 넘긴다", async () => {
    const { sm, fakeDriver } = await makeSM();
    const created = await sm.create({ engine: "acp" });
    await sm.admit(created.sid);
    await sm.hibernate(created.sid, "idle");
    await sm.admit(created.sid);

    expect(fakeDriver.control.lastOpenCtx()?.stderrLogPath).toBe(
      engineLogPath(roots.base, PROJ, created.sid),
    );
  });

  it("세션마다 다른 경로를 넘긴다(로그 혼입 방지)", async () => {
    const { sm, fakeDriver } = await makeSM();
    const a = await sm.create({ engine: "acp" });
    const b = await sm.create({ engine: "acp" });
    await sm.admit(a.sid);
    const pathA = fakeDriver.control.lastOpenCtx()?.stderrLogPath;
    await sm.admit(b.sid);
    const pathB = fakeDriver.control.lastOpenCtx()?.stderrLogPath;

    expect(pathA).toBeDefined();
    expect(pathB).toBeDefined();
    expect(pathA).not.toBe(pathB);
  });
});
